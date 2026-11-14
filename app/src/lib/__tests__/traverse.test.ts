// The slope limit applies to every step that is walked, not only to cells.
// These terrains have cells that all read as walkable (slope 0) with steep
// drops between them: the case the cell test alone cannot see.
import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG } from '../model'
import { cautiousObjective, energyObjective, timeObjective, type Objective } from '../objectives'
import { lineCells, measurePath, smoothPath } from '../pathGeometry'
import { computeAllPlans, summarise } from '../planner'
import { findLeg } from '../router'
import { walkBack } from '../returnCheck'
import type { Terrain } from '../terrain'
import { gradeAllowed, gradeDeg, stepAllowed, stepLengths } from '../traverse'
import { at, CELL, cellOf, makeTerrain } from './synthetic'

const elev = (t: Terrain, x: number, y: number) => t.elevRaw[y * t.width + x] * t.meta.elevation.scale_m
const idx = (t: Terrain, x: number, y: number) => y * t.width + x
const modes = (t: Terrain): Objective[] => [timeObjective(), energyObjective(180), cautiousObjective(t)]

/** Re-checks a route step by step with arithmetic written here, not the planner's. */
function expectEveryStepWithinLimit(t: Terrain, samples: { lat: number; lon: number; elevation: number; dist: number }[], vertices: { lat: number; lon: number }[]) {
  // 1. every piece of the measured route
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const dz = b.elevation - a.elevation
    const along = b.dist - a.dist
    if (along <= 0) continue
    const horizontal = Math.sqrt(Math.max(along * along - dz * dz, 0))
    expect((Math.atan2(Math.abs(dz), horizontal) * 180) / Math.PI).toBeLessThanOrEqual(20 + 1e-6)
  }
  // 2. every move from one cell to the next under each straight line
  for (let i = 1; i < vertices.length; i++) {
    const a = cellOf(t, vertices[i - 1])
    const b = cellOf(t, vertices[i])
    const cells = lineCells(t, a.x, a.y, b.x, b.y)
    expect(cells).not.toBeNull()
    for (let k = 1; k < cells!.length; k++) {
      const p = cells![k - 1]
      const q = cells![k]
      const dx = (q % t.width) - (p % t.width)
      const dy = Math.floor(q / t.width) - Math.floor(p / t.width)
      expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(1)
      const rise = Math.abs(t.elevRaw[q] - t.elevRaw[p]) * t.meta.elevation.scale_m
      expect((Math.atan2(rise, Math.hypot(dx * CELL, dy * CELL)) * 180) / Math.PI).toBeLessThanOrEqual(20 + 1e-9)
    }
  }
}

describe('the limit on a single step', () => {
  it('is 20 degrees, inclusive, up and down', () => {
    expect(gradeAllowed(20)).toBe(true)
    expect(gradeAllowed(-20)).toBe(true)
    expect(gradeAllowed(20.0001)).toBe(false)
    expect(gradeAllowed(-20.0001)).toBe(false)
    expect(MAX_SLOPE_DEG).toBe(20)
  })

  it('refuses anything that is not a number', () => {
    expect(gradeAllowed(NaN)).toBe(false)
    expect(gradeAllowed(gradeDeg(NaN, 4))).toBe(false)
    expect(gradeAllowed(gradeDeg(Infinity, 4))).toBe(false)
  })

  it('uses the rise over the horizontal length of the step', () => {
    // 1.4 m over 4 m is 19.3 degrees; 1.5 m is 20.6 degrees.
    const t = makeTerrain(4, 3, () => 0, (x) => (x === 1 ? 1.4 : x === 2 ? 2.9 : x === 3 ? 2.9 : 0))
    const len = stepLengths(t)
    expect(stepAllowed(t, 0, 1, 0, len[0])).toBe(true) // 0 -> 1.4
    expect(stepAllowed(t, 1, 1, 4, len[4])).toBe(true) // and back down
    expect(stepAllowed(t, 1, 1, 0, len[0])).toBe(false) // 1.4 -> 2.9
    expect(stepAllowed(t, 2, 1, 4, len[4])).toBe(false) // and back down
    expect(stepAllowed(t, 2, 1, 0, len[0])).toBe(true) // level
  })

  it('measures a diagonal step over its own, longer, length', () => {
    // A rise of 1.9 m: 25.4 degrees straight across, 18.6 degrees over the 5.66 m diagonal.
    const t = makeTerrain(3, 3, () => 0, (x) => (x >= 1 ? 1.9 : 0))
    const len = stepLengths(t)
    expect(stepAllowed(t, 0, 1, 0, len[0])).toBe(false)
    expect(stepAllowed(t, 0, 1, 1, len[1])).toBe(true)
  })

  it('still refuses a diagonal that passes a blocked cell', () => {
    const t = makeTerrain(3, 3, (x, y) => (x === 1 && y === 0 ? 40 : 0))
    expect(stepAllowed(t, 0, 0, 1, stepLengths(t)[1])).toBe(false)
  })

  it('refuses steps off the grid and steps onto cells without data', () => {
    const t = makeTerrain(3, 3, (x, y) => (x === 1 && y === 1 ? NaN : 0))
    const len = stepLengths(t)
    expect(stepAllowed(t, 0, 0, 4, len[4])).toBe(false)
    expect(stepAllowed(t, 0, 1, 0, len[0])).toBe(false)
    expect(stepAllowed(t, 1, 1, 0, len[0])).toBe(false)
  })
})

