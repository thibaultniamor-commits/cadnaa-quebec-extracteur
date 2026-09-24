"""Index des dalles LiDAR (MNT 1 m) diffusées par le MRNF via Forêt ouverte.

L'index des feuillets 1/20 000 et les métadonnées d'acquisition sont gardés en cache local
et retéléchargés seulement quand le MRNF publie une nouvelle version (en-tête Last-Modified).
"""
import json
import threading
import time
import zipfile
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import geopandas as gpd
import pandas as pd

from . import net

BASE = "https://diffusion.mffp.gouv.qc.ca/Diffusion/DonneeGratuite/Foret/IMAGERIE/Produits_derives_LiDAR"
INDEX_URL = f"{BASE}/Produit_derive_lidar/03-Telechargement/URL_Lidar.geojson"
META_URL = f"{BASE}/Metadonnees.zip"
WMS_URL = "https://geoegl.msp.gouv.qc.ca/ws/mffpecofor.fcgi"

CACHE = Path(__file__).resolve().parent.parent / "cache" / "foretouverte"
DALLES = CACHE / "dalles.geojson"   # index simplifié servi à la carte
STATE = CACHE / "etat.json"
CHECK_EVERY_S = 24 * 3600
SIMPLIFY_DEG = 0.0003               # ~30 m : suffisant pour l'affichage des feuillets
MIN_OVERLAP = 0.02                  # part minimale du feuillet couverte par une acquisition

_lock = threading.Lock()
_status = {"updating": False, "error": None}


def _state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def etat() -> dict:
    s = _state()
    return {
        "disponible": DALLES.exists(),
        "index_date": s.get("index_modified"),
        "meta_date": s.get("meta_modified"),
        "verifie": s.get("checked_at"),
        "dalles": s.get("count"),
        "annees": s.get("years"),
        "maj_en_cours": _status["updating"],
        "erreur": _status["error"],
        "wms": WMS_URL,
    }


def _iso(http_date: str | None) -> str | None:
    if not http_date:
        return None
    return parsedate_to_datetime(http_date).astimezone(timezone.utc).isoformat()


def _remote_modified(url: str) -> str | None:
    r = net.session().head(url, timeout=60, allow_redirects=True)
    r.raise_for_status()
    return _iso(r.headers.get("Last-Modified"))


def _download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    with net.session().get(url, timeout=300, stream=True) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(dest)


def _build() -> dict:
    """Joint à chaque feuillet les années et densités des acquisitions LiDAR qui le couvrent."""
    idx = gpd.read_file(CACHE / "URL_Lidar.geojson").to_crs(4326)
    meta_zip = CACHE / "Metadonnees.zip"
    with zipfile.ZipFile(meta_zip) as z:  # le nom du shapefile change à chaque édition
        shp = next(n for n in z.namelist() if n.lower().endswith(".shp"))
    meta = gpd.read_file(f"/vsizip/{meta_zip.as_posix()}/{shp}").to_crs(4326)
    meta = meta[["AN_ACQ", "DENS_PT", "PROPRIO", "geometry"]]

    # Recouvrement calculé en Québec Lambert (EPSG:32198) pour des surfaces en m².
    a = idx[["Feuillet20K", "geometry"]].to_crs(32198)
    b = meta.to_crs(32198)
    b["geometry"] = b.geometry.make_valid()
    a["surf"] = a.area
    inter = gpd.overlay(a, b, how="intersection", keep_geom_type=True)
    inter = inter[inter.area / inter["surf"] >= MIN_OVERLAP]

    def dens(v):
        try:
            return float(str(v).split()[0])
        except ValueError:
            return None

    info = {}
    for f20k, g in inter.groupby("Feuillet20K"):
        ans = sorted({int(x) for x in g["AN_ACQ"] if str(x).isdigit()})
        ds = [d for d in map(dens, g["DENS_PT"]) if d]
        info[f20k] = {
            "ans": ans,
            "dens": max(ds) if ds else None,
            "prop": ", ".join(sorted({str(p) for p in g["PROPRIO"] if p})),
        }

    out = gpd.GeoDataFrame({
        "f": idx["Feuillet20K"],
        "r": idx["Region"],
        "mnt": idx["MNT"],
        "rep": idx["Repertoire"],
    }, geometry=idx.geometry.simplify(SIMPLIFY_DEG, preserve_topology=True), crs=4326)
    empty = {"ans": [], "dens": None, "prop": ""}
    out["ans"] = [info.get(f, empty)["ans"] for f in out["f"]]
    out["an"] = [max(v) if v else None for v in out["ans"]]
    out["dens"] = [info.get(f, empty)["dens"] for f in out["f"]]
    out["prop"] = [info.get(f, empty)["prop"] for f in out["f"]]

    fc = json.loads(out.to_json(drop_id=True, to_wgs84=False))
    for feat in fc["features"]:  # 5 décimales (~1 m) : fichier bien plus léger
        feat["geometry"]["coordinates"] = _round(feat["geometry"]["coordinates"])
    tmp = DALLES.with_suffix(".part")
    tmp.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    tmp.replace(DALLES)
    years = pd.Series([y for v in out["ans"] for y in v])
    return {"count": len(out), "years": [int(years.min()), int(years.max())] if len(years) else None}


def _round(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], 5), round(c[1], 5)]
    return [_round(x) for x in c]


def update(force: bool = False) -> dict:
    """Vérifie les dates côté MRNF ; retélécharge et reconstruit l'index seulement s'il a changé."""
    with _lock:
        s = _state()
        checked = s.get("checked_at")
        fresh = checked and time.time() - datetime.fromisoformat(checked).timestamp() < CHECK_EVERY_S
        if DALLES.exists() and fresh and not force:
            return etat()
        _status.update(updating=True, error=None)
        try:
            CACHE.mkdir(parents=True, exist_ok=True)
            idx_mod, meta_mod = _remote_modified(INDEX_URL), _remote_modified(META_URL)
            changed = False
            if idx_mod != s.get("index_modified") or not (CACHE / "URL_Lidar.geojson").exists():
                _download(INDEX_URL, CACHE / "URL_Lidar.geojson")
                changed = True
            if meta_mod != s.get("meta_modified") or not (CACHE / "Metadonnees.zip").exists():
                _download(META_URL, CACHE / "Metadonnees.zip")
                changed = True
            if changed or not DALLES.exists():
                s.update(_build())
            s.update(index_modified=idx_mod, meta_modified=meta_mod,
                     checked_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
            STATE.write_text(json.dumps(s, indent=1), encoding="utf-8")
        except Exception as e:  # noqa: BLE001 - le cache existant reste utilisable
            _status["error"] = f"Mise à jour impossible : {type(e).__name__} : {e}"
        finally:
            _status["updating"] = False
        return etat()


def update_in_background() -> None:
    threading.Thread(target=update, daemon=True).start()
