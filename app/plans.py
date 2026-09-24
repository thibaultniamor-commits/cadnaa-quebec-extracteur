"""Plans importés pour le calage : PDF (page rendue en image) ou DXF (polylignes du modèle).

Coordonnées « plan » renvoyées au navigateur, axe y vers le haut :
  - PDF : pixels de l'image rendue, (colonne, -ligne) ;
  - DXF : unités du dessin, décalées de `offset` pour garder des nombres petits.
"""
import io
import math

import numpy as np

MAX_PX = 7000              # côté max de l'image rendue d'une page PDF
MAX_DPI = 300
MAX_DXF_POINTS = 600_000
MAX_INSERT_DEPTH = 6

# $INSUNITS -> mètres par unité de dessin (0 = sans unité : échelle inconnue).
DXF_UNITS = {1: ("po", 0.0254), 2: ("pi", 0.3048), 4: ("mm", 0.001), 5: ("cm", 0.01), 6: ("m", 1.0),
             14: ("dm", 0.1)}
DXF_CURVES = {"LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"}


def kind_of(data: bytes, name: str) -> str:
    if data[:5] == b"%PDF-":
        return "pdf"
    if name.lower().endswith(".dxf"):
        return "dxf"
    if name.lower().endswith(".dwg") or data[:4] == b"AC10":
        raise ValueError("Format DWG non lu : exporter le plan en DXF depuis le logiciel de DAO.")
    raise ValueError("Format non reconnu : fournir un PDF ou un DXF.")


# ---------- PDF ----------

def pdf_pages(data: bytes) -> list[dict]:
    """Taille et résolution de rendu de chaque page (le rendu lui-même est fait à la demande)."""
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        raise ValueError(f"PDF illisible ({e}).") from e
    pages = []
    for i in range(len(pdf)):
        w, h = pdf[i].get_size()  # points (1/72 po)
        dpi = min(MAX_DPI, MAX_PX / max(w, h, 1) * 72)
        pages.append({"dpi": round(dpi, 3), "w_mm": round(w / 72 * 25.4), "h_mm": round(h / 72 * 25.4)})
    pdf.close()
    if not pages:
        raise ValueError("PDF sans page.")
    return pages


def pdf_render(data: bytes, page: int, dpi: float) -> bytes:
    """Page rendue en PNG (fond blanc)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        img = pdf[page].render(scale=dpi / 72, may_draw_forms=True).to_pil()
    finally:
        pdf.close()
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG", compress_level=3)
    return buf.getvalue()


# ---------- DXF ----------

def _entities(entities, layer=None, depth=0):
    """Courbes du dessin, blocs éclatés ; une entité de bloc sur le calque 0 prend le calque de l'insertion."""
    for e in entities:
        t = e.dxftype()
        own = e.dxf.get("layer", "0")
        lay = layer if (layer is not None and own == "0") else own
        if t == "INSERT":
            if depth < MAX_INSERT_DEPTH:
                try:
                    yield from _entities(e.virtual_entities(), lay, depth + 1)
                except Exception:  # noqa: BLE001 - bloc défectueux : ignoré
                    continue
        elif t in DXF_CURVES:
            yield e, lay


def dxf_read(data: bytes) -> dict:
    """Polylignes 2D de l'espace objet, courbes aplaties, regroupées par calque."""
    import ezdxf.path
    from ezdxf import recover

    try:
        doc, _ = recover.read(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001 - message clair pour l'utilisateur
        raise ValueError(f"DXF illisible ({type(e).__name__}).") from e

    paths = []
    for e, layer in _entities(doc.modelspace()):
        try:
            p = ezdxf.path.make_path(e)
        except Exception:  # noqa: BLE001 - entité non convertible : ignorée
            continue
        if len(p):
            closed = e.dxftype() == "CIRCLE" or bool(getattr(e, "closed", False) or getattr(e, "is_closed", False))
            paths.append((layer, p, closed))
    if not paths:
        raise ValueError("Aucune ligne dans l'espace objet du DXF.")

    # Emprise robuste (les entités parasites loin du dessin ne doivent pas fixer la tolérance).
    ctrl = np.array([(v.x, v.y) for _, p, _ in paths for v in p.control_vertices()])
    lo, hi = np.percentile(ctrl, 1, axis=0), np.percentile(ctrl, 99, axis=0)
    diag = float(np.hypot(*(hi - lo))) or 1.0
    tol = diag / 20000
    x0, y0 = float(np.floor(lo[0])), float(np.floor(lo[1]))
    nd = max(0, 6 - int(math.floor(math.log10(diag))))  # décimales : ~1e-6 de l'emprise

    layers, lines, npts = {}, [], 0
    for layer, p, closed in paths:
        for sub in p.sub_paths():
            pts = [(v.x, v.y) for v in sub.flattening(distance=tol)]
            if len(pts) < 2:
                continue
            if closed and pts[0] != pts[-1]:
                pts.append(pts[0])
            closed_now = len(pts) >= 4 and math.isclose(pts[0][0], pts[-1][0]) and math.isclose(pts[0][1], pts[-1][1])
            idx = layers.setdefault(layer, len(layers))
            flat = [idx, int(closed_now)]
            for x, y in pts:
                flat += (round(x - x0, nd), round(y - y0, nd))
            lines.append(flat)
            npts += len(pts)
            if npts > MAX_DXF_POINTS:
                raise ValueError(f"DXF trop lourd (plus de {MAX_DXF_POINTS:,} points) : purger le dessin "
                                 "(hachures, blocs de mobilier, références externes) ou n'exporter que le plan "
                                 "de masse.".replace(",", " "))

    counts = [0] * len(layers)
    for line in lines:
        counts[line[0]] += 1
    units = DXF_UNITS.get(doc.header.get("$INSUNITS", 0))
    return {
        "kind": "dxf",
        "layers": [{"name": n, "n": counts[i]} for n, i in layers.items()],
        "lines": lines,
        "offset": [x0, y0],
        "bbox": [float(lo[0] - x0), float(lo[1] - y0), float(hi[0] - x0), float(hi[1] - y0)],
        "units": units[0] if units else None,
        "unit_m": units[1] if units else None,
        "points": npts,
    }
