"""Chaîne d'extraction : zone dessinée -> ZIP de shapefiles prêts pour CadnaA."""
import datetime as dt
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from . import buildings, crs, osmroads, preview, projets, roads, topo, traffic

MAX_AREA_KM2 = 100.0
ENCODING = "cp1252"  # encodage Windows lu par CadnaA (accents français)

LAYERS = ("topo", "batiments", "routes")

# Périodes d'évaluation (Lden) : jour 7 h-19 h, soir 19 h-23 h, nuit 23 h-7 h.
PERIODS = (("J", "jour", 12), ("S", "soir", 4), ("N", "nuit", 8))


@dataclass
class Options:
    geometry: dict
    layers: list = field(default_factory=lambda: list(LAYERS))
    contour_interval: float = 1.0
    dem_resolution: float | None = None  # None = automatique selon la surface
    smoothing_m: float = 3.0
    default_height: float = 6.0
    crs: str = "auto"
    dem_grid: bool = False
    traffic: bool = True  # débits MTMD rattachés aux routes
    dem_source: str = "foretouverte"  # foretouverte (MRNF, CGVD28) | hrdem (RNCan, CGVD2013)
    footprint_source: str = "auto"  # auto (priorité par maille) | osm | refbati
    road_attrs: bool = True  # vitesse, voies, largeur, revêtement OSM rattachés aux routes
    profile: tuple = (75.0, 15.0, 10.0)  # % du DJMA en jour / soir / nuit


TERRAIN_MARGIN_M = 100  # MNT lu au-delà de la zone : terrain sous les bâtiments qui débordent de la limite
TERRAIN_PAD_M = 20      # le terrain exporté dépasse la zone d'au moins cette distance, et chaque bâtiment de 10 m


def terrain_zone(zone, buildings=None):
    """Emprise du terrain exporté : zone + marge + bâtiments gardés (à cheval sur la limite), sans trous.

    CadnaA fait retomber le terrain à 0 au-delà des dernières courbes : tout objet doit être posé à l'intérieur.
    """
    parts = [zone.buffer(TERRAIN_PAD_M, join_style="mitre")]
    if buildings is not None and len(buildings):
        parts.append(buildings.geometry.buffer(10, join_style="mitre").union_all())
    area = shapely.union_all(parts).intersection(zone.buffer(TERRAIN_MARGIN_M))
    polys = [shapely.Polygon(p.exterior) for p in getattr(area, "geoms", [area]) if p.geom_type == "Polygon"]
    return max(polys, key=lambda p: p.area).simplify(1.0) if polys else zone


def auto_resolution(area_km2):
    if area_km2 <= 4:
        return 1.0
    if area_km2 <= 25:
        return 2.0
    return 5.0


def _write(gdf, path, epsg):
    gdf = gdf.set_crs(epsg, allow_override=True)
    gdf.to_file(path, driver="ESRI Shapefile", encoding=ENCODING, engine="pyogrio")


@dataclass
class Extraction:
    """Données extraites, gardées en mémoire entre l'aperçu 3D et l'écriture du ZIP."""
    opts: Options
    epsg: int
    zone: object
    summary: dict
    preview_path: Path
    dtm: object = None
    grid: object = None
    contours: gpd.GeoDataFrame | None = None
    edges: gpd.GeoDataFrame | None = None       # bord de la zone en 3D, altitude du terrain à chaque sommet
    buildings: gpd.GeoDataFrame | None = None
    roads: gpd.GeoDataFrame | None = None
    sections: gpd.GeoDataFrame | None = None
    dem_info: topo.DemInfo | None = None
    terrain: tuple | None = None                # (z, grid) de l'aperçu 3D, repère des volumes
    projets: gpd.GeoDataFrame | None = None     # bâtiments projetés saisis sur un plan calé
    projets_items: list = field(default_factory=list)
    demolis: set = field(default_factory=set)   # ID_BAT des bâtiments existants démolis
    projets_mode: str = "separe"                # separe : batiments_projetes.shp ; fusion : dans batiments.shp


