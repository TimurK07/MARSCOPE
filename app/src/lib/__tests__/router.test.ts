import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG, MAX_SPEED_MS, walkingSpeedMs } from '../model'
import { findLeg as findRoute, isWalkable, walkBack } from '../router'
import { at, CELL, cellOf, makeTerrain, rng } from './synthetic'
import type { Terrain } from '../terrain'

// These tests are about the grid search itself, so they look at its path before straightening.
const findLeg: typeof findRoute = (t, a, b) => findRoute(t, a, b, { smooth: false })

const N = 64
const STEEP = MAX_SLOPE_DEG + 10
const wall = (col: number, gapRow?: number) => (x: number, y: number) => (x === col && y !== gapRow ? STEEP : 0)

/** No cell on the path is blocked, and no diagonal step clips a blocked cell. */
function expectSafe(t: Terrain, path: { lat: number; lon: number }[]) {
  const cells = path.map((p) => cellOf(t, p))
  cells.forEach((c) => expect(isWalkable(t, c.y * t.width + c.x)).toBe(true))
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]
    const b = cells[i]
    expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBe(1)
    if (a.x !== b.x && a.y !== b.y) {
      expect(isWalkable(t, a.y * t.width + b.x)).toBe(true)
      expect(isWalkable(t, b.y * t.width + a.x)).toBe(true)
    }
  }
}

describe('route search: baseline behaviour', () => {
  it('walks straight across flat ground at full speed', () => {
    const t = makeTerrain(N, N, () => 0)
    const res = findLeg(t, at(t, 5, 32), at(t, 55, 32))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.distance).toBeCloseTo(50 * CELL, 5)
    expect(res.leg.duration).toBeCloseTo((50 * CELL) / MAX_SPEED_MS, 5)
    expect(res.leg.ascent).toBe(0)
  })

  it('detours through a gap instead of crossing no-go terrain', () => {
    const t = makeTerrain(N, N, wall(30, 5))
    const res = findLeg(t, at(t, 5, 32), at(t, 55, 32))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.distance).toBeGreaterThan(50 * CELL * 1.3)
    expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
    expectSafe(t, res.leg.samples)
    const crossing = res.leg.samples.map((s) => cellOf(t, s)).filter((c) => c.x === 30)
    expect(crossing.length).toBeGreaterThan(0)
    crossing.forEach((c) => expect(c.y).toBe(5))
  })

  it('reports when a target is cut off', () => {
    const t = makeTerrain(N, N, wall(30))
    expect(findLeg(t, at(t, 5, 32), at(t, 55, 32)).ok).toBe(false)
  })

  it('refuses a target on no-go terrain or outside the grid', () => {
    const t = makeTerrain(N, N, wall(30))
    expect(findLeg(t, at(t, 5, 32), at(t, 30, 32)).ok).toBe(false)
    expect(findLeg(t, at(t, 5, 32), { lat: 5, lon: 5 }).ok).toBe(false)
  })

  it('takes longer uphill than downhill over the same ground', () => {
    // A uniform 5 degree ramp rising to the east.
    const rise = CELL * Math.tan((5 * Math.PI) / 180)
    const t = makeTerrain(N, 8, () => 5, (x) => x * rise)
    const up = findLeg(t, at(t, 5, 4), at(t, 55, 4))
    const down = findLeg(t, at(t, 55, 4), at(t, 5, 4))
    expect(up.ok && down.ok).toBe(true)
    if (!up.ok || !down.ok) return
    expect(up.leg.duration).toBeGreaterThan(down.leg.duration * 1.5)
    expect(up.leg.ascent).toBeCloseTo(down.leg.descent, 5)
  })
})

