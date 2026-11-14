// Prints the example mission as the current code computes it. Used to record
// before/after numbers; it asserts nothing about specific values.
import { writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { buildChecks } from '../src/lib/mission'
import { findLeg, walkBack } from '../src/lib/router'
import { EXAMPLE, loadTerrainFromDisk } from './loadTerrain'

// These tests search the full 1024 x 1024 grid; when the whole suite runs in parallel they need more than the default 5 s.
vi.setConfig({ testTimeout: 120_000 })

it('captures the example mission', { timeout: 120_000 }, () => {
  const t = loadTerrainFromDisk()
  const seq = [...EXAMPLE, EXAMPLE[0]]
  let dist = 0
  let time = 0
  let asc = 0
  let desc = 0
  let perKg = 0
  let fixed = 0
  let cells = 0
  const legs: string[] = []
  const samples: { lat: number; lon: number }[] = []
  const t0 = performance.now()
  for (let i = 0; i < seq.length - 1; i++) {
    const r = findLeg(t, seq[i], seq[i + 1])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    dist += r.leg.distance
    time += r.leg.duration
    asc += r.leg.ascent
    desc += r.leg.descent
    perKg += r.leg.energyPerKg
    fixed += r.leg.energyFixed
    cells += r.leg.samples.length
    samples.push(...r.leg.samples)
    legs.push(
      `${r.leg.distance.toFixed(0)} m / ${(r.leg.duration / 60).toFixed(2)} min / max slope ${r.leg.maxSlope.toFixed(2)} | grid path ${r.leg.grid.distance.toFixed(0)} m / ${(r.leg.grid.duration / 60).toFixed(2)} min, ${r.leg.grid.cells} cells -> ${r.leg.vertices.length} vertices | hidden steep: ${r.leg.hiddenCells == null ? 'n/a' : (r.leg.hiddenCells * 100).toFixed(1) + '% of cells, worst ' + ((r.leg.hiddenMax ?? 0) * 100).toFixed(0) + '%, load ' + (r.leg.hiddenLoad ?? 0).toFixed(2)}`,
    )
  }
  const ms = performance.now() - t0
  const tb = performance.now()
  const back = walkBack(t, EXAMPLE[0], samples)
  const backMs = performance.now() - tb
  const checks = buildChecks({ evaSeconds: time + 2 * 20 * 60, walkBack: back })
  // A long diagonal leg across the study area, as a stress case.
  const b = t.meta.bbox
  const t1 = performance.now()
  const long = findLeg(t, { lat: b.south + 0.008, lon: b.west + 0.012 }, { lat: b.north - 0.012, lon: b.east - 0.02 })
  const longMs = performance.now() - t1
  // Timings: median of several runs, after the first run has warmed the code up.
  const median = (fn: () => void) => {
    const runs: number[] = []
    for (let i = 0; i < 7; i++) {
      const s0 = performance.now()
      fn()
      runs.push(performance.now() - s0)
    }
    return +runs.sort((x, y) => x - y)[3].toFixed(1)
  }
  const bench = {
    example_3_legs_ms: median(() => {
      for (let i = 0; i < seq.length - 1; i++) findLeg(t, seq[i], seq[i + 1])
    }),
    long_leg_ms: median(() => findLeg(t, { lat: b.south + 0.008, lon: b.west + 0.012 }, { lat: b.north - 0.012, lon: b.east - 0.02 })),
    walk_back_ms: median(() => walkBack(t, EXAMPLE[0], samples)),
  }
  const report = JSON.stringify(
      {
        distance_m: +dist.toFixed(1),
        walking_min: +(time / 60).toFixed(2),
        eva_min_with_2x20: +(time / 60 + 40).toFixed(2),
        ascent_m: +asc.toFixed(1),
        descent_m: +desc.toFixed(1),
        walking_kcal_180kg: +((perKg * 180 + fixed) / 4184).toFixed(1),
        route_cells: cells,
        legs,
        example_ms: +ms.toFixed(0),
        walk_back: back && { max_distance_m: +back.maxDistance.toFixed(0), max_time_min: +(back.maxTime / 60).toFixed(1), reachable: back.reachable },
        walk_back_ms: +backMs.toFixed(0),
        checks: checks.map((c) => `${c.label}: ${c.value} (${c.limit}) ${c.ok ? 'ok' : 'FAIL'}, ${c.margin}`),
        long_leg: long.ok ? `${long.leg.distance.toFixed(0)} m / ${(long.leg.duration / 60).toFixed(1)} min` : long.reason,
        long_leg_ms: +longMs.toFixed(0),
        bench_median_ms: bench,
      },
      null,
      1,
    )
  console.log(report)
  // CAPTURE_OUT=<file> saves the numbers, for before/after comparisons.
  if (process.env.CAPTURE_OUT) writeFileSync(process.env.CAPTURE_OUT, report)
})
