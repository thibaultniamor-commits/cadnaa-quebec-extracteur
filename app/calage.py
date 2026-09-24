"""Calage d'un plan sur la carte par paires de points (moindres carrés).

Le calcul se fait en MTM (mètres, projection conforme) : les écarts résiduels sont des distances au sol.
Le navigateur reçoit ensuite une affine plan -> (lon, lat), suffisante pour l'affichage et la saisie
(l'erreur d'approximation est de l'ordre du millimètre sur un plan de quelques centaines de mètres).
"""
import math

import numpy as np
from pyproj import Transformer

from . import crs

MIN_POINTS = {"similitude": 2, "rigide": 2, "affine": 3}


def _fit(src, dst, method, scale=None):
    """Matrice 2x3 M telle que dst ≈ M @ [x, y, 1]."""
    n = len(src)
    if method == "affine":
        g = np.column_stack([src, np.ones(n)])
        if np.linalg.matrix_rank(g) < 3:
            raise ValueError("Points alignés : répartir les points de calage autour du projet.")
        sol, *_ = np.linalg.lstsq(g, dst, rcond=None)
        return sol.T
    # Similitude (Umeyama sans réflexion) ; rigide = échelle imposée par les unités du plan.
    ms, md = src.mean(0), dst.mean(0)
    s, d = src - ms, dst - md
    ss = float((s ** 2).sum())
    if ss < 1e-12:
        raise ValueError("Points confondus sur le plan.")
    a = float((s * d).sum())
    b = float((s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum())
    theta = math.atan2(b, a)
    k = scale if method == "rigide" else math.hypot(a, b) / ss
    r = k * np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    return np.column_stack([r, md - r @ ms])


def fit(pairs, method, bbox, unit_m=None):
    """pairs : [(x_plan, y_plan, lat, lon)] ; bbox : emprise du plan (unités plan) pour l'affine d'affichage.

    unit_m : mètres (réels pour un DXF, sur papier pour un PDF) par unité de plan, si connu.
    """
    need = MIN_POINTS[method]
    if len(pairs) < need:
        return {"ok": False, "min": need, "message": f"{need} points au minimum pour cette transformation."}
    if method == "rigide" and not unit_m:
        raise ValueError("Unités du plan inconnues : utiliser la similitude.")
    p = np.asarray(pairs, dtype=float)
    lon0 = float(p[:, 3].mean())
    epsg = crs.resolve("auto", lon0)
    to_mtm = Transformer.from_crs(4326, epsg, always_xy=True)
    to_ll = Transformer.from_crs(epsg, 4326, always_xy=True)
    src = p[:, :2]
    dst = np.column_stack(to_mtm.transform(p[:, 3], p[:, 2]))

    m = _fit(src, dst, method, unit_m)
    pred = src @ m[:, :2].T + m[:, 2]
    res = np.hypot(*(pred - dst).T)
    det = float(np.linalg.det(m[:, :2]))
    scale = math.sqrt(abs(det))
    out = {
        "ok": True, "min": need, "epsg": epsg,
        "residuals": [round(float(r), 3) for r in res],
        "rms": round(float(np.sqrt((res ** 2).mean())), 3) if len(res) > need else None,
        "scale": scale,                                            # m par unité de plan
        "rotation": round(math.degrees(math.atan2(m[1, 0], m[0, 0])), 3),
        "warnings": [],
    }
    if method == "affine":
        sx, sy = np.hypot(*m[:, 0]), np.hypot(*m[:, 1])
        out["aniso"] = round(float(abs(sx / sy - 1) * 100), 2)    # écart d'échelle x/y (%)
        if det < 0:
            out["warnings"].append("Transformation en miroir : points probablement inversés.")
    if unit_m:
        out["ratio"] = scale / unit_m                               # 1:ratio (PDF) ou facteur (DXF)

    # Affine plan -> (lon, lat) ajustée sur une grille couvrant le plan.
    x0, y0, x1, y1 = bbox
    gx, gy = np.meshgrid(np.linspace(x0, x1, 7), np.linspace(y0, y1, 7))
    grid = np.column_stack([gx.ravel(), gy.ravel()])
    mtm = grid @ m[:, :2].T + m[:, 2]
    lon, lat = to_ll.transform(mtm[:, 0], mtm[:, 1])
    g = np.column_stack([grid, np.ones(len(grid))])
    (a, b, c), *_ = np.linalg.lstsq(g, lon, rcond=None)
    (d, e, f), *_ = np.linalg.lstsq(g, lat, rcond=None)
    out["affine_ll"] = [float(v) for v in (a, b, c, d, e, f)]      # lon = a x + b y + c ; lat = d x + e y + f
    return out
