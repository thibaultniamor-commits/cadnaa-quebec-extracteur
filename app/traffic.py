"""Débits de circulation du MTMD (DJMA, DJME, DJMH, % camions, 30e heure) rattachés aux routes.

Source : « Débit de circulation », ministère des Transports et de la Mobilité durable (CC-BY 4.0),
service WFS ms:circulation_routier. Les débits sont des totaux deux sens, estimés par section de trafic
sur le réseau sous gestion du MTMD (autoroutes, nationales, régionales et quelques collectrices).
"""
import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import linemerge, substring

from .net import session

WFS_URL = "https://ws.mapserver.transports.gouv.qc.ca/swtq"
LAYER = "ms:circulation_routier"
YEARS = 10

MATCH_BUFFER_M = 20.0     # demi-largeur du couloir autour de la section
SECOND_BUFFER_M = 150.0   # 2e passe : chaussée éloignée portant le même nom de route
SPLIT_TOL_M = 5.0         # pas de coupe à moins de 5 m d'une extrémité
MIN_OVERLAP = 0.7         # part du tronçon dans le couloir
MIN_PARALLEL = 0.7        # longueur projetée sur la section / longueur du tronçon
DIVIDED_RATIO = 1.6       # longueur rattachée / longueur de section au-delà de laquelle on suppose 2 chaussées
EXCLUDED_CLASSES = ("Rue piétonne",)
EXCLUDED_CARACT = ("Voie de desserte", "Bretelle")


def _float(v):
    try:
        v = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return np.nan
    return v if np.isfinite(v) else np.nan


def _latest(props, key):
    """(valeur, année) la plus récente non vide pour val_<key>_annee_N (N = 1 le plus récent)."""
    for n in range(1, YEARS + 1):
        v = _float(props.get(f"val_{key}_annee_{n}"))
        if np.isfinite(v):
            return v, int(_float(props.get(f"{key}_annee_{n}")) or 0)
    return np.nan, 0


def fetch(zone_ll):
    """Sections de trafic MTMD intersectant l'emprise de la zone (GeoDataFrame EPSG:4326)."""
    x0, y0, x1, y1 = zone_ll.bounds
    params = {
        "service": "wfs", "version": "2.0.0", "request": "getfeature", "typename": LAYER,
        "srsname": "EPSG:4326", "outputformat": "geojson",
        "bbox": f"{y0:.6f},{x0:.6f},{y1:.6f},{x1:.6f},urn:ogc:def:crs:EPSG::4326",
    }
    r = session().get(WFS_URL, params=params, timeout=120)
    r.raise_for_status()
    rows, geoms = [], []
    for f in r.json().get("features", []):
        p = f.get("properties") or {}
        g = f.get("geometry")
        if not g:
            continue
        djma, year = _latest(p, "djma")
        djme = _float(p.get(f"val_djme_annee_{_year_index(p, 'djme', year)}"))
        djmh = _float(p.get(f"val_djmh_annee_{_year_index(p, 'djmh', year)}"))
        cam, cam_year = _latest(p, "cam")
        rows.append({
            "SECT_MTMD": p.get("num_sectn_trafc") or "",
            "DEBUT": (p.get("des_debut_sous_route") or "")[:100],
            "FIN": (p.get("des_fin_sous_route") or "")[:100],
            "DJMA": djma, "DJME": djme, "DJMH": djmh, "AN_DJMA": year,
            "PCT_CAM": cam, "AN_CAM": cam_year,
            "H30": _float(p.get("val_30e_heure")),
        })
        geoms.append(_line(g))
    gdf = gpd.GeoDataFrame(rows, geometry=geoms, crs=4326)
    return gdf[~gdf.geometry.is_empty & gdf.DJMA.notna()].reset_index(drop=True) if len(gdf) else gdf


def _year_index(props, key, year):
    for n in range(1, YEARS + 1):
        if int(_float(props.get(f"{key}_annee_{n}")) or 0) == year:
            return n
    return 0


def _line(geojson):
    coords = geojson["coordinates"]
    if geojson["type"] == "LineString":
        return LineString([c[:2] for c in coords])
    merged = linemerge(MultiLineString([[c[:2] for c in part] for part in coords]))
    return merged


def _split_at_sections(roads, sections, eligible):
    """Coupe les tronçons aux limites des sections pour qu'un morceau ne relève que d'une section."""
    ends = [pt for g in sections.geometry for pt in getattr(g.boundary, "geoms", [])]
    if not ends:
        return roads
    ends_gs = gpd.GeoSeries(ends, crs=sections.crs)
    eidx = ends_gs.sindex
    rows = []
    for i, row in roads.iterrows():
        geom = row.geometry
        cuts = []
        if eligible[i]:
            for k in eidx.query(geom.buffer(MATCH_BUFFER_M), predicate="intersects"):
                d = geom.project(ends_gs.iloc[k])
                if SPLIT_TOL_M < d < geom.length - SPLIT_TOL_M:
                    cuts.append(d)
        if not cuts:
            rows.append(row)
            continue
        bounds = [0.0] + sorted(set(round(c, 1) for c in cuts)) + [geom.length]
        for a, b in zip(bounds[:-1], bounds[1:]):
            if b - a > 0.5:
                piece = row.copy()
                piece["geometry"] = substring(geom, a, b)
                rows.append(piece)
    out = gpd.GeoDataFrame(rows, geometry="geometry", crs=roads.crs).reset_index(drop=True)
    if "LONG_M" in out:
        out["LONG_M"] = out.geometry.length.round(1)
    return out


