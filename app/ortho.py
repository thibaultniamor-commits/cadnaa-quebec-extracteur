"""Orthophoto du gouvernement du Québec (WMS Imagerie_GQ du MRNF), plaquée sur le terrain de l'aperçu 3D.

Le service ne propose pas le MTM : l'image est demandée en EPSG:3857 puis reprojetée sur l'emprise exacte du
maillage de l'aperçu (du centre de la première maille au centre de la dernière), nord en haut.
"""
import io
import math

import numpy as np
from affine import Affine
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject, transform_bounds

from . import net

WMS_URL = "https://servicesmatriciels.mern.gouv.qc.ca/erdas-iws/ogc/wms/Imagerie_Continue"
LAYER = "Imagerie_GQ"
MAX_PX = 4000        # limite du service (et des textures WebGL courantes : 4096)
FINEST_M = 0.15      # inutile d'aller plus fin que la résolution des orthophotos
ATTRIBUTION = "Imagerie : gouvernement du Québec (MRNF)"


def image(grid) -> bytes:
    """JPEG de l'orthophoto couvrant le maillage de l'aperçu défini par `grid` (grille du terrain affiché)."""
    res = grid.res
    x0 = grid.transform.c + res / 2
    x1 = grid.transform.c + (grid.width - 0.5) * res
    y1 = grid.transform.f - res / 2
    y0 = grid.transform.f - (grid.height - 0.5) * res
    px = max((x1 - x0) / MAX_PX, (y1 - y0) / MAX_PX, FINEST_M)
    width, height = max(1, round((x1 - x0) / px)), max(1, round((y1 - y0) / px))

    # Emprise en Web Mercator, un peu élargie pour ne pas rogner les bords après reprojection.
    a, b, c, d = transform_bounds(grid.crs, "EPSG:3857", x0, y0, x1, y1, densify_pts=21)
    pad_x, pad_y = (c - a) * 0.02, (d - b) * 0.02
    a, b, c, d = a - pad_x, b - pad_y, c + pad_x, d + pad_y
    req_w = min(MAX_PX, math.ceil(width * 1.05))
    req_h = min(MAX_PX, math.ceil(req_w * (d - b) / (c - a)))
    if req_h == MAX_PX:
        req_w = math.ceil(req_h * (c - a) / (d - b))
    params = {
        "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": LAYER, "STYLES": "",
        "CRS": "EPSG:3857", "BBOX": f"{a},{b},{c},{d}", "WIDTH": req_w, "HEIGHT": req_h, "FORMAT": "image/jpeg",
    }
    r = net.session().get(WMS_URL, params=params, timeout=120)
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("image/"):
        raise RuntimeError(f"Réponse inattendue du service d'imagerie : {r.text[:200]}")
    src = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))

    dst = np.zeros((3, height, width), dtype=np.uint8)
    for band in range(3):
        reproject(src[:, :, band], dst[band], src_transform=from_bounds(a, b, c, d, req_w, req_h),
                  src_crs="EPSG:3857", dst_transform=Affine(px, 0, x0, 0, -px, y1), dst_crs=grid.crs,
                  resampling=Resampling.bilinear)
    out = io.BytesIO()
    Image.fromarray(np.moveaxis(dst, 0, -1)).save(out, format="JPEG", quality=85)
    return out.getvalue()