def extract(opts: Options, out_dir: Path, progress=lambda msg: None) -> Extraction:
    """Télécharge et calcule toutes les couches, puis écrit les données de l'aperçu 3D."""
    t0 = time.time()
    zone_ll = shape(opts.geometry)
    if zone_ll.geom_type != "Polygon" or not zone_ll.is_valid:
        raise ValueError("La zone doit être un polygone valide.")
    c = zone_ll.centroid
    if not crs.in_quebec(c.x, c.y):
        raise ValueError("La zone doit être située au Québec.")
    epsg = crs.resolve(opts.crs, c.x)
    to_proj = Transformer.from_crs(4326, epsg, always_xy=True).transform
    zone = shp_transform(to_proj, zone_ll)
    area_km2 = zone.area / 1e6
    if area_km2 > MAX_AREA_KM2:
        raise ValueError(f"Zone trop grande ({area_km2:.1f} km², maximum {MAX_AREA_KM2:.0f} km²).")
    progress(f"Zone : {area_km2:.2f} km² — projection {crs.name(epsg)} (EPSG:{epsg})")

    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    bbox_ll = zone_ll.buffer(0.002).bounds  # ~150 m : couvre TERRAIN_MARGIN_M
    summary = {"zone_km2": round(area_km2, 3), "epsg": epsg, "crs": crs.name(epsg), "alt_ref": "CGVD2013"}
    ex = Extraction(opts, epsg, zone, summary, out_dir / f"cadnaa_qc_{stamp}_apercu.json")

    if "topo" in opts.layers:
        res = opts.dem_resolution or auto_resolution(area_km2)
        pad = TERRAIN_MARGIN_M + 3 * res + opts.smoothing_m * 3
        grid = topo.Grid.covering(zone.buffer(pad).bounds, res, f"EPSG:{epsg}")
        progress(f"Topographie : lecture du MNT à {res:g} m ({grid.width}×{grid.height} px)…")
        dtm, info = topo.build_dtm(bbox_ll, grid, opts.dem_source, progress)
        ex.dem_info = info
        progress(f"Topographie : {_dem_sources(info)}, altitudes {info.datum}.")
        ex.dtm, ex.grid = dtm, grid
        summary["alt_ref"] = info.datum
        summary.update(mnt_resolution_m=res, couverture_lidar=round(info.lidar, 3),
                       mnt_sources={k: round(v, 3) for k, v in info.parts.items() if v},
                       mnt_feuillets=info.feuillets, mnt_annees=info.annees, ecart_cgvd_m=info.offset,
                       equidistance_m=opts.contour_interval)

    if "batiments" in opts.layers:
        b, fp = _footprints(zone_ll, zone, epsg, opts.footprint_source, progress)
        summary["emprises"] = fp
        progress(f"Bâtiments : {len(b)} emprises. Calcul des hauteurs LiDAR…")
        h = ground = None
        if len(b):
            hres = 1.0 if area_km2 <= 30 else 2.0
            hgrid = topo.Grid.covering(b.total_bounds, hres, f"EPSG:{epsg}")
            b_dtm, b_dsm = topo.lidar_surfaces(bbox_ll, hgrid, want_dsm=True)
            h, ground = buildings.lidar_heights(b, hgrid, b_dtm, b_dsm)
            if ex.dem_info is not None and ex.dem_info.datum == "CGVD28" and ex.dem_info.offset is not None:
                ground = ground + ex.dem_info.offset  # sol HRDEM ramené dans la référence du MNT
        else:
            h = ground = []
        ex.buildings = b = buildings.assign_heights(b, h, ground, opts.default_height)
        counts = b["H_SRC"].value_counts().to_dict() if len(b) else {}
        summary.update(batiments=len(b), hauteurs=counts)
        progress(f"Bâtiments : {len(b)} — sources des hauteurs {counts}")

    if ex.dtm is not None:
        progress("Topographie : calcul des courbes de niveau…")
        tz = terrain_zone(zone, ex.buildings)
        lines = topo.contours(ex.dtm, ex.grid, opts.contour_interval, tz, opts.smoothing_m)
        ex.contours = gpd.GeoDataFrame({"ALTITUDE": [z for z, _ in lines]}, geometry=[g for _, g in lines])
        edges = topo.edge_lines(ex.dtm, ex.grid, tz, opts.smoothing_m)
        ex.edges = gpd.GeoDataFrame({"TYPE": ["BORD_TERRAIN"] * len(edges)}, geometry=edges)
        summary.update(courbes=len(ex.contours), marge_terrain_m=round(tz.hausdorff_distance(zone), 1))
        progress(f"Topographie : {len(ex.contours)} courbes de niveau.")

    if "routes" in opts.layers:
        progress("Routes : interrogation AQréseau+" + (" et OpenStreetMap…" if opts.road_attrs else "…"))
        pool = ThreadPoolExecutor(1)
        osm_ways = pool.submit(osmroads.fetch, zone_ll) if opts.road_attrs else None
        pool.shutdown(wait=False)
        r = roads.clip(roads.fetch(zone_ll).to_crs(epsg), zone)
        summary.update(routes=len(r), routes_km=round(float(r.geometry.length.sum()) / 1000, 2))
        progress(f"Routes : {len(r)} tronçons ({summary['routes_km']} km).")
        if opts.traffic:
            progress("Débits : sections de trafic MTMD…")
            sections = traffic.fetch(zone_ll).to_crs(epsg)
            r, sections = traffic.attach(r, sections, zone)
            ex.sections = sections
            with_djma = r.DJMA_SRC == "MTMD"
            summary.update(sections_mtmd=len(sections), routes_djma=int(with_djma.sum()),
                           routes_djma_km=round(float(r.geometry[with_djma].length.sum()) / 1000, 2))
            progress(f"Débits : {len(sections)} sections MTMD, DJMA rattaché à {summary['routes_djma']} tronçons "
                     f"({summary['routes_djma_km']} km).")
            r = _hourly_flows(r, opts.profile)
            summary["profil"] = dict(zip((name for _, name, _ in PERIODS), opts.profile))
        if opts.road_attrs:
            r = _road_attrs(r, osm_ways, epsg, summary, progress)
        ex.roads = r

    progress("Aperçu 3D : préparation…")
    ex.terrain = preview.terrain(ex.dtm, ex.grid, zone, bbox_ll, epsg)
    data = preview.build(zone, ex.terrain, buildings=ex.buildings, roads=ex.roads, contours=ex.contours,
                         stats=summary)
    preview.write(ex.preview_path, data)
    summary["duree_s"] = round(time.time() - t0, 1)
    progress(f"Extraction terminée en {summary['duree_s']} s.")
    return ex


