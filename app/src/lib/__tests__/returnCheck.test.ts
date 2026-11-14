// Return to the habitat: one way back must meet the distance limit and the time
// limit together. The planner's answer is compared with two references written
// here from scratch: every simple path on tiny grids, and full Pareto fronts on
// larger random ones.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { walkingSpeedMs } from '../model'
import { buildChecks, missionVerdict } from '../mission'
import { computeAllPlans, summarise } from '../planner'
import { WalkBackField, walkBack, type ReturnLimits } from '../returnCheck'
import { ROUTE_MODES } from '../objectives'
import type { Terrain } from '../terrain'
import { at, CELL, makeTerrain, rng } from './synthetic'

const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]

// ---- the rules, written out again for the references (nothing shared with the planner but the speed model)
/** The planning pace, written out here: the model's speed, never above 2000 m in 3600 s. */
const planning = (g: number) => Math.min(walkingSpeedMs(g), 2000 / 3600)
/** The speed the references walk at. The return check uses the planning pace unless told otherwise. */
let SPEED: (g: number) => number = planning
const BOTH_SPEEDS: [string, (g: number) => number][] = [
  ['at the planning pace', planning],
  ['at the model speed', walkingSpeedMs],
]
const slopeOf = (t: Terrain, i: number) => (t.slopeRaw[i] === 65535 ? NaN : t.slopeRaw[i] * 0.01)
const okCell = (t: Terrain, i: number) => !Number.isNaN(slopeOf(t, i)) && slopeOf(t, i) <= 20
const elev = (t: Terrain, i: number) => t.elevRaw[i] * t.meta.elevation.scale_m
/** The step from cell u to its k-th neighbour: length, time, or null when it may not be walked. */
function step(t: Terrain, u: number, k: number): { v: number; d: number; s: number } | null {
  const x = u % t.width
  const y = (u - x) / t.width
  const nx = x + DX[k]
  const ny = y + DY[k]
  if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) return null
  const v = ny * t.width + nx
  if (!okCell(t, u) || !okCell(t, v)) return null
  if (DX[k] !== 0 && DY[k] !== 0 && (!okCell(t, y * t.width + nx) || !okCell(t, ny * t.width + x))) return null
  const len = Math.hypot(DX[k] * CELL, DY[k] * CELL)
  const dz = elev(t, v) - elev(t, u)
  const grade = (Math.atan2(dz, len) * 180) / Math.PI
  if (!(Math.abs(grade) <= 20)) return null
  return { v, d: Math.hypot(len, dz), s: len / SPEED(grade) }
}

/** Reference 1: walk every simple path from a cell to the habitat. Tiny grids only. */
function existsByEnumeration(t: Terrain, from: number, home: number, lim: ReturnLimits): boolean {
  const seen = new Uint8Array(t.width * t.height)
  const go = (u: number, d: number, s: number): boolean => {
    if (d > lim.distance_m || s > lim.time_s) return false
    if (u === home) return true
    seen[u] = 1
    for (let k = 0; k < 8; k++) {
      const e = step(t, u, k)
      if (e && !seen[e.v] && go(e.v, d + e.d, s + e.s)) {
        seen[u] = 0
        return true
      }
    }
    seen[u] = 0
    return false
  }
  return okCell(t, from) && go(from, 0, 0)
}

/**
 * Reference 2: for every cell, all (distance, time) pairs of ways back that no
 * other way back beats on both counts. Label correcting, no bounds, no heuristics.
 */
