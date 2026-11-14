import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG, MAX_SPEED_MS, walkingSpeedMs } from '../model'
import { lineCells, measurePath, smoothPath } from '../pathGeometry'
import { findLeg, isWalkable, walkBack } from '../router'
import { elevationAt, elevationAtPoint, hiddenSteepShare, type Terrain } from '../terrain'
import { at, CELL, makeTerrain, rng } from './synthetic'

const STEEP = MAX_SLOPE_DEG + 10
const idx = (t: Terrain, x: number, y: number) => y * t.width + x
const xy = (t: Terrain, cells: number[]) => cells.map((c) => [c % t.width, Math.floor(c / t.width)])

describe('line of sight over the grid', () => {
  const free = makeTerrain(12, 12, () => 0)

  it('lists the cells along a row', () => {
    expect(xy(free, lineCells(free, 2, 5, 6, 5)!)).toEqual([[2, 5], [3, 5], [4, 5], [5, 5], [6, 5]])
  })

  it('lists every cell a slanted line passes through', () => {
    // From (0,0) to (2,1): the line clips (1,0) and (1,1) on the way.
    expect(xy(free, lineCells(free, 0, 0, 2, 1)!)).toEqual([[0, 0], [1, 0], [1, 1], [2, 1]])
  })

  it('includes both cells beside a corner the line passes through', () => {
    const cells = xy(free, lineCells(free, 1, 1, 3, 3)!)
    expect(cells).toContainEqual([2, 1])
    expect(cells).toContainEqual([1, 2])
    expect(cells).toContainEqual([3, 2])
    expect(cells).toContainEqual([2, 3])
  })

  it('is blocked by a cell on the line', () => {
    const t = makeTerrain(12, 12, (x, y) => (x === 4 && y === 5 ? STEEP : 0))
    expect(lineCells(t, 2, 5, 6, 5)).toBeNull()
  })

  it('is blocked when either cell beside a touched corner is not walkable', () => {
    const one = makeTerrain(12, 12, (x, y) => (x === 2 && y === 1 ? STEEP : 0))
    expect(lineCells(one, 1, 1, 3, 3)).toBeNull()
    const other = makeTerrain(12, 12, (x, y) => (x === 1 && y === 2 ? STEEP : 0))
    expect(lineCells(other, 1, 1, 3, 3)).toBeNull()
  })

  it('cannot slip between two blocked cells that touch at a corner', () => {
    const t = makeTerrain(12, 12, (x, y) => ((x === 5 && y === 4) || (x === 4 && y === 5) ? STEEP : 0))
    expect(lineCells(t, 2, 2, 8, 8)).toBeNull()
    // The same in the other diagonal direction.
    const u = makeTerrain(12, 12, (x, y) => ((x === 5 && y === 5) || (x === 6 && y === 4) ? STEEP : 0))
    expect(lineCells(u, 8, 2, 2, 8)).toBeNull()
  })

  it('is blocked by missing terrain data, blocked ends and the edge of the grid', () => {
    const t = makeTerrain(12, 12, (x, y) => (x === 4 && y === 5 ? NaN : x === 9 ? STEEP : 0))
    expect(lineCells(t, 2, 5, 6, 5)).toBeNull()
    expect(lineCells(t, 7, 2, 9, 2)).toBeNull()
    expect(lineCells(t, 9, 2, 7, 2)).toBeNull()
    expect(lineCells(free, 10, 10, 14, 10)).toBeNull()
  })

  it('agrees with a brute-force check on random terrain', () => {
    const rand = rng(11)
    for (let n = 0; n < 300; n++) {
      const t = makeTerrain(14, 14, () => (rand() < 0.15 ? STEEP : 0))
      const p = [0, 1, 2, 3].map(() => Math.floor(rand() * 14))
      const got = lineCells(t, p[0], p[1], p[2], p[3])
      // Sample the segment densely: every cell under a sample must be walkable.
      let clear = true
      for (let k = 0; k <= 2000 && clear; k++) {
        const fx = p[0] + 0.5 + ((p[2] - p[0]) * k) / 2000
        const fy = p[1] + 0.5 + ((p[3] - p[1]) * k) / 2000
        if (!isWalkable(t, idx(t, Math.min(13, Math.floor(fx)), Math.min(13, Math.floor(fy))))) clear = false
      }
      // The exact check may also refuse a line that only touches a blocked corner,
      // so it can be stricter than sampling, never more permissive.
      if (got) expect(clear).toBe(true)
      if (got) for (const c of got) expect(isWalkable(t, c)).toBe(true)
    }
  })
})

