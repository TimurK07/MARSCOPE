"""Checks for the terrain preparation maths. Run: python scripts/test_prepare_terrain.py"""

from __future__ import annotations

import math

import numpy as np

from prepare_terrain import ELEV_SCALE, SLOPE_LIMIT_DEG, SLOPE_SCALE, subcell_counts

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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
