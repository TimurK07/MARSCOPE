import { describe, expect, it } from 'vitest'
import { LatestOnly } from '../latest'
import { missionVerdict } from '../mission'
import { EVA, MAX_SLOPE_DEG, MAX_SPEED_MS, walkingSpeedMs } from '../model'
import {
  CAUTION_WEIGHT,
  cautionShare,
  cautiousObjective,
  energyObjective,
  makeObjective,
  minEnergyPerMetre,
  pieceEnergyJ,
  ROUTE_MODES,
  timeObjective,
  type Objective,
  type RouteMode,
} from '../objectives'
import { lineCells, measurePath, smoothPath } from '../pathGeometry'
import { computeAllPlans, computePlan, summarise } from '../planner'
import { findLeg, isWalkable } from '../router'
import type { Terrain } from '../terrain'
import { at, CELL, makeTerrain, rng } from './synthetic'

const STEEP = MAX_SLOPE_DEG + 10
const MASS = 180
const MODES: RouteMode[] = ['fastest', 'energy', 'cautious']
const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]

/** Exhaustive search with no heuristic, for any objective. */
function dijkstra(t: Terrain, obj: Objective, sx: number, sy: number, gx: number, gy: number): number {
  const n = t.width * t.height
  const elev = (i: number) => t.elevRaw[i] * t.meta.elevation.scale_m
  const dist = new Array<number>(n).fill(Infinity)
  const done = new Array<boolean>(n).fill(false)
  dist[sy * t.width + sx] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i
    if (u < 0) return Infinity
    if (u === gy * t.width + gx) return dist[u]
    done[u] = true
    const x = u % t.width
    const y = (u - x) / t.width
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) continue
      const v = ny * t.width + nx
      if (!isWalkable(t, v)) continue
      if (DX[k] !== 0 && DY[k] !== 0 && (!isWalkable(t, y * t.width + nx) || !isWalkable(t, ny * t.width + x))) continue
      const d = Math.hypot(DX[k] * CELL, DY[k] * CELL)
      const grade = (Math.atan2(elev(v) - elev(u), d) * 180) / Math.PI
      // Written out here on purpose, apart from the planner's own rule: no step steeper than 20 degrees.
      if (Math.abs(grade) > 20) continue
      const cand = dist[u] + obj.pieceCost(d, grade, v)
      if (cand < dist[v]) dist[v] = cand
    }
  }
}

/** Random hilly terrain with obstacles and patches of hidden steep ground. */
function randomTerrain(rand: () => number, size: number): Terrain {
  const phase = rand() * 6
  const amp = rand() * 6
  return makeTerrain(
    size,
    size,
    () => (rand() < 0.2 ? STEEP : rand() * 18),
    (x, y) => 20 + amp * Math.sin(x / 2.5 + phase) + amp * Math.cos(y / 3 + phase) + rand() * 0.5,
    () => (rand() < 0.25 ? Math.floor(rand() * 17) : 0),
  )
}