describe('measuring a path', () => {
  it('charges a grid path exactly what walking it cell by cell costs', () => {
    const t = makeTerrain(20, 20, () => 0)
    const cells = Array.from({ length: 10 }, (_, i) => idx(t, 2 + i, 5))
    const m = measurePath(t, cells)!
    expect(m.distance).toBeCloseTo(9 * CELL, 9)
    expect(m.duration).toBeCloseTo((9 * CELL) / MAX_SPEED_MS, 9)
    expect(m.samples).toHaveLength(10)
  })

  it('refuses to measure a path that touches no-go ground', () => {
    const t = makeTerrain(20, 20, (x, y) => (x === 6 && y === 5 ? STEEP : 0))
    expect(measurePath(t, [idx(t, 2, 5), idx(t, 10, 5)])).toBeNull()
    expect(measurePath(t, [idx(t, 2, 5), idx(t, 5, 5)])).not.toBeNull()
  })

  it('reports totals that match its own samples', () => {
    const rand = rng(3)
    const t = makeTerrain(30, 30, () => rand() * 15, (x, y) => 10 + 3 * Math.sin(x / 3) + 2 * Math.cos(y / 4))
    const m = measurePath(t, [idx(t, 2, 3), idx(t, 20, 9), idx(t, 25, 25), idx(t, 4, 22)])!
    const last = m.samples[m.samples.length - 1]
    expect(last.dist).toBeCloseTo(m.distance, 9)
    expect(last.time).toBeCloseTo(m.duration, 9)
    let up = 0
    let down = 0
    let dist = 0
    for (let i = 1; i < m.samples.length; i++) {
      const dz = m.samples[i].elevation - m.samples[i - 1].elevation
      if (dz > 0) up += dz
      else down -= dz
      dist += m.samples[i].dist - m.samples[i - 1].dist
      // No piece is longer than about one and a half cells.
      expect(m.samples[i].dist - m.samples[i - 1].dist).toBeLessThan(CELL * 1.6)
    }
    expect(up).toBeCloseTo(m.ascent, 6)
    expect(down).toBeCloseTo(m.descent, 6)
    expect(dist).toBeCloseTo(m.distance, 6)
    expect(m.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
  })

  it('keeps walking costs direction-dependent on a straightened path', () => {
    const rise = CELL * Math.tan((5 * Math.PI) / 180)
    const t = makeTerrain(40, 10, () => 5, (x) => x * rise)
    const up = measurePath(t, [idx(t, 3, 5), idx(t, 35, 5)])!
    const down = measurePath(t, [idx(t, 35, 5), idx(t, 3, 5)])!
    expect(up.duration).toBeGreaterThan(down.duration * 1.5)
    expect(up.ascent).toBeCloseTo(down.descent, 6)
    expect(Math.abs(up.duration - (32 * CELL) / walkingSpeedMs(5)) / up.duration).toBeLessThan(0.1)
  })
})

describe('straightening a route', () => {
  it('replaces a staircase on open flat ground with one straight line', () => {
    const t = makeTerrain(40, 40, () => 0)
    const raw = findLeg(t, at(t, 3, 4), at(t, 33, 17), { smooth: false })
    const res = findLeg(t, at(t, 3, 4), at(t, 33, 17))
    expect(raw.ok && res.ok).toBe(true)
    if (!raw.ok || !res.ok) return
    expect(res.leg.vertices).toHaveLength(2)
    const straight = Math.hypot(30 * CELL, 13 * CELL)
    expect(res.leg.distance).toBeCloseTo(straight, 6)
    expect(res.leg.distance).toBeLessThan(raw.leg.distance)
    expect(res.leg.grid.distance).toBeCloseTo(raw.leg.distance, 9)
    expect(res.leg.duration).toBeLessThanOrEqual(raw.leg.duration)
  })

  it('does not cut through an obstacle', () => {
    const t = makeTerrain(40, 40, (x, y) => (x >= 15 && x <= 18 && y >= 5 && y <= 30 ? STEEP : 0))
    const res = findLeg(t, at(t, 3, 12), at(t, 33, 12))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.vertices.length).toBeGreaterThan(2)
    // Independent re-check of every line of the result.
    const w = t.width
    const cellsOf = res.leg.vertices.map((v) => {
      const b = t.meta.bbox
      return Math.floor(((b.north - v.lat) / (b.north - b.south)) * t.height) * w + Math.floor(((v.lon - b.west) / (b.east - b.west)) * w)
    })
    for (let i = 1; i < cellsOf.length; i++) {
      const a = cellsOf[i - 1]
      const c = cellsOf[i]
      expect(lineCells(t, a % w, Math.floor(a / w), c % w, Math.floor(c / w))).not.toBeNull()
    }
    expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
  })

  it('does not squeeze a shortcut past a corner-touching obstacle', () => {
    // Two blocked cells meeting at a corner sit exactly on the diagonal between the ends.
    const t = makeTerrain(16, 16, (x, y) => ((x === 8 && y === 7) || (x === 7 && y === 8) ? STEEP : 0))
    const res = findLeg(t, at(t, 3, 3), at(t, 12, 12))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.vertices.length).toBeGreaterThan(2)
    expect(res.leg.distance).toBeGreaterThan(Math.hypot(9 * CELL, 9 * CELL))
  })

  it('is never slower than the grid path and never leaves safe ground, on random terrain', () => {
    const rand = rng(99)
    let straightened = 0
    for (let n = 0; n < 60; n++) {
      const amp = rand() * 5
      const t = makeTerrain(28, 28, () => (rand() < 0.18 ? STEEP : rand() * 16), (x, y) => 20 + amp * Math.sin(x / 3) + amp * Math.cos(y / 2.5) + rand() * 0.4)
      const res = findLeg(t, at(t, 1, 1), at(t, 26, 26))
      if (!res.ok) continue
      expect(res.leg.duration).toBeLessThanOrEqual(res.leg.grid.duration + 1e-6)
      expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
      if (res.leg.vertices.length < res.leg.grid.cells) straightened++
    }
    expect(straightened).toBeGreaterThan(5)
  })

  it('keeps the grid path when a straight line would be slower', () => {
    // A ridge lies across the direct line; the grid path goes round it on the level.
    const ridge = (x: number, y: number) => (y >= 8 && y <= 22 ? 6 * Math.exp(-((x - 15) ** 2) / 8) : 0)
    const t = makeTerrain(30, 30, () => 5, ridge)
    const res = findLeg(t, at(t, 3, 15), at(t, 27, 15))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const direct = measurePath(t, [idx(t, 3, 15), idx(t, 27, 15)])!
    expect(res.leg.duration).toBeLessThan(direct.duration)
    expect(res.leg.vertices.length).toBeGreaterThan(2)
  })

  it('does not trade clean ground for hidden steep ground', () => {
    // Open flat ground, but the cells along the diagonal hide steep ground at 1 m.
    const rough = (x: number, y: number) => (Math.abs(x - y) <= 1 && x > 4 && x < 15 ? 16 : 0)
    const withData = makeTerrain(20, 20, () => 0, () => 0, rough)
    const noData = makeTerrain(20, 20, () => 0)
    // An L-shaped grid path that keeps to clean cells.
    const path = (t: Terrain) => [
      ...Array.from({ length: 16 }, (_, i) => idx(t, 2 + i, 2)),
      ...Array.from({ length: 15 }, (_, i) => idx(t, 17, 3 + i)),
    ]
    // Without subcell data the diagonal shortcut is taken.
    expect(smoothPath(noData, path(noData))).toHaveLength(2)
    // With it, the shortcut across the rough diagonal is refused.
    const kept = smoothPath(withData, path(withData))
    expect(kept.length).toBeGreaterThan(2)
    const m = measurePath(withData, kept)!
    expect(m.hiddenLoad).toBe(0)
    expect(hiddenSteepShare(withData, idx(withData, 8, 8))).toBe(1)
  })

  it('leaves the way back to the habitat valid', () => {
    const t = makeTerrain(40, 40, (x, y) => (x >= 15 && x <= 18 && y >= 5 && y <= 30 ? STEEP : 0))
    const res = findLeg(t, at(t, 3, 12), at(t, 33, 12))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const back = walkBack(t, at(t, 3, 12), res.leg.samples)!
    expect(back.reachable).toBe(true)
    // The way back is computed on the grid, so it is at least as long as the straightened leg.
    expect(back.maxDistance).toBeGreaterThanOrEqual(res.leg.distance - 1e-6)
  })
})

