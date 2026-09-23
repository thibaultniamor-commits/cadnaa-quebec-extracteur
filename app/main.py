"""Serveur web local : carte de sélection + extraction en tâche de fond."""
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import crs, pipeline, preview

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT.parent / "output"
STATIC = ROOT / "static"

app = FastAPI(title="Extracteur CadnaA - Québec")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

_executor = ThreadPoolExecutor(max_workers=2)
_jobs: dict[str, dict] = {}
_lock = threading.Lock()


class ExtractRequest(BaseModel):
    geometry: dict
    layers: list[str] = Field(default_factory=lambda: list(pipeline.LAYERS))
    contour_interval: float = Field(1.0, gt=0, le=50)
    dem_resolution: float | None = Field(None, gt=0, le=30)
    smoothing_m: float = Field(3.0, ge=0, le=30)
    default_height: float = Field(6.0, gt=0, le=300)
    crs: str = "auto"
    dem_grid: bool = False


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/crs")
def crs_for(lon: float):
    epsg = crs.resolve("auto", lon)
    return {"epsg": epsg, "name": crs.name(epsg), "zone": crs.mtm_zone(lon)}


@app.post("/api/extract")
def extract(req: ExtractRequest):
    layers = [l for l in req.layers if l in pipeline.LAYERS]
    if not layers:
        raise HTTPException(400, "Aucune couche sélectionnée.")
    job_id = uuid.uuid4().hex[:12]
    job = {"status": "en_cours", "messages": [], "summary": None, "error": None, "file": None}
    with _lock:
        _jobs[job_id] = job
    opts = pipeline.Options(**{**req.model_dump(), "layers": layers})
    _executor.submit(_run, job, opts)
    return {"job_id": job_id}


def _run(job, opts):
    try:
        path, summary = pipeline.run(opts, OUTPUT, progress=job["messages"].append)
        job.update(status="termine", summary=summary, file=str(path))
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
    return {k: job[k] for k in ("status", "messages", "summary", "error")}


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str):
    job = _job(job_id)
    if job["status"] != "termine":
        raise HTTPException(409, "Extraction non terminée.")
    path = Path(job["file"])
    return FileResponse(path, media_type="application/zip", filename=path.name)


@app.get("/api/jobs/{job_id}/preview")
def preview_data(job_id: str):
    job = _job(job_id)
    if job["status"] != "termine":
        raise HTTPException(409, "Extraction non terminée.")
    path = preview.path_for(Path(job["file"]))
    if not path.exists():
        raise HTTPException(404, "Aperçu indisponible.")
    return FileResponse(path, media_type="application/json")