def _road_attrs(r, osm_ways, epsg, summary, progress):
    """Vitesse, voies, largeur, sens unique et revêtement OSM ; valeurs par défaut si OSM est indisponible."""
    progress("Routes : rattachement des vitesses affichées, voies et revêtements OpenStreetMap…")
    try:
        ways = osm_ways.result().to_crs(epsg)
    except Exception as e:  # noqa: BLE001 - les valeurs par défaut restent utilisables
        progress(f"Routes : OpenStreetMap indisponible ({type(e).__name__}) ; vitesses et voies par défaut.")
        ways = osmroads.fetch_empty().to_crs(epsg)
        summary["routes_osm_indisponible"] = True
    r = osmroads.attach(r, ways)
    km = r.geometry.length / 1000
    share = (lambda mask: round(float(km[mask].sum() / km.sum()), 3) if km.sum() else 0.0)
    summary.update(routes_vit_osm=share(r.VIT_SRC != "DEFAUT"), routes_voies_osm=share(r.VOIES_SRC == "OSM"),
                   routes_revet_osm=share(r.REVET != "INCONNU"))
    progress(f"Routes : vitesse OSM sur {summary['routes_vit_osm']:.0%} du linéaire (rue comprise), voies sur "
             f"{summary['routes_voies_osm']:.0%}, revêtement sur {summary['routes_revet_osm']:.0%} ; "
             "le reste prend les valeurs par défaut de la classe.")
    return r


def _hourly_flows(r, profile):
    """Débits horaires moyens par période (véh/h, par chaussée) : DJMA_CH x part de la période / durée."""
    r = r.copy()
    for (code, _, hours), pct in zip(PERIODS, profile):
        r[f"Q_{code}"] = (r.DJMA_CH * pct / 100 / hours).round(0)
    return r


FOOTPRINT_NAMES = {"OSM": "OpenStreetMap", "REFBATI": "Référentiel québécois sur les bâtiments"}


