"""Données d'aperçu 3D (JSON) : terrain allégé, bâtiments, routes, courbes, zone.

Coordonnées locales en mètres, centrées sur le terrain : x = est, y = nord, z = altitude.
"""
import json
import math
import warnings

import numpy as np
import shapely
from scipy.ndimage import map_coordinates
from shapely.geometry import MultiPolygon, Polygon

from . import topo

MAX_CELLS = 300          # côté max de la grille de terrain affichée
MAX_CONTOUR_POINTS = 400_000


def _downsample(dtm, grid, factor):
    """Moyenne par blocs (NaN ignorés)."""
    h, w = (grid.height // factor) * factor, (grid.width // factor) * factor
    blocks = dtm[:h, :w].reshape(h // factor, factor, w // factor, factor)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # blocs entièrement NaN
        z = np.nanmean(blocks, axis=(1, 3))
    res = grid.res * factor
    g = topo.Grid(grid.crs, topo.Affine(res, 0, grid.transform.c, 0, -res, grid.transform.f), w // factor,
                  h // factor, res)
    return z, g


def terrain(dtm, grid, zone, bbox_ll, epsg):
    """Grille de terrain d'au plus MAX_CELLS de côté (réutilise le MNT calculé, sinon lecture grossière)."""
    if dtm is not None:
        factor = max(1, math.ceil(max(grid.width, grid.height) / MAX_CELLS))
        return _downsample(dtm, grid, factor)
    x0, y0, x1, y1 = zone.bounds
    res = max(2.0, math.ceil(max(x1 - x0, y1 - y0) / MAX_CELLS))
    g = topo.Grid.covering(zone.buffer(2 * res).bounds, res, f"EPSG:{epsg}")
    z, _ = topo.build_dtm(bbox_ll, g, source="hrdem")  # même référence (CGVD2013) que ALT_SOL sans topographie
    return z, g


class Sampler:
    """Interpolation bilinéaire de l'altitude sur la grille de terrain."""

    def __init__(self, z, grid):
        self.z = np.where(np.isfinite(z), z, np.nanmin(z) if np.isfinite(z).any() else 0.0)
        self.g = grid

    def __call__(self, xs, ys):
        cols = (np.asarray(xs) - self.g.transform.c) / self.g.res - 0.5
        rows = (self.g.transform.f - np.asarray(ys)) / self.g.res - 0.5
        return map_coordinates(self.z, [rows, cols], order=1, mode="nearest")


def _num(v, nd=1):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if math.isfinite(v) else None


class Frame:
    """Repère local de l'aperçu : origine au centre du terrain, altitudes relatives à zref."""

    def __init__(self, dtm_grid):
        z, grid = dtm_grid
        self.grid = grid
        self.sample = Sampler(z, grid)
        self.cx = grid.transform.c + grid.width * grid.res / 2
        self.cy = grid.transform.f - grid.height * grid.res / 2
        self.zref = float(np.nanmin(z)) if np.isfinite(z).any() else 0.0

    def loc(self, coords):
        return [[round(x - self.cx, 1), round(y - self.cy, 1)] for x, y, *_ in coords]

    def draped(self, line, offset):
        line = shapely.segmentize(line, self.grid.res)
        xy = np.asarray(line.coords)[:, :2]
        zs = self.sample(xy[:, 0], xy[:, 1]) + offset
        return [[round(x - self.cx, 1), round(y - self.cy, 1), round(float(h), 2)] for (x, y), h in zip(xy, zs)]


def building_items(buildings, f):
    """Volumes extrudés (une entrée par polygone) ; bid / pid relient aux bâtiments existants / projetés."""
    items = []
    for i, row in enumerate(buildings.itertuples(index=False)):
        geom = row.geometry
        c = geom.representative_point()
        ground_mesh = float(f.sample([c.x], [c.y])[0])
        ground = _num(row.ALT_SOL, 2)
        top = (ground if ground is not None else ground_mesh) + float(row.HAUTEUR)
        parts = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
        for part in parts:
            if not isinstance(part, Polygon) or part.is_empty:
                continue
            ring = np.asarray(part.exterior.coords)[:, :2]
            ground_min = min(float(f.sample(ring[:, 0], ring[:, 1]).min()), ground_mesh)
            item = {
                "id": i,
                "o": f.loc(part.exterior.coords),
                "i": [f.loc(r.coords) for r in part.interiors],
                "g": round(ground_mesh, 2),   # sol au centre (référence de la hauteur)
                "gm": round(ground_min, 2),   # sol le plus bas sous l'emprise (pied du volume)
                "t": round(top, 2),
                "h": _num(row.HAUTEUR), "s": row.H_SRC, "hl": _num(row.H_LIDAR), "ho": _num(row.H_OSM),
                "nv": _num(row.NIVEAUX, 0), "n": row.NOM or "", "ty": row.TYPE or "",
                "e": row.EMP_SRC, "er": row.EMP_ROLE or "", "ep": row.EMP_PROD or "", "ed": row.EMP_DATE or "",
                "oi": row.OSM_ID or "",
            }
            if getattr(row, "ID_BAT", ""):
                item["bid"] = row.ID_BAT
            if getattr(row, "PROJ_ID", ""):
                item["pid"] = row.PROJ_ID
            items.append(item)
    return items


def build(zone, dtm_grid, buildings=None, roads=None, contours=None, stats=None):
    z, grid = dtm_grid
    f = Frame(dtm_grid)
    out = {
        "zref": round(f.zref, 2),
        "stats": stats or {},
        "terrain": {
            "nx": grid.width, "ny": grid.height, "res": grid.res,
            "z": [_num(v, 2) for v in z.ravel()],
        },
        "zone": f.draped(zone.exterior, 0.5),
    }

    if buildings is not None:
        out["buildings"] = building_items(buildings, f)

    if roads is not None:
        djma = roads["DJMA"] if "DJMA" in roads else [None] * len(roads)
        out["roads"] = [{"c": f.draped(g, 0.4), "k": k, "n": n, "d": _num(d, 0)}
                        for g, k, n, d in zip(roads.geometry, roads.CLASSE, roads.NOM, djma)]

    if contours is not None and len(contours):
        levels = sorted(contours.ALTITUDE.unique())
        npts = int(shapely.get_num_coordinates(contours.geometry.values).sum())
        step = max(1, math.ceil(npts / MAX_CONTOUR_POINTS))
        keep = set(levels[::step])
        out["contours"] = [{"z": float(a), "c": f.loc(g.coords)}
                           for g, a in zip(contours.geometry, contours.ALTITUDE) if a in keep]
        out["contour_step"] = step
    return out


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
