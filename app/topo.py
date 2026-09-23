"""Topographie : MNT LiDAR HRDEM 1 m (RNCan), complété par MRDEM 30 m, et courbes de niveau."""
import math
from dataclasses import dataclass

import contourpy
import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from scipy.ndimage import gaussian_filter
from shapely.geometry import LineString, MultiLineString, GeometryCollection
from shapely.prepared import prep

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
)


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


def read_on_grid(url, grid: Grid, resampling=Resampling.bilinear):
    """Lit un COG distant directement rééchantillonné sur la grille cible (NaN hors données)."""
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open("/vsicurl/" + url) as src:
            with WarpedVRT(src, crs=grid.crs, transform=grid.transform, width=grid.width, height=grid.height,
                           resampling=resampling, src_nodata=src.nodata, nodata=np.nan,
                           dtype="float32") as vrt:
                return vrt.read(1)


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


def build_dtm(bbox_ll, grid: Grid):
    """MNT sur la grille : LiDAR quand disponible, sinon MRDEM 30 m. Retourne (mnt, fraction_lidar)."""
    dtm, _ = lidar_surfaces(bbox_ll, grid)
    lidar = np.isfinite(dtm)
    if not lidar.all():
        fill = read_on_grid(MRDEM_DTM, grid, Resampling.bilinear)
        dtm[~lidar] = fill[~lidar]
    return dtm, float(lidar.mean())


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