describe('objective functions', () => {
  it('never give a step a negative cost', () => {
    const t = makeTerrain(4, 4, () => 0, () => 0, () => 16)
    for (const obj of [timeObjective(), energyObjective(60), energyObjective(MASS), energyObjective(400), cautiousObjective(t)]) {
      for (let g = -60; g <= 60; g += 0.25) expect(obj.pieceCost(CELL, g, 5)).toBeGreaterThan(0)
    }
  })

  it('have a per-metre lower bound that holds for every grade', () => {
    const t = makeTerrain(4, 4, () => 0, () => 0, (x) => x * 5)
    for (const obj of [timeObjective(), energyObjective(60), energyObjective(MASS), energyObjective(400), cautiousObjective(t)]) {
      for (let g = -60; g <= 60; g += 0.013) {
        for (const cell of [0, 1, 2, 3]) expect(obj.pieceCost(1, g, cell)).toBeGreaterThanOrEqual(obj.minPerMetre)
      }
    }
  })

  it('scale with distance, so a piece split in two costs the same', () => {
    for (const obj of [timeObjective(), energyObjective(MASS)]) {
      expect(obj.pieceCost(8, 4, 0)).toBeCloseTo(2 * obj.pieceCost(4, 4, 0), 9)
    }
  })

  it('make time the cost of the fastest mode', () => {
    expect(timeObjective().pieceCost(16, 0, 0)).toBeCloseTo(16 / MAX_SPEED_MS, 12)
    expect(timeObjective().pieceCost(16, 8, 0)).toBeCloseTo(16 / walkingSpeedMs(8), 12)
  })

  it('make energy depend on direction and on the suited mass', () => {
    expect(pieceEnergyJ(10, 6, MASS)).toBeGreaterThan(pieceEnergyJ(10, 0, MASS))
    expect(pieceEnergyJ(10, -6, MASS)).toBeLessThan(pieceEnergyJ(10, 6, MASS))
    expect(pieceEnergyJ(10, 3, 240)).toBeGreaterThan(pieceEnergyJ(10, 3, 120))
    expect(minEnergyPerMetre(240)).toBeGreaterThan(minEnergyPerMetre(120))
  })

  it('weight the cautious mode by the stated factor and nothing else', () => {
    const t = makeTerrain(4, 1, () => 0, () => 0, (x) => [0, 4, 8, 16][x])
    const obj = cautiousObjective(t)
    const base = 10 / MAX_SPEED_MS
    expect(obj.pieceCost(10, 0, 0)).toBeCloseTo(base, 12)
    expect(obj.pieceCost(10, 0, 1)).toBeCloseTo(base * (1 + CAUTION_WEIGHT * 0.25), 12)
    expect(obj.pieceCost(10, 0, 3)).toBeCloseTo(base * (1 + CAUTION_WEIGHT), 12)
    // Without subcell data the mode has nothing to weigh and equals the fastest mode.
    const plain = makeTerrain(4, 1, () => 0)
    expect(cautiousObjective(plain).pieceCost(10, 3, 2)).toBeCloseTo(timeObjective().pieceCost(10, 3, 2), 12)
  })

  it('treats cells with no valid 1 m pixels as fully steep, not as clean', () => {
    const t = makeTerrain(3, 1, () => 0, () => 0, () => 0)
    t.subValid![1] = 0
    expect(cautionShare(t, 0)).toBe(0)
    expect(cautionShare(t, 1)).toBe(1)
  })
})

describe('A* against exhaustive search, for every mode', () => {
  for (const mode of MODES) {
    it(`${mode}: finds the minimum of its own objective`, () => {
      const rand = rng(mode.length * 1000 + 17)
      let compared = 0
      for (let n = 0; n < 45; n++) {
        const size = 14 + Math.floor(rand() * 8)
        const t = randomTerrain(rand, size)
        const obj = makeObjective(mode, t, MASS)
        const pick = () => {
          for (;;) {
            const x = Math.floor(rand() * size)
            const y = Math.floor(rand() * size)
            if (isWalkable(t, y * size + x)) return { x, y }
          }
        }
        const a = pick()
        const b = pick()
        const expected = dijkstra(t, obj, a.x, a.y, b.x, b.y)
        const got = findLeg(t, at(t, a.x, a.y), at(t, b.x, b.y), { smooth: false, objective: obj })
        if (expected === Infinity) expect(got.ok).toBe(false)
        else {
          expect(got.ok).toBe(true)
          if (got.ok) expect(Math.abs(got.leg.cost - expected) / Math.max(expected, 1)).toBeLessThan(1e-9)
          compared++
        }
      }
      expect(compared).toBeGreaterThan(15)
    })
  }

  it('each mode beats the other two on its own objective, and none beats it', () => {
    const rand = rng(404)
    const strictlyBetter: Record<RouteMode, number> = { fastest: 0, energy: 0, cautious: 0 }
    for (let n = 0; n < 40; n++) {
      const t = randomTerrain(rand, 20)
      const from = at(t, 1, 1)
      const to = at(t, 18, 18)
      const legs = MODES.map((m) => findLeg(t, from, to, { smooth: false, objective: makeObjective(m, t, MASS) }))
      if (!legs.every((l) => l.ok)) continue
      const cells = (mode: RouteMode) => {
        const l = legs[MODES.indexOf(mode)]
        if (!l.ok) throw new Error('unreachable')
        return l.leg.vertices.map((v) => {
          const b = t.meta.bbox
          return Math.floor(((b.north - v.lat) / (b.north - b.south)) * t.height) * t.width + Math.floor(((v.lon - b.west) / (b.east - b.west)) * t.width)
        })
      }
      for (const mine of MODES) {
        const obj = makeObjective(mine, t, MASS)
        const own = measurePath(t, cells(mine), obj)!.cost
        for (const other of MODES) {
          if (other === mine) continue
          const theirs = measurePath(t, cells(other), obj)!.cost
          expect(own).toBeLessThanOrEqual(theirs * (1 + 1e-9))
          if (own < theirs * (1 - 1e-6)) strictlyBetter[mine]++
        }
      }
    }
    // The modes really do choose different routes, in each direction.
    for (const m of MODES) expect(strictlyBetter[m]).toBeGreaterThan(0)
  })
})

