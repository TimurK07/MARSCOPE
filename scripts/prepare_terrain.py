"""Prepare terrain grids for the MARSCOPE study area (Mount Sharp, Gale crater).

Source: MRO HiRISE "Gale Crater DEM" (1 m posts, layer Gale_DEM_SMG_1m), served
by NASA JPL Mars Trek as an ArcGIS ImageServer.

One export of the DEM is used: the source grid, 4096 x 4096 pixels of about 1 m
(1.009 m; the DEM's own posts are 1.000 m), fetched as 16 tiles. Everything else
is derived from it here:

  routing grid  1024 x 1024 cells of about 4 m. The elevation of a cell is the
                mean of its own 4 x 4 source pixels, so it describes exactly the
                ground the cell covers. Slope is computed on that grid and drives
                the route search and the hard 20 degree limit.
  subcell grid  per routing cell, how many of its 16 source pixels are steeper
                than the limit. Used only to show what the 4 m grid hides.

Why the routing grid is not requested from the server: asked for the whole area
at 1024 x 1024, the server does not return the value at each cell centre. It
returns the value at the centre of the north-west source pixel of each cell,
1.5 m north and 1.5 m west of where the cell is. That put elevation and slope out
of step with the subcell grid, the imagery and every coordinate in the app. The
near-native 4096 x 4096 export is placed correctly (checked against the DEM's
native pixels), so the routing grid is now built from it.

Usage:
    python scripts/prepare_terrain.py

Outputs (app/public/data/gale/):
    elevation_2cm.bin  uint16 little-endian, value = (elevation_m - elev_min) / elev_scale
    slope_cdeg.bin     uint16 little-endian, value = ceil(slope_deg / slope_scale) (65535 = no data)
    subcell.bin        uint8 pairs per cell: [steep source pixels, valid source pixels], each 0..16
    meta.json          grid geometry, scales and provenance

Scales, for reading the numbers
    Cell slope is a central difference between neighbouring cells: a baseline of
    two cells, about 8 m. Subcell slope is the same over two source pixels, about
    2 m. The step between two cells that the planner also limits is about 4 m
    (5.7 m diagonally).

What the data can and cannot show
    The DEM is a stereo product with 1 m posts; features smaller than a few metres
    (rocks, ledges, loose ground) are not resolved. The subcell metric counts 1 m
    pixels steeper than the limit. It is a measure of how rough a cell is, not a
    probability of a fall, and it cannot find hazards the DEM does not contain.
"""

from __future__ import annotations

import json
import math
import time
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
SIZE = 1024  # routing cells per side
SUB = 4  # source pixels per routing cell, per side
SRC = SIZE * SUB  # source pixels per side

MARS_RADIUS_M = 3_396_190.0  # Mars 2000 sphere (IAU), same as the DEM's CRS 104905
SLOPE_LIMIT_DEG = 20.0  # hard limit used by the planner (NASA EVA-EXP-0075)

# 2 cm steps. With 10 cm steps the grade of a single 4 m step was off by up to
# 1.4 degrees, which moved walking speed by 4% on a typical step and 23% on a bad
# one. 2 cm keeps that under 0.3 degrees and still fits the area's 924 m of relief
# in 16 bits.
ELEV_SCALE = 0.02
# Slope is stored rounded UP to the next step, so a stored value is never below the
# true slope: a cell just over the limit can never be read as walkable.
SLOPE_SCALE = 0.01
SLOPE_NODATA = 65535


def export_url(west: float, south: float, east: float, north: float, size: int) -> str:
    params = {
        "bbox": f"{west},{south},{east},{north}",
        "bboxSR": "104905",
        "size": f"{size},{size}",
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": "RSP_BilinearInterpolation",
        "f": "image",
    }
    return f"{SERVICE}/exportImage?{urllib.parse.urlencode(params)}"


def fetch(url: str, path: Path, tries: int = 5) -> None:
    """Downloads once and keeps the file. A short or failed download is retried, never kept."""
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + ".part")
    for attempt in range(1, tries + 1):
        try:
            print(f"Downloading {path.name}" + (f" (attempt {attempt})" if attempt > 1 else ""))
            with urllib.request.urlopen(url, timeout=120) as r:
                expected = int(r.headers.get("Content-Length") or 0)
                data = r.read()
            if expected and len(data) != expected:
                raise IOError(f"got {len(data)} of {expected} bytes")
            part.write_bytes(data)
            part.replace(path)
            return
        except Exception as err:  # network errors and short reads alike
            print(f"  failed: {err}")
            time.sleep(2 * attempt)
    raise SystemExit(f"Could not download {path.name}")


def read_tiff(path: Path) -> np.ndarray:
    a = tifffile.imread(path).astype(np.float64)
    return a[..., 0] if a.ndim == 3 else a


