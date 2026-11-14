"""Checks for the terrain preparation maths and for the grids it produced.

Run: python scripts/test_prepare_terrain.py

The first group needs nothing but numpy. The second group compares the grids
shipped with the app (app/public/data/gale/) with the 1 m source tiles in
data/raw/. Those tiles are not committed; when they are absent the comparison is
skipped and says so. Run scripts/prepare_terrain.py once to fetch them.
"""

from __future__ import annotations

import json
import math

import numpy as np

import prepare_terrain as pt
from prepare_terrain import (
    ELEV_SCALE,
    SLOPE_LIMIT_DEG,
    SLOPE_SCALE,
    block_mean,
    cell_slope,
    encode_elevation,
    encode_slope,
    subcell_counts,
)

PIX = 1.0  # metres per source pixel in these tests
SUB = 4


def ramp(rows: int, cols: int, deg: float, axis: int = 1) -> np.ndarray:
    """A plane rising at a constant slope along one axis."""
    step = math.tan(math.radians(deg)) * PIX
    y, x = np.mgrid[0:rows, 0:cols]
    return (x if axis == 1 else y) * step - 3000.0


def counts(src: np.ndarray):
    return subcell_counts(src, PIX * SUB, PIX * SUB, SUB)


def test_flat_ground_has_no_steep_pixels():
    steep, valid = counts(np.full((16, 16), -3000.0))
    assert steep.shape == (4, 4)
    assert steep.sum() == 0
    assert (valid == 16).all()


def test_slopes_around_the_limit():
    # Exactly 20.0 is left out: a ramp built with tan() and read back with arctan() lands
    # a rounding error above or below it.
    for deg, expect_steep in ((19.9, False), (19.99, False), (20.01, True), (25.0, True)):
        steep, valid = counts(ramp(16, 16, deg))
        assert (valid == 16).all()
        assert bool((steep == 16).all()) is expect_steep, deg
        assert bool((steep == 0).all()) is (not expect_steep), deg
    assert SLOPE_LIMIT_DEG == 20.0


def test_a_steep_strip_inside_one_cell_is_counted_there():
    src = np.full((16, 16), -3000.0)
    # A 2 m high step between source columns 5 and 6, inside routing column 1.
    src[:, 6:] += 2.0
    steep, valid = counts(src)
    assert (valid == 16).all()
    # The central difference sees the step at columns 5 and 6: two pixels per source row.
    assert (steep[:, 1] == 8).all()
    assert steep[:, 0].sum() == 0 and steep[:, 2:].sum() == 0


def test_hidden_steepness_is_invisible_at_cell_scale():
    """The reason the metric exists: a narrow step vanishes when averaged over a cell."""
    src = np.full((16, 16), -3000.0)
    src[:, 6:8] += 1.5  # a 2 m wide, 1.5 m high ridge
    steep, _ = counts(src)
    cell_mean = src.reshape(4, 4, 4, 4).mean(axis=(1, 3))
    cell_slope = np.degrees(np.arctan(np.abs(np.gradient(cell_mean, PIX * SUB, axis=1))))
    assert cell_slope.max() < SLOPE_LIMIT_DEG
    assert steep[:, 1].min() > 0


def test_missing_pixels_are_not_counted_as_safe():
    src = np.full((16, 16), -3000.0)
    src[5, 5] = np.nan
    steep, valid = counts(src)
    # The missing pixel and its four neighbours have no usable slope.
    assert valid[1, 1] == 16 - 5
    assert steep.sum() == 0
    assert valid.sum() == 16 * 16 - 5

    out_of_range = np.full((16, 16), -3000.0)
    out_of_range[0:4, 0:4] = 1e9  # a whole cell of nonsense values
    _, valid2 = counts(out_of_range)
    assert valid2[0, 0] == 0
    # Pixels bordering the bad cell lose their slope as well.
    assert valid2[0, 1] == 12 and valid2[1, 0] == 12