describe('what each mode prefers', () => {
  it('fastest and energy-efficient trade time against energy over a hill', () => {
    // A low, broad hill on the direct line.
    const hill = (x: number, y: number) => 3.2 * Math.exp(-((x - 20) ** 2 + (y - 20) ** 2) / 60)
    const t = makeTerrain(40, 40, () => 4, hill)
    const from = at(t, 4, 20)
    const to = at(t, 36, 20)
    const fast = findLeg(t, from, to, { objective: makeObjective('fastest', t, MASS) })
    const lean = findLeg(t, from, to, { objective: makeObjective('energy', t, MASS) })
    expect(fast.ok && lean.ok).toBe(true)
    if (!fast.ok || !lean.ok) return
    const kJ = (l: typeof fast.leg) => (l.energyPerKg * MASS + l.energyFixed) / 1000
    // Each is at least as good as the other on its own measure.
    expect(kJ(lean.leg)).toBeLessThanOrEqual(kJ(fast.leg) * (1 + 1e-9))
    expect(fast.leg.duration).toBeLessThanOrEqual(lean.leg.duration * (1 + 1e-9))
    // In the walking-speed model a climb costs a lot of time, so the fastest route
    // is the one that avoids the hill; the energy model minds the climb less.
    expect(fast.leg.ascent).toBeLessThan(lean.leg.ascent)
    expect(lean.leg.distance).toBeLessThan(fast.leg.distance)
  })

  it('cautious goes round hidden steep ground the fastest route crosses', () => {
    // Flat open ground with a rough band across the direct line and a clean way round close by.
    const rough = (x: number, y: number) => (x >= 18 && x <= 21 && y >= 17 ? 12 : 0)
    const t = makeTerrain(40, 40, () => 0, () => 0, rough)
    const from = at(t, 4, 20)
    const to = at(t, 36, 20)
    const fast = findLeg(t, from, to, { objective: makeObjective('fastest', t, MASS) })
    const careful = findLeg(t, from, to, { objective: makeObjective('cautious', t, MASS) })
    expect(fast.ok && careful.ok).toBe(true)
    if (!fast.ok || !careful.ok) return
    expect(fast.leg.hiddenLoad!).toBeGreaterThan(1)
    expect(careful.leg.hiddenLoad!).toBe(0)
    expect(careful.leg.distance).toBeGreaterThan(fast.leg.distance)
    expect(careful.leg.duration).toBeGreaterThan(fast.leg.duration)
  })

  it('cautious still crosses hidden steep ground when going round costs more than the weight allows', () => {
    // The same band with the gap far away: the detour is worth more than the weighted crossing.
    const far = makeTerrain(40, 40, () => 0, () => 0, (x, y) => (x >= 18 && x <= 21 && y >= 6 ? 12 : 0))
    const careful = findLeg(far, at(far, 4, 20), at(far, 36, 20), { objective: makeObjective('cautious', far, MASS) })
    expect(careful.ok).toBe(true)
    if (careful.ok) expect(careful.leg.hiddenLoad!).toBeGreaterThan(0)
    // And with no way round at all.
    const none = makeTerrain(40, 12, () => 0, () => 0, (x) => (x >= 18 && x <= 21 ? 12 : 0))
    const through = findLeg(none, at(none, 4, 6), at(none, 36, 6), { objective: makeObjective('cautious', none, MASS) })
    expect(through.ok).toBe(true)
    if (through.ok) expect(through.leg.hiddenLoad!).toBeGreaterThan(0)
  })
})

