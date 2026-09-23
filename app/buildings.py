"""Bâtiments : emprises OpenStreetMap (Overpass) + hauteurs LiDAR (DSM - DTM)."""
import re

import geopandas as gpd
import numpy as np
import pandas as pd
from rasterio.features import rasterize
from shapely.geometry import LineString, Polygon, MultiPolygon
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

from .net import session

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

MIN_AREA_M2 = 5.0
LEVEL_HEIGHT_M = 3.0


def _overpass(query):
    errors = []
    for url in OVERPASS_ENDPOINTS:
        try:
            r = session().post(url, data={"data": query}, timeout=300)
            if r.ok and "json" in r.headers.get("Content-Type", ""):
                return r.json()
            errors.append(f"{url}: HTTP {r.status_code}")
        except Exception as e:  # noqa: BLE001 - on essaie le serveur suivant
            errors.append(f"{url}: {e}")
    raise RuntimeError("Overpass indisponible : " + " ; ".join(errors))


def _polygonal(geom):
    geom = make_valid(geom)
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    polys = [g for g in getattr(geom, "geoms", []) if isinstance(g, (Polygon, MultiPolygon))]
    return unary_union(polys) if polys else None


def _relation_geom(members):
    rings = {"outer": [], "inner": []}
    for m in members:
        if m.get("type") == "way" and "geometry" in m and len(m["geometry"]) >= 2:
            rings["inner" if m.get("role") == "inner" else "outer"].append(
                LineString([(p["lon"], p["lat"]) for p in m["geometry"]]))
    outer = unary_union(list(polygonize(unary_union(rings["outer"])))) if rings["outer"] else None
    if outer is None or outer.is_empty:
        return None
    if rings["inner"]:
        outer = outer.difference(unary_union(list(polygonize(unary_union(rings["inner"])))))
    return outer


def _num(value):
    m = re.match(r"\s*([0-9]+(?:[.,][0-9]+)?)", value or "")
    return float(m.group(1).replace(",", ".")) if m else np.nan


def fetch_osm(zone_ll):
    """Bâtiments OSM intersectant la zone (GeoDataFrame EPSG:4326)."""
    ring = zone_ll.simplify(0.0001).exterior.coords
    poly = " ".join(f"{lat:.6f} {lon:.6f}" for lon, lat in ring)
    query = (f'[out:json][timeout:240];'
             f'(way["building"](poly:"{poly}");relation["building"]["type"="multipolygon"](poly:"{poly}"););'
             f'out geom;')
    rows = []
    for el in _overpass(query).get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "way":
            pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
            if len(pts) < 4 or pts[0] != pts[-1]:
                continue
            geom = Polygon(pts)
        else:
            geom = _relation_geom(el.get("members", []))
        geom = _polygonal(geom) if geom is not None else None
        if geom is None or geom.is_empty:
            continue
        rows.append({
            "OSM_ID": f"{el['type'][0]}{el['id']}",
            "TYPE": tags.get("building", "yes")[:50],
            "NOM": tags.get("name", "")[:100],
            "NIVEAUX": _num(tags.get("building:levels")),
            "H_OSM": _num(tags.get("height")),
            "geometry": geom,
        })
    return gpd.GeoDataFrame(rows, columns=["OSM_ID", "TYPE", "NOM", "NIVEAUX", "H_OSM", "geometry"],
                            geometry="geometry", crs=4326)


def lidar_heights(gdf, grid, dtm, dsm):
    """Hauteur médiane (DSM - DTM) et altitude du sol médiane par bâtiment ; NaN si couverture insuffisante."""
    n = len(gdf)
    h = np.full(n, np.nan)
    ground = np.full(n, np.nan)
    if n == 0 or dsm is None or not np.isfinite(dsm).any():
        return h, ground
    # Érosion de 0,5 m pour éviter les pixels de bordure (façades, végétation adjacente).
    shapes = []
    for i, g in enumerate(gdf.geometry):
        eroded = g.buffer(-0.5)
        shapes.append((eroded if eroded.area >= 4 else g, i + 1))
    labels = rasterize(shapes, out_shape=(grid.height, grid.width), transform=grid.transform, fill=0,
                       dtype="int32")
    diff = dsm - dtm
    mask = (labels > 0) & np.isfinite(diff)
    if not mask.any():
        return h, ground
    df = pd.DataFrame({"id": labels[mask] - 1, "h": diff[mask], "z": dtm[mask]})
    stats = df.groupby("id").agg(h=("h", "median"), z=("z", "median"), n=("h", "size"))
    pixel_area = grid.res * grid.res
    areas = gdf.geometry.area.to_numpy()
    for idx, row in stats.iterrows():
        ground[idx] = row.z
        if row.n * pixel_area >= 0.3 * areas[idx] and 2.0 <= row.h <= 250:
            h[idx] = row.h
    return h, ground


def assign_heights(gdf, h_lidar, ground, default_height):
    """Priorité : LiDAR > height OSM > niveaux OSM x 3 m > valeur par défaut."""
    gdf = gdf.copy()
    gdf["H_LIDAR"] = np.round(h_lidar, 1)
    gdf["ALT_SOL"] = np.round(ground, 2)
    src = np.full(len(gdf), "DEFAUT", dtype=object)
    height = np.full(len(gdf), float(default_height))
    levels = gdf["NIVEAUX"].to_numpy(dtype=float) * LEVEL_HEIGHT_M
    for values, label in ((levels, "OSM_NIV"), (gdf["H_OSM"].to_numpy(dtype=float), "OSM_H"),
                          (np.asarray(h_lidar, dtype=float), "LIDAR")):
        ok = np.isfinite(values) & (values > 0)
        height[ok] = values[ok]
        src[ok] = label
    gdf["HAUTEUR"] = np.round(height, 1)
    gdf["H_SRC"] = src
    return gdf


def clean(gdf_proj, zone):
    """Garde les bâtiments dont le centre est dans la zone (emprise entière conservée)."""
    gdf_proj = gdf_proj[gdf_proj.geometry.area >= MIN_AREA_M2]
    return gdf_proj[gdf_proj.geometry.representative_point().within(zone)].reset_index(drop=True)
