"""Topographie : MNT LiDAR Forêt ouverte (MRNF) ou HRDEM (RNCan), complété par MRDEM 30 m, et courbes de niveau."""
import hashlib
import math
import warnings
import queue
import threading
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path

import contourpy
import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window, from_bounds
from scipy.ndimage import gaussian_filter
from shapely.geometry import LineString, MultiLineString, GeometryCollection
from shapely.prepared import prep

from . import foretouverte
from .net import session

STAC_SEARCH = "https://datacube.services.geo.ca/stac/api/search"
HRDEM_COLLECTION = "hrdem-mosaic-1m"
MRDEM_DTM = "https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif"

GDAL_ENV = dict(
    GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
    GDAL_HTTP_MULTIRANGE="YES",
    GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
    VSI_CACHE="TRUE",
    GDAL_HTTP_MAX_RETRY="3",
    GDAL_HTTP_RETRY_DELAY="2",
    # Sans délai maximal, une connexion bloquée (fréquent sur le serveur du MRNF) attend indéfiniment.
    GDAL_HTTP_CONNECTTIMEOUT="20",
    GDAL_HTTP_TIMEOUT="120",
    GDAL_HTTP_LOW_SPEED_TIME="30",
    GDAL_HTTP_LOW_SPEED_LIMIT="1000",
)
BAND_ROWS = 512     # hauteur des bandes lues en parallèle (multiple des blocs 256 des COG)
READ_THREADS = 6    # requêtes simultanées par fichier : sur ces serveurs, la latence domine
MIN_OFFSET_PX = 200  # pixels communs minimum pour estimer l'écart CGVD28 - CGVD2013
MNT_CACHE = Path(__file__).resolve().parent.parent / "cache" / "mnt"
MNT_CACHE_MAX_MB = 1000



class _DaemonPool:
    """Threads de lecture permanents et « daemon ».

    Un thread qui se termine libère ses connexions GDAL/curl, et ce nettoyage peut bloquer indéfiniment
    (observé sous Windows) : les threads sont donc réutilisés, jamais terminés, et pas attendus à la sortie
    du programme (ce que ferait ThreadPoolExecutor).
    """

    def __init__(self, n, name):
        self._q = queue.SimpleQueue()
        for i in range(n):
            threading.Thread(target=self._work, name=f"{name}-{i}", daemon=True).start()

    def _work(self):
        while True:
            fn, arg, fut = self._q.get()
            if fut.set_running_or_notify_cancel():
                try:
                    fut.set_result(fn(arg))
                except BaseException as e:  # noqa: BLE001 - transmise à l'appelant par result()
                    fut.set_exception(e)

    def map(self, fn, items):
        futures = []
        for item in items:
            fut = Future()
            self._q.put((fn, item, fut))
            futures.append(fut)
        return [f.result() for f in futures]


# Deux pools : les feuillets lus en parallèle soumettent eux-mêmes leurs bandes (un seul pool s'interbloquerait).
_tile_pool = _DaemonPool(2, "mnt-feuillet")
_band_pool = _DaemonPool(2 * READ_THREADS, "mnt-bande")