function paretoFronts(t: Terrain, home: number, lim: ReturnLimits = { distance_m: Infinity, time_s: Infinity }): [number, number][][] {
  const n = t.width * t.height
  const fronts: [number, number][][] = Array.from({ length: n }, () => [])
  if (!okCell(t, home)) return fronts
  fronts[home] = [[0, 0]]
  const queue = [home]
  const queued = new Uint8Array(n)
  while (queue.length) {
    const v = queue.shift()!
    queued[v] = 0
    for (let k = 0; k < 8; k++) {
      // The neighbour u walks u -> v; find that step from u's side.
      const x = v % t.width
      const y = (v - x) / t.width
      const ux = x + DX[k]
      const uy = y + DY[k]
      if (ux < 0 || uy < 0 || ux >= t.width || uy >= t.height) continue
      const u = uy * t.width + ux
      const e = step(t, u, (k + 4) % 8)
      if (!e || e.v !== v) continue
      let changed = false
      for (const [d0, s0] of fronts[v]) {
        const d = d0 + e.d
        const s = s0 + e.s
        if (d > lim.distance_m || s > lim.time_s) continue
        if (fronts[u].some(([a, b]) => a <= d && b <= s)) continue
        fronts[u] = fronts[u].filter(([a, b]) => !(d <= a && s <= b))
        fronts[u].push([d, s])
        changed = true
      }
      if (changed && !queued[u]) {
        queued[u] = 1
        queue.push(u)
      }
    }
  }
  return fronts
}

/** Hills, a few blocked cells, and sometimes a cliff line between walkable cells. */
function randomTerrain(rand: () => number, size: number): Terrain {
  const a = 1 + rand() * 5
  const fx = 0.5 + rand() * 1.2
  const fy = 0.5 + rand() * 1.2
  const cliffAt = rand() < 0.5 ? 2 + Math.floor(rand() * (size - 4)) : -1
  const blocked = new Set<number>()
  for (let i = 0; i < size; i++) if (rand() < 0.5) blocked.add(Math.floor(rand() * size * size))
  return makeTerrain(
    size,
    size,
    (x, y) => (blocked.has(y * size + x) ? 30 : 0),
    (x, y) => 12 + a * Math.sin(x * fx) * Math.cos(y * fy) + (cliffAt >= 0 && x >= cliffAt && y % 4 !== 0 ? 3 : 0),
  )
}

describe.each(BOTH_SPEEDS)('one way back within both limits: against every simple path, %s', (_name, speed) => {
  beforeAll(() => {
    SPEED = speed
  })
  afterAll(() => {
    SPEED = planning
  })
  it('agrees on 4 x 4 grids for every cell and many limits', () => {
    const rand = rng(41)
    let yes = 0
    let no = 0
    for (let n = 0; n < 40; n++) {
      const t = randomTerrain(rand, 4)
      const home = Math.floor(rand() * 16)
      if (!okCell(t, home)) continue
      for (let m = 0; m < 4; m++) {
        const lim = { distance_m: 6 + rand() * 30, time_s: 4 + rand() * 60 }
        const field = new WalkBackField(t, at(t, home % 4, Math.floor(home / 4)), lim, undefined, speed)
        for (let c = 0; c < 16; c++) {
          if (!okCell(t, c)) continue
          const want = existsByEnumeration(t, c, home, lim)
          const got = field.cell(c)!
          expect(got.verified).toBe(true)
          expect(got.feasible).toBe(want)
          if (got.feasible) {
            expect(got.dist).toBeLessThanOrEqual(lim.distance_m)
            expect(got.time).toBeLessThanOrEqual(lim.time_s)
          }
          if (want) yes++
          else no++
        }
      }
    }
    expect(yes).toBeGreaterThan(300)
    expect(no).toBeGreaterThan(300)
  })
})