describe('straightening under each objective', () => {
  for (const mode of MODES) {
    it(`${mode}: never worsens its own objective and stays on safe ground`, () => {
      const rand = rng(900 + mode.length)
      let straightened = 0
      for (let n = 0; n < 40; n++) {
        const t = randomTerrain(rand, 26)
        const obj = makeObjective(mode, t, MASS)
        const res = findLeg(t, at(t, 1, 1), at(t, 24, 24), { objective: obj })
        if (!res.ok) continue
        expect(res.leg.cost).toBeLessThanOrEqual(res.leg.grid.cost * (1 + 1e-9) + 1e-6)
        expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
        if (res.leg.vertices.length < res.leg.grid.cells) straightened++
        // Every line of the result is re-checked from scratch.
        const w = t.width
        const cells = res.leg.vertices.map((v) => {
          const b = t.meta.bbox
          return Math.floor(((b.north - v.lat) / (b.north - b.south)) * t.height) * w + Math.floor(((v.lon - b.west) / (b.east - b.west)) * w)
        })
        for (let i = 1; i < cells.length; i++) {
          expect(lineCells(t, cells[i - 1] % w, Math.floor(cells[i - 1] / w), cells[i] % w, Math.floor(cells[i] / w))).not.toBeNull()
        }
      }
      expect(straightened).toBeGreaterThan(3)
    })
  }

  it('energy mode refuses a shortcut that is quicker but costs more energy', () => {
    // An L-shaped path round a hill. The diagonal over the hill is shorter.
    const hill = (x: number, y: number) => 2.5 * Math.exp(-((x - 12) ** 2 + (y - 12) ** 2) / 18)
    const t = makeTerrain(24, 24, () => 3, hill)
    const idx = (x: number, y: number) => y * 24 + x
    const path = [...Array.from({ length: 19 }, (_, i) => idx(3 + i, 3)), ...Array.from({ length: 18 }, (_, i) => idx(21, 4 + i))]
    const energy = energyObjective(MASS)
    const kept = smoothPath(t, path, energy)
    const grid = measurePath(t, path, energy)!
    expect(measurePath(t, kept, energy)!.cost).toBeLessThanOrEqual(grid.cost * (1 + 1e-9))
    const direct = measurePath(t, [path[0], path[path.length - 1]], energy)!
    // The straight line over the hill would cost more energy, so it is not what we get.
    if (direct.cost > grid.cost) expect(kept.length).toBeGreaterThan(2)
  })
})

describe('the same safety rules in every mode', () => {
  it('no mode crosses a wall, and all agree a cut-off target is unreachable', () => {
    const wall = makeTerrain(30, 30, (x) => (x === 15 ? STEEP : 0), () => 0, () => 0)
    const gap = makeTerrain(30, 30, (x, y) => (x === 15 && y !== 3 ? STEEP : 0), () => 0, () => 0)
    for (const mode of MODES) {
      expect(findLeg(wall, at(wall, 3, 15), at(wall, 27, 15), { objective: makeObjective(mode, wall, MASS) }).ok).toBe(false)
      const res = findLeg(gap, at(gap, 3, 15), at(gap, 27, 15), { objective: makeObjective(mode, gap, MASS) })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
    }
  })

  it('no mode clips a diagonal wall or walks on missing data', () => {
    const diag = makeTerrain(16, 16, (x, y) => (x === 15 - y ? STEEP : 0), () => 0, () => 0)
    const hole = makeTerrain(12, 3, (x) => (x === 6 ? NaN : 0), () => 0, () => 0)
    for (const mode of MODES) {
      expect(findLeg(diag, at(diag, 2, 2), at(diag, 13, 13), { objective: makeObjective(mode, diag, MASS) }).ok).toBe(false)
      expect(findLeg(hole, at(hole, 1, 1), at(hole, 10, 1), { objective: makeObjective(mode, hole, MASS) }).ok).toBe(false)
    }
  })

  it('walkable ground is the same set of cells whatever the mode', () => {
    const rand = rng(5)
    const t = randomTerrain(rand, 24)
    // A cell that hides steep ground is still walkable: the metric is a preference, not a block.
    let hiddenButWalkable = 0
    for (let i = 0; i < 24 * 24; i++) if (isWalkable(t, i) && cautionShare(t, i) > 0) hiddenButWalkable++
    expect(hiddenButWalkable).toBeGreaterThan(0)
    const reach = MODES.map((m) => findLeg(t, at(t, 1, 1), at(t, 22, 22), { objective: makeObjective(m, t, MASS) }).ok)
    expect(new Set(reach).size).toBe(1)
  })
})

