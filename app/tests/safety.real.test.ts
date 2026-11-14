// The hard limits on the real Gale terrain: the per-step slope limit and the joint
// return check, re-verified with arithmetic written in this file.
//
// The grid is the one built from 4 x 4 block means of the 1 m DEM (Phase 4.2).
// Figures that depend on the grid are noted as such where they appear.
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
const SOL_4677 = { lat: -4.80871233, lon: 137.3816902 } // 1.11 km: the case the audit found misjudged in Phase 4.1
const SOUTH = { lat: -4.8442, lon: 137.372 }
// 1.6 km east of the habitat in a straight line, across broken ground.
const EAST = { lat: -4.8235, lon: 137.4160 }
// On steep but walkable ground (cell slope 19.9 degrees), 600 m from the habitat.
const STEEP_TARGET = { lat: -4.815874, lon: 137.3894873 }
const MESA = { lat: -4.7924951, lon: 137.3979639 } // a walkable cell on a mesa cut off on all sides

const MISSIONS: Record<string, PlanInput> = {
  example: { points: EXAMPLE, roundTrip: true, massKg: MASS },
  longer: { points: [...EXAMPLE, SOL_4845], roundTrip: true, massKg: MASS },
  audit_case: { points: [...EXAMPLE, SOL_4677], roundTrip: true, massKg: MASS },
  south: { points: [...EXAMPLE, SOUTH], roundTrip: true, massKg: MASS },
  east: { points: [...EXAMPLE, EAST], roundTrip: true, massKg: MASS },
  steep: { points: [...EXAMPLE, STEEP_TARGET], roundTrip: true, massKg: MASS },
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

const report: Record<string, unknown> = {}
// Neighbour pairs of walkable cells on the current grid, and how many of them are steeper than 20 degrees.
const BETWEEN = 3_046_043
const STEEP = 4577

describe('per-step slope limit on the real grid', () => {
  it('counts the steep steps between walkable cells, and finds every one refused', () => {
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
    // Counts for the block-mean grid. (The misplaced grid it replaced had 3,717 of 3,055,746.)
    report.steep_steps = { between_walkable_cells: between, over_20_deg: steep, steepest_deg: +worst.toFixed(2) }
    expect(between).toBe(BETWEEN)
    expect(steep).toBe(STEEP)
    expect(worst).toBeGreaterThan(30)
    expect(passed).toBe(0)
  })
})

describe('missions on the real grid', () => {

  // ---- an independent reading of the terrain, written here: plain searches from the habitat
  const DX8 = [1, 1, 0, -1, -1, -1, 0, 1]
  const DY8 = [0, 1, 1, 1, 0, -1, -1, -1]
  /** The speed model, written out here. */
  const model = (g: number) => (g <= -20 ? 0.05 : g <= -10 ? 0.095 * g + 1.95 : g <= 0 ? 0.06 * g + 1.6 : g <= 6 ? -0.2 * g + 1.6 : g <= 15 ? -0.039 * g + 0.634 : 0.05)
  /** The way back is timed at the planning pace: the model, never faster than 2000 m in 3600 s. */
  const speed = (g: number) => Math.min(model(g), 2000 / 3600)
  /** The step u -> v if it may be walked: its length and time. */
  const stepOf = (u: number, k: number): { v: number; d: number; s: number } | null => {
    const x = u % W
    const y = (u - x) / W
    const nx = x + DX8[k]
    const ny = y + DY8[k]
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return null
    const v = ny * W + nx
    if (!cellOk(u) || !cellOk(v)) return null
    if (DX8[k] !== 0 && DY8[k] !== 0 && (!cellOk(y * W + nx) || !cellOk(ny * W + x))) return null
    const len = Math.hypot(DX8[k] * CX, DY8[k] * CY)
    const dz = z(v) - z(u)
    const g = (Math.atan2(dz, len) * 180) / Math.PI
    if (!(Math.abs(g) <= 20)) return null
    return { v, d: Math.hypot(len, dz), s: len / speed(g) }
  }
  /**
   * Least cost of walking to the habitat from every cell, by distance or by time.
   * A plain Dijkstra with a sorted bucket list; nothing shared with the planner.
   */
  const toHome = (home: number, by: 'd' | 's'): Float64Array => {
    const best = new Float64Array(W * H).fill(Infinity)
    const done = new Uint8Array(W * H)
    const heap: [number, number][] = [[0, home]]
    best[home] = 0
    const push = (c: number, n: number) => {
      heap.push([c, n])
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1
        if (heap[p][0] <= heap[i][0]) break
        ;[heap[p], heap[i]] = [heap[i], heap[p]]
        i = p
      }
    }
    const pop = (): [number, number] => {
      const top = heap[0]
      const last = heap.pop()!
      if (heap.length) {
        heap[0] = last
        for (let i = 0; ; ) {
          let c = 2 * i + 1
          if (c >= heap.length) break
          if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++
          if (heap[i][0] <= heap[c][0]) break
          ;[heap[i], heap[c]] = [heap[c], heap[i]]
          i = c
        }
      }
      return top
    }
    while (heap.length) {
      const [cost, v] = pop()
      if (done[v]) continue
      done[v] = 1
      // Every neighbour u that may step onto v: the step is taken from u's side, towards the habitat.
      for (let k = 0; k < 8; k++) {
        const x = (v % W) + DX8[k]
        const y = Math.floor(v / W) + DY8[k]
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const u = y * W + x
        if (done[u]) continue
        const e = stepOf(u, (k + 4) % 8)
        if (!e || e.v !== v) continue
        const c = cost + e[by]
        if (c < best[u]) {
          best[u] = c
          push(c, u)
        }
      }
    }
    return best
  }
  /** Length and time of a path of cells; null if any step may not be walked. */
  const rewalk = (path: number[]): { d: number; s: number } | null => {
    let d = 0
    let s = 0
    for (let i = 1; i < path.length; i++) {
      let e = null
      for (let k = 0; k < 8 && !e; k++) {
        const c = stepOf(path[i - 1], k)
        if (c && c.v === path[i]) e = c
      }
      if (!e) return null
      d += e.d
      s += e.s
    }
    return { d, s }
  }

  const home = cellAt(t, EXAMPLE[0])
  const D = RETURN_LIMITS.distance_m
  const T = RETURN_LIMITS.time_s
  let shortest: Float64Array
  let fastest: Float64Array

  it('derives every verdict independently and finds the planner agrees', { timeout: 600_000 }, () => {
    shortest = toHome(home, 'd')
    fastest = toHome(home, 's')
    const table: Record<string, unknown> = {}
    for (const [name, input] of Object.entries(MISSIONS)) {
      const plans = computeAllPlans(t, input)
      const field = new WalkBackField(t, EXAMPLE[0])
      const row: Record<string, unknown> = {}
      const verdicts = new Set<string>()
      // A checkpoint the habitat cannot be reached from is one no route can reach either (steps are allowed both ways).
      const cutOff = input.points.some((p) => !Number.isFinite(shortest[cellAt(t, p)]))
      for (const m of ROUTE_MODES) {
        const p = plans[m.id]!
        const s = summarise(p, input, 20)!
        verdicts.add(s.verdict)
        if (p.error) {
          expect(cutOff, `${name}: NO ROUTE must mean a checkpoint is cut off`).toBe(true)
          row[m.id] = { verdict: s.verdict, error: p.error }
          continue
        }
        expect(cutOff).toBe(false)
        const v = verifyRoute(p)
        // Both walking times belong to the same route: re-add them here from the route's own samples.
        let modelTime = 0
        let planTime = 0
        let flatTotal = 0
        for (let i = 1; i < p.samples.length; i++) {
          const a = p.samples[i - 1]
          const b = p.samples[i]
          const along = b.dist - a.dist
          if (along <= 0) continue
          const dz = b.elevation - a.elevation
          const flat = Math.sqrt(Math.max(along * along - dz * dz, 0))
          const g = (Math.atan2(dz, flat) * 180) / Math.PI
          flatTotal += flat
          modelTime += flat / model(g)
          planTime += flat / speed(g)
        }
        expect(Math.abs(modelTime - p.walkTime) / p.walkTime).toBeLessThan(1e-6)
        expect(Math.abs(planTime - p.planWalkTime) / p.planWalkTime).toBeLessThan(1e-6)
        expect(p.planWalkTime).toBeGreaterThanOrEqual(p.walkTime)
        // Nothing on a route is walked faster than the planning pace in that scenario.
        expect(p.planWalkTime).toBeGreaterThanOrEqual(flatTotal / (2000 / 3600) - 1e-6)
        const cells = [...new Set(p.samples.map((q) => cellAt(t, q)))]
        // What the terrain says about the way back, without the planner's return check:
        //   no path at all can be within both limits from a cell whose shortest way back is too long or fastest too slow.
        const provenFail = cells.some((c) => shortest[c] > D || fastest[c] > T)
        //   and a plan passes when every cell has a real path, re-walked here, within both limits.
        let provenPass = true
        let worst = { d: 0, s: 0 }
        for (const c of cells) {
          const path = field.returnPath(c)
          const sums = path && path[0] === c && path[path.length - 1] === home ? rewalk(path) : null
          const got = field.cell(c)!
          if (sums) {
            // The figures the planner reports for the cell are this path's own, at full precision.
            expect(Math.abs(sums.d - got.dist)).toBeLessThan(1e-6)
            expect(Math.abs(sums.s - got.time)).toBeLessThan(1e-6)
          }
          if (!sums || sums.d > D || sums.s > T) provenPass = false
          else if (Math.max(sums.d / D, sums.s / T) > Math.max(worst.d / D, worst.s / T)) worst = sums
        }
        // The 8-hour limit is judged on the planning duration: the planning walking time re-added above, plus 20 min at each target.
        const planEva = planTime + (input.points.length - 1) * 20 * 60
        expect(Math.abs(planEva - s.planEvaSeconds)).toBeLessThan(1e-3)
        const overTime = planEva > 8 * 3600
        // Background dose for each duration: 0.67 mSv per day times the time, re-derived here.
        const modelEva = modelTime + (input.points.length - 1) * 20 * 60
        expect(Math.abs(s.doseMsv - (0.67 * modelEva) / 86_400)).toBeLessThan(1e-7)
        expect(Math.abs(s.planDoseMsv - (0.67 * planEva) / 86_400)).toBeLessThan(1e-7)
        const independent = provenFail || overTime ? 'nogo' : provenPass ? 'go' : 'undetermined'
        expect(s.checks!.find((c) => c.id === 'duration')!.ok).toBe(!overTime)
        expect(independent, `${name}/${m.id}: the independent reading must settle the verdict`).not.toBe('undetermined')
        expect(s.verdict, `${name}/${m.id}`).toBe(independent)
        const back = p.walkBack!
        expect(back.verified).toBe(true)
        row[m.id] = {
          verdict: s.verdict,
          failed: s.checks!.filter((c) => !c.ok).map((c) => `${c.id} ${c.value}`),
          distance_m: +p.distance.toFixed(0),
          walk_min: +(p.walkTime / 60).toFixed(1),
          walk_min_planning: +(p.planWalkTime / 60).toFixed(1),
          eva_min: +(s.evaSeconds / 60).toFixed(0),
          eva_min_planning: +(s.planEvaSeconds / 60).toFixed(0),
          energy_kcal: +s.energyKcal.toFixed(0),
          dose_mSv_model: +s.doseMsv.toFixed(4),
          dose_mSv_planning: +s.planDoseMsv.toFixed(4),
          climb_m: +p.ascent.toFixed(0),
          descent_m: +p.descent.toFixed(0),
          hidden_load: +p.exposure!.load.toFixed(2),
          hidden_per_km: +p.exposure!.perKm.toFixed(2),
          return_m: +back.maxDistance.toFixed(2),
          return_min: +(back.maxTime / 60).toFixed(2),
          independent: provenFail
            ? `no way back within limits: from some point the shortest is ${Math.max(...cells.map((c) => shortest[c])).toFixed(0)} m, the fastest ${(Math.max(...cells.map((c) => fastest[c])) / 60).toFixed(1)} min`
            : `every return path re-walked; tightest ${worst.d.toFixed(3)} m in ${worst.s.toFixed(1)} s`,
          steepest_step_deg: +v.steepest.toFixed(2),
          steps_checked: v.pieces + v.moves,
          cells_checked: cells.length,
        }
      }
      // Safety verdicts are the same for every priority: the return check does not depend on it.
      expect(verdicts.size, name).toBe(1)
      table[name] = row
    }
    Object.assign(report, table)
    // Fixed points of the scenario set. The southern and the audit missions are not listed:
    // their verdicts are whatever the independent reading above establishes.
    const verdictOf = (name: string) => (table[name] as Record<string, { verdict: string }>).fastest.verdict
    expect(verdictOf('example')).toBe('go')
    expect(verdictOf('longer')).toBe('go')
    expect(verdictOf('east')).toBe('nogo')
    expect(verdictOf('mesa')).toBe('noroute')
  })

  it('return distance limit on the real grid: the verdict follows the limit, and each one is checked independently', () => {
    // [mission, limit in metres]. At the default limit the example's way back from its far end is shown as 885 m,
    // the quickest one. A shorter one exists (about 750 m), so the plan still passes at 0.8 km: the check looks for
    // a way back within the limit chosen, it does not compare the limit with the figure it showed before.
    const cases: [string, number][] = [['example', 700], ['example', 800], ['audit_case', 1200], ['audit_case', 1300], ['audit_case', 2000], ['east', 3000]]
    const rows: Record<string, unknown> = {}
    const details: Record<string, string> = {}
    for (const [name, limit] of cases) {
      const input = { ...MISSIONS[name], returnDistanceM: limit }
      const plans = computeAllPlans(t, input)
      const field = new WalkBackField(t, EXAMPLE[0], { distance_m: limit, time_s: T })
      const seen = new Set<string>()
      for (const m of ROUTE_MODES) {
        const p = plans[m.id]!
        const s = summarise(p, input, 20)!
        const cells = [...new Set(p.samples.map((q) => cellAt(t, q)))]
        // No way back can be within the limits from a cell whose shortest is over the distance limit or fastest over the hour.
        const provenFail = cells.some((c) => shortest[c] > limit || fastest[c] > T)
        let provenPass = true
        for (const c of cells) {
          const path = field.returnPath(c)
          const sums = path && path[0] === c && path[path.length - 1] === home ? rewalk(path) : null
          if (!sums || sums.d > limit || sums.s > T) provenPass = false
        }
        const independent = provenFail ? 'nogo' : provenPass ? 'go' : 'undetermined'
        expect(independent, `${name} at ${limit} m, ${m.id}`).not.toBe('undetermined')
        expect(s.verdict, `${name} at ${limit} m, ${m.id}`).toBe(independent)
        expect(s.checks!.find((c) => c.id === 'walkback-distance')!.limit).toBe(`≤ ${limit / 1000} km`)
        expect(p.walkBack!.verified).toBe(true)
        seen.add(s.verdict)
      }
      expect(seen.size).toBe(1)
      rows[`${name} @ ${limit / 1000} km`] = [...seen][0]
      const back = plans.fastest!.walkBack!
      details[`${name} @ ${limit / 1000} km`] = `${[...seen][0]}: way back ${back.maxDistance.toFixed(0)} m in ${(back.maxTime / 60).toFixed(1)} min`
    }
    report.return_limit_cases = details
    // The limit moves these verdicts both ways.
    expect(rows['example @ 0.7 km']).toBe('nogo')
    expect(rows['example @ 0.8 km']).toBe('go')
    expect(rows['audit_case @ 1.2 km']).toBe('nogo')
    expect(rows['audit_case @ 1.3 km']).toBe('go')
    expect(rows['audit_case @ 2 km']).toBe('go')
    // And above 2 km it cannot rescue a plan whose way back takes over an hour.
    expect(rows['east @ 3 km']).toBe('nogo')
  })

  it('example mission with long stops: under 8 h by the model, over at the planning pace, NO-GO in every mode', () => {
    const input = MISSIONS.example
    const plans = computeAllPlans(t, input)
    const LIMIT = 8 * 3600
    const stop = 215 // minutes at each of the two targets
    const rows: Record<string, unknown> = {}
    for (const m of ROUTE_MODES) {
      const p = plans[m.id]!
      const s = summarise(p, input, stop)!
      // Both walking times re-added here from the route's own samples.
      let modelTime = 0
      let planTime = 0
      for (let i = 1; i < p.samples.length; i++) {
        const along = p.samples[i].dist - p.samples[i - 1].dist
        if (along <= 0) continue
        const dz = p.samples[i].elevation - p.samples[i - 1].elevation
        const flat = Math.sqrt(Math.max(along * along - dz * dz, 0))
        const g = (Math.atan2(dz, flat) * 180) / Math.PI
        modelTime += flat / model(g)
        planTime += flat / speed(g)
      }
      const modelEva = modelTime + 2 * stop * 60
      const planEva = planTime + 2 * stop * 60
      expect(modelEva).toBeLessThan(LIMIT)
      expect(planEva).toBeGreaterThan(LIMIT)
      expect(s.verdict).toBe('nogo')
      expect(s.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['duration'])
      rows[m.id] = { model_eva_min: +(modelEva / 60).toFixed(1), planning_eva_min: +(planEva / 60).toFixed(1), verdict: s.verdict }
      // With the default 20-minute stops the same routes are well inside the limit.
      expect(summarise(p, input, 20)!.verdict).toBe('go')
    }
    report.example_with_215_min_stops = rows
  })

  it('southern mission: the far target has no way back within the limits, by two plain searches', () => {
    const c = cellAt(t, SOUTH)
    report.south_far_target = { shortest_back_m: +shortest[c].toFixed(2), fastest_back_min: +(fastest[c] / 60).toFixed(2), limits: `${D} m, ${T / 60} min` }
    // Not asserted as an expectation of the outcome: this records which bound decides it.
    const decided = shortest[c] > D || fastest[c] > T
    const field = new WalkBackField(t, EXAMPLE[0])
    const got = field.cell(c)!
    expect(got.verified).toBe(true)
    if (decided) expect(got.feasible).toBe(false)
    else {
      // Between the bounds only a path settles it: re-walk whatever the planner claims.
      const path = field.returnPath(c)!
      const sums = rewalk(path)!
      expect(got.feasible).toBe(sums.d <= D && sums.s <= T)
    }
  })

  it('the planner\'s fastest and shortest ways back match the plain searches', () => {
    // A cross-check of the return fields themselves, at the mission targets.
    for (const p of [EXAMPLE[1], EXAMPLE[2], SOL_4845, SOL_4677, SOUTH, EAST]) {
      const c = cellAt(t, p)
      // The planner's own A* with a planning-pace time cost, against the plain search above.
      const leg = findLeg(t, p, EXAMPLE[0], {
        smooth: false,
        objective: { mode: 'fastest', unit: 's', pieceCost: (d, g) => d / speed(g), minPerMetre: 1 / 1.6 },
      })
      expect(leg.ok).toBe(true)
      if (leg.ok) expect(Math.abs(leg.leg.grid.cost - fastest[c])).toBeLessThan(1e-6)
      const short = findLeg(t, p, EXAMPLE[0], {
        smooth: false,
        objective: { mode: 'fastest', unit: 'm', pieceCost: (d, g) => d / Math.cos((g * Math.PI) / 180), minPerMetre: 1 },
      })
      if (short.ok) expect(Math.abs(short.leg.grid.distance - shortest[c])).toBeLessThan(1e-6)
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
