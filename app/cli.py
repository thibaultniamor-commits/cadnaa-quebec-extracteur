"""Extraction en ligne de commande (tests) :
python -m app.cli --bbox -71.23 46.80 -71.20 46.82 --layers topo batiments routes
"""
import argparse
import json
from pathlib import Path

from shapely.geometry import box, mapping

from .pipeline import LAYERS, Options, run


def main():
    p = argparse.ArgumentParser(description="Extraction CadnaA - Québec")
    p.add_argument("--bbox", nargs=4, type=float, metavar=("OUEST", "SUD", "EST", "NORD"), required=True)
    p.add_argument("--layers", nargs="+", default=list(LAYERS), choices=LAYERS)
    p.add_argument("--interval", type=float, default=1.0, help="Équidistance des courbes (m)")
    p.add_argument("--resolution", type=float, default=None, help="Résolution du MNT (m), auto par défaut")
    p.add_argument("--default-height", type=float, default=6.0)
    p.add_argument("--crs", default="auto")
    p.add_argument("--dem-grid", action="store_true")
    p.add_argument("--no-traffic", action="store_true", help="Ne pas rattacher les débits MTMD")
    p.add_argument("--dem-source", default="foretouverte", choices=("foretouverte", "hrdem"),
                   help="MNT LiDAR : Forêt ouverte (MRNF, CGVD28) ou HRDEM (RNCan, CGVD2013)")
    p.add_argument("--out", default="output")
    a = p.parse_args()
    opts = Options(geometry=mapping(box(*a.bbox)), layers=a.layers, contour_interval=a.interval,
                   dem_resolution=a.resolution, default_height=a.default_height, crs=a.crs, dem_grid=a.dem_grid,
                   traffic=not a.no_traffic, dem_source=a.dem_source)
    zip_path, summary = run(opts, Path(a.out), progress=print)
    print(zip_path)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
