"""Bâtiments : emprises OpenStreetMap (Overpass) et Référentiel québécois sur les bâtiments (WFS du MRNF),
priorisées maille par maille selon leur complétude, + hauteurs LiDAR (DSM - DTM)."""
import re
import time

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import shapely
from rasterio.features import rasterize
from shapely.geometry import LineString, Polygon, MultiPolygon, shape
from shapely.ops import polygonize, unary_union
from shapely.validation import make_valid

from .net import session

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
REFBATI_WFS = "https://servicesvecto3.mern.gouv.qc.ca/geoserver/ReferentielBatiment_Pub/wfs"
REFBATI_LAYER = "ReferentielBatiment_Pub:Empreintes_batiments"
REFBATI_PAGE = 10000

MIN_AREA_M2 = 5.0
LEVEL_HEIGHT_M = 3.0

# Priorité des emprises (mode auto), maille par maille :
CELL_M = 500.0          # côté des mailles
OSM_COVER_MIN = 0.85    # OSM principal si ses emprises couvrent au moins 85 % de la surface bâtie du Référentiel
DUP_OVERLAP = 0.2       # une emprise complémentaire recouverte à 20 % ou plus par une emprise gardée est un doublon
MATCH_MIN = 0.5         # recouvrement mutuel minimal pour reporter les attributs OSM sur une emprise du Référentiel

COLUMNS = ["ID_BAT", "EMP_SRC", "EMP_ROLE", "EMP_PROD", "EMP_DATE", "EMP_NC", "OSM_ID", "TYPE", "NOM", "NIVEAUX",
           "H_OSM", "geometry"]


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


def _get_json(url, params, tries=4):
    for attempt in range(tries):
        try:
            r = session().get(url, params=params, timeout=180)
            r.raise_for_status()
            return r.json()
        except (requests.ConnectionError, requests.Timeout):  # le serveur du MRNF coupe parfois la connexion
            if attempt == tries - 1:
                raise
            time.sleep(3 * (attempt + 1))


def fetch_refbati(zone_ll):
    """Emprises du Référentiel québécois sur les bâtiments dans l'emprise de la zone (GeoDataFrame EPSG:4326)."""
    lon0, lat0, lon1, lat1 = zone_ll.bounds
    params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": REFBATI_LAYER,
              "outputFormat": "application/json", "srsName": "EPSG:4326", "sortBy": "IDENTIFIANT",
              "bbox": f"{lat0},{lon0},{lat1},{lon1},urn:ogc:def:crs:EPSG::4326", "count": REFBATI_PAGE}
    feats, start = [], 0
    while True:
        page = _get_json(REFBATI_WFS, {**params, "startIndex": start}).get("features", [])
        feats += page
        if len(page) < REFBATI_PAGE:
            break
        start += REFBATI_PAGE
    rows = []
    for f in feats:
        p = f["properties"]
        geom = _polygonal(shape(f["geometry"])) if f.get("geometry") else None
        if geom is None or geom.is_empty:
            continue
        date = (p.get("DATE_SOURCE") or "")[:10]
        rows.append({
            "REF_ID": p.get("ID_BATIMENT") or str(p.get("IDENTIFIANT")),
            "EMP_PROD": (p.get("PRODUCTEUR") or "")[:80],
            "EMP_DATE": "" if date.startswith("1900") else date,  # 1900-01-01 : date inconnue
            "EMP_NC": p.get("NIVEAU_COMPLETUDE") or "",
            "VERSION": p.get("VERSION") or "",
            "geometry": geom,
        })
    return gpd.GeoDataFrame(rows, columns=["REF_ID", "EMP_PROD", "EMP_DATE", "EMP_NC", "VERSION", "geometry"],
                            geometry="geometry", crs=4326)


def _pairs(a, b):
    """Couples (i de a, j de b) d'emprises qui se touchent, et aire de leur intersection."""
    if not len(a) or not len(b):
        return np.array([], int), np.array([], int), np.array([])
    ia, ib = b.sindex.query(a.geometry.values, predicate="intersects")
    inter = shapely.area(shapely.intersection(a.geometry.values[ia], b.geometry.values[ib]))
    return ia, ib, inter


def _cells(gdf):
    p = gdf.geometry.representative_point()
    return pd.Series(list(zip(np.floor(p.x / CELL_M).astype(int), np.floor(p.y / CELL_M).astype(int))),
                     index=gdf.index, dtype=object)


def _from_osm(osm):
    out = osm.reset_index(drop=True).copy()
    out["ID_BAT"] = "osm:" + out["OSM_ID"]
    out["EMP_SRC"], out["EMP_ROLE"] = "OSM", ""
    out["EMP_PROD"], out["EMP_DATE"], out["EMP_NC"] = "Contributeurs OpenStreetMap", "", ""
    return out[COLUMNS]


