"""Routes : AQréseau+ (Adresses Québec, MRNF) via le service ArcGIS REST."""
import geopandas as gpd
import numpy as np
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from .net import get_json_no_alpn

AQ_URL = "https://servicescarto.mrnf.gouv.qc.ca/pes/rest/services/Territoire/AQreseauPlus_WMS/MapServer"

# (couche à l'échelle la plus fine, classe, vitesse indicative km/h — à valider pour chaque projet)
ROAD_LAYERS = [
    (62, "Autoroute", 100),
    (65, "Bretelle autoroute", 70),
    (70, "Nationale", 90),
    (73, "Bretelle nationale", 50),
    (77, "Régionale", 90),
    (80, "Bretelle régionale", 50),
    (85, "Collectrice", 70),
    (88, "Bretelle collectrice", 50),
    (91, "Accès aux ressources", 70),
    (93, "Bretelle accès ressources", 50),
    (97, "Locale", 70),  # en milieu rural (rangs) ; 50 en milieu urbain
    (98, "Rue piétonne", 0),
    (101, "Autre route", 30),
]

# En milieu urbain, la vitesse par défaut est de 50 km/h (Code de la sécurité routière, art. 328) : une
# « Nationale » qui traverse une ville y est presque toujours à 50, pas à 90. Autoroutes et bretelles inchangées.
URBAN_SPEED = {"Nationale": 50, "Régionale": 50, "Collectrice": 50, "Accès aux ressources": 50, "Locale": 50}
URBAN_RADIUS_M = 250
URBAN_DENSITY_KM_KM2 = 8.0  # réseau routier autour du tronçon : quadrillage urbain ~15-25, campagne < 3

PAGE = 1000


def _query_layer(layer_id, bbox_ll):
    features, offset = [], 0
    while True:
        params = {
            "where": "1=1",
            "geometry": ",".join(f"{v:.6f}" for v in bbox_ll),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "*",
            "outSR": 4326,
            "returnGeometry": "true",
            "resultOffset": offset,
            "resultRecordCount": PAGE,
            "f": "geojson",
        }
        data = get_json_no_alpn(f"{AQ_URL}/{layer_id}/query", params)
        if "error" in data:
            raise RuntimeError(f"AQréseau+ couche {layer_id} : {data['error']}")
        batch = data.get("features", [])
        features += batch
        more = data.get("exceededTransferLimit") or data.get("properties", {}).get("exceededTransferLimit")
        if not batch or (not more and len(batch) < PAGE):
            return features
        offset += len(batch)


def fetch(zone_ll):
    """Tronçons routiers intersectant l'emprise de la zone (GeoDataFrame EPSG:4326)."""
    rows, seen = [], set()
    for layer_id, label, speed in ROAD_LAYERS:
        for f in _query_layer(layer_id, zone_ll.bounds):
            p = f.get("properties") or {}
            key = (p.get("OBJECTID"), p.get("NomRte"), p.get("SHAPE_Length"))
            if not f.get("geometry") or key in seen:
                continue
            seen.add(key)
            geom = shp_transform(lambda x, y, z=None: (x, y), shape(f["geometry"]))
            rows.append({
                "NOM": (p.get("NomRte") or "")[:100],
                "NO_RTE": p.get("NoRte") or 0,
                "CLASSE": label,
                "CLS_AQ": (p.get("ClsRte") or "")[:50],
                "CARACT": (p.get("CaractRte") or "")[:50],
                "GESTION": (p.get("Gestion") or "")[:50],
                "VIT_DEF": speed,
                "geometry": geom,
            })
    return gpd.GeoDataFrame(rows, columns=["NOM", "NO_RTE", "CLASSE", "CLS_AQ", "CARACT", "GESTION", "VIT_DEF",
                                           "geometry"], geometry="geometry", crs=4326)


def urban_speeds(gdf_proj, zone):
    """MILIEU (URBAIN | RURAL) d'après la densité du réseau dans un rayon de 250 m, et VIT_DEF en conséquence.

    La densité est rapportée à la partie du cercle située dans la zone, le réseau n'étant connu que là.
    """
    out = gdf_proj.copy()
    if not len(out):
        out["MILIEU"] = []
        return out
    sindex = out.sindex
    density = np.zeros(len(out))
    for i, g in enumerate(out.geometry):
        circle = g.interpolate(0.5, normalized=True).buffer(URBAN_RADIUS_M)
        area = circle.intersection(zone).area
        near = out.geometry.iloc[sindex.query(circle, predicate="intersects")]
        density[i] = near.intersection(circle).length.sum() / area * 1000 if area > 0 else 0.0
    urban = density >= URBAN_DENSITY_KM_KM2
    out["MILIEU"] = np.where(urban, "URBAIN", "RURAL")
    out["VIT_DEF"] = [URBAN_SPEED.get(c, v) if u else v for c, v, u in zip(out.CLASSE, out.VIT_DEF, urban)]
    return out


def clip(gdf_proj, zone):
    out = gdf_proj.copy()
    out["geometry"] = out.geometry.intersection(zone)
    out = out[~out.geometry.is_empty & out.geom_type.isin(["LineString", "MultiLineString"])]
    out = out.explode(index_parts=False)
    out = out[out.geometry.length > 0.5].reset_index(drop=True)
    out["LONG_M"] = out.geometry.length.round(1)
    return out