def _footprints(zone_ll, zone, epsg, mode, progress):
    """Télécharge les emprises OSM et Référentiel en parallèle, puis applique la priorité par maille."""
    wanted = {"OSM": buildings.fetch_osm, "REFBATI": buildings.fetch_refbati}
    if mode != "auto":
        wanted = {k: f for k, f in wanted.items() if k.lower() == mode}
    progress("Bâtiments : téléchargement des emprises " + " et ".join(FOOTPRINT_NAMES[k] for k in wanted) + "…")
    got, failed = {}, {}
    with ThreadPoolExecutor(len(wanted)) as pool:
        futures = {k: pool.submit(f, zone_ll) for k, f in wanted.items()}
        for k, fut in futures.items():
            try:
                got[k] = buildings.clean(fut.result().to_crs(epsg), zone)
            except Exception as e:  # noqa: BLE001 - en mode auto, l'autre source prend le relais
                failed[k] = f"{type(e).__name__} : {e}"[:300]
    if not got:
        raise RuntimeError("Emprises de bâtiments indisponibles : " + " ; ".join(f"{FOOTPRINT_NAMES[k]} ({v})"
                                                                              for k, v in failed.items()))
    for k, err in failed.items():
        progress(f"Bâtiments : {FOOTPRINT_NAMES[k]} indisponible ({err}) ; emprises de l'autre source seulement.")
    ref = got.get("REFBATI")
    b, fp = buildings.footprints(got.get("OSM"), ref, epsg, mode)
    fp["indisponibles"] = sorted(failed)
    kept_ref = b[b.EMP_SRC == "REFBATI"]
    if ref is not None and len(ref):
        fp["refbati_version"] = ref.VERSION.mode()[0]
    if len(kept_ref):
        fp["refbati_producteurs"] = kept_ref.EMP_PROD.value_counts().to_dict()
        years = sorted({d[:4] for d in kept_ref.EMP_DATE if d})
        fp["refbati_annees"] = [years[0], years[-1]] if years else []
    progress("Bâtiments : " + _footprint_text(fp))
    return b, fp


def _footprint_text(fp):
    n = fp["retenues"]
    get = lambda k: n.get(k, 0)  # noqa: E731
    head = (f"{get('OSM_PRINCIPAL') + get('OSM_COMPLEMENT')} emprises OSM, "
            f"{get('REFBATI_PRINCIPAL') + get('REFBATI_COMPLEMENT')} du Référentiel")
    if "mailles" in fp:
        m, mr = fp["mailles"], fp["mailles_refbati"]
        return (f"{head}. Source principale par maille de 500 m : OSM sur {m - mr}, Référentiel sur {mr} "
                f"(OSM couvre {fp['couverture_osm']:.0%} du bâti du Référentiel) ; "
                f"{get('OSM_COMPLEMENT') + get('REFBATI_COMPLEMENT')} bâtiments ajoutés en complément.")
    return f"{head} (source unique)."


def set_projets(ex: Extraction, items: list, demolis: list, mode: str) -> dict:
    """Enregistre les bâtiments projetés et démolis ; renvoie l'altitude du sol et les recouvrements."""
    z, grid = (ex.dtm, ex.grid) if ex.dtm is not None else ex.terrain
    p = projets.build(items, ex.epsg, z, grid)
    known = set(ex.buildings.ID_BAT) if ex.buildings is not None else set()
    ex.projets, ex.demolis, ex.projets_mode = p, set(demolis) & known, mode
    ex.projets_items = preview.building_items(p, preview.Frame(ex.terrain)) if len(p) else []
    return {
        "alt_sol": {pid: (None if pd.isna(a) else a) for pid, a in zip(p.PROJ_ID, p.ALT_SOL)},
        "surface": {pid: round(a, 1) for pid, a in zip(p.PROJ_ID, p.geometry.area)},
        "recouverts": projets.covered(ex.buildings, p),
        "hors_zone": [pid for pid, g in zip(p.PROJ_ID, p.geometry) if not g.intersects(ex.zone)],
        "demolis": sorted(ex.demolis),
    }


def _buildings_out(ex: Extraction):
    """(batiments.shp, batiments_projetes.shp) selon le mode de sortie ; STATUT = EXISTANT | DEMOLI | PROJETE."""
    b = ex.buildings
    if b is not None:
        b = b.copy()
        b["STATUT"] = ["DEMOLI" if o in ex.demolis else "EXISTANT" for o in b.ID_BAT]
    p = ex.projets.drop(columns="PROJ_ID") if ex.projets is not None and len(ex.projets) else None
    if p is None or ex.projets_mode == "separe":
        return b, p
    if b is None:
        return p, None
    b["PLAN"] = ""
    merged = pd.concat([b, p.to_crs(b.crs)], ignore_index=True)
    return gpd.GeoDataFrame(merged, geometry="geometry", crs=b.crs), None