@dataclass
class Grid:
    crs: str
    transform: Affine
    width: int
    height: int
    res: float

    @classmethod
    def covering(cls, bounds, res, crs):
        xmin = math.floor(bounds[0] / res) * res
        ymin = math.floor(bounds[1] / res) * res
        xmax = math.ceil(bounds[2] / res) * res
        ymax = math.ceil(bounds[3] / res) * res
        return cls(crs, Affine(res, 0, xmin, 0, -res, ymax),
                   int(round((xmax - xmin) / res)), int(round((ymax - ymin) / res)), res)

    def coarsened(self, f):
        """Grille f fois plus grossière, alignée sur le coin haut-gauche (lignes et colonnes en trop écartées)."""
        return Grid(self.crs, self.transform * Affine.scale(f), self.width // f, self.height // f, self.res * f)

    def x_centers(self):
        return self.transform.c + (np.arange(self.width) + 0.5) * self.res

    def y_centers(self):
        return self.transform.f - (np.arange(self.height) + 0.5) * self.res


def hrdem_assets(bbox_ll):
    """Tuiles HRDEM 1 m intersectant l'emprise (lon/lat)."""
    r = session().post(STAC_SEARCH, json={"collections": [HRDEM_COLLECTION], "bbox": list(bbox_ll), "limit": 100},
                       timeout=60)
    r.raise_for_status()
    return [f["assets"] for f in r.json()["features"]]


def _overview(src, target_res):
    """Niveau de réduction le plus grossier restant au moins aussi fin que la cible (None = pleine résolution)."""
    level = None
    for i, f in enumerate(src.overviews(1)):
        if src.res[0] * f <= target_res * 1.001:
            level = i
    return level


def _read_band(url, level, win):
    with rasterio.Env(**GDAL_ENV), rasterio.open("/vsicurl/" + url, overview_level=level) as src:
        return src.read(1, window=win)


def read_on_grid(url, grid: Grid, resampling=Resampling.bilinear):
    """Lit un COG distant rééchantillonné sur la grille cible (NaN hors données).

    Seule la fenêtre utile est lue, au niveau de réduction adapté et en bandes parallèles, puis reprojetée
    en mémoire. Une reprojection à la volée (WarpedVRT) enchaîne une requête par bloc et ignore les
    niveaux de réduction : inutilisable sur un serveur lent comme celui du MRNF.
    """
    out = np.full((grid.height, grid.width), np.nan, dtype="float32")
    x0, y1 = grid.transform * (0, 0)
    x1, y0 = grid.transform * (grid.width, grid.height)
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open("/vsicurl/" + url) as full:
            src_crs, nodata = full.crs, full.nodata
            # Moyenne : lire au plus à la résolution cible ; bilinéaire : garder 2 fois plus fin.
            level = _overview(full, grid.res if resampling == Resampling.average else grid.res / 2)
            bx0, by0, bx1, by1 = transform_bounds(grid.crs, src_crs, x0, y0, x1, y1, densify_pts=21)
        with rasterio.open("/vsicurl/" + url, overview_level=level) as src:
            pad = 2 * src.res[0]
            win = from_bounds(bx0 - pad, by0 - pad, bx1 + pad, by1 + pad, src.transform)
            r0, c0 = max(0, math.floor(win.row_off)), max(0, math.floor(win.col_off))
            r1 = min(src.height, math.ceil(win.row_off + win.height))
            c1 = min(src.width, math.ceil(win.col_off + win.width))
            if r1 <= r0 or c1 <= c0:
                return out
            win_transform = src.window_transform(Window(c0, r0, c1 - c0, r1 - r0))
    cuts = [r0] + list(range((r0 // BAND_ROWS + 1) * BAND_ROWS, r1, BAND_ROWS)) + [r1]
    bands = [Window(c0, a, c1 - c0, b - a) for a, b in zip(cuts[:-1], cuts[1:])]
    data = np.vstack(list(_band_pool.map(lambda w: _read_band(url, level, w), bands))).astype("float32")
    if nodata is not None:
        data[data == nodata] = np.nan
    reproject(data, out, src_transform=win_transform, src_crs=src_crs, src_nodata=np.nan,
              dst_transform=grid.transform, dst_crs=grid.crs, dst_nodata=np.nan, resampling=resampling)
    return out


def lidar_surfaces(bbox_ll, grid: Grid, want_dsm=False):
    """Mosaïque HRDEM (DTM et éventuellement DSM) sur la grille ; NaN là où il n'y a pas de LiDAR."""
    resampling = Resampling.average if grid.res > 1 else Resampling.bilinear
    dtm = np.full((grid.height, grid.width), np.nan, dtype="float32")
    dsm = np.full_like(dtm, np.nan) if want_dsm else None
    for assets in hrdem_assets(bbox_ll):
        a = read_on_grid(assets["dtm"]["href"], grid, resampling)
        ok = np.isfinite(a) & np.isnan(dtm)
        dtm[ok] = a[ok]
        if want_dsm and "dsm" in assets:
            s = read_on_grid(assets["dsm"]["href"], grid, resampling)
            ok = np.isfinite(s) & np.isnan(dsm)
            dsm[ok] = s[ok]
    return dtm, dsm


@dataclass
class DemInfo:
    """Provenance du MNT assemblé."""
    datum: str                                     # CGVD28 (données MRNF) ou CGVD2013 (données RNCan)
    parts: dict = field(default_factory=dict)      # part de la grille couverte par chaque source
    offset: float | None = None                    # écart ajouté aux données RNCan pour les ramener en CGVD28
    feuillets: list = field(default_factory=list)  # feuillets Forêt ouverte utilisés
    annees: list = field(default_factory=list)     # années d'acquisition de ces feuillets

    @property
    def lidar(self):
        return self.parts.get("FORET_OUVERTE", 0.0) + self.parts.get("HRDEM", 0.0)


def _block_mean(a, f):
    h, w = (a.shape[0] // f) * f, (a.shape[1] // f) * f
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # blocs entièrement vides
        return np.nanmean(a[:h, :w].reshape(h // f, f, w // f, f), axis=(1, 3))


def _median_offset(fo, hr):
    d = fo - hr
    d = d[np.isfinite(d)]
    return round(float(np.median(d)), 3) if d.size >= MIN_OFFSET_PX else None


def _read_cached(url, grid: Grid, resampling):
    """read_on_grid avec cache disque : le serveur du MRNF est lent et la même zone est souvent réextraite."""
    key = hashlib.sha1(repr((url, grid.crs, tuple(grid.transform)[:6], grid.width, grid.height,
                             resampling.name)).encode()).hexdigest()
    path = MNT_CACHE / f"{key}.npy"
    if path.exists():
        path.touch()  # plus récemment utilisé
        return np.load(path)
    a = read_on_grid(url, grid, resampling)
    MNT_CACHE.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part.npy")
    np.save(tmp, a)
    tmp.replace(path)
    files = sorted(MNT_CACHE.glob("*.npy"), key=lambda p: p.stat().st_mtime, reverse=True)
    total = 0
    for p in files:  # purge des lectures les plus anciennes au-delà de la taille maximale
        total += p.stat().st_size
        if total > MNT_CACHE_MAX_MB * 1e6 and p != path:
            p.unlink(missing_ok=True)
    return a


def _foret_ouverte(dtm, info, bbox_ll, grid, resampling, progress):
    tiles = foretouverte.tiles_for(bbox_ll)
    if not tiles:
        return
    progress(f"Topographie : {len(tiles)} feuillet(s) LiDAR Forêt ouverte ({', '.join(t['f'] for t in tiles)})…")
    arrays = list(_tile_pool.map(lambda t: _read_cached(t["mnt"], grid, resampling), tiles))
    years = set()
    for t, a in zip(tiles, arrays):  # tuiles triées de la plus récente à la plus ancienne : la plus récente l'emporte
        ok = np.isfinite(a) & np.isnan(dtm)
        if ok.any():
            dtm[ok] = a[ok]
            info.feuillets.append(t["f"])
            years.update(t["ans"])
    info.annees = sorted(years)


def build_dtm(bbox_ll, grid: Grid, source="foretouverte", progress=lambda msg: None):
    """MNT sur la grille. Retourne (mnt, DemInfo).

    source = "foretouverte" : feuillets LiDAR du MRNF, complétés par le HRDEM puis le MRDEM décalés de l'écart
    médian mesuré sur la zone commune (écart CGVD28 - CGVD2013) : tout le MNT est alors en CGVD28.
    source = "hrdem" : HRDEM puis MRDEM (RNCan), en CGVD2013.
    """
    resampling = Resampling.average if grid.res > 1 else Resampling.bilinear
    dtm = np.full((grid.height, grid.width), np.nan, dtype="float32")
    info = DemInfo(datum="CGVD2013")
    if source == "foretouverte":
        try:
            _foret_ouverte(dtm, info, bbox_ll, grid, resampling, progress)
        except Exception as e:  # noqa: BLE001 - repli sur les données RNCan
            dtm[:] = np.nan
            info.feuillets, info.annees = [], []
            progress(f"Topographie : Forêt ouverte indisponible ({type(e).__name__} : {e}) ; repli sur le HRDEM.")
    fo = np.isfinite(dtm)
    info.parts["FORET_OUVERTE"] = float(fo.mean())
    if fo.any():
        info.datum = "CGVD28"

    if fo.all():
        # MNT complet : l'écart sert seulement à recaler les altitudes du sol des bâtiments (HRDEM).
        f = max(1, math.ceil(max(grid.width, grid.height) / 300))
        cgrid = grid.coarsened(f)
        if cgrid.width and cgrid.height:
            info.offset = _median_offset(_block_mean(dtm, f), lidar_surfaces(bbox_ll, cgrid)[0])
    else:
        hr = lidar_surfaces(bbox_ll, grid)[0]
        if fo.any():
            info.offset = _median_offset(dtm, hr)
            if info.offset is None:
                progress("Topographie : recouvrement insuffisant pour caler le HRDEM sur Forêt ouverte, "
                         "aucun décalage appliqué (marche possible aux raccords).")
        ok = np.isfinite(hr) & ~fo
        dtm[ok] = hr[ok] + (info.offset or 0.0)
        info.parts["HRDEM"] = float(ok.mean())
    rest = np.isnan(dtm)
    if rest.any():
        dtm[rest] = read_on_grid(MRDEM_DTM, grid, Resampling.bilinear)[rest] + (info.offset or 0.0)
        info.parts["MRDEM"] = float(rest.mean())
    return dtm, info


def _lines(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, (MultiLineString, GeometryCollection)):
        return [g for part in geom.geoms for g in _lines(part)]
    return []


def contours(dtm, grid: Grid, interval, zone, smoothing_m=3.0):
    """Courbes de niveau 3D (LineString Z) découpées sur la zone. Retourne [(altitude, ligne)]."""
    valid = np.isfinite(dtm)
    if not valid.any():
        return []
    z = dtm
    sigma = smoothing_m / grid.res
    if sigma > 0:
        z = gaussian_filter(np.where(valid, dtm, np.nanmean(dtm)), sigma)
        z[~valid] = np.nan

    # contourpy attend des coordonnées croissantes : on retourne l'axe Y.
    gen = contourpy.contour_generator(grid.x_centers(), grid.y_centers()[::-1], np.ma.masked_invalid(z[::-1]),
                                      line_type="Separate")
    lo = math.ceil(np.nanmin(z) / interval) * interval
    hi = math.floor(np.nanmax(z) / interval) * interval
    tol = grid.res * 0.5
    min_len = max(10.0, 5 * grid.res)
    zone_p = prep(zone)

    out = []
    for level in np.arange(lo, hi + interval / 2, interval):
        level = round(float(level), 3)
        for seg in gen.lines(level):
            if len(seg) < 2:
                continue
            line = LineString(seg).simplify(tol)
            if line.length < min_len:
                continue
            parts = [line] if zone_p.contains(line) else _lines(line.intersection(zone))
            for part in parts:
                if part.length >= min_len:
                    out.append((level, LineString([(x, y, level) for x, y in part.coords])))
    return out


def write_ascii_grid(path, dtm, grid: Grid):
    """MNT en grille ESRI ASCII (.asc + .prj)."""
    with rasterio.open(path, "w", driver="AAIGrid", width=grid.width, height=grid.height, count=1,
                       dtype="float32", crs=grid.crs, transform=grid.transform, nodata=-9999) as dst:
        dst.write(np.where(np.isfinite(dtm), dtm, -9999).astype("float32"), 1)