describe.each(BOTH_SPEEDS)('one way back within both limits: against full Pareto fronts, %s', (_name, speed) => {
  beforeAll(() => {
    SPEED = speed
  })
  afterAll(() => {
    SPEED = planning
  })
  it('agrees for every cell, with limits placed in the gaps between the trade-offs', () => {
    const rand = rng(7)
    let checked = 0
    let gapCases = 0
    let exactSearches = 0
    for (let n = 0; n < 30; n++) {
      const size = 9 + Math.floor(rand() * 4)
      const t = randomTerrain(rand, size)
      const home = Math.floor(rand() * size * size)
      if (!okCell(t, home)) continue
      const all = paretoFronts(t, home)
      // Limits taken from the trade-offs of some cell far from home, so that they bite.
      const rich = all.map((f, i) => ({ i, f })).filter((o) => o.f.length >= 2)
      const trials: ReturnLimits[] = []
      for (let k = 0; k < 4 && rich.length; k++) {
        const f = [...rich[Math.floor(rand() * rich.length)].f].sort((p, q) => p[0] - q[0])
        const j = Math.floor(rand() * (f.length - 1))
        // Between two neighbouring trade-off points: just short of both, and just enough for one of them.
        trials.push({ distance_m: (f[j][0] + f[j + 1][0]) / 2, time_s: (f[j][1] + f[j + 1][1]) / 2 })
        trials.push({ distance_m: f[j][0] * (1 + 1e-6), time_s: f[j][1] * (1 + 1e-6) })
        trials.push({ distance_m: f[j + 1][0] * (1 - 1e-6), time_s: f[j][1] * (1 - 1e-6) })
      }
      trials.push({ distance_m: size * CELL * 0.9, time_s: 40 })
      for (const lim of trials) {
        const field = new WalkBackField(t, at(t, home % size, Math.floor(home / size)), lim, undefined, speed)
        for (let c = 0; c < size * size; c++) {
          if (!okCell(t, c)) continue
          const want = all[c].some(([d, s]) => d <= lim.distance_m && s <= lim.time_s)
          const got = field.cell(c)!
          expect(got.verified).toBe(true)
          expect(got.feasible, `terrain ${n}, cell ${c}, limits ${lim.distance_m.toFixed(2)} m / ${lim.time_s.toFixed(2)} s`).toBe(want)
          if (got.feasible) {
            // The path it reports is a real one: some true way back is no longer and no slower.
            expect(got.dist).toBeLessThanOrEqual(lim.distance_m)
            expect(got.time).toBeLessThanOrEqual(lim.time_s)
            expect(all[c].some(([d, s]) => d <= got.dist + 1e-6 && s <= got.time + 1e-6)).toBe(true)
          }
          // The case two separate checks get wrong: shortest is short enough, fastest quick enough, no path is both.
          const shortest = Math.min(...all[c].map((p) => p[0]))
          const fastest = Math.min(...all[c].map((p) => p[1]))
          if (all[c].length && shortest <= lim.distance_m && fastest <= lim.time_s && !want) gapCases++
          checked++
        }
        exactSearches += field.stats.exactSearches
        expect(field.stats.unverified).toBe(0)
      }
    }
    expect(checked).toBeGreaterThan(20_000)
    // The references really contain the hard case, and the exact search really ran.
    expect(gapCases).toBeGreaterThan(50)
    expect(exactSearches).toBeGreaterThan(50)
  })

  it('gives the same answer whatever order the cells are asked in', () => {
    const rand = rng(99)
    const t = randomTerrain(rand, 12)
    const home = 5 * 12 + 6
    const all = paretoFronts(t, home)
    const f = [...all.find((x) => x.length >= 3)!].sort((p, q) => p[0] - q[0])
    const lim = { distance_m: (f[0][0] + f[1][0]) / 2, time_s: (f[0][1] + f[1][1]) / 2 }
    const cells = [...Array(144).keys()].filter((c) => okCell(t, c))
    const forward = new WalkBackField(t, at(t, 6, 5), lim, undefined, speed)
    const backward = new WalkBackField(t, at(t, 6, 5), lim, undefined, speed)
    const a = cells.map((c) => forward.cell(c)!.feasible)
    const b = [...cells].reverse().map((c) => backward.cell(c)!.feasible).reverse()
    expect(a).toEqual(b)
  })
})