def test_boundary_cells_are_complete():
    steep, valid = counts(ramp(16, 16, 30.0, axis=0))
    # One-sided differences on the outer edge still give every pixel a slope.
    assert (valid == 16).all()
    assert (steep == 16).all()
    assert steep.dtype == np.uint8 and valid.dtype == np.uint8


def test_encodings():
    # Elevation: within half a step.
    z = np.array([-3865.47, -3400.013, -2941.9])
    q = np.round((z - z.min()) / ELEV_SCALE) * ELEV_SCALE + z.min()
    assert np.abs(q - z).max() <= ELEV_SCALE / 2 + 1e-9
    assert (z.max() - z.min()) / ELEV_SCALE < 65535
    # Slope: rounded up, never down.
    for s in (19.999, 20.0, 20.001, 20.25):
        stored = math.ceil(s / SLOPE_SCALE - 1e-9) * SLOPE_SCALE
        assert stored >= s - 1e-9
        assert (stored > SLOPE_LIMIT_DEG) == (s > SLOPE_LIMIT_DEG + 1e-9), s


# ---- the routing grid: block means, placement and slope


def test_block_mean_is_the_mean_of_the_cells_own_pixels():
    rng = np.random.default_rng(7)
    src = rng.normal(-3000.0, 5.0, (16, 24))
    mean, valid = block_mean(src, 4)
    assert mean.shape == (4, 6) and valid.all()
    for r in range(4):
        for c in range(6):
            assert abs(mean[r, c] - src[4 * r : 4 * r + 4, 4 * c : 4 * c + 4].mean()) < 1e-9


def test_block_mean_is_centred_on_the_cell():
    """On a plane the mean of a block is the height at the block's centre, not at a corner."""
    y, x = np.mgrid[0:16, 0:16]
    src = -3000.0 + 0.30 * x + 0.10 * y  # height at source pixel centres (x + 0.5, y + 0.5)
    mean, _ = block_mean(src, 4)
    for r in range(4):
        for c in range(4):
            centre = -3000.0 + 0.30 * (4 * c + 1.5) + 0.10 * (4 * r + 1.5)
            north_west_pixel = src[4 * r, 4 * c]
            assert abs(mean[r, c] - centre) < 1e-9
            # The old grid held the north-west pixel: 0.6 m lower on this plane.
            assert abs(mean[r, c] - north_west_pixel - (0.30 + 0.10) * 1.5) < 1e-9


def test_block_mean_keeps_orientation():
    # Rows run north -> south and columns west -> east, as in the source.
    src = np.zeros((8, 8))
    src[0:4, 4:8] = 10.0  # the north-east cell
    mean, _ = block_mean(src, 4)
    assert mean[0, 1] == 10.0 and mean[0, 0] == 0.0 and mean[1, 0] == 0.0 and mean[1, 1] == 0.0


def test_a_cell_with_any_missing_pixel_is_missing():
    src = np.full((8, 8), -3000.0)
    src[1, 1] = np.nan
    src[5, 6] = 1e9
    mean, valid = block_mean(src, 4)
    assert valid.tolist() == [[False, True], [True, False]]
    assert np.isnan(mean[0, 0]) and np.isnan(mean[1, 1])
    assert mean[0, 1] == -3000.0


def test_cell_slope_of_a_plane():
    # 4 m cells on a plane tilted 12 degrees to the east and 5 degrees to the south.
    gx, gy = math.tan(math.radians(12.0)), math.tan(math.radians(5.0))
    y, x = np.mgrid[0:12, 0:12]
    dem = -3000.0 + gx * 4.0 * x + gy * 4.0 * y
    s = cell_slope(dem, np.ones_like(dem, bool), 4.0, 4.0)
    assert np.allclose(s, math.degrees(math.atan(math.hypot(gx, gy))), atol=1e-9)


