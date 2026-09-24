"""Bâtiments projetés saisis sur un plan calé, et bâtiments existants démolis."""
import geopandas as gpd
import numpy as np
from pyproj import Transformer
from rasterio.features import geometry_mask
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from .buildings import _polygonal

MAX_PROJETS = 500
MIN_AREA_M2 = 1.0
COVER_DEMOLI = 0.3  # part de l'emprise existante recouverte au-delà de laquelle on propose la démolition


def ground_level(geom, z, grid):
    """Altitude médiane du terrain sous l'emprise (centre de l'emprise si elle est plus petite qu'une maille)."""
    if z is None:
        return np.nan
    mask = ~geometry_mask([geom], out_shape=z.shape, transform=grid.transform, all_touched=True)
    vals = z[mask & np.isfinite(z)]
    if vals.size:
        return float(np.median(vals))
    c = geom.representative_point()
    col = int((c.x - grid.transform.c) / grid.res)
    row = int((grid.transform.f - c.y) / grid.res)
    if 0 <= row < z.shape[0] and 0 <= col < z.shape[1] and np.isfinite(z[row, col]):
        return float(z[row, col])
    return np.nan


def build(items, epsg, z, grid):
    """GeoDataFrame des bâtiments projetés (mêmes champs que batiments.shp) depuis la saisie du navigateur."""
    if len(items) > MAX_PROJETS:
        raise ValueError(f"{MAX_PROJETS} bâtiments projetés au maximum.")
    to_proj = Transformer.from_crs(4326, epsg, always_xy=True).transform
    rows = []
    for it in items:
        geom = _polygonal(shp_transform(to_proj, shape(it["geometry"])))
        if geom is None or geom.area < MIN_AREA_M2:
            raise ValueError(f"Emprise invalide ou trop petite : « {it['nom']} ».")
        rows.append({
            "OSM_ID": "", "TYPE": "projet", "NOM": it["nom"][:100], "NIVEAUX": it.get("niveaux") or np.nan,
            "H_OSM": np.nan, "H_LIDAR": np.nan, "ALT_SOL": round(ground_level(geom, z, grid), 2),
            "HAUTEUR": round(float(it["hauteur"]), 1), "H_SRC": "PROJET", "STATUT": "PROJETE",
            "PLAN": (it.get("plan") or "")[:80], "PROJ_ID": it["id"], "geometry": geom,
        })
    cols = ["OSM_ID", "TYPE", "NOM", "NIVEAUX", "H_OSM", "H_LIDAR", "ALT_SOL", "HAUTEUR", "H_SRC", "STATUT",
            "PLAN", "PROJ_ID", "geometry"]
    return gpd.GeoDataFrame(rows, columns=cols, geometry="geometry", crs=epsg)


def covered(existing, projets):
    """OSM_ID des bâtiments existants recouverts à plus de COVER_DEMOLI par une emprise projetée."""
    if existing is None or not len(existing) or not len(projets):
        return []
    union = projets.geometry.union_all()
    near = existing[existing.geometry.intersects(union)]
    part = near.geometry.intersection(union).area / near.geometry.area
    return near.loc[part >= COVER_DEMOLI, "OSM_ID"].tolist()