def _from_ref(ref, osm):
    """Emprises du Référentiel, avec les attributs OSM (type, nom, niveaux, height) du bâtiment OSM équivalent."""
    out = ref.reset_index(drop=True).copy()
    out["ID_BAT"] = "ref:" + out["REF_ID"]
    out["EMP_SRC"], out["EMP_ROLE"] = "REFBATI", ""
    out["OSM_ID"], out["TYPE"], out["NOM"], out["NIVEAUX"], out["H_OSM"] = "", "", "", np.nan, np.nan
    ia, ib, inter = _pairs(out, osm)
    if len(ia):
        m = pd.DataFrame({"i": ia, "j": ib, "a": inter})
        m = m[(m.a >= MATCH_MIN * out.geometry.area.to_numpy()[ia])
              & (m.a >= MATCH_MIN * osm.geometry.area.to_numpy()[ib])]
        m = m.sort_values("a").drop_duplicates("i", keep="last")
        for col in ("OSM_ID", "TYPE", "NOM", "NIVEAUX", "H_OSM"):
            out.loc[m.i.to_numpy(), col] = osm[col].to_numpy()[m.j.to_numpy()]
    return out[COLUMNS]


def _add(kept, cand, role):
    """Ajoute les candidats qui ne doublonnent pas une emprise gardée ; un chevauchement partiel est découpé."""
    cand = cand.reset_index(drop=True).copy()
    cand["EMP_ROLE"] = role
    if kept is None or not len(kept):
        return cand
    if not len(cand):
        return kept
    ia, ib, inter = _pairs(cand, kept)
    over = np.bincount(ia, weights=inter, minlength=len(cand))
    keep = over < DUP_OVERLAP * cand.geometry.area.to_numpy()
    geoms = cand.geometry.to_numpy().copy()
    hits = pd.DataFrame({"i": ia, "j": ib})[inter > 0]
    kept_geoms = kept.geometry.to_numpy()
    for i, js in hits.groupby("i").j:
        if keep[i]:
            cut = _polygonal(geoms[i].difference(unary_union(kept_geoms[js.to_numpy()])))
            if cut is None or cut.is_empty or cut.area < MIN_AREA_M2:
                keep[i] = False
            else:
                geoms[i] = cut
    cand = cand.set_geometry(gpd.GeoSeries(geoms, crs=cand.crs))
    return gpd.GeoDataFrame(pd.concat([kept, cand[keep]], ignore_index=True), geometry="geometry", crs=kept.crs)


def footprints(osm, ref, crs, mode="auto"):
    """Emprises retenues (projection métrique, déjà découpées à la zone) et bilan de la priorisation.

    auto : dans chaque maille de 500 m, OSM est la source principale si ses emprises couvrent au moins 85 % de la
    surface bâtie du Référentiel, sinon c'est le Référentiel. L'autre source ajoute ensuite les bâtiments qui
    manquent, sans doublon. osm / refbati : une seule source. osm ou ref à None : source indisponible.
    """
    empty = gpd.GeoDataFrame({c: [] for c in COLUMNS}, geometry="geometry", crs=crs)
    o = _from_osm(osm) if osm is not None else empty
    r = _from_ref(ref, o) if ref is not None else empty
    stats = {"mode": mode, "brutes": {"OSM": len(o), "REFBATI": len(r)}}
    if mode == "osm" or (mode == "auto" and not len(r)):
        kept = _add(None, o, "PRINCIPAL")
    elif mode == "refbati" or not len(o):
        kept = _add(None, r, "PRINCIPAL")
    else:
        ia, _, inter = _pairs(r, o)
        area = r.geometry.area.to_numpy()
        covered = np.minimum(np.bincount(ia, weights=inter, minlength=len(r)), area)
        cr, co = _cells(r), _cells(o)
        cov = pd.DataFrame({"c": cr, "a": area, "v": covered}).groupby("c")[["a", "v"]].sum()
        ref_cells = set(cov.index[cov.v < OSM_COVER_MIN * cov.a])
        in_r, in_o = cr.isin(ref_cells).to_numpy(), co.isin(ref_cells).to_numpy()
        kept = _add(None, o[~in_o], "PRINCIPAL")
        kept = _add(kept, r[in_r], "PRINCIPAL")
        kept = _add(kept, r[~in_r], "COMPLEMENT")
        kept = _add(kept, o[in_o], "COMPLEMENT")
        stats.update(mailles=len(set(cr) | set(co)), mailles_refbati=len(ref_cells),
                     couverture_osm=round(float(covered.sum() / area.sum()), 3))
    stats["retenues"] = {f"{s}_{role}": int(n) for (s, role), n in kept.groupby(["EMP_SRC", "EMP_ROLE"]).size().items()}
    return gpd.GeoDataFrame(kept[COLUMNS].reset_index(drop=True), geometry="geometry", crs=crs), stats


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