describe('a cliff between walkable cells', () => {
  // Every cell reads as flat. East of x = 15 the ground is 3 m higher: 36.9 degrees
  // straight across and 27.9 degrees diagonally, so no single step may cross it.
  const cliff = (ramp: boolean) =>
    makeTerrain(30, 30, () => 0, (x, y) => {
      if (ramp && y >= 24 && y <= 26) return Math.min(3, Math.max(0, (x - 12) * 0.75)) // 10.6 degrees over four cells
      return x >= 15 ? 3 : 0
    })

  it('is not crossed by any routing mode', () => {
    const t = cliff(false)
    for (const objective of modes(t)) {
      const res = findLeg(t, at(t, 5, 10), at(t, 25, 10), { objective })
      expect(res.ok).toBe(false)
    }
  })

  it('is NO ROUTE for the mission in every mode, never GO', () => {
    const t = cliff(false)
    const input = { points: [at(t, 5, 10), at(t, 25, 10)], roundTrip: true, massKg: 180 }
    const plans = computeAllPlans(t, input)
    for (const m of ['fastest', 'energy', 'cautious'] as const) expect(summarise(plans[m], input, 20)!.verdict).toBe('noroute')
  })

  it('is passed only by the ramp, in every mode, with every step within the limit', () => {
    const t = cliff(true)
    for (const objective of modes(t)) {
      const res = findLeg(t, at(t, 5, 10), at(t, 25, 10), { objective })
      expect(res.ok).toBe(true)
      if (!res.ok) continue
      // The route has to go down to the ramp rows to get across.
      const rows = res.leg.samples.map((s) => cellOf(t, s)).filter((c) => c.x >= 13 && c.x <= 15).map((c) => c.y)
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(23)
      expectEveryStepWithinLimit(t, res.leg.samples, res.leg.vertices)
    }
  })

  it('has no way back across it either', () => {
    const t = cliff(false)
    const back = walkBack(t, at(t, 5, 10), [at(t, 25, 10)])!
    expect(back.reachable).toBe(false)
    expect(back.feasible).toBe(false)
  })

  it('cannot be crossed by a straightened line', () => {
    const t = cliff(true)
    expect(lineCells(t, 5, 10, 25, 10)).toBeNull()
    expect(lineCells(t, 25, 10, 5, 10)).toBeNull()
    // Diagonal across the cliff, through cell corners.
    expect(lineCells(t, 10, 5, 20, 15)).toBeNull()
    expect(measurePath(t, [idx(t, 5, 10), idx(t, 25, 10)])).toBeNull()
    // Along the foot of the cliff is fine.
    expect(lineCells(t, 14, 2, 14, 20)).not.toBeNull()
  })

  it('is never cut by straightening a route that goes round it', () => {
    const t = cliff(true)
    for (const objective of modes(t)) {
      const grid = findLeg(t, at(t, 5, 10), at(t, 25, 10), { objective, smooth: false })
      const smooth = findLeg(t, at(t, 5, 10), at(t, 25, 10), { objective })
      expect(grid.ok && smooth.ok).toBe(true)
      if (!grid.ok || !smooth.ok) continue
      expect(smooth.leg.vertices.length).toBeLessThan(grid.leg.vertices.length)
      expectEveryStepWithinLimit(t, smooth.leg.samples, smooth.leg.vertices)
      // Where it crosses the cliff line, the straightened route is on the ramp like the grid route.
      for (const s of smooth.leg.samples) {
        const c = cellOf(t, s)
        if (c.x === 14 || c.x === 15) expect(elev(t, c.x, c.y)).toBeLessThan(3)
      }
    }
  })
})