def _buildings_3d(ex: Extraction, b):
    """PolygonZ dont chaque sommet porte l'altitude du toit (ALT_SOL + HAUTEUR).

    CadnaA lit la coordonnée Z d'un bâtiment comme une hauteur absolue : un polygone 2D (Z = 0)
    enfouit le bâtiment sous le terrain. ALT_SOL manquant (hors LiDAR) : terrain médian sous l'emprise.
    """
    b = b.copy()
    missing = b.ALT_SOL.isna().to_numpy()
    if missing.any():
        z, grid = (ex.dtm, ex.grid) if ex.dtm is not None else (ex.terrain or (None, None))
        b.loc[missing, "ALT_SOL"] = [round(projets.ground_level(g, z, grid), 2) for g in b.geometry[missing]]
    b["ALT_TOIT"] = np.round(b.ALT_SOL + b.HAUTEUR, 2)
    roof = b.ALT_TOIT.fillna(b.HAUTEUR).to_numpy(dtype=float)  # sans terrain connu : Z = hauteur relative
    b["geometry"] = shapely.force_3d(shapely.force_2d(b.geometry.to_numpy()), roof)
    return b


def _draped(ex: Extraction, gdf, step=10.0):
    """Lignes et polygones posés sur le terrain : Z de chaque sommet = altitude du sol (sommets tous les `step` m).

    Un shapefile 2D arrive dans CadnaA avec Z = 0, lu comme une altitude absolue.
    """
    z, grid = (ex.dtm, ex.grid) if ex.dtm is not None else (ex.terrain or (None, None))
    if z is None or not np.isfinite(z).any():
        return gdf
    sample = preview.Sampler(z, grid)
    geoms = shapely.segmentize(shapely.force_2d(gdf.geometry.to_numpy()), step)
    gdf = gdf.copy()
    xy = shapely.get_coordinates(geoms)
    zs = np.round(sample(xy[:, 0], xy[:, 1]), 2)
    gdf["geometry"] = shapely.set_coordinates(shapely.force_3d(geoms), np.column_stack([xy, zs]))
    return gdf


def package(ex: Extraction, out_dir: Path) -> Path:
    """Écrit les shapefiles de l'extraction et les regroupe dans un ZIP."""
    folder = out_dir / ex.preview_path.name.removesuffix("_apercu.json")
    folder.mkdir(parents=True, exist_ok=True)
    epsg, s = ex.epsg, ex.summary
    zone = gpd.GeoDataFrame({"NOM": ["Zone d'étude"], "SURF_KM2": [s["zone_km2"]]}, geometry=[ex.zone])
    _write(_draped(ex, zone), folder / "zone_etude.shp", epsg)
    if ex.contours is not None:
        _write(ex.contours, folder / "courbes_niveau.shp", epsg)
        if ex.edges is not None and len(ex.edges):
            _write(ex.edges, folder / "bord_terrain.shp", epsg)
        if ex.opts.dem_grid:
            topo.write_ascii_grid(folder / "mnt.asc", ex.dtm, ex.grid)
    existing, projected = _buildings_out(ex)
    if existing is not None:
        _write(_buildings_3d(ex, existing), folder / "batiments.shp", epsg)
    if projected is not None:
        _write(_buildings_3d(ex, projected), folder / "batiments_projetes.shp", epsg)
    if ex.sections is not None and len(ex.sections):
        _write(ex.sections, folder / "sections_trafic_mtmd.shp", epsg)
    if ex.roads is not None:
        _write(_draped(ex, ex.roads), folder / "routes.shp", epsg)
    (folder / "LISEZMOI.txt").write_text(_readme(ex.opts, s, ex), encoding="utf-8")
    zip_path = Path(shutil.make_archive(str(folder), "zip", folder))
    shutil.rmtree(folder, ignore_errors=True)
    return zip_path


def run(opts: Options, out_dir: Path, progress=lambda msg: None) -> tuple[Path, dict]:
    """Extraction complète jusqu'au ZIP (ligne de commande)."""
    ex = extract(opts, out_dir, progress)
    return package(ex, out_dir), ex.summary