def test_cell_slope_uses_the_two_neighbours_not_the_cell_itself():
    """The baseline is two cells: a spike in one cell tilts its neighbours, not itself."""
    dem = np.full((7, 7), -3000.0)
    dem[3, 3] += 2.0
    s = cell_slope(dem, np.ones_like(dem, bool), 4.0, 4.0)
    assert s[3, 3] == 0.0
    assert abs(s[3, 2] - math.degrees(math.atan(2.0 / 8.0))) < 1e-9


def test_ground_beside_missing_data_is_never_gentle():
    dem = np.full((6, 6), -3000.0)
    valid = np.ones_like(dem, bool)
    dem[2, 2] = np.nan
    valid[2, 2] = False
    dem[0, 0] = -3600.0  # the lowest valid cell, far below
    stored = encode_slope(cell_slope(dem, valid, 4.0, 4.0), valid)
    assert stored[2, 2] == pt.SLOPE_NODATA
    for r, c in ((2, 1), (2, 3), (1, 2), (3, 2)):
        assert stored[r, c] * SLOPE_SCALE > SLOPE_LIMIT_DEG


def test_encoders_round_the_safe_way():
    rng = np.random.default_rng(3)
    dem = rng.normal(-3400.0, 80.0, (40, 40))
    valid = np.ones_like(dem, bool)
    u16, lo, hi = encode_elevation(dem, valid)
    assert np.abs(u16 * ELEV_SCALE + lo - dem).max() <= ELEV_SCALE / 2 + 1e-9
    assert lo == dem.min() and hi == dem.max()
    slope = cell_slope(dem, valid, 4.0, 4.0)
    stored = encode_slope(slope, valid) * SLOPE_SCALE
    assert (stored >= slope - 1e-9).all() and (stored - slope).max() <= SLOPE_SCALE + 1e-9
    # No cell over the limit reads as within it.
    assert not ((slope > SLOPE_LIMIT_DEG) & (stored <= SLOPE_LIMIT_DEG)).any()


# ---- the grids shipped with the app, against the source tiles


def _shipped():
    meta = json.loads((pt.OUT_DIR / "meta.json").read_text())
    n = meta["width"]
    elev = np.fromfile(pt.OUT_DIR / meta["elevation"]["file"], "<u2").reshape(n, n) * meta["elevation"]["scale_m"] + meta["elevation"]["min_m"]
    slope = np.fromfile(pt.OUT_DIR / meta["slope"]["file"], "<u2").reshape(n, n)
    sub = np.fromfile(pt.OUT_DIR / meta["subcell"]["file"], np.uint8).reshape(n, n, 2)
    return meta, elev, slope, sub


def _source_or_none():
    tiles = [pt.RAW_DIR / f"gale_dem_1m_r{r}c{c}.tif" for r in range(4) for c in range(4)]
    if not all(t.exists() for t in tiles):
        return None
    return pt.load_source()


def test_shipped_grid_dimensions_and_metadata():
    meta, elev, slope, sub = _shipped()
    assert meta["width"] == meta["height"] == pt.SIZE
    assert meta["bbox"] == {"west": pt.WEST, "south": pt.SOUTH, "east": pt.EAST, "north": pt.NORTH}
    assert meta["elevation"]["scale_m"] == ELEV_SCALE and meta["slope"]["scale_deg"] == SLOPE_SCALE
    assert meta["subcell"]["pixelsPerCell"] == pt.SUB * pt.SUB
    cx, cy = pt.cell_size_m()
    assert abs(meta["cellSizeX_m"] - cx) < 1e-9 and abs(meta["cellSizeY_m"] - cy) < 1e-9
    assert "mean of each cell" in meta["method"]["elevation"]