describe('diagonal corner cutting', () => {
  // 3 x 3 neighbourhood around a diagonal step from (1,1) to (2,2).
  const corner = (blockEast: boolean, blockSouth: boolean) =>
    makeTerrain(8, 8, (x, y) => ((blockEast && x === 2 && y === 1) || (blockSouth && x === 1 && y === 2) ? STEEP : 0))

  it('takes the diagonal when both adjacent cells are free', () => {
    const t = corner(false, false)
    const res = findLeg(t, at(t, 1, 1), at(t, 2, 2))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.samples).toHaveLength(2)
    expect(res.leg.distance).toBeCloseTo(CELL * Math.SQRT2, 5)
  })

  it('goes around when one adjacent cell is blocked', () => {
    const t = corner(true, false)
    const res = findLeg(t, at(t, 1, 1), at(t, 2, 2))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Two straight steps through the free corner cell instead of the diagonal.
    expect(res.leg.samples).toHaveLength(3)
    expect(res.leg.distance).toBeCloseTo(2 * CELL, 5)
    expectSafe(t, res.leg.samples)
  })

  it('does not squeeze between two blocked cells', () => {
    const t = corner(true, true)
    const res = findLeg(t, at(t, 1, 1), at(t, 2, 2))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.samples.length).toBeGreaterThan(3)
    expectSafe(t, res.leg.samples)
  })

  it('cannot pass a diagonal wall whose cells touch only at corners', () => {
    const t = makeTerrain(16, 16, (x, y) => (x === 15 - y ? STEEP : 0))
    expect(findLeg(t, at(t, 2, 2), at(t, 13, 13)).ok).toBe(false)
  })

  it('threads a one-cell-wide corridor with a bend without clipping its walls', () => {
    // Corridor: along row 4 to column 10, then down column 10.
    const t = makeTerrain(20, 20, (x, y) => ((y === 4 && x <= 10) || (x === 10 && y >= 4) ? 0 : STEEP))
    const res = findLeg(t, at(t, 1, 4), at(t, 10, 18))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectSafe(t, res.leg.samples)
    // The bend has to be walked as two straight steps: 9 + 14 cells.
    expect(res.leg.distance).toBeCloseTo(23 * CELL, 5)
  })

  it('stays safe along the edge of the grid', () => {
    const t = makeTerrain(12, 12, (x, y) => (x === 1 && y > 0 && y < 11 ? STEEP : 0))
    const res = findLeg(t, at(t, 0, 5), at(t, 5, 5))
    expect(res.ok).toBe(true)
    if (res.ok) expectSafe(t, res.leg.samples)
  })

  it('never clips blocked cells on random terrain', () => {
    const rand = rng(7)
    for (let n = 0; n < 40; n++) {
      const t = makeTerrain(24, 24, () => (rand() < 0.3 ? STEEP : 0))
      const res = findLeg(t, at(t, 0, 0), at(t, 23, 23))
      if (res.ok) expectSafe(t, res.leg.samples)
    }
  })
})

describe('hard slope limit', () => {
  const walkableAt = (deg: number) => isWalkable(makeTerrain(2, 2, () => deg), 0)

  it('allows ground up to the limit and nothing above it', () => {
    expect(walkableAt(19.9)).toBe(true)
    expect(walkableAt(20.0)).toBe(true)
    expect(walkableAt(20.01)).toBe(false)
    expect(walkableAt(20.25)).toBe(false)
  })

  it('never reads a slope as lower than it is', () => {
    // 20.001 degrees is between two storage steps: it must round up, not down.
    expect(walkableAt(20.001)).toBe(false)
    expect(walkableAt(19.999)).toBe(true)
  })

  it('treats missing terrain data as not walkable', () => {
    const t = makeTerrain(10, 3, (x) => (x === 5 ? NaN : 0))
    expect(isWalkable(t, 5)).toBe(false)
    expect(findLeg(t, at(t, 1, 1), at(t, 8, 1)).ok).toBe(false)
    expect(findLeg(t, at(t, 1, 1), at(t, 5, 1)).ok).toBe(false)
  })

  it('routes around a cell that is just over the limit', () => {
    const t = makeTerrain(9, 3, (x, y) => (x === 4 && y === 1 ? 20.01 : 0))
    const res = findLeg(t, at(t, 0, 1), at(t, 8, 1))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectSafe(t, res.leg.samples)
    expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
  })
})

describe('walk back to the habitat', () => {
  it('equals the outbound route on flat ground', () => {
    const t = makeTerrain(N, N, () => 0)
    const out = findLeg(t, at(t, 5, 32), at(t, 45, 32))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const back = walkBack(t, at(t, 5, 32), out.leg.samples)!
    expect(back.reachable).toBe(true)
    expect(back.maxDistance).toBeCloseTo(40 * CELL, 3)
    expect(back.maxTime).toBeCloseTo((40 * CELL) / MAX_SPEED_MS, 2)
  })

  it('is slower than the walk out when the habitat is uphill', () => {
    const rise = CELL * Math.tan((5 * Math.PI) / 180)
    // Ground rises to the west, so the habitat at x = 5 is above the target at x = 45.
    const t = makeTerrain(N, 8, () => 5, (x) => (N - x) * rise)
    const out = findLeg(t, at(t, 5, 4), at(t, 45, 4))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const back = walkBack(t, at(t, 5, 4), out.leg.samples)!
    expect(back.maxTime).toBeGreaterThan(out.leg.duration * 1.5)
    // Close to a steady 5 degree climb (elevation is stored in 0.1 m steps, so not exact).
    const steady = (40 * CELL) / walkingSpeedMs(5)
    expect(Math.abs(back.maxTime - steady) / steady).toBeLessThan(0.1)
  })

  it('follows the terrain, not the straight line', () => {
    const t = makeTerrain(N, N, wall(30, 5))
    const out = findLeg(t, at(t, 25, 32), at(t, 35, 32))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const back = walkBack(t, at(t, 25, 32), out.leg.samples)!
    // 10 cells apart in a straight line, but the only way back is through the gap.
    expect(back.maxDistance).toBeGreaterThan(10 * CELL * 4)
    expect(back.reachable).toBe(true)
  })

  it('flags a point with no safe way back', () => {
    const t = makeTerrain(N, N, wall(30))
    const back = walkBack(t, at(t, 5, 32), [at(t, 55, 32)])!
    expect(back.reachable).toBe(false)
  })
})