def _readme(opts, s, ex=None):
    lines = [
        "Extraction CadnaA - Québec",
        f"Généré le {dt.datetime.now():%Y-%m-%d %H:%M}",
        f"Système de coordonnées : {s['crs']} (EPSG:{s['epsg']}) - unités en mètres",
        f"Surface de la zone : {s['zone_km2']} km²",
        "",
        "FICHIERS",
        "  zone_etude.shp      Polygone de la zone sélectionnée (3D : Z = altitude du terrain)",
    ]
    if "courbes" in s:
        lines += [
            f"  courbes_niveau.shp  {s['courbes']} courbes de niveau 3D (PolylineZ), équidistance {s['equidistance_m']} m",
            f"                      ALTITUDE : altitude (m, {s['alt_ref']}). La coordonnée Z porte aussi l'altitude.",
            f"                      MNT {s['mnt_resolution_m']} m : {_dem_sources(ex.dem_info)}"
            if ex is not None and ex.dem_info is not None else
            f"                      MNT {s['mnt_resolution_m']} m, couverture LiDAR {s['couverture_lidar']:.0%}",
            *_readme_dem(ex),
        ]
        lines += [
            "                      Courbes et bord tracés sur la zone élargie d'au moins 20 m, et jusqu'à 10 m au-delà de",
            f"                      tout bâtiment à cheval sur la limite (marge maximale {s.get('marge_terrain_m')} m) :",
            "                      aucun bâtiment ne repose sur le terrain retombé à 0 hors du modèle.",
            "  bord_terrain.shp    Limite du terrain en 3D (PolylineZ) : chaque sommet porte l'altitude du terrain",
            "                      (tous les 5 m environ). Ferme le modèle de terrain le long des bords.",
        ]
        if opts.dem_grid:
            lines.append("  mnt.asc             MNT en grille ESRI ASCII (même projection)")
    if "batiments" in s:
        lines += [
            f"  batiments.shp       {s['batiments']} bâtiments (polygones)",
            *_readme_footprints(s.get("emprises")),
            "                      HAUTEUR : hauteur retenue (m, relative au sol)",
            "                      H_SRC   : LIDAR (DSM-DTM médian) | OSM_H (tag height) | OSM_NIV (niveaux x 3 m) | DEFAUT",
            "                      H_LIDAR, H_OSM, NIVEAUX : valeurs brutes pour contrôle ;",
            "                      OSM_ID, TYPE, NOM, NIVEAUX, H_OSM : attributs OSM (reportés sur l'emprise du",
            "                        Référentiel quand un même bâtiment OSM la recouvre à 50 % ou plus) ;",
            f"                      ALT_SOL : altitude du sol (m, {s['alt_ref']})",
            "                      ALT_TOIT : altitude du toit = ALT_SOL + HAUTEUR (m) ; polygones 3D (PolygonZ) dont",
            "                        la coordonnée Z porte ALT_TOIT",
            f"                      Répartition des sources : {s.get('hauteurs')}",
            "                      STATUT  : EXISTANT | DEMOLI (bâtiment existant à retirer dans l'état projeté)",
        ]
    lines += _readme_projets(ex)
    if "routes" in s:
        lines += [
            f"  routes.shp          {s['routes']} tronçons ({s['routes_km']} km, polylignes)",
            "                      NOM, NO_RTE, CLASSE (classe AQréseau+), CLS_AQ, CARACT, GESTION, LONG_M",
            "                      VIT_DEF : vitesse INDICATIVE selon la classe - à valider",
            *_readme_road_attrs(s),
        ]
        if "sections_mtmd" in s:
            lines += [
                f"                      Débits MTMD rattachés à {s['routes_djma']} tronçons ({s['routes_djma_km']} km) :",
                "                      DJMA / DJME / DJMH : débits journaliers moyens annuel / estival / hivernal,",
                "                        TOTAL DES DEUX SENS (véh/j) ; AN_DJMA : année ; PCT_CAM : % camions ;",
                "                        H30 : débit de la 30e heure (véh/h)",
                "                      NB_CHAUS : 1 ou 2 chaussées détectées ; DJMA_CH = DJMA / NB_CHAUS (débit par chaussée,",
                "                        à utiliser si chaque chaussée est une source distincte dans CadnaA)",
                "                      SECT_MTMD : n° de section ; RECOUVR : % du tronçon dans le couloir de la section",
                "                      Tronçons sans DJMA : réseau municipal non couvert par le MTMD (à compléter).",
                *_readme_profile(s),
                f"  sections_trafic_mtmd.shp  {s['sections_mtmd']} sections de trafic MTMD brutes (contrôle du rattachement)",
            ]
    lines += [
        "",
        "IMPORT DANS CADNAA",
        "  Fichier > Importer, format ArcView Shape (*.shp), un fichier à la fois.",
        "  Dans les options d'import, affecter le type d'objet et les attributs :",
        "    courbes_niveau.shp -> Courbe de niveau ; hauteur = coordonnée Z (ou attribut ALTITUDE)",
        "    bord_terrain.shp   -> Courbe de niveau ; hauteur = coordonnée Z (surtout pas un attribut : l'altitude",
        "                          varie le long de la ligne). Sans elle, CadnaA fait retomber le terrain à 0 aux bords.",
        "    batiments.shp      -> Bâtiment ; la coordonnée Z donne l'altitude absolue du toit (ALT_TOIT) ;",
        "                          ou bien hauteur = HAUTEUR en mode relatif (le terrain doit alors être importé)",
        "    batiments_projetes.shp -> Bâtiment ; idem ; à placer dans une variante",
        "    routes.shp         -> Route ; nom = NOM ; vitesse = " + ("VITESSE" if "routes_vit_osm" in s else "VIT_DEF")
        + " (à vérifier) ; DTV/DJMA = DJMA_CH ; % PL = PCT_CAM",
        "                          les sommets portent l'altitude du terrain (Z, tous les 10 m) : routes posées au sol",
        *(["                          largeur = LARG_M ; débits horaires jour / soir / nuit = Q_J / Q_S / Q_N"]
          if "profil" in s else []),
        "    zone_etude.shp     -> Limite de calcul (facultatif)",
        "",
        "SOURCES ET LICENCES",
        "  Topographie : MRNF - Lidar, modèles numériques (Forêt ouverte) - CC-BY 4.0 ;",
        "                RNCan - MNEHR/HRDEM 1 m et MNEMR/MRDEM 30 m - Licence du gouvernement ouvert - Canada",
        "  Bâtiments   : © contributeurs OpenStreetMap - ODbL 1.0 ;",
        "                Référentiel québécois sur les bâtiments - MRNF et partenaires - CC-BY 4.0 ;",
        "                hauteurs dérivées du HRDEM (RNCan) - Licence du gouvernement ouvert - Canada",
        "  Routes      : Adresses Québec / AQréseau+ - MRNF, gouvernement du Québec - CC-BY 4.0",
        "  Débits      : Débit de circulation - ministère des Transports et de la Mobilité durable - CC-BY 4.0",
        *(["  Vitesses, voies, revêtements : © contributeurs OpenStreetMap - ODbL 1.0"] if "routes_vit_osm" in s else []),
        "  Les données sont fournies à titre indicatif : vérifier avant toute étude réglementaire.",
    ]
    return "\r\n".join(lines) + "\r\n"