describe('elevation precision', () => {
  it('reads cell centres exactly and interpolates between them', () => {
    const t = makeTerrain(6, 6, () => 0, (x, y) => x * 2 + y * 10)
    expect(elevationAtPoint(t, 2.5, 3.5)).toBeCloseTo(elevationAt(t, idx(t, 2, 3)), 9)
    expect(elevationAtPoint(t, 3, 3.5)).toBeCloseTo(35, 9) // halfway between 34 and 36
    expect(elevationAtPoint(t, 3, 4)).toBeCloseTo(40, 9) // centre of four cells
    // Clamped at the edge rather than extrapolated.
    expect(elevationAtPoint(t, 0, 0)).toBeCloseTo(0, 9)
  })

  it('decodes any stored step to within half a step', () => {
    for (const scale of [0.1, 0.02]) {
      for (const z of [0.004, 0.013, 1.237, 923.61]) {
        const decoded = Math.round(z / scale) * scale
        expect(Math.abs(decoded - z)).toBeLessThanOrEqual(scale / 2 + 1e-12)
      }
    }
  })

  it('keeps the grade error of one step under a third of a degree at 2 cm', () => {
    const worst = (scale: number) => (Math.atan2(scale, CELL) * 180) / Math.PI
    expect(worst(0.02)).toBeLessThan(0.3)
    expect(worst(0.1)).toBeGreaterThan(1.4)
    // On the flat that grade error moves walking speed by this much.
    expect(1 - walkingSpeedMs(worst(0.02)) / MAX_SPEED_MS).toBeLessThan(0.04)
    expect(1 - walkingSpeedMs(worst(0.1)) / MAX_SPEED_MS).toBeGreaterThan(0.17)
  })
})