describe('a line that is too steep although every cell-to-cell move is not', () => {
  // A plane rising 1.3 m per cell both east and south (18 degrees each way).
  // Moves east or south are allowed. Diagonal moves, and any straight line that
  // gains height both ways at once, are steeper than 20 degrees.
  const t = makeTerrain(20, 20, () => 0, (x, y) => (x + y) * 1.3)

  it('allows the staircase and refuses the diagonal step', () => {
    const len = stepLengths(t)
    expect(stepAllowed(t, 5, 5, 0, len[0])).toBe(true)
    expect(stepAllowed(t, 5, 5, 2, len[2])).toBe(true)
    expect(stepAllowed(t, 5, 5, 1, len[1])).toBe(false)
  })

  it('refuses the shallow oblique line even though it only makes allowed moves', () => {
    // From (2, 2) to (12, 7): the cells it crosses are joined by east and south moves only.
    const cells = lineCells(t, 2, 2, 12, 7)
    expect(cells).not.toBeNull()
    // Walked as a straight line it climbs 19.5 m over 44.7 m: 23.6 degrees.
    expect(measurePath(t, [idx(t, 2, 2), idx(t, 12, 7)])).toBeNull()
  })

  it('keeps such a line out of straightened routes, in every mode', () => {
    for (const objective of modes(t)) {
      const res = findLeg(t, at(t, 2, 2), at(t, 12, 7), { objective })
      expect(res.ok).toBe(true)
      if (!res.ok) continue
      expectEveryStepWithinLimit(t, res.leg.samples, res.leg.vertices)
      const path = res.leg.vertices.map((v) => idx(t, cellOf(t, v).x, cellOf(t, v).y))
      expect(measurePath(t, path, objective)).not.toBeNull()
      // smoothPath itself never hands back a line it would have to refuse.
      const gridLeg = findLeg(t, at(t, 2, 2), at(t, 12, 7), { objective, smooth: false })
      if (gridLeg.ok) {
        const g = gridLeg.leg.vertices.map((v) => idx(t, cellOf(t, v).x, cellOf(t, v).y))
        expect(measurePath(t, smoothPath(t, g, objective), objective)).not.toBeNull()
      }
    }
  })
})

describe('the same hard limits for every mode', () => {
  it('reaches exactly the same cells whatever the priority', () => {
    // Islands cut off by cliffs and by blocked cells: reachability must not depend on the mode.
    const t = makeTerrain(24, 24, (x, y) => (x === 8 && y < 18 ? 35 : 0), (x, y) => (x >= 16 && y >= 6 ? 4 : 0))
    const from = at(t, 3, 3)
    let reached = 0
    let cut = 0
    for (let y = 1; y < 24; y += 3) {
      for (let x = 1; x < 24; x += 3) {
        const got = modes(t).map((objective) => findLeg(t, from, at(t, x, y), { objective }).ok)
        expect(new Set(got).size).toBe(1)
        if (got[0]) reached++
        else cut++
      }
    }
    expect(reached).toBeGreaterThan(10)
    expect(cut).toBeGreaterThan(10)
  })
})