describe('the two limits are judged on one path', () => {
  // A wall along x = 6 with two gaps, and the habitat on a plateau 3.6 m up, west of it.
  //   Near gap (row 6): a ramp of three 1.2 m steps, 16.7 degrees. Short, but very slow to climb.
  //   Far gap (row 27): by then the plateau has eased down to the plain. Level and quick, but long.
  const W = 13
  const H = 30
  const wall = (x: number, y: number) => (x === 6 && y !== 6 && y !== 27 ? 40 : 0)
  const ground = (x: number, y: number) => {
    if (x <= 5) return y <= 12 ? 3.6 : Math.max(0, 3.6 - (y - 12) * 0.3)
    return y === 6 && x <= 8 ? (9 - x) * 1.2 : 0
  }
  const t = makeTerrain(W, H, wall, ground)
  const home = at(t, 2, 6)
  const point = at(t, 10, 6)
  const c = 6 * W + 10
  const fronts = paretoFronts(t, 6 * W + 2)[c].sort((p, q) => p[0] - q[0])

  it('has a short slow way back and a long quick one', () => {
    expect(fronts.length).toBeGreaterThanOrEqual(2)
    const shortest = fronts[0]
    const fastest = fronts[fronts.length - 1]
    expect(shortest[0]).toBeLessThan(fastest[0])
    expect(shortest[1]).toBeGreaterThan(fastest[1])
  })

  it('fails when the shortest is short enough and the fastest quick enough, but no path is both', () => {
    const shortest = fronts[0]
    const next = fronts[1]
    const fastest = fronts[fronts.length - 1]
    // Enough distance for the shortest only, enough time for anything but the shortest.
    const lim = { distance_m: (shortest[0] + next[0]) / 2, time_s: (shortest[1] + next[1]) / 2 }
    expect(shortest[0]).toBeLessThanOrEqual(lim.distance_m)
    expect(fastest[1]).toBeLessThanOrEqual(lim.time_s)
    const back = walkBack(t, home, [point], lim)!
    expect(back.reachable).toBe(true)
    expect(back.verified).toBe(true)
    expect(back.feasible).toBe(false)
    // The figures reported belong to one path, and that path breaks a limit.
    expect(back.maxDistance > lim.distance_m || back.maxTime > lim.time_s).toBe(true)
    expect(fronts.some(([d, s]) => Math.abs(d - back.maxDistance) < 1e-6 && Math.abs(s - back.maxTime) < 1e-6)).toBe(true)
  })

  it('passes as soon as one path is within both', () => {
    for (const [d, s] of fronts) {
      const back = walkBack(t, home, [point], { distance_m: d * 1.001, time_s: s * 1.001 })!
      expect(back.feasible).toBe(true)
      expect(back.maxDistance).toBeLessThanOrEqual(d * 1.001)
      expect(back.maxTime).toBeLessThanOrEqual(s * 1.001)
    }
  })

  it('passes on a long fastest way back when a shorter one is quick enough (the audit case in small)', () => {
    const shortest = fronts[0]
    const fastest = fronts[fronts.length - 1]
    // The fastest way back is over the distance limit. Checking the limit on it alone said NO-GO.
    const lim = { distance_m: (shortest[0] + fastest[0]) / 2, time_s: shortest[1] * 1.01 }
    expect(fastest[0]).toBeGreaterThan(lim.distance_m)
    const back = walkBack(t, home, [point], lim)!
    expect(back.feasible).toBe(true)
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back })
    expect(missionVerdict(true, true, checks)).toBe('go')
  })
})

describe('return check: direction, dead ends and missing data', () => {
  it('counts the climb home, not the walk out reversed', () => {
    // The habitat is at the top of an 8 degree slope; the target is below it.
    const t = makeTerrain(60, 9, () => 8, (x) => (60 - x) * CELL * Math.tan((8 * Math.PI) / 180))
    const home = at(t, 5, 4)
    const down = at(t, 50, 4)
    const out = paretoFronts(t, 4 * 60 + 50)[4 * 60 + 5] // walking home -> target, as "back" to the target
    const back = paretoFronts(t, 4 * 60 + 5)[4 * 60 + 50]
    const outTime = Math.min(...out.map((p) => p[1]))
    const backTime = Math.min(...back.map((p) => p[1]))
    // At the planning pace the walk down is capped at 2 km/h; the climb home is slower still.
    expect(backTime).toBeGreaterThan(outTime * 1.5)
    // A time limit between the two: the walk out would fit, the way back does not.
    const lim = { distance_m: 1e6, time_s: (outTime + backTime) / 2 }
    expect(walkBack(t, home, [down], lim)!.feasible).toBe(false)
    expect(walkBack(t, down, [home], lim)!.feasible).toBe(true)
  })

  it('reports a point with no way back at all', () => {
    const t = makeTerrain(20, 9, (x) => (x === 10 ? 40 : 0))
    const back = walkBack(t, at(t, 3, 4), [at(t, 5, 4), at(t, 15, 4)])!
    expect(back.reachable).toBe(false)
    expect(back.feasible).toBe(false)
  })

  it('treats cells without terrain data as impassable', () => {
    const t = makeTerrain(20, 9, (x, y) => (x === 10 && y !== 0 ? NaN : 0))
    const lim = { distance_m: 55, time_s: 1e6 }
    // Straight across would be 48 m; the only way is round the top, which is longer than the limit.
    const back = walkBack(t, at(t, 4, 6), [at(t, 16, 6)], lim)!
    expect(back.reachable).toBe(true)
    expect(back.feasible).toBe(false)
    expect(walkBack(t, at(t, 4, 6), [at(t, 16, 6)], { distance_m: 80, time_s: 1e6 })!.feasible).toBe(true)
  })

})

