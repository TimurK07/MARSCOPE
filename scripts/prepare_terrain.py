"""Prepare terrain grids for the MARSCOPE study area (Mount Sharp, Gale crater).

Source: MRO HiRISE "Gale Crater DEM" (1 m/px, layer Gale_DEM_SMG_1m), served by
NASA JPL Mars Trek as an ArcGIS ImageServer. We export a patch of the DEM,
compute slope, and write compact binary grids the web app loads directly.

Usage:
    python scripts/prepare_terrain.py

Outputs (app/public/data/gale/):
    elevation.bin  uint16 little-endian, value = (elevation_m - elev_min) / elev_scale
    slope_cdeg.bin uint16 little-endian, value = ceil(slope_deg / slope_scale) (65535 = no data)
    meta.json      grid geometry, scales and provenance
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import tifffile

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DIR = ROOT / "app" / "public" / "data" / "gale"

SERVICE = "https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer"

# Study area (planetocentric degrees, east-positive longitude).
# Covers Curiosity's recent traverse on Mount Sharp, including the boxwork region.
WEST, SOUTH, EAST, NORTH = 137.355, -4.860, 137.425, -4.790
SIZE = 1024  # pixels per side

MARS_RADIUS_M = 3_396_190.0  # Mars 2000 sphere (IAU), same as the DEM's CRS 104905
ELEV_SCALE = 0.1  # metres per uint16 step
# Slope is stored rounded UP to the next step, so a stored value is never below the
# true slope: a cell just over the 20 degree limit can never be read as walkable.
SLOPE_SCALE = 0.01  # degrees per uint16 step
SLOPE_NODATA = 65535


def download_dem(path: Path) -> str:
    params = {
        "bbox": f"{WEST},{SOUTH},{EAST},{NORTH}",
        "bboxSR": "104905",
        "size": f"{SIZE},{SIZE}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    url = f"{SERVICE}/exportImage?{urllib.parse.urlencode(params)}"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading DEM patch from Mars Trek -> {path.name}")
        urllib.request.urlretrieve(url, path)
    return url


def main() -> None:
    raw_path = RAW_DIR / "gale_dem_patch.tif"
    url = download_dem(raw_path)

    dem = tifffile.imread(raw_path).astype(np.float64)
    if dem.ndim == 3:
        dem = dem[..., 0]
    assert dem.shape == (SIZE, SIZE), dem.shape

    # Anything outside a plausible Mars elevation range is treated as no data.
    valid = np.isfinite(dem) & (dem > -9000) & (dem < 22000)
    print(f"valid cells: {valid.mean() * 100:.2f}%")
    elev_min = float(dem[valid].min())
    elev_max = float(dem[valid].max())
    print(f"elevation range: {elev_min:.1f} .. {elev_max:.1f} m")

    # Cell size in metres. Rows run north -> south, columns west -> east.
    lat_mid = math.radians((SOUTH + NORTH) / 2)
    m_per_deg = math.pi * MARS_RADIUS_M / 180.0
    cell_y = (NORTH - SOUTH) / SIZE * m_per_deg
    cell_x = (EAST - WEST) / SIZE * m_per_deg * math.cos(lat_mid)
    print(f"cell size: {cell_x:.3f} m (E-W) x {cell_y:.3f} m (N-S)")

    filled = np.where(valid, dem, elev_min)
    dz_dy, dz_dx = np.gradient(filled, cell_y, cell_x)
    slope_deg = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    print(
        "slope percentiles (50/90/99): "
        + ", ".join(f"{np.percentile(slope_deg[valid], p):.1f}" for p in (50, 90, 99))
    )

    elev_u16 = np.clip(np.round((filled - elev_min) / ELEV_SCALE), 0, 65535).astype("<u2")
    slope_u16 = np.minimum(np.ceil(slope_deg / SLOPE_SCALE - 1e-9), SLOPE_NODATA - 1).astype("<u2")
    slope_u16[~valid] = SLOPE_NODATA
    # The encoding must be conservative everywhere there is data.
    assert np.all(slope_u16[valid] * SLOPE_SCALE >= slope_deg[valid] - 1e-6)
    above = int(((slope_deg > 20.0) & valid).sum())
    read_above = int(((slope_u16 * SLOPE_SCALE > 20.0) & valid).sum())
    assert read_above >= above
    print(f"cells above 20 deg: {above} true, {read_above} as stored")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    elev_u16.tofile(OUT_DIR / "elevation.bin")
    slope_u16.tofile(OUT_DIR / "slope_cdeg.bin")

    meta = {
        "name": "Mount Sharp study area, Gale crater",
        "bbox": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
        "width": SIZE,
        "height": SIZE,
        "cellSizeX_m": cell_x,
        "cellSizeY_m": cell_y,
        "elevation": {
            "file": "elevation.bin",
            "dtype": "uint16-le",
            "min_m": elev_min,
            "max_m": elev_max,
            "scale_m": ELEV_SCALE,
        },
        "slope": {
            "file": "slope_cdeg.bin",
            "dtype": "uint16-le",
            "scale_deg": SLOPE_SCALE,
            "nodata": SLOPE_NODATA,
        },
        "crs": "Mars 2000 sphere (ESRI:104905), planetocentric lat, east-positive lon",
        "source": {
            "dataset": "MRO HiRISE, Gale Crater DEM (Gale_DEM_SMG_1m), 1 m/px",
            "provider": "NASA JPL Mars Trek",
            "url": url,
            "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        },
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {OUT_DIR}")


if __name__ == "__main__":
    main()
