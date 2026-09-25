"""Attributs routiers OpenStreetMap (vitesse affichée, voies, largeur, sens unique, revêtement) rattachés aux
tronçons AQréseau+, avec valeurs par défaut selon la classe quand OSM ne renseigne rien.

Source : © contributeurs OpenStreetMap (ODbL 1.0), via Overpass.
"""
import re

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import LineString, Point

from .buildings import _overpass

HIGHWAYS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road"

MATCH_BUFFER_M = 12.0   # demi-largeur du couloir autour du chemin OSM
MIN_OVERLAP = 0.6       # part du tronçon AQréseau+ dans le couloir
MIN_PARALLEL = 0.6      # longueur projetée sur le chemin OSM / longueur du tronçon
MPH = 1.609344
URBAN_KMH = 50          # Code de la sécurité routière : 50 km/h en agglomération sauf signalisation

LANE_WIDTH_M = {"Autoroute": 3.7, "Bretelle autoroute": 3.7}
LANE_WIDTH_DEFAULT = 3.5

SURFACES = {
    "asphalt": "ENROBE", "paved": "ENROBE",
    "concrete": "BETON", "concrete:plates": "BETON", "concrete:lanes": "BETON",
    "chipseal": "TRAIT_SURF",
    "paving_stones": "PAVES", "sett": "PAVES", "cobblestone": "PAVES", "unhewn_cobblestone": "PAVES",
    "unpaved": "NON_REVETU", "gravel": "NON_REVETU", "fine_gravel": "NON_REVETU", "compacted": "NON_REVETU",
    "dirt": "NON_REVETU", "ground": "NON_REVETU", "earth": "NON_REVETU", "sand": "NON_REVETU",
}

COLUMNS = ["OSM_RTE", "OSM_HWY", "MAXSPEED", "LANES", "WIDTH", "ONEWAY", "SURFACE"]


def _speed(value):
    """km/h depuis une valeur maxspeed OSM (« 50 », « 30 mph », « CA-QC:urban »), ou NaN."""
    if not value:
        return np.nan
    v = value.split(";")[0].strip().lower()
    if v.endswith(":urban"):
        return float(URBAN_KMH)
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(mph)?$", v)
    if not m:
        return np.nan
    kmh = float(m.group(1)) * (MPH if m.group(2) else 1.0)
    return float(round(kmh)) if 0 < kmh <= 150 else np.nan


def _int(value):
    m = re.match(r"^\s*(\d+)", value or "")
    n = int(m.group(1)) if m else 0
    return n if 0 < n <= 12 else 0


def _width(value):
    m = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$", value or "")
    w = float(m.group(1).replace(",", ".")) if m else np.nan
    return w if 1.5 <= w <= 60 else np.nan


def fetch(zone_ll):
    """Chemins routiers OSM de l'emprise de la zone (GeoDataFrame EPSG:4326)."""
    x0, y0, x1, y1 = zone_ll.buffer(0.0005).bounds
    query = (f'[out:json][timeout:180];way["highway"~"^({HIGHWAYS})(_link)?$"]'
             f"({y0:.6f},{x0:.6f},{y1:.6f},{x1:.6f});out tags geom;")
    rows, geoms = [], []
    for w in _overpass(query).get("elements", []):
        pts = [(p["lon"], p["lat"]) for p in w.get("geometry") or []]
        if len(pts) < 2:
            continue
        t = w.get("tags", {})
        speed = _speed(t.get("maxspeed"))
        if np.isnan(speed):  # vitesses différentes par sens : la plus élevée (cas le plus bruyant)
            directed = [_speed(t.get(k)) for k in ("maxspeed:forward", "maxspeed:backward")]
            directed = [s for s in directed if not np.isnan(s)]
            speed = max(directed) if directed else np.nan
        rows.append({
            "OSM_RTE": f"w{w['id']}",
            "OSM_HWY": t.get("highway", ""),
            "MAXSPEED": speed,
            "LANES": _int(t.get("lanes")),
            "WIDTH": _width(t.get("width")),
            "ONEWAY": t.get("oneway") in ("yes", "1", "-1") or t.get("junction") == "roundabout"
                      or t.get("highway") in ("motorway", "motorway_link"),
            "SURFACE": t.get("surface", ""),
        })
        geoms.append(LineString(pts))
    return gpd.GeoDataFrame(rows, columns=COLUMNS, geometry=geoms, crs=4326)


def fetch_empty():
    return gpd.GeoDataFrame(columns=COLUMNS, geometry=[], crs=4326)


def _match(geom, corridors, ways, candidates):
    """Chemin OSM (index) qui recouvre le mieux un tronçon parallèle, ou None."""
    length = geom.length
    best = None
    for j in candidates:
        covered = geom.intersection(corridors.iloc[j]).length
        if covered < MIN_OVERLAP * length:
            continue
        way = ways.geometry.iloc[j]
        start, end = geom.coords[0], geom.coords[-1]
        if abs(way.project(Point(end[:2])) - way.project(Point(start[:2]))) < MIN_PARALLEL * length:
            continue  # rue transversale ou viaduc
        if best is None or covered > best[1]:
            best = (j, covered)
    return best


