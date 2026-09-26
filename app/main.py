"""Serveur web local : carte de sélection + extraction en tâche de fond."""
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import calage, crs, foretouverte, ortho, pipeline, plans

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT.parent / "output"
STATIC = ROOT / "static"


@asynccontextmanager
async def lifespan(_app):
    foretouverte.update_in_background()  # vérifie au plus une fois par jour si le MRNF a publié un nouvel index
    yield


app = FastAPI(title="Extracteur CadnaA - Québec", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.add_middleware(GZipMiddleware, minimum_size=50_000)


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Page et fichiers statiques revalidés à chaque chargement : sans cela, le navigateur garde l'ancien
    JavaScript (modules surtout) après une mise à jour de l'outil. La revalidation (ETag) reste légère."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response

_executor = ThreadPoolExecutor(max_workers=2)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()
KEEP_EXTRACTIONS = 5  # extractions gardées en mémoire pour générer leur ZIP
_plans: dict[str, dict] = {}
KEEP_PLANS = 5
MAX_PLAN_MB = 150


class ExtractRequest(BaseModel):
    geometry: dict
    layers: list[str] = Field(default_factory=lambda: list(pipeline.LAYERS))
    contour_interval: float = Field(1.0, gt=0, le=50)
    dem_resolution: float | None = Field(None, gt=0, le=30)
    smoothing_m: float = Field(3.0, ge=0, le=30)
    default_height: float = Field(6.0, gt=0, le=300)
    crs: str = "auto"
    dem_grid: bool = False
    traffic: bool = True
    dem_source: Literal["foretouverte", "hrdem"] = "foretouverte"
    footprint_source: Literal["auto", "osm", "refbati"] = "auto"
    road_attrs: bool = True
    profile: tuple[float, float, float] = (75.0, 15.0, 10.0)  # % du DJMA en jour / soir / nuit

    @field_validator("profile")
    @classmethod
    def _profile_total(cls, v):
        if min(v) < 0 or abs(sum(v) - 100) > 0.5:
            raise ValueError("Les parts jour / soir / nuit doivent être positives et totaliser 100 %.")
        return v


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/crs")
def crs_for(lon: float):
    epsg = crs.resolve("auto", lon)
    return {"epsg": epsg, "name": crs.name(epsg), "zone": crs.mtm_zone(lon)}


# ---------- Dalles LiDAR Forêt ouverte ----------

@app.get("/api/lidar/etat")
def lidar_state():
    return foretouverte.etat()


@app.get("/api/lidar/dalles")
def lidar_tiles():
    if not foretouverte.DALLES.exists():
        raise HTTPException(503, "Index des dalles en cours de téléchargement.")
    return FileResponse(foretouverte.DALLES, media_type="application/geo+json", headers={"Cache-Control": "no-cache"})


@app.post("/api/lidar/maj")
def lidar_update():
    return foretouverte.update(force=True)


@app.post("/api/extract")
def extract(req: ExtractRequest):
    layers = [l for l in req.layers if l in pipeline.LAYERS]
    if not layers:
        raise HTTPException(400, "Aucune couche sélectionnée.")
    job_id = uuid.uuid4().hex[:12]
    job = {"status": "en_cours", "messages": [], "progress": [0.0, 0.0], "summary": None, "error": None, "extraction": None,
           "preview": None, "file": None, "lock": threading.Lock()}
    with _lock:
        _jobs[job_id] = job
        # Libère la mémoire des extractions les plus anciennes.
        for old in list(_jobs.values())[:-KEEP_EXTRACTIONS]:
            old["extraction"] = None
    opts = pipeline.Options(**{**req.model_dump(), "layers": layers})
    _executor.submit(_run, job, opts)
    return {"job_id": job_id}


def _run(job, opts):
    try:
        ex = pipeline.extract(opts, OUTPUT, progress=job["messages"].append,
                              step=lambda start, end: job.update(progress=[round(start, 4), round(end, 4)]))
        job.update(status="termine", summary=ex.summary, extraction=ex, preview=ex.preview_path)
    except ValueError as e:
        job.update(status="erreur", error=str(e))
    except Exception as e:  # noqa: BLE001 - l'erreur est remontée à l'interface
        traceback.print_exc()
        job.update(status="erreur", error=f"{type(e).__name__} : {e}")


def _job(job_id):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Tâche inconnue.")
    return job


@app.get("/api/jobs/{job_id}")
def status(job_id: str):
    job = _job(job_id)
    return {k: job[k] for k in ("status", "messages", "progress", "summary", "error")}


def _done(job_id):
    job = _job(job_id)
    if job["status"] != "termine":
        raise HTTPException(409, "Extraction non terminée.")
    return job


@app.post("/api/jobs/{job_id}/zip")
def make_zip(job_id: str):
    job = _done(job_id)
    with job["lock"]:
        if job["file"] is None:
            if job["extraction"] is None:
                raise HTTPException(410, "Extraction expirée : relancez l'extraction.")
            job["file"] = pipeline.package(job["extraction"], OUTPUT)
    return {"name": job["file"].name}


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str):
    job = _done(job_id)
    if job["file"] is None:
        raise HTTPException(409, "ZIP non généré.")
    return FileResponse(job["file"], media_type="application/zip", filename=job["file"].name)