def valid_mask(dem: np.ndarray) -> np.ndarray:
    """Anything outside a plausible Mars elevation range is treated as no data."""
    return np.isfinite(dem) & (dem > -9000) & (dem < 22000)


def slope_degrees(dem: np.ndarray, cell_y: float, cell_x: float) -> np.ndarray:
    dz_dy, dz_dx = np.gradient(dem, cell_y, cell_x)
    return np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))


def load_source() -> np.ndarray:
    """The DEM at about 1 m, fetched as a 4 x 4 mosaic of tiles so each request stays small."""
    n = 4
    tile = SRC // n
    d_lon = (EAST - WEST) / n
    d_lat = (NORTH - SOUTH) / n
    out = np.empty((SRC, SRC), dtype=np.float64)
    for row in range(n):  # north to south
        for col in range(n):
            box = (WEST + col * d_lon, NORTH - (row + 1) * d_lat, WEST + (col + 1) * d_lon, NORTH - row * d_lat)
            path = RAW_DIR / f"gale_dem_1m_r{row}c{col}.tif"
            fetch(export_url(*box, tile), path)
            a = read_tiff(path)
            assert a.shape == (tile, tile), a.shape
            out[row * tile : (row + 1) * tile, col * tile : (col + 1) * tile] = a
    return out


def subcell_counts(src: np.ndarray, cell_y: float, cell_x: float, sub: int = SUB) -> tuple[np.ndarray, np.ndarray]:
    """Per routing cell: how many of its source pixels are steeper than the limit, and how many are valid.

    src holds sub x sub source pixels per routing cell. Slope at a source pixel is
    a central difference, so it spans two pixels (about 2 m); on the outer edge of
    the grid it is one-sided. A pixel next to missing data is itself counted as
    missing, because its slope would be computed from an invalid neighbour.
    """
    rows, cols = src.shape[0] // sub, src.shape[1] // sub
    valid = valid_mask(src)
    filled = np.where(valid, src, np.nan)
    slope = slope_degrees(filled, cell_y / sub, cell_x / sub)
    # A central difference never reads the pixel itself, so the pixel's own validity is checked too.
    ok = valid & np.isfinite(slope)
    steep = ok & (slope > SLOPE_LIMIT_DEG)
    blocks = lambda a: a.reshape(rows, sub, cols, sub).sum(axis=(1, 3)).astype(np.uint8)
    return blocks(steep), blocks(ok)


def block_mean(src: np.ndarray, sub: int = SUB) -> tuple[np.ndarray, np.ndarray]:
    """Routing-grid elevation: the mean of each cell's own sub x sub source pixels.

    Returns (elevation, valid). A cell is valid only if every one of its source
    pixels is: a cell that is partly unknown is not given a height from the part
    that happens to be known. Invalid cells come back as NaN.
    """
    rows, cols = src.shape[0] // sub, src.shape[1] // sub
    ok = valid_mask(src).reshape(rows, sub, cols, sub).all(axis=(1, 3))
    blocks = np.where(valid_mask(src), src, 0.0).reshape(rows, sub, cols, sub)
    mean = blocks.mean(axis=(1, 3))
    return np.where(ok, mean, np.nan), ok