def _street_speed(roads, speed):
    """Vitesse OSM dominante (en longueur) des tronçons de même nom et même classe, ou NaN.

    Comble les tronçons sans maxspeed d'une rue dont d'autres tronçons en ont un : plus fiable en ville
    que la vitesse indicative de la classe (une « Nationale » urbaine est souvent à 50 km/h, pas 90).
    """
    df = roads[["NOM", "CLASSE"]].assign(v=speed, l=roads.geometry.length)
    known = df[df.v.notna() & (df.NOM != "")]
    if not len(known):
        return np.full(len(roads), np.nan)
    by_len = known.groupby(["NOM", "CLASSE", "v"]).l.sum().reset_index()
    dominant = by_len.loc[by_len.groupby(["NOM", "CLASSE"]).l.idxmax()].set_index(["NOM", "CLASSE"]).v
    return df.join(dominant.rename("street"), on=["NOM", "CLASSE"]).street.to_numpy(dtype=float)


NEIGHBOUR_RADIUS_M = 500


def _neighbour_speed(roads, speed):
    """Vitesse OSM dominante (en longueur) des tronçons de même classe et même milieu à moins de 500 m, ou NaN.

    Reprend la politique locale (rues résidentielles à 30 ou 40 km/h selon la municipalité, rangs à 80) là où
    ni le tronçon ni sa rue n'ont de maxspeed.
    """
    out = np.full(len(roads), np.nan)
    known = np.flatnonzero(~np.isnan(speed))
    if not len(known):
        return out
    milieu = roads["MILIEU"].to_numpy() if "MILIEU" in roads else np.full(len(roads), "")
    classes = roads.CLASSE.to_numpy()
    ref = roads.iloc[known]
    sindex = ref.sindex
    lengths = ref.geometry.length.to_numpy()
    for i, g in enumerate(roads.geometry):
        if not np.isnan(speed[i]):
            continue
        near = sindex.query(g.buffer(NEIGHBOUR_RADIUS_M), predicate="intersects")
        near = near[(classes[known[near]] == classes[i]) & (milieu[known[near]] == milieu[i])]
        if len(near):
            s = pd.Series(lengths[near]).groupby(speed[known[near]]).sum()
            out[i] = s.idxmax()
    return out


def attach(roads, ways):
    """Ajoute aux tronçons (même CRS projeté) vitesse, voies, largeur, sens unique et revêtement.

    Sans maxspeed OSM sur le tronçon, sa rue ou son voisinage, la vitesse retenue est VIT_DEF (classe et milieu).
    """
    roads = roads.copy()
    n = len(roads)
    osm_id = np.full(n, "", dtype=object)
    hwy = np.full(n, "", dtype=object)
    speed = np.full(n, np.nan)
    lanes = np.zeros(n, dtype=int)
    width = np.full(n, np.nan)
    oneway = np.zeros(n, dtype=bool)
    surface = np.full(n, "", dtype=object)
    if n and len(ways):
        corridors = ways.geometry.buffer(MATCH_BUFFER_M, cap_style="flat")
        for i, geom in enumerate(roads.geometry):
            if geom.length < 1:
                continue
            m = _match(geom, corridors, ways, corridors.sindex.query(geom, predicate="intersects"))
            if m is None:
                continue
            w = ways.iloc[m[0]]
            osm_id[i], hwy[i], speed[i], lanes[i] = w.OSM_RTE, w.OSM_HWY, w.MAXSPEED, w.LANES
            width[i], oneway[i], surface[i] = w.WIDTH, w.ONEWAY, w.SURFACE

    classes = roads.CLASSE.to_numpy()
    has_speed = ~np.isnan(speed)
    street = _street_speed(roads, speed)
    has_street = ~has_speed & ~np.isnan(street)
    near = _neighbour_speed(roads, speed)
    has_near = ~has_speed & ~has_street & ~np.isnan(near)
    roads["VITESSE"] = np.select([has_speed, has_street, has_near], [speed, street, near],
                                 roads.VIT_DEF.to_numpy(dtype=float))
    roads["VITESSE"] = roads["VITESSE"].astype(int)
    roads["VIT_SRC"] = np.select([has_speed, has_street, has_near], ["OSM", "OSM_RUE", "OSM_VOIS"], "DEFAUT")

    # Sans lanes OSM : 2 voies (1 par sens, ou 2 par chaussée d'autoroute), 1 voie pour un sens unique.
    default_lanes = np.where(oneway & (classes != "Autoroute"), 1, 2)
    roads["VOIES"] = np.where(lanes > 0, lanes, default_lanes)
    roads["VOIES_SRC"] = np.where(lanes > 0, "OSM", "DEFAUT")

    lane_w = np.array([LANE_WIDTH_M.get(c, LANE_WIDTH_DEFAULT) for c in classes])
    has_width = ~np.isnan(width)
    roads["LARG_M"] = np.round(np.where(has_width, width, roads["VOIES"].to_numpy() * lane_w), 1)
    roads["LARG_SRC"] = np.where(has_width, "OSM", "VOIES")

    roads["SENS_UNIQ"] = oneway.astype(int)
    roads["REVET"] = [SURFACES.get(s, "INCONNU" if not s else "AUTRE") for s in surface]
    roads["REVET_OSM"] = [s[:30] for s in surface]
    roads["OSM_RTE"] = osm_id
    roads["OSM_HWY"] = hwy
    return roads