@app.get("/api/jobs/{job_id}/preview")
def preview_data(job_id: str):
    job = _done(job_id)
    if not job["preview"].exists():
        raise HTTPException(404, "Aperçu indisponible.")
    return FileResponse(job["preview"], media_type="application/json")


@app.get("/api/jobs/{job_id}/ortho.jpg")
def orthophoto(job_id: str):
    """Orthophoto plaquée sur le terrain de l'aperçu, calculée à la première demande puis gardée en mémoire."""
    job = _done(job_id)
    with job["lock"]:
        if job.get("ortho") is None:
            ex = _extraction(job_id)
            if ex.terrain is None:
                raise HTTPException(404, "Aperçu sans terrain.")
            try:
                job["ortho"] = ortho.image(ex.terrain[1])
            except Exception as e:  # noqa: BLE001 - service externe : l'aperçu garde ses couleurs d'altitude
                raise HTTPException(502, f"Service d'imagerie du MRNF indisponible ({type(e).__name__}).") from e
    return Response(job["ortho"], media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/jobs/{job_id}/batiments")
def existing_buildings(job_id: str):
    """Emprises existantes en WGS84 : accrochage des points de calage et désignation des démolitions."""
    ex = _extraction(job_id)
    if ex.buildings is None:
        return {"type": "FeatureCollection", "features": []}
    b = ex.buildings[["ID_BAT", "HAUTEUR", "geometry"]].to_crs(4326)
    return JSONResponse(content=b.__geo_interface__)


def _extraction(job_id):
    ex = _done(job_id)["extraction"]
    if ex is None:
        raise HTTPException(410, "Extraction expirée : relancez l'extraction.")
    return ex


# ---------- Plans et bâtiments projetés ----------

@app.post("/api/plans")
async def upload_plan(request: Request, name: str = "plan"):
    data = await request.body()
    if not data:
        raise HTTPException(400, "Fichier vide.")
    if len(data) > MAX_PLAN_MB * 1e6:
        raise HTTPException(413, f"Fichier trop lourd (maximum {MAX_PLAN_MB} Mo).")
    try:
        kind = plans.kind_of(data, name)
        if kind == "dxf":
            return JSONResponse(await run_in_threadpool(plans.dxf_read, data))
        pages = await run_in_threadpool(plans.pdf_pages, data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    plan_id = uuid.uuid4().hex[:12]
    with _lock:
        _plans[plan_id] = {"data": data, "pages": pages, "png": {}}
        for old in list(_plans)[:-KEEP_PLANS]:
            del _plans[old]
    return {"kind": "pdf", "plan_id": plan_id, "pages": pages}


@app.get("/api/plans/{plan_id}/page/{page}")
def plan_page(plan_id: str, page: int):
    plan = _plans.get(plan_id)
    if plan is None:
        raise HTTPException(404, "Plan expiré : réimporter le fichier.")
    if not 0 <= page < len(plan["pages"]):
        raise HTTPException(404, "Page inexistante.")
    if page not in plan["png"]:
        plan["png"] = {page: plans.pdf_render(plan["data"], page, plan["pages"][page]["dpi"])}
    return Response(plan["png"][page], media_type="image/png", headers={"Cache-Control": "max-age=3600"})


# Projections possibles de la carte de l'éditeur de calage : celles des shapefiles.
VIEW_EPSGS = set(range(crs.mtm_epsg(3), crs.mtm_epsg(10) + 1)) | {crs.LAMBERT_QC}


class FitRequest(BaseModel):
    pairs: list[tuple[float, float, float, float]] = Field(max_length=50)  # x, y plan ; lat, lon carte
    method: Literal["similitude", "affine", "rigide"] = "similitude"
    bbox: tuple[float, float, float, float]
    unit_m: float | None = Field(None, gt=0)
    view_epsg: int | None = None


@app.post("/api/calage")
def fit_plan(req: FitRequest):
    try:
        if req.view_epsg is not None and req.view_epsg not in VIEW_EPSGS:
            raise ValueError("Projection de la carte inconnue.")
        return calage.fit(req.pairs, req.method, req.bbox, req.unit_m, req.view_epsg)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class ProjectBuilding(BaseModel):
    id: str = Field(max_length=40)
    nom: str = Field(max_length=100)
    hauteur: float = Field(gt=0, le=300)
    niveaux: int | None = Field(None, ge=1, le=150)
    plan: str | None = Field(None, max_length=200)
    geometry: dict


class ProjectsRequest(BaseModel):
    mode: Literal["separe", "fusion"] = "separe"
    buildings: list[ProjectBuilding] = Field(default_factory=list)
    demolis: list[str] = Field(default_factory=list)


@app.put("/api/jobs/{job_id}/projets")
def set_projects(job_id: str, req: ProjectsRequest):
    job = _done(job_id)
    ex = _extraction(job_id)
    with job["lock"]:
        try:
            info = pipeline.set_projets(ex, [b.model_dump() for b in req.buildings], req.demolis, req.mode)
        except (ValueError, KeyError, TypeError, AttributeError) as e:
            raise HTTPException(400, f"Bâtiment projeté invalide : {e}") from e
        job["file"] = None  # le ZIP devra être régénéré
    return info


@app.get("/api/jobs/{job_id}/projets")
def projects_preview(job_id: str):
    """Volumes des bâtiments projetés et ID_BAT démolis, dans le repère de l'aperçu 3D."""
    ex = _extraction(job_id)
    return {"buildings": ex.projets_items, "demolis": sorted(ex.demolis)}
