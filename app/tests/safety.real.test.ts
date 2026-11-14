// Phase 4.1 on the real Gale terrain: the per-step slope limit and the joint
// return check, re-verified with arithmetic written in this file.
import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ROUTE_MODES } from '../src/lib/objectives'
import { lineCells } from '../src/lib/pathGeometry'
import { computeAllPlans, summarise, type Plan, type PlanInput } from '../src/lib/planner'
import { WalkBackField } from '../src/lib/returnCheck'
import { findLeg } from '../src/lib/router'
import { RETURN_LIMITS } from '../src/lib/model'
import { cellAt, type Terrain } from '../src/lib/terrain'
import { stepAllowed, stepLengths } from '../src/lib/traverse'
import { EXAMPLE, loadTerrainFromDisk } from './loadTerrain'

// These tests search the full 1024 x 1024 grid; when the whole suite runs in parallel they need more than the default 5 s.
vi.setConfig({ testTimeout: 120_000 })

const t: Terrain = loadTerrainFromDisk()
const W = t.width
const H = t.height
const MASS = 180
const CX = t.meta.cellSizeX_m
const CY = t.meta.cellSizeY_m
const z = (i: number) => t.meta.elevation.min_m + t.elevRaw[i] * t.meta.elevation.scale_m
const cellOk = (i: number) => t.slopeRaw[i] !== 65535 && t.slopeRaw[i] * 0.01 <= 20
const deg = (rise: number, run: number) => (Math.atan2(Math.abs(rise), run) * 180) / Math.PI

// Curiosity stops used as targets (MSL waypoints, mars.nasa.gov), by sol.
const SOL_4845 = { lat: -4.81060029, lon: 137.3816452 } // 1.01 km from the habitat
const SOL_4677 = { lat: -4.80871233, lon: 137.3816902 } // 1.11 km: the case the audit found misjudged
const SOUTH = { lat: -4.8442, lon: 137.372 }
// 1.6 km east of the habitat in a straight line, across broken ground.
const EAST = { lat: -4.8235, lon: 137.4160 }
const MESA = { lat: -4.8391845703125, lon: 137.4187451171875 } // walkable, but cut off on all sides

const MISSIONS: Record<string, PlanInput> = {
  example: { points: EXAMPLE, roundTrip: true, massKg: MASS },
  longer: { points: [...EXAMPLE, SOL_4845], roundTrip: true, massKg: MASS },
  audit_case: { points: [...EXAMPLE, SOL_4677], roundTrip: true, massKg: MASS },
  south: { points: [...EXAMPLE, SOUTH], roundTrip: true, massKg: MASS },
  east: { points: [...EXAMPLE, EAST], roundTrip: true, massKg: MASS },
  mesa: { points: [...EXAMPLE, MESA], roundTrip: true, massKg: MASS },
}

/** Every step of a route, re-derived here from raw elevations. */
function verifyRoute(p: Plan): { pieces: number; moves: number; steepest: number } {
  let pieces = 0
  let moves = 0
  let steepest = 0
  // 1. pieces of the route as measured
  for (let i = 1; i < p.samples.length; i++) {
    const a = p.samples[i - 1]
    const b = p.samples[i]
    const along = b.dist - a.dist
    if (along <= 0) continue
    const dz = b.elevation - a.elevation
    const g = deg(dz, Math.sqrt(Math.max(along * along - dz * dz, 0)))
    expect(g).toBeLessThanOrEqual(20 + 1e-6)
    if (g > steepest) steepest = g
    expect(cellOk(cellAt(t, b))).toBe(true)
    pieces++
  }
  // 2. cell-to-cell moves under every straight line of the route
  for (const leg of p.legs) {
    const cells = leg.vertices.map((v) => cellAt(t, v))
    for (let i = 1; i < cells.length; i++) {
      const line = lineCells(t, cells[i - 1] % W, Math.floor(cells[i - 1] / W), cells[i] % W, Math.floor(cells[i] / W))
      expect(line).not.toBeNull()
      for (let k = 1; k < line!.length; k++) {
        const u = line![k - 1]
        const v = line![k]
        const dx = (v % W) - (u % W)
        const dy = Math.floor(v / W) - Math.floor(u / W)
        expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(1)
        expect(cellOk(u) && cellOk(v)).toBe(true)
        if (dx !== 0 && dy !== 0) expect(cellOk(u + dx) && cellOk(u + dy * W)).toBe(true)
        const g = deg(z(v) - z(u), Math.hypot(dx * CX, dy * CY))
        expect(g).toBeLessThanOrEqual(20)
        if (g > steepest) steepest = g
        moves++
      }
    }
  }
  return { pieces, moves, steepest }
}

