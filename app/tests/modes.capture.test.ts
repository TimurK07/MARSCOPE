// Three routing modes on the real Gale terrain: invariants, a comparison table and timings.
import { writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { MAX_SLOPE_DEG } from '../src/lib/model'
import { ROUTE_MODES } from '../src/lib/objectives'
import { lineCells } from '../src/lib/pathGeometry'
import { computeAllPlans, computePlan, summarise, type Plan } from '../src/lib/planner'
import { cellAt } from '../src/lib/terrain'
import { isWalkable } from '../src/lib/router'
import { EXAMPLE, loadTerrainFromDisk } from './loadTerrain'

// These tests search the full 1024 x 1024 grid; when the whole suite runs in parallel they need more than the default 5 s.
vi.setConfig({ testTimeout: 120_000 })

const t = loadTerrainFromDisk()
const MASS = 180

const MISSIONS = {
  example: { points: EXAMPLE, roundTrip: true, massKg: MASS },
  // The example plus a third target up the slope to the south.
  extended: { points: [...EXAMPLE, { lat: -4.8442, lon: 137.372 }], roundTrip: true, massKg: MASS },
}

function checkSafe(p: Plan) {
  const w = t.width
  for (const s of p.samples) expect(isWalkable(t, cellAt(t, s))).toBe(true)
  for (const leg of p.legs) {
    const cells = leg.vertices.map((v) => cellAt(t, v))
    for (let i = 1; i < cells.length; i++) {
      expect(lineCells(t, cells[i - 1] % w, Math.floor(cells[i - 1] / w), cells[i] % w, Math.floor(cells[i] / w))).not.toBeNull()
    }
    expect(leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
    expect(leg.cost).toBeLessThanOrEqual(leg.grid.cost * (1 + 1e-9) + 1e-6)
  }
}

describe('three modes on the real terrain', () => {
  const report: Record<string, unknown> = {}

  for (const [name, input] of Object.entries(MISSIONS)) {
    it(`${name}: every mode is safe, complete and held to the same checks`, { timeout: 120_000 }, () => {
      const plans = computeAllPlans(t, input)
      const rows: Record<string, unknown> = {}
      for (const m of ROUTE_MODES) {
        const p = plans[m.id]!
        expect(p.error).toBeNull()
        checkSafe(p)
        expect(p.walkBack!.reachable).toBe(true)
        const s = summarise(p, input, 20)!
        expect(s.checks!.map((c) => c.id)).toEqual(['duration', 'walkback-distance', 'walkback-time'])
        rows[m.id] = {
          verdict: s.verdict,
          distance_m: +p.distance.toFixed(0),
          walking_min: +(p.walkTime / 60).toFixed(2),
          energy_kcal: +s.energyKcal.toFixed(1),
          climb_m: +p.ascent.toFixed(0),
          hidden_load: +p.exposure!.load.toFixed(2),
          hidden_per_km: +p.exposure!.perKm.toFixed(2),
          cells_affected_pct: +(p.exposure!.cellShare * 100).toFixed(2),
          worst_cell_pct: +(p.exposure!.worst * 100).toFixed(0),
          walk_back: `${(p.walkBack!.maxDistance / 1000).toFixed(2)} km / ${(p.walkBack!.maxTime / 60).toFixed(1)} min`,
          vertices: p.legs.map((l) => l.vertices.length).join('+'),
        }
      }
      // Each mode is at least as good as the others on what it optimises, within the
      // small slack that straightening (a greedy step) can introduce.
      const f = plans.fastest!
      const e = plans.energy!
      const c = plans.cautious!
      const kcal = (p: Plan) => (p.energyPerKg * MASS + p.energyFixed) / 4184
      expect(f.walkTime).toBeLessThanOrEqual(Math.min(e.walkTime, c.walkTime) * 1.01)
      expect(kcal(e)).toBeLessThanOrEqual(Math.min(kcal(f), kcal(c)) * 1.01)
      expect(c.objectiveValue).toBeLessThanOrEqual(c.legs.reduce((a, l) => a + l.grid.cost, 0) * (1 + 1e-9))
      report[name] = rows
    })
  }

  it('times the planner', { timeout: 180_000 }, () => {
    const median = (fn: () => void) => {
      const runs: number[] = []
      for (let i = 0; i < 5; i++) {
        const s0 = performance.now()
        fn()
        runs.push(performance.now() - s0)
      }
      return +runs.sort((a, b) => a - b)[2].toFixed(0)
    }
    report.bench_median_ms = {
      example_selected_mode_first: median(() => computePlan(t, MISSIONS.example, 'fastest')),
      example_all_three_modes: median(() => computeAllPlans(t, MISSIONS.example)),
      extended_all_three_modes: median(() => computeAllPlans(t, MISSIONS.extended)),
      extended_cached_repeat: (() => {
        const cache = new Map()
        computeAllPlans(t, MISSIONS.extended, cache)
        return median(() => computeAllPlans(t, MISSIONS.extended, cache))
      })(),
    }
    const out = JSON.stringify(report, null, 1)
    console.log(out)
    if (process.env.MODES_OUT) writeFileSync(process.env.MODES_OUT, out)
  })
})