/** Re-walks a path of cells with the rules written in this file and adds up its length and time. */
function walk(t: Terrain, path: number[]): { d: number; s: number } | null {
  let d = 0
  let s = 0
  for (let i = 1; i < path.length; i++) {
    let e = null
    for (let k = 0; k < 8 && !e; k++) {
      const c = step(t, path[i - 1], k)
      if (c && c.v === path[i]) e = c
    }
    if (!e) return null
    d += e.d
    s += e.s
  }
  return { d, s }
}

describe('the path behind the figures', () => {
  it('is one real path from the cell to the habitat, and its own sums give both figures', () => {
    const rand = rng(314)
    let viaSearch = 0
    let checked = 0
    for (let n = 0; n < 20; n++) {
      const size = 10 + Math.floor(rand() * 3)
      const t = randomTerrain(rand, size)
      const home = Math.floor(rand() * size * size)
      if (!okCell(t, home)) continue
      const all = paretoFronts(t, home)
      const rich = all.filter((f) => f.length >= 3)
      if (!rich.length) continue
      const f = [...rich[Math.floor(rand() * rich.length)]].sort((p, q) => p[0] - q[0])
      // Just enough for a middle trade-off point: neither the shortest nor the fastest path will do.
      const j = 1 + Math.floor(rand() * (f.length - 2))
      const lim = { distance_m: f[j][0] * (1 + 1e-9), time_s: f[j][1] * (1 + 1e-9) }
      const field = new WalkBackField(t, at(t, home % size, Math.floor(home / size)), lim)
      for (let c = 0; c < size * size; c++) {
        if (!okCell(t, c)) continue
        const got = field.cell(c)!
        const path = field.returnPath(c)
        if (!got.reachable) {
          expect(path).toBeNull()
          continue
        }
        expect(path![0]).toBe(c)
        expect(path![path!.length - 1]).toBe(home)
        const sums = walk(t, path!)
        expect(sums, 'every step of the path is an allowed step').not.toBeNull()
        // Full precision, before any rounding: the figures reported are this path's own.
        expect(Math.abs(sums!.d - got.dist)).toBeLessThan(1e-9)
        expect(Math.abs(sums!.s - got.time)).toBeLessThan(1e-9)
        if (got.feasible) {
          expect(sums!.d).toBeLessThanOrEqual(lim.distance_m)
          expect(sums!.s).toBeLessThanOrEqual(lim.time_s)
        }
        checked++
      }
      viaSearch += field.stats.exactSearches
    }
    expect(checked).toBeGreaterThan(1000)
    expect(viaSearch).toBeGreaterThan(20)
  })
})