def test_shipped_slope_is_the_slope_of_the_shipped_elevation():
    """Needs no source tiles: slope and elevation in the app must belong to the same grid."""
    meta, elev, slope, _ = _shipped()
    valid = slope != pt.SLOPE_NODATA
    again = cell_slope(elev, valid, meta["cellSizeY_m"], meta["cellSizeX_m"])
    stored = slope * SLOPE_SCALE
    # Elevation is stored in 2 cm steps: up to 1 cm off per cell. A difference over two cells
    # (8 m) is then off by up to 2 cm on each axis, which moves the slope by at most 0.21 degrees;
    # on the outer edge the difference is one-sided (4 m) and the bound doubles. Rounding up adds 0.01.
    diff = np.abs(stored - again)
    assert diff[1:-1, 1:-1][valid[1:-1, 1:-1]].max() < 0.23
    assert diff[valid].max() < 0.45


def test_shipped_elevation_is_the_block_mean_of_the_source():
    src = _source_or_none()
    if src is None:
        return "skipped: source tiles not in data/raw"
    _, elev, _, _ = _shipped()
    mean, valid = block_mean(src)
    assert valid.all()
    assert np.abs(elev - mean).max() <= ELEV_SCALE / 2 + 1e-6


def test_shipped_grid_is_not_offset_from_the_source():
    """The grid must fit the source best where it is, not shifted by a pixel or two in any direction."""
    src = _source_or_none()
    if src is None:
        return "skipped: source tiles not in data/raw"
    _, elev, _, _ = _shipped()
    n = pt.SIZE
    inner = slice(4, n - 4)

    def rms(dy: int, dx: int) -> float:
        # Mean of the 4 x 4 block displaced by (dy, dx) source pixels.
        shifted = np.roll(np.roll(src, -dy, axis=0), -dx, axis=1)
        m, _ = block_mean(shifted)
        return float(np.sqrt(((elev - m)[inner, inner] ** 2).mean()))

    here = rms(0, 0)
    assert here < 0.01
    for dy, dx in ((-2, -2), (-1, 0), (1, 0), (0, -1), (0, 1), (2, 2), (-1, -1), (1, 1)):
        assert rms(dy, dx) > 10 * here + 0.05, (dy, dx)
    # The grid this replaced sat on the north-west pixel of each block: that is no longer a fit.
    north_west = src.reshape(n, 4, n, 4)[:, 0, :, 0]
    assert float(np.sqrt(((elev - north_west) ** 2).mean())) > 0.3


def test_shipped_slope_and_subcell_come_from_the_same_source():
    src = _source_or_none()
    if src is None:
        return "skipped: source tiles not in data/raw"
    meta, _, slope, sub = _shipped()
    cx, cy = meta["cellSizeX_m"], meta["cellSizeY_m"]
    mean, valid = block_mean(src)
    assert np.array_equal(slope, encode_slope(cell_slope(mean, valid, cy, cx), valid))
    steep, ok = subcell_counts(src, cy, cx)
    assert np.array_equal(sub[..., 0], steep) and np.array_equal(sub[..., 1], ok)


def test_cell_slope_and_subcell_steepness_agree_in_place():
    """A placement check that needs no source tiles.

    Where a cell is over the limit, some of its own 1 m pixels almost always are
    too. If the two grids were out of step by a pixel or two this would fail:
    with the earlier, misplaced grid 0.72 % of blocked cells had no steep pixel.
    """
    _, _, slope, sub = _shipped()
    blocked = (slope != pt.SLOPE_NODATA) & (slope * SLOPE_SCALE > SLOPE_LIMIT_DEG)
    no_steep_pixel = blocked & (sub[..., 0] == 0)
    assert no_steep_pixel.sum() / blocked.sum() < 0.002


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    skipped = 0
    for t in tests:
        note = t()
        if isinstance(note, str):
            skipped += 1
            print(f"--  {t.__name__}: {note}")
        else:
            print(f"ok  {t.__name__}")
    print(f"{len(tests) - skipped} passed" + (f", {skipped} skipped" if skipped else ""))
