"""Chaîne d'extraction : zone dessinée -> ZIP de shapefiles prêts pour CadnaA."""
import datetime as dt
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import geopandas as gpd
import pandas as pd
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform as shp_transform

from . import buildings, crs, preview, projets, roads, topo, traffic

MAX_AREA_KM2 = 100.0
ENCODING = "cp1252"  # encodage Windows lu par CadnaA (accents français)

LAYERS = ("topo", "batiments", "routes")


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
    bbox_ll = zone_ll.buffer(0.001).bounds
    summary = {"zone_km2": round(area_km2, 3), "epsg": epsg, "crs": crs.name(epsg), "alt_ref": "CGVD2013"}
    ex = Extraction(opts, epsg, zone, summary, out_dir / f"cadnaa_qc_{stamp}_apercu.json")

    if "topo" in opts.layers:
        res = opts.dem_resolution or auto_resolution(area_km2)
        grid = topo.Grid.covering(zone.buffer(3 * res + opts.smoothing_m * 3).bounds, res, f"EPSG:{epsg}")
        progress(f"Topographie : lecture du MNT à {res:g} m ({grid.width}×{grid.height} px)…")
        dtm, info = topo.build_dtm(bbox_ll, grid, opts.dem_source, progress)
        ex.dem_info = info
        progress(f"Topographie : {_dem_sources(info)}, altitudes {info.datum}. Calcul des courbes…")
        lines = topo.contours(dtm, grid, opts.contour_interval, zone, opts.smoothing_m)
        ex.contours = gpd.GeoDataFrame({"ALTITUDE": [z for z, _ in lines]}, geometry=[g for _, g in lines])
        ex.dtm, ex.grid = dtm, grid
        summary["alt_ref"] = info.datum
        summary.update(courbes=len(ex.contours), mnt_resolution_m=res, couverture_lidar=round(info.lidar, 3),
                       mnt_sources={k: round(v, 3) for k, v in info.parts.items() if v},
                       mnt_feuillets=info.feuillets, mnt_annees=info.annees, ecart_cgvd_m=info.offset,
                       equidistance_m=opts.contour_interval)
        progress(f"Topographie : {len(ex.contours)} courbes de niveau.")

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

    if "routes" in opts.layers:
        progress("Routes : interrogation AQréseau+…")
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
        ex.roads = r

    progress("Aperçu 3D : préparation…")
    ex.terrain = preview.terrain(ex.dtm, ex.grid, zone, bbox_ll, epsg)
    data = preview.build(zone, ex.terrain, buildings=ex.buildings, roads=ex.roads, contours=ex.contours,
                         stats=summary)
    preview.write(ex.preview_path, data)
    summary["duree_s"] = round(time.time() - t0, 1)
    progress(f"Extraction terminée en {summary['duree_s']} s.")
    return ex


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


def package(ex: Extraction, out_dir: Path) -> Path:
    """Écrit les shapefiles de l'extraction et les regroupe dans un ZIP."""
    folder = out_dir / ex.preview_path.name.removesuffix("_apercu.json")
    folder.mkdir(parents=True, exist_ok=True)
    epsg, s = ex.epsg, ex.summary
    _write(gpd.GeoDataFrame({"NOM": ["Zone d'étude"], "SURF_KM2": [s["zone_km2"]]}, geometry=[ex.zone]),
           folder / "zone_etude.shp", epsg)
    if ex.contours is not None:
        _write(ex.contours, folder / "courbes_niveau.shp", epsg)
        if ex.opts.dem_grid:
            topo.write_ascii_grid(folder / "mnt.asc", ex.dtm, ex.grid)
    existing, projected = _buildings_out(ex)
    if existing is not None:
        _write(existing, folder / "batiments.shp", epsg)
    if projected is not None:
        _write(projected, folder / "batiments_projetes.shp", epsg)
    if ex.sections is not None and len(ex.sections):
        _write(ex.sections, folder / "sections_trafic_mtmd.shp", epsg)
    if ex.roads is not None:
        _write(ex.roads, folder / "routes.shp", epsg)
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
        "  zone_etude.shp      Polygone de la zone sélectionnée",
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
            f"                      Répartition des sources : {s.get('hauteurs')}",
            "                      STATUT  : EXISTANT | DEMOLI (bâtiment existant à retirer dans l'état projeté)",
        ]
    lines += _readme_projets(ex)
    if "routes" in s:
        lines += [
            f"  routes.shp          {s['routes']} tronçons ({s['routes_km']} km, polylignes)",
            "                      NOM, NO_RTE, CLASSE (classe AQréseau+), CLS_AQ, CARACT, GESTION, LONG_M",
            "                      VIT_DEF : vitesse INDICATIVE selon la classe - à valider",
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
                f"  sections_trafic_mtmd.shp  {s['sections_mtmd']} sections de trafic MTMD brutes (contrôle du rattachement)",
            ]
    lines += [
        "",
        "IMPORT DANS CADNAA",
        "  Fichier > Importer, format ArcView Shape (*.shp), un fichier à la fois.",
        "  Dans les options d'import, affecter le type d'objet et les attributs :",
        "    courbes_niveau.shp -> Courbe de niveau ; hauteur = coordonnée Z (ou attribut ALTITUDE)",
        "    batiments.shp      -> Bâtiment ; hauteur = HAUTEUR (relative)",
        "    batiments_projetes.shp -> Bâtiment ; hauteur = HAUTEUR (relative) ; à placer dans une variante",
        "    routes.shp         -> Route ; nom = NOM ; vitesse = VIT_DEF (à vérifier) ; DTV/DJMA = DJMA_CH ; % PL = PCT_CAM",
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
        "  Les données sont fournies à titre indicatif : vérifier avant toute étude réglementaire.",
    ]
    return "\r\n".join(lines) + "\r\n"


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