def encode_elevation(dem: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Elevation in ELEV_SCALE steps above the lowest valid cell. Invalid cells are stored as 0."""
    elev_min = float(dem[valid].min())
    elev_max = float(dem[valid].max())
    assert (elev_max - elev_min) / ELEV_SCALE < 65535, "relief does not fit the elevation encoding"
    filled = np.where(valid, dem, elev_min)
    u16 = np.clip(np.round((filled - elev_min) / ELEV_SCALE), 0, 65535).astype("<u2")
    assert np.abs(u16[valid] * ELEV_SCALE + elev_min - dem[valid]).max() <= ELEV_SCALE / 2 + 1e-9
    return u16, elev_min, elev_max


def cell_slope(dem: np.ndarray, valid: np.ndarray, cell_y: float, cell_x: float) -> np.ndarray:
    """Slope of the routing grid in degrees: a central difference between neighbouring cells.

    Invalid cells are filled with the lowest elevation first. That makes the slope
    next to missing data very large, so ground beside a hole is never read as gentle.
    """
    filled = np.where(valid, dem, float(dem[valid].min()))
    return slope_degrees(filled, cell_y, cell_x)


def encode_slope(slope_deg: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Slope in SLOPE_SCALE steps, rounded up; SLOPE_NODATA where there is no data."""
    u16 = np.minimum(np.ceil(slope_deg / SLOPE_SCALE - 1e-9), SLOPE_NODATA - 1).astype("<u2")
    u16[~valid] = SLOPE_NODATA
    # The encoding must be conservative everywhere there is data.
    assert np.all(u16[valid] * SLOPE_SCALE >= slope_deg[valid] - 1e-6)
    return u16


def cell_size_m() -> tuple[float, float]:
    """Size of a routing cell in metres (east-west, north-south). Rows run north -> south."""
    lat_mid = math.radians((SOUTH + NORTH) / 2)
    m_per_deg = math.pi * MARS_RADIUS_M / 180.0
    cell_y = (NORTH - SOUTH) / SIZE * m_per_deg
    cell_x = (EAST - WEST) / SIZE * m_per_deg * math.cos(lat_mid)
    return cell_x, cell_y


def main() -> None:
    t0 = time.time()
    cell_x, cell_y = cell_size_m()
    print(f"cell size: {cell_x:.3f} m (E-W) x {cell_y:.3f} m (N-S)")

    # The source grid, and the routing grid as the mean of each cell's own 4 x 4 pixels.
    src = load_source()
    dem, valid = block_mean(src)
    assert dem.shape == (SIZE, SIZE), dem.shape
    print(f"valid cells: {valid.mean() * 100:.2f}%")

    elev_u16, elev_min, elev_max = encode_elevation(dem, valid)
    print(f"elevation range: {elev_min:.1f} .. {elev_max:.1f} m")

    slope_deg = cell_slope(dem, valid, cell_y, cell_x)
    print(
        "slope percentiles (50/90/99): "
        + ", ".join(f"{np.percentile(slope_deg[valid], p):.1f}" for p in (50, 90, 99))
    )
    slope_u16 = encode_slope(slope_deg, valid)
    above = int(((slope_deg > SLOPE_LIMIT_DEG) & valid).sum())
    read_above = int(((slope_u16 * SLOPE_SCALE > SLOPE_LIMIT_DEG) & valid).sum())
    assert read_above >= above
    print(f"cells above {SLOPE_LIMIT_DEG:g} deg: {above} true, {read_above} as stored")

    # Steep ground hidden inside cells, from the same source pixels.
    steep, ok = subcell_counts(src, cell_y, cell_x)
    walkable = valid & (slope_deg <= SLOPE_LIMIT_DEG)
    some = walkable & (steep > 0)
    half = walkable & (steep * 2 >= np.maximum(ok, 1)) & (ok > 0)
    print(f"source pixels: {(SRC * SRC):,}, valid for slope {ok.sum() / (SRC * SRC) * 100:.2f}%")
    print(
        f"walkable cells: {int(walkable.sum()):,}; with any 1 m pixel over the limit: "
        f"{some.sum() / walkable.sum() * 100:.1f}%; with half or more: {half.sum() / walkable.sum() * 100:.1f}%"
    )
    subcell = np.stack([steep, ok], axis=-1)  # interleaved pairs

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    elev_u16.tofile(OUT_DIR / "elevation_2cm.bin")
    slope_u16.tofile(OUT_DIR / "slope_cdeg.bin")
    subcell.tofile(OUT_DIR / "subcell.bin")

    meta = {
        "name": "Mount Sharp study area, Gale crater",
        "bbox": {"west": WEST, "south": SOUTH, "east": EAST, "north": NORTH},
        "width": SIZE,
        "height": SIZE,
        "cellSizeX_m": cell_x,
        "cellSizeY_m": cell_y,
        "elevation": {
            "file": "elevation_2cm.bin",
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
        "subcell": {
            "file": "subcell.bin",
            "dtype": "uint8 pairs: steep, valid",
            "pixelsPerCell": SUB * SUB,
            "limit_deg": SLOPE_LIMIT_DEG,
            "pixel_m": cell_x / SUB,
            "note": "Derived metric: count of ~1 m source pixels in each cell whose slope exceeds the limit. Not a hazard probability.",
        },
        "crs": "Mars 2000 sphere (ESRI:104905), planetocentric lat, east-positive lon",
        "method": {
            "elevation": f"mean of each cell's {SUB} x {SUB} source pixels",
            "slope": "central difference between neighbouring cells (two-cell baseline), in degrees, stored rounded up",
            "sourceGrid": f"{SRC} x {SRC} pixels over the same bounding box, exported in 16 tiles with bilinear interpolation",
        },
        "source": {
            "dataset": "MRO HiRISE, Gale Crater DEM (Gale_DEM_SMG_1m), 1 m/px",
            "provider": "NASA JPL Mars Trek",
            "url": export_url(WEST, NORTH - (NORTH - SOUTH) / 4, WEST + (EAST - WEST) / 4, NORTH, SRC // 4),
            "urlNote": "first of 16 tiles (4 x 4, north-west first); the others shift the bbox by a quarter of the area",
            "retrieved": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        },
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {OUT_DIR} in {time.time() - t0:.1f} s")


if __name__ == "__main__":
    main()