def _match(geom, corridors, sections, candidates):
    """Meilleure section (index, longueur recouverte) pour un tronçon, ou None."""
    length = geom.length
    best = None
    for j in candidates:
        covered = geom.intersection(corridors.iloc[j]).length
        if covered < MIN_OVERLAP * length:
            continue
        sec = sections.geometry.iloc[j]
        start, end = geom.coords[0], geom.coords[-1]
        projected = abs(sec.project(Point(end[:2])) - sec.project(Point(start[:2])))
        if projected < MIN_PARALLEL * length:
            continue  # tronçon qui croise la section (viaduc, rue transversale)
        if best is None or covered > best[1]:
            best = (j, covered)
    return best


def attach(roads, sections, zone):
    """Ajoute DJMA… aux tronçons (mêmes CRS projetés). Retourne (routes enrichies, sections découpées)."""
    roads = roads.copy()
    for col in ("DJMA", "DJME", "DJMH", "PCT_CAM", "H30", "DJMA_CH", "RECOUVR"):
        roads[col] = np.nan
    roads["AN_DJMA"] = 0
    roads["NB_CHAUS"] = 0
    roads["SECT_MTMD"] = ""
    roads["DJMA_SRC"] = ""
    if not len(sections) or not len(roads):
        return roads, sections

    def eligible_mask(df):
        return (~df.CLASSE.isin(EXCLUDED_CLASSES) & ~df.CARACT.fillna("").isin(EXCLUDED_CARACT)).to_numpy()

    roads = _split_at_sections(roads, sections, eligible_mask(roads))
    eligible = eligible_mask(roads)

    # 1re passe : couloir étroit autour de la section.
    near = sections.geometry.buffer(MATCH_BUFFER_M, cap_style="flat")
    best = {}
    for i in np.flatnonzero(eligible):
        geom = roads.geometry.iloc[i]
        if geom.length >= 1:
            m = _match(geom, near, sections, near.sindex.query(geom, predicate="intersects"))
            if m:
                best[i] = m

    # 2e passe : chaussée éloignée (terre-plein large) portant le même nom qu'un tronçon déjà rattaché.
    names = {}
    for i, (j, _) in best.items():
        if roads.NOM.iloc[i]:
            names.setdefault(j, set()).add(roads.NOM.iloc[i])
    far = sections.geometry.buffer(SECOND_BUFFER_M, cap_style="flat")
    for i in np.flatnonzero(eligible):
        if i in best or not roads.NOM.iloc[i]:
            continue
        geom = roads.geometry.iloc[i]
        cands = [j for j in far.sindex.query(geom, predicate="intersects") if roads.NOM.iloc[i] in names.get(j, ())]
        m = _match(geom, far, sections, cands) if geom.length >= 1 else None
        if m:
            best[i] = m

    # Cohérence : une section ne porte qu'une classe de route (la dominante en longueur). Écarte les rues
    # parallèles à une autoroute qui tombent dans le couloir.
    by_class = {}
    for i, (j, _) in best.items():
        key = (j, roads.CLASSE.iloc[i])
        by_class[key] = by_class.get(key, 0.0) + roads.geometry.iloc[i].length
    dominant = {}
    for (j, cls), length in by_class.items():
        if length > dominant.get(j, ("", 0.0))[1]:
            dominant[j] = (cls, length)
    best = {i: m for i, m in best.items() if roads.CLASSE.iloc[i] == dominant[m[0]][0]}

    # Chaussées séparées : longueur rattachée ~ 2 x longueur de la section (dans la zone).
    matched_len = {}
    for i, (j, covered) in best.items():
        matched_len[j] = matched_len.get(j, 0.0) + roads.geometry.iloc[i].length
    zone_buf = zone.buffer(MATCH_BUFFER_M)
    divided = {j: matched_len[j] / max(sections.geometry.iloc[j].intersection(zone_buf).length, 1.0) > DIVIDED_RATIO
               for j in matched_len}

    cols = {c: roads.columns.get_loc(c) for c in roads.columns}
    for i, (j, covered) in best.items():
        s = sections.iloc[j]
        n = 2 if divided[j] else 1
        for c, v in (("DJMA", s.DJMA), ("DJME", s.DJME), ("DJMH", s.DJMH), ("PCT_CAM", s.PCT_CAM), ("H30", s.H30),
                     ("AN_DJMA", s.AN_DJMA), ("NB_CHAUS", n), ("DJMA_CH", round(s.DJMA / n)),
                     ("SECT_MTMD", s.SECT_MTMD), ("DJMA_SRC", "MTMD"),
                     ("RECOUVR", round(100 * covered / roads.geometry.iloc[i].length))):
            roads.iat[i, cols[c]] = v

    clipped = sections.copy()
    clipped["geometry"] = clipped.geometry.intersection(zone)
    clipped = clipped[~clipped.geometry.is_empty].explode(index_parts=False).reset_index(drop=True)
    clipped = clipped[clipped.geom_type == "LineString"]
    return roads, clipped