describe('exactly at the limits', () => {
  // Level ground, straight back along a row: 40 steps of 4 m, walked at the planning pace.
  const t = makeTerrain(60, 5, () => 0)
  const home = at(t, 5, 2)
  const point = at(t, 45, 2)
  const exact = new WalkBackField(t, home, { distance_m: 1e9, time_s: 1e9 }).cell(2 * 60 + 45)!
  const D = exact.dist
  const T = exact.time
  /** The nearest representable number below / above x. */
  const below = (x: number) => x * (1 - Number.EPSILON)
  const above = (x: number) => x * (1 + Number.EPSILON)
  const feasible = (distance_m: number, time_s: number) => {
    const back = walkBack(t, home, [point], { distance_m, time_s })!
    expect(back.verified).toBe(true)
    return back.feasible
  }

  it('knows the straight way back to the last digit', () => {
    expect(D).toBe(160)
    // 160 m at the planning pace of 2000 m per 3600 s: 288 s. (The model alone would take 100 s.)
    expect(Math.abs(T - 288)).toBeLessThan(1e-9)
  })

  it('passes when the way back is exactly as long and as slow as allowed', () => {
    expect(feasible(D, T)).toBe(true)
  })

  it('fails when either limit is the smallest possible amount short', () => {
    expect(below(D)).toBeLessThan(D)
    expect(feasible(below(D), T)).toBe(false)
    expect(feasible(D, below(T))).toBe(false)
    expect(feasible(below(D), below(T))).toBe(false)
    expect(feasible(below(D), 1e9)).toBe(false)
    expect(feasible(1e9, below(T))).toBe(false)
  })

  it('passes when the limits are the smallest possible amount generous', () => {
    expect(feasible(above(D), above(T))).toBe(true)
    expect(feasible(above(D), T)).toBe(true)
    expect(feasible(D, above(T))).toBe(true)
  })

  it('reports the figures of the path it accepted, unrounded', () => {
    const back = walkBack(t, home, [point], { distance_m: D, time_s: T })!
    expect(back.maxDistance).toBe(D)
    expect(back.maxTime).toBe(T)
  })
})