def _readme_road_attrs(s):
    if "routes_vit_osm" not in s:
        return []
    out = [
        "                      Attributs OpenStreetMap rattachés au chemin OSM parallèle le plus proche (OSM_RTE, OSM_HWY) :",
        "                      VITESSE : vitesse retenue (km/h) - VIT_SRC : OSM (maxspeed du tronçon) | OSM_RUE (maxspeed",
        "                        dominant de la même rue) | DEFAUT (= VIT_DEF) ; "
        f"vitesse OSM sur {s['routes_vit_osm']:.0%} du linéaire",
        "                      VOIES : nombre de voies (sur la chaussée dessinée) - VOIES_SRC : OSM | DEFAUT (2, ou 1 en sens",
        f"                        unique) ; nombre OSM sur {s['routes_voies_osm']:.0%} du linéaire",
        "                      LARG_M : largeur de chaussée (m) - LARG_SRC : OSM (tag width) | VOIES (voies x 3,5 m,",
        "                        3,7 m sur autoroute)",
        "                      SENS_UNIQ : 1 = sens unique (ou chaussée d'autoroute) ; REVET : ENROBE | BETON | PAVES |",
        "                        TRAIT_SURF | NON_REVETU | AUTRE | INCONNU (REVET_OSM : valeur brute) ; "
        f"connu sur {s['routes_revet_osm']:.0%} du linéaire",
    ]
    if s.get("routes_osm_indisponible"):
        out.append("                      ATTENTION OpenStreetMap indisponible lors de l'extraction : valeurs par défaut partout")
    return out