describe('plans and verdicts across modes', () => {
  const open = makeTerrain(60, 60, () => 0, () => 0, (x) => (x >= 28 && x <= 31 ? 10 : 0))
  const input = { points: [at(open, 5, 30), at(open, 50, 30), at(open, 50, 10)], roundTrip: true, massKg: MASS }

  it('measures every mode the same way', () => {
    const plans = computeAllPlans(open, input)
    for (const m of ROUTE_MODES) {
      const p = plans[m.id]!
      expect(p.error).toBeNull()
      expect(p.legs).toHaveLength(3)
      const last = p.samples[p.samples.length - 1]
      expect(last.dist).toBeCloseTo(p.distance, 6)
      expect(last.time).toBeCloseTo(p.walkTime, 6)
      // Exposure is reported both in total and per kilometre.
      expect(p.exposure!.perKm).toBeCloseTo(p.exposure!.load / (p.distance / 1000), 9)
      expect(p.walkBack!.reachable).toBe(true)
    }
    // The walk back is a safety check over the grid by time, so it does not depend on the mode's taste.
    expect(plans.cautious!.exposure!.load).toBeLessThanOrEqual(plans.fastest!.exposure!.load)
    expect(plans.fastest!.walkTime).toBeLessThanOrEqual(plans.energy!.walkTime + 1e-6)
    expect(plans.fastest!.walkTime).toBeLessThanOrEqual(plans.cautious!.walkTime + 1e-6)
  })

  it('gives every mode the same checks, with its own numbers', () => {
    const plans = computeAllPlans(open, input)
    for (const m of ROUTE_MODES) {
      const s = summarise(plans[m.id], input, 20)!
      expect(s.checks!.map((c) => c.id)).toEqual(['duration', 'walkback-distance', 'walkback-time'])
      expect(s.evaSeconds).toBeCloseTo(plans[m.id]!.walkTime + 2 * 20 * 60, 6)
      expect(s.verdict).toBe('go')
    }
  })

  it('does not turn NO-GO into GO by changing the mode', () => {
    const plans = computeAllPlans(open, input)
    // Long stops push every mode over the 8 hour limit.
    for (const m of ROUTE_MODES) {
      const s = summarise(plans[m.id], input, EVA.maxDuration_h * 60)!
      expect(s.verdict).toBe('nogo')
      expect(s.checks!.find((c) => c.id === 'duration')!.ok).toBe(false)
    }
  })

  it('is NO ROUTE in every mode when a checkpoint cannot be reached', () => {
    const walled = makeTerrain(40, 40, (x) => (x === 20 ? STEEP : 0), () => 0, () => 0)
    const cut = { points: [at(walled, 5, 20), at(walled, 35, 20)], roundTrip: true, massKg: MASS }
    for (const m of ROUTE_MODES) {
      const p = computePlan(walled, cut, m.id)!
      expect(p.error).not.toBeNull()
      expect(p.walkBack).toBeNull()
      const s = summarise(p, cut, 20)!
      expect(s.verdict).toBe('noroute')
      expect(s.checks).toBeNull()
      expect(missionVerdict(true, s.feasible, s.checks)).toBe('noroute')
    }
  })

  it('reuses cached legs and keeps modes apart in the cache', () => {
    const cache = new Map()
    const first = computeAllPlans(open, input, cache)
    const size = cache.size
    expect(size).toBe(9) // three legs for each of three modes
    const again = computeAllPlans(open, input, cache)
    expect(cache.size).toBe(size)
    expect(again.energy!.distance).toBe(first.energy!.distance)
    // A different suited mass is a different energy route, and only that.
    computeAllPlans(open, { ...input, massKg: 240 }, cache)
    expect(cache.size).toBe(size + 3)
  })

  it('returns no plan for fewer than two checkpoints', () => {
    expect(computePlan(open, { points: [at(open, 5, 30)], roundTrip: true, massKg: MASS }, 'fastest')).toBeNull()
  })
})

describe('rapid edits and mode switching', () => {
  it('only the newest request is current', () => {
    const latest = new LatestOnly()
    const a = latest.next()
    const b = latest.next()
    const c = latest.next()
    expect(latest.isCurrent(a)).toBe(false)
    expect(latest.isCurrent(b)).toBe(false)
    expect(latest.isCurrent(c)).toBe(true)
  })

  it('an answer that arrives late is ignored', async () => {
    const latest = new LatestOnly()
    const shown: string[] = []
    const request = (label: string, delayMs: number) => {
      const ticket = latest.next()
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (latest.isCurrent(ticket)) shown.push(label)
          resolve()
        }, delayMs),
      )
    }
    // The first request is slow and finishes after the two that followed it.
    await Promise.all([request('first', 30), request('second', 5), request('third', 10)])
    expect(shown).toEqual(['third'])
  })

  it('clearing the plan makes outstanding answers stale', () => {
    const latest = new LatestOnly()
    const ticket = latest.next()
    latest.cancel()
    expect(latest.isCurrent(ticket)).toBe(false)
  })

  it('switching mode needs no new calculation: all three plans come from one request', () => {
    const t = makeTerrain(30, 30, () => 0, () => 0, () => 0)
    const plans = computeAllPlans(t, { points: [at(t, 3, 3), at(t, 25, 20)], roundTrip: false, massKg: MASS })
    expect(Object.keys(plans).sort()).toEqual(['cautious', 'energy', 'fastest'])
    for (const m of MODES) expect(plans[m]!.mode).toBe(m)
  })
})