describe('when the calculation limit is reached', () => {
  /** Finds a terrain, cell and limits that the fields cannot settle, so the exact search has to run. */
  function hardCase() {
    const rand = rng(2718)
    for (let n = 0; n < 200; n++) {
      const size = 10 + Math.floor(rand() * 3)
      const t = randomTerrain(rand, size)
      const home = Math.floor(rand() * size * size)
      if (!okCell(t, home)) continue
      const all = paretoFronts(t, home)
      for (let c = 0; c < size * size; c++) {
        if (all[c].length < 3) continue
        const f = [...all[c]].sort((p, q) => p[0] - q[0])
        for (let j = 1; j < f.length - 1; j++) {
          for (const truth of [true, false]) {
            // Just enough for a middle trade-off point, or just short of it.
            const k = truth ? 1 + 1e-9 : 1 - 1e-9
            const lim = { distance_m: f[j][0] * k, time_s: f[j][1] * k }
            const want = all[c].some(([d, s]) => d <= lim.distance_m && s <= lim.time_s)
            const full = new WalkBackField(t, at(t, home % size, Math.floor(home / size)), lim)
            const got = full.cell(c)!
            if (full.stats.exactSearches > 0 && full.stats.labels > 3) return { t, size, home, c, lim, want, got }
          }
        }
      }
    }
    throw new Error('no hard case found')
  }
  const h = hardCase()
  const habitat = at(h.t, h.home % h.size, Math.floor(h.home / h.size))
  const point = at(h.t, h.c % h.size, Math.floor(h.c / h.size))

  it('has a case that only the exact search can settle, and settles it correctly with its full budget', () => {
    expect(h.got.verified).toBe(true)
    expect(h.got.feasible).toBe(h.want)
  })

  it('reports the point as not verified: neither passed nor failed', () => {
    for (const budget of [0, 1, 2]) {
      const starved = new WalkBackField(h.t, habitat, h.lim, budget)
      const back = starved.assess([point])!
      expect(starved.stats.unverified).toBe(1)
      expect(back.reachable).toBe(true)
      expect(back.verified).toBe(false)
      expect(back.feasible).toBe(false)
    }
  })

  it('gives the mission the verdict UNVERIFIED, not NO-GO and never GO', () => {
    const back = new WalkBackField(h.t, habitat, h.lim, 0).assess([point])!
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back })
    expect(missionVerdict(true, true, checks)).toBe('unverified')
    expect(checks.filter((c) => c.state === 'unverified').map((c) => c.id)).toEqual(['walkback-distance', 'walkback-time'])
    expect(checks.every((c) => c.state !== 'fail')).toBe(true)
  })

  it('still says NO-GO when another point of the route is a proven failure', () => {
    // A second point that is ruled out without any search, so it is proven even with no budget.
    const probe = new WalkBackField(h.t, habitat, h.lim, 0)
    const far = [...Array(h.size * h.size).keys()].find((c) => {
      const d = okCell(h.t, c) ? probe.cell(c) : null
      return !!d && d.reachable && d.verified && !d.feasible
    })
    expect(far).toBeDefined()
    if (far === undefined) return
    const back = new WalkBackField(h.t, habitat, h.lim, 0).assess([point, at(h.t, far % h.size, Math.floor(far / h.size))])!
    expect(back.verified).toBe(true)
    expect(back.feasible).toBe(false)
    expect(missionVerdict(true, true, buildChecks({ evaSeconds: 3600, walkBack: back }))).toBe('nogo')
  })

  it('stays unverified, not GO, when the other points of the route pass', () => {
    const back = new WalkBackField(h.t, habitat, h.lim, 0).assess([habitat, point])!
    expect(back.verified).toBe(false)
    expect(back.feasible).toBe(false)
    expect(missionVerdict(true, true, buildChecks({ evaSeconds: 3600, walkBack: back }))).toBe('unverified')
  })

  it('never turns a starved search into a pass, across many cases', () => {
    const rand = rng(1618)
    let starvedCases = 0
    for (let n = 0; n < 25; n++) {
      const size = 10 + Math.floor(rand() * 3)
      const t = randomTerrain(rand, size)
      const home = Math.floor(rand() * size * size)
      if (!okCell(t, home)) continue
      const all = paretoFronts(t, home)
      const rich = all.filter((f) => f.length >= 3)
      if (!rich.length) continue
      const f = [...rich[Math.floor(rand() * rich.length)]].sort((p, q) => p[0] - q[0])
      const j = 1 + Math.floor(rand() * (f.length - 2))
      const lim = { distance_m: f[j][0] * (1 + 1e-9), time_s: f[j][1] * (1 + 1e-9) }
      const starved = new WalkBackField(t, at(t, home % size, Math.floor(home / size)), lim, 0)
      for (let c = 0; c < size * size; c++) {
        if (!okCell(t, c)) continue
        const truth = all[c].some(([d, s]) => d <= lim.distance_m && s <= lim.time_s)
        const got = starved.cell(c)!
        if (got.verified) expect(got.feasible).toBe(truth) // a verified answer is still the right one
        else {
          expect(got.feasible).toBe(false) // and an unverified one is never a pass
          starvedCases++
        }
      }
    }
    expect(starvedCases).toBeGreaterThan(20)
  })
})

describe('the same return verdict for every route priority', () => {
  it('judges all three modes by the same way back', () => {
    const rand = rng(5)
    for (let n = 0; n < 6; n++) {
      const t = randomTerrain(rand, 24)
      const pts = [at(t, 3, 3), at(t, 20, 6), at(t, 18, 20)]
      const input = { points: pts, roundTrip: true, massKg: 180 }
      const plans = computeAllPlans(t, input)
      const verdicts = ROUTE_MODES.map((m) => summarise(plans[m.id], input, 0)!)
      if (verdicts.some((v) => !v.feasible)) {
        // A checkpoint that cannot be reached is NO ROUTE in every mode.
        expect(verdicts.every((v) => v.verdict === 'noroute')).toBe(true)
        continue
      }
      // The return check of a point does not depend on the mode: any point two modes share gets one answer.
      const field = new WalkBackField(t, pts[0])
      for (const m of ROUTE_MODES) {
        const own = plans[m.id]!.walkBack!
        const again = field.assess(plans[m.id]!.samples)!
        expect(again.feasible).toBe(own.feasible)
        expect(again.maxDistance).toBeCloseTo(own.maxDistance, 9)
      }
    }
  })
})