describe('per-step slope limit on the real grid', () => {
  it('finds the steep steps the audit counted, and refuses every one', () => {
    const len = stepLengths(t)
    const DX = [1, 1, 0, -1]
    const DY = [0, 1, 1, 1]
    const K = [0, 1, 2, 3] // east, south-east, south, south-west in the planner's numbering
    let between = 0
    let steep = 0
    let worst = 0
    let passed = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = y * W + x
        if (!cellOk(u)) continue
        for (let n = 0; n < 4; n++) {
          const nx = x + DX[n]
          const ny = y + DY[n]
          if (nx < 0 || ny >= H || nx >= W) continue
          const v = ny * W + nx
          if (!cellOk(v)) continue
          between++
          const g = deg(z(v) - z(u), Math.hypot(DX[n] * CX, DY[n] * CY))
          if (g > 20) {
            steep++
            if (g > worst) worst = g
            if (stepAllowed(t, x, y, K[n], len[K[n]])) passed++
            if (stepAllowed(t, nx, ny, K[n] + 4, len[K[n] + 4])) passed++
          }
        }
      }
    }
    expect(between).toBe(3_055_746)
    expect(steep).toBe(3717)
    expect(worst).toBeGreaterThan(44)
    expect(passed).toBe(0)
  })
})

describe('missions on the real grid', () => {
  const report: Record<string, unknown> = {}

  it('verifies every step of every route and gives the expected verdicts', { timeout: 300_000 }, () => {
    const expected: Record<string, string> = { example: 'go', longer: 'go', audit_case: 'go', south: 'go', east: 'nogo', mesa: 'noroute' }
    for (const [name, input] of Object.entries(MISSIONS)) {
      const plans = computeAllPlans(t, input)
      const row: Record<string, unknown> = {}
      const verdicts = new Set<string>()
      for (const m of ROUTE_MODES) {
        const p = plans[m.id]!
        const s = summarise(p, input, 20)!
        verdicts.add(s.verdict)
        if (p.error) {
          row[m.id] = { verdict: s.verdict, error: p.error }
          continue
        }
        const v = verifyRoute(p)
        const back = p.walkBack!
        // The return figures are one path: when the plan passes they are both within the limits.
        if (back.feasible) {
          expect(back.maxDistance).toBeLessThanOrEqual(RETURN_LIMITS.distance_m)
          expect(back.maxTime).toBeLessThanOrEqual(RETURN_LIMITS.time_s)
        } else {
          expect(back.maxDistance > RETURN_LIMITS.distance_m || back.maxTime > RETURN_LIMITS.time_s).toBe(true)
        }
        expect(back.verified).toBe(true)
        row[m.id] = {
          verdict: s.verdict,
          failed: s.checks!.filter((c) => !c.ok).map((c) => `${c.id} ${c.value}`),
          distance_m: +p.distance.toFixed(0),
          walk_min: +(p.walkTime / 60).toFixed(1),
          eva_min: +(s.evaSeconds / 60).toFixed(0),
          energy_kcal: +s.energyKcal.toFixed(0),
          climb_m: +p.ascent.toFixed(0),
          hidden_load: +p.exposure!.load.toFixed(2),
          return_from_worst_point: `${(back.maxDistance / 1000).toFixed(2)} km in ${(back.maxTime / 60).toFixed(1)} min`,
          steepest_step_deg: +v.steepest.toFixed(2),
          steps_checked: v.pieces + v.moves,
        }
      }
      // Safety verdicts are the same for every priority: the return check does not depend on it.
      expect(verdicts.size, name).toBe(1)
      if (expected[name]) expect([...verdicts][0], name).toBe(expected[name])
      report[name] = row
    }
  })

  it('no longer fails the audit case on the length of its fastest way back', () => {
    // 1.11 km from the habitat. The fastest way back is over 2 km; a shorter one is quick enough.
    const field = new WalkBackField(t, EXAMPLE[0])
    const c = cellAt(t, SOL_4677)
    const fastest = findLeg(t, SOL_4677, EXAMPLE[0], { smooth: false })
    expect(fastest.ok).toBe(true)
    if (!fastest.ok) return
    expect(fastest.leg.grid.distance).toBeGreaterThan(RETURN_LIMITS.distance_m)
    expect(fastest.leg.grid.duration).toBeLessThan(RETURN_LIMITS.time_s)
    const d = field.cell(c)!
    expect(d.feasible).toBe(true)
    expect(d.verified).toBe(true)
    expect(d.dist).toBeLessThanOrEqual(RETURN_LIMITS.distance_m)
    expect(d.time).toBeLessThanOrEqual(RETURN_LIMITS.time_s)
    report.audit_case_point = { fastest_back: `${fastest.leg.grid.distance.toFixed(0)} m in ${(fastest.leg.grid.duration / 60).toFixed(1)} min`, accepted_back: `${d.dist.toFixed(0)} m in ${(d.time / 60).toFixed(1)} min` }
  })

  it('is NO-GO in the east because no way back at all is short enough', () => {
    const input = MISSIONS.east
    const p = computeAllPlans(t, input).fastest!
    const back = p.walkBack!
    expect(back.feasible).toBe(false)
    // Independent of the return check: the shortest safe path from the worst point, by a plain distance search.
    const shortest = findLeg(t, back.maxDistanceAt, EXAMPLE[0], {
      smooth: false,
      objective: { mode: 'fastest', unit: 'm', pieceCost: (d, g) => d / Math.cos((g * Math.PI) / 180), minPerMetre: 1 },
    })
    expect(shortest.ok).toBe(true)
    if (shortest.ok) expect(shortest.leg.grid.distance).toBeGreaterThan(RETURN_LIMITS.distance_m)
  })

  it('is GO in the south only through a path that is neither the shortest nor the fastest', () => {
    const input = MISSIONS.south
    const field = new WalkBackField(t, EXAMPLE[0])
    const p = computeAllPlans(t, input).fastest!
    const back = field.assess(p.samples)!
    expect(back.feasible).toBe(true)
    expect(back.verified).toBe(true)
    // The fastest way back from the far target is too long, and the shortest too slow.
    const fastest = findLeg(t, SOUTH, EXAMPLE[0], { smooth: false })
    const shortest = findLeg(t, SOUTH, EXAMPLE[0], {
      smooth: false,
      objective: { mode: 'fastest', unit: 'm', pieceCost: (d, g) => d / Math.cos((g * Math.PI) / 180), minPerMetre: 1 },
    })
    expect(fastest.ok && shortest.ok).toBe(true)
    if (fastest.ok && shortest.ok) {
      expect(fastest.leg.grid.distance).toBeGreaterThan(RETURN_LIMITS.distance_m)
      expect(shortest.leg.grid.duration).toBeGreaterThan(RETURN_LIMITS.time_s)
    }
    const d = field.cell(cellAt(t, SOUTH))!
    expect(d.feasible).toBe(true)
    expect(d.dist).toBeLessThanOrEqual(RETURN_LIMITS.distance_m)
    expect(d.time).toBeLessThanOrEqual(RETURN_LIMITS.time_s)
  })

  it('southern mission: every return path re-walked from raw elevations, before any rounding', { timeout: 300_000 }, () => {
    const input = MISSIONS.south
    const D = RETURN_LIMITS.distance_m
    const T = RETURN_LIMITS.time_s
    const DX8 = [1, 1, 0, -1, -1, -1, 0, 1]
    const DY8 = [0, 1, 1, 1, 0, -1, -1, -1]
    const speed = (g: number) => (g <= -20 ? 0.05 : g <= -10 ? 0.095 * g + 1.95 : g <= 0 ? 0.06 * g + 1.6 : g <= 6 ? -0.2 * g + 1.6 : g <= 15 ? -0.039 * g + 0.634 : 0.05)
    /** Length and time of a path of cells, with every step checked against the hard limits. */
    const rewalk = (path: number[]) => {
      let d = 0
      let s = 0
      for (let i = 1; i < path.length; i++) {
        const u = path[i - 1]
        const v = path[i]
        const dx = (v % W) - (u % W)
        const dy = Math.floor(v / W) - Math.floor(u / W)
        expect(DX8.some((x, k) => x === dx && DY8[k] === dy)).toBe(true)
        expect(cellOk(u) && cellOk(v)).toBe(true)
        if (dx !== 0 && dy !== 0) expect(cellOk(u + dx) && cellOk(u + dy * W)).toBe(true)
        const len = Math.hypot(dx * CX, dy * CY)
        const dz = z(v) - z(u)
        const g = (Math.atan2(dz, len) * 180) / Math.PI
        expect(Math.abs(g)).toBeLessThanOrEqual(20)
        d += Math.hypot(len, dz)
        s += len / speed(g)
      }
      return { d, s }
    }
    const home = cellAt(t, EXAMPLE[0])
    const plans = computeAllPlans(t, input)
    const field = new WalkBackField(t, EXAMPLE[0])
    let tightest = { d: 0, s: 0, margin_m: Infinity, margin_s: Infinity }
    let cells = 0
    for (const m of ROUTE_MODES) {
      for (const c of new Set(plans[m.id]!.samples.map((p) => cellAt(t, p)))) {
        const got = field.cell(c)!
        expect(got.feasible).toBe(true)
        expect(got.verified).toBe(true)
        const path = field.returnPath(c)!
        expect(path[0]).toBe(c)
        expect(path[path.length - 1]).toBe(home)
        const sums = rewalk(path)
        // The figures reported are this one path's own length and time...
        expect(Math.abs(sums.d - got.dist)).toBeLessThan(1e-6)
        expect(Math.abs(sums.s - got.time)).toBeLessThan(1e-6)
        // ...and that same path is within both limits, compared at full precision.
        expect(sums.d).toBeLessThanOrEqual(D)
        expect(sums.s).toBeLessThanOrEqual(T)
        if (D - sums.d < tightest.margin_m) tightest = { d: sums.d, s: sums.s, margin_m: D - sums.d, margin_s: T - sums.s }
        cells++
      }
    }
    expect(cells).toBeGreaterThan(1500)
    const far = field.cell(cellAt(t, SOUTH))!
    const back = plans.fastest!.walkBack!
    const checks = summarise(plans.fastest, input, 20)!.checks!
    report.south_full_precision = {
      route_cells_checked: cells,
      far_target: { distance_m: far.dist, time_s: far.time, time_min: far.time / 60 },
      tightest_distance: tightest,
      shown_by_the_app: { distance_m: back.maxDistance, time_s: back.maxTime, rows: checks.slice(1).map((c) => `${c.label}: ${c.value} ${c.limit}, ${c.margin}`) },
    }
  })

  it('times the return check and the whole plan', { timeout: 300_000 }, () => {
    const median = (f: () => void, n = 3) => {
      const ms: number[] = []
      for (let i = 0; i < n; i++) {
        const t0 = performance.now()
        f()
        ms.push(performance.now() - t0)
      }
      return +ms.sort((a, b) => a - b)[n >> 1].toFixed(0)
    }
    const bench: Record<string, unknown> = {}
    for (const [name, input] of Object.entries(MISSIONS)) {
      const plans = computeAllPlans(t, input)
      const routes = ROUTE_MODES.map((m) => plans[m.id]!).filter((p) => !p.error)
      let stats = {}
      const returnMs = routes.length
        ? median(() => {
            const f = new WalkBackField(t, input.points[0])
            for (const p of routes) f.assess(p.samples)
            stats = { ...f.stats }
          })
        : 0
      bench[name] = { all_three_modes_ms: median(() => computeAllPlans(t, input)), of_which_return_check_ms: returnMs, ...stats }
    }
    report.benchmark = bench
    const out = JSON.stringify(report, null, 1)
    if (process.env.SAFETY_OUT) writeFileSync(process.env.SAFETY_OUT, out)
  })
})