def _readme_profile(s):
    if "profil" not in s:
        return []
    pj, ps, pn = (s["profil"][name] for _, name, _ in PERIODS)
    return [
        "                      Q_J / Q_S / Q_N : débit horaire moyen par chaussée (véh/h) en jour 7-19 h / soir 19-23 h /",
        f"                        nuit 23-7 h = DJMA_CH x part de la période / durée ; parts retenues {pj:g} / {ps:g} / {pn:g} %",
        "                        (profil type À VALIDER avec des comptages horaires)",
    ]


SOURCE_NAMES = {"FORET_OUVERTE": "LiDAR Forêt ouverte (MRNF)", "HRDEM": "LiDAR HRDEM (RNCan)",
                "MRDEM": "MRDEM 30 m (RNCan)"}


def _dem_sources(info):
    parts = [f"{SOURCE_NAMES[k]} {v:.0%}" for k, v in info.parts.items() if v >= 0.0005]
    return ", ".join(parts) or "aucune donnée"


def _readme_dem(ex):
    info = ex.dem_info if ex else None
    if info is None:
        return []
    out = []
    if info.feuillets:
        out.append(f"                      Feuillets Forêt ouverte : {', '.join(info.feuillets)}"
                   f" (acquisitions {', '.join(map(str, info.annees)) or 'inconnues'})")
    if info.datum == "CGVD28":
        if info.parts.get("HRDEM") or info.parts.get("MRDEM"):
            out.append("                      Données RNCan (CGVD2013) ramenées en CGVD28 par l'écart médian mesuré : "
                       + (f"{info.offset:+.2f} m" if info.offset is not None else "non mesurable, aucun décalage"))
    return out


def _readme_footprints(fp):
    if not fp:
        return []
    out = [
        "                      Emprises : " + _footprint_text(fp),
        *(["                      Règle : par maille de 500 m, OSM est la source principale si ses emprises couvrent",
           "                        au moins 85 % de la surface bâtie du Référentiel, sinon c'est le Référentiel ;",
           "                        l'autre source ajoute les bâtiments manquants (doublon si recouvert à 20 % ou plus)."]
          if fp.get("mode") == "auto" else []),
        "                      ID_BAT  : identifiant (osm:w123 = chemin OSM 123 ; ref:... = IdBati du Référentiel)",
        "                      EMP_SRC : OSM | REFBATI ; EMP_ROLE : PRINCIPAL (source retenue pour la maille)",
        "                        | COMPLEMENT (bâtiment absent de la source principale, ajouté sans doublon)",
        "                      EMP_PROD, EMP_DATE, EMP_NC : producteur, date de la donnée source (vide = inconnue)",
        "                        et niveau de complétude (NC-1 = validé manuellement) des emprises du Référentiel",
    ]
    if fp.get("refbati_version"):
        years = fp.get("refbati_annees") or []
        out.append(f"                      Référentiel version {fp['refbati_version']}"
                   + (f", données sources {years[0]}-{years[1]}" if years else ""))
    if fp.get("indisponibles"):
        out.append("                      ATTENTION source indisponible lors de l'extraction : "
                   + ", ".join(FOOTPRINT_NAMES[k] for k in fp["indisponibles"]))
    return out


def _readme_projets(ex):
    if ex is None or ex.projets is None or not len(ex.projets):
        return []
    n, nd = len(ex.projets), len(ex.demolis)
    where = ("batiments_projetes.shp" if ex.projets_mode == "separe"
             else "batiments.shp (STATUT = PROJETE)")
    return [
        f"  Bâtiments projetés : {n} emprise(s) saisie(s) sur plan calé, dans {where}",
        "                      H_SRC = PROJET ; HAUTEUR saisie ; NIVEAUX saisis ; ALT_SOL : terrain médian sous l'emprise",
        "                      PLAN : fichier du plan source",
        f"                      Bâtiments existants démolis : {nd} (STATUT = DEMOLI dans batiments.shp)",
        "                      État projeté = bâtiments EXISTANT + PROJETE ; état actuel = EXISTANT + DEMOLI.",
    ]
