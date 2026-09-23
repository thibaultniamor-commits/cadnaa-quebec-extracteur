"""Systèmes de coordonnées de sortie (métriques, adaptés au Québec)."""
from pyproj import CRS

# Emprise approximative du Québec (lon/lat) pour valider la zone demandée.
QC_BOUNDS = (-79.8, 44.99, -57.1, 62.6)

LAMBERT_QC = 32198  # NAD83 / Quebec Lambert


def mtm_zone(lon: float) -> int:
    """Zone MTM (3 à 10) contenant la longitude ; chaque zone fait 3° de large à partir de -57°."""
    zone = int((-lon - 57.0) // 3) + 3
    return min(max(zone, 3), 10)


def mtm_epsg(zone: int) -> int:
    """NAD83(CSRS) / MTM zone 3..10 -> EPSG:2945..2952."""
    return 2942 + zone


def resolve(choice: str, lon: float) -> int:
    """choice : 'auto', 'mtm3'..'mtm10' ou 'lambert'."""
    if choice in ("auto", "", None):
        return mtm_epsg(mtm_zone(lon))
    if choice == "lambert":
        return LAMBERT_QC
    if choice.startswith("mtm"):
        return mtm_epsg(int(choice[3:]))
    raise ValueError(f"Système de coordonnées inconnu : {choice}")


def name(epsg: int) -> str:
    return CRS.from_epsg(epsg).name


def in_quebec(lon: float, lat: float) -> bool:
    x0, y0, x1, y1 = QC_BOUNDS
    return x0 <= lon <= x1 and y0 <= lat <= y1
