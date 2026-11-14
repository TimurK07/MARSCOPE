// Two walking times for one route, and the return check at the planning pace.
import { describe, expect, it } from 'vitest'
import { buildChecks, missionVerdict } from '../mission'
import { EVA, RETURN_LIMITS, walkingSpeedMs } from '../model'
import { ROUTE_MODES } from '../objectives'
import { computeAllPlans, computePlan, summarise } from '../planner'
import { WalkBackField, walkBack } from '../returnCheck'
import { findLeg } from '../router'
import type { Terrain } from '../terrain'
import { at, CELL, makeTerrain, rng } from './synthetic'

const CAP = 2000 / 3600
const planning = (g: number) => Math.min(walkingSpeedMs(g), CAP)
const D = RETURN_LIMITS.distance_m
const T = RETURN_LIMITS.time_s

describe('two walking times for the same route', () => {
  it('on level ground: the model at 1.6 m/s, the planning time at 2 km/h', () => {
    const t = makeTerrain(60, 9, () => 0)
    const res = findLeg(t, at(t, 5, 4), at(t, 55, 4))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.distance).toBeCloseTo(200, 9)
    expect(res.leg.duration).toBeCloseTo(200 / 1.6, 9)
    expect(res.leg.planDuration).toBeCloseTo(200 / CAP, 9)
    expect(res.leg.planDuration).toBeCloseTo(360, 9) // 200 m at 2 km/h is six minutes
  })

  it('are equal where the model is already slower than the planning pace', () => {
    // A steady 10 degree climb: the model walks about 0.24 m/s, well under the cap, even on a diagonal step.
    const t = makeTerrain(60, 9, () => 10, (x) => x * CELL * Math.tan((10 * Math.PI) / 180))
    const res = findLeg(t, at(t, 5, 4), at(t, 45, 4), { smooth: false })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.planDuration).toBeCloseTo(res.leg.duration, 6)
  })

  it('are both sums over the pieces of the one route that is shown', () => {
    const rand = rng(11)
    for (let n = 0; n < 8; n++) {
      const a = 2 + rand() * 4
      const t = makeTerrain(30, 30, () => 0, (x, y) => 20 + a * Math.sin(x * 0.5) * Math.cos(y * 0.4))
      const input = { points: [at(t, 3, 3), at(t, 25, 8), at(t, 20, 26)], roundTrip: true, massKg: 180 }
      const plans = computeAllPlans(t, input)
      for (const m of ROUTE_MODES) {
        const p = plans[m.id]!
        if (p.error) continue
        let model = 0
        let plan = 0
        for (let i = 1; i < p.samples.length; i++) {
          const along = p.samples[i].dist - p.samples[i - 1].dist
          if (along <= 0) continue
          const dz = p.samples[i].elevation - p.samples[i - 1].elevation
          const flat = Math.sqrt(Math.max(along * along - dz * dz, 0))
          const g = (Math.atan2(dz, flat) * 180) / Math.PI
          model += flat / walkingSpeedMs(g)
          plan += flat / planning(g)
        }
        expect(Math.abs(model - p.walkTime)).toBeLessThan(1e-6 * p.walkTime)
        expect(Math.abs(plan - p.planWalkTime)).toBeLessThan(1e-6 * p.planWalkTime)
        expect(p.planWalkTime).toBeGreaterThanOrEqual(p.walkTime)
        const s = summarise(p, input, 20)!
        // EVA duration is walking plus time at the targets, in either scenario.
        expect(s.evaSeconds).toBeCloseTo(p.walkTime + 2 * 20 * 60, 9)
        expect(s.planEvaSeconds).toBeCloseTo(p.planWalkTime + 2 * 20 * 60, 9)
        expect(s.planWalkTime).toBe(p.planWalkTime)
      }
    }
  })
})

describe('the routing objectives are unchanged', () => {
  // A hill between start and goal. Round it on the level, or over it: shorter, but slower by the model.
  const hill = (x: number, y: number) => 6 * Math.exp(-((x - 20) ** 2 + (y - 15) ** 2) / 30)
  const t = makeTerrain(40, 30, () => 0, hill)
  const input = { points: [at(t, 6, 15), at(t, 34, 15)], roundTrip: false, massKg: 180 }

  it('Fastest still minimises the model time, not the planning time', () => {
    const fastest = computePlan(t, input, 'fastest')!
    // Every other route found here takes at least as long by the model.
    for (const m of ROUTE_MODES) {
      const other = computePlan(t, input, m.id)!
      expect(fastest.walkTime).toBeLessThanOrEqual(other.walkTime + 1e-6)
    }
    // And a route that is quicker at the planning pace exists (the direct, steeper one), so the two really differ.
    const direct = findLeg(t, input.points[0], input.points[1], {
      objective: { mode: 'fastest', unit: 's', pieceCost: (d, g) => d / planning(g), minPerMetre: 1 / 1.6 },
    })
    expect(direct.ok).toBe(true)
    if (direct.ok) {
      expect(direct.leg.planDuration).toBeLessThan(fastest.planWalkTime - 1)
      expect(direct.leg.duration).toBeGreaterThan(fastest.walkTime + 1)
    }
  })

  it('gives each mode the value of its own objective', () => {
    const plans = computeAllPlans(t, input)
    expect(plans.fastest!.objectiveValue).toBeCloseTo(plans.fastest!.walkTime, 6)
    expect(plans.energy!.objectiveValue).toBeCloseTo(plans.energy!.energyPerKg * 180 + plans.energy!.energyFixed, 3)
    expect(plans.cautious!.objectiveValue).toBeGreaterThanOrEqual(plans.cautious!.walkTime - 1e-6)
  })
})

describe('the return limit of one hour, at the planning pace', () => {
  /** A level corridor one cell wide in effect: the way back from column x is x - 2 steps of 4 m. */
  const corridor = (cells: number): Terrain => makeTerrain(cells + 6, 3, () => 0)
  const verdictOf = (t: Terrain, x: number) => {
    const back = walkBack(t, at(t, 2, 1), [at(t, x, 1)])!
    return { back, verdict: missionVerdict(true, true, buildChecks({ evaSeconds: 3600, walkBack: back })) }
  }

  it('on level ground 2 km takes exactly the hour, so both limits are met together or not at all', () => {
    const t = corridor(520)
    // 499 steps: 1996 m. 500 steps: 2000 m. 501 steps: 2004 m.
    const under = verdictOf(t, 2 + 499)
    expect(under.back.maxDistance).toBe(1996)
    expect(under.back.maxTime).toBeCloseTo(1996 / CAP, 6)
    expect(under.verdict).toBe('go')

    const over = verdictOf(t, 2 + 501)
    expect(over.back.maxDistance).toBe(2004)
    expect(over.back.feasible).toBe(false)
    expect(over.verdict).toBe('nogo')

    // Exactly 2000 m: the distance is at its limit. Whether the hour is met is decided by the sum itself.
    const at2km = verdictOf(t, 2 + 500)
    expect(at2km.back.maxDistance).toBe(2000)
    let seconds = 0
    for (let i = 0; i < 500; i++) seconds += CELL / CAP
    expect(Math.abs(at2km.back.maxTime - seconds)).toBeLessThan(1e-6)
    expect(at2km.back.feasible).toBe(at2km.back.maxDistance <= D && at2km.back.maxTime <= T)
    expect(at2km.verdict).toBe(at2km.back.feasible ? 'go' : 'nogo')
  })

  it('at the model speed the same 2 km would have taken under 21 minutes', () => {
    const t = corridor(520)
    const model = walkBack(t, at(t, 2, 1), [at(t, 2 + 499, 1)], undefined, walkingSpeedMs)!
    expect(model.maxTime).toBeCloseTo(1996 / 1.6, 6)
    expect(model.maxTime / 60).toBeLessThan(21)
  })

  it('passes and fails exactly at limits set to the path\'s own figures', () => {
    const t = corridor(60)
    const home = at(t, 2, 1)
    const point = at(t, 42, 1)
    const exact = new WalkBackField(t, home, { distance_m: 1e9, time_s: 1e9 }).cell(1 * t.width + 42)!
    expect(exact.dist).toBe(160)
    expect(exact.time).toBeCloseTo(288, 9)
    const below = (x: number) => x * (1 - Number.EPSILON)
    const feasible = (distance_m: number, time_s: number) => walkBack(t, home, [point], { distance_m, time_s })!.feasible
    expect(feasible(exact.dist, exact.time)).toBe(true)
    expect(feasible(below(exact.dist), exact.time)).toBe(false)
    expect(feasible(exact.dist, below(exact.time))).toBe(false)
  })
})

describe('a mission the model passes and the planning pace does not', () => {
  // Home is at the top. The way back is 1 km on the level, then 900 m up a 5.7 degree ramp.
  //   Model:    1000 m at 1.6 m/s, then 900 m at 0.46 m/s: 43 minutes. Within the hour.
  //   Planning: 1000 m at 2 km/h, then the same climb:     63 minutes. Over it.
  const FLAT = 250
  const RAMP = 225
  const t = makeTerrain(FLAT + RAMP + 6, 3, () => 0, (x) => (x <= 2 + RAMP ? (2 + RAMP - Math.max(x, 2)) * 0.4 : 0))
  const home = at(t, 2, 1)
  const point = at(t, 2 + RAMP + FLAT, 1)

  it('is within both limits by the model alone', () => {
    const back = walkBack(t, home, [point], undefined, walkingSpeedMs)!
    expect(back.maxDistance).toBeLessThan(D)
    expect(back.maxTime).toBeLessThan(T)
    expect(back.feasible).toBe(true)
    expect(missionVerdict(true, true, buildChecks({ evaSeconds: 3600, walkBack: back }))).toBe('go')
  })

  it('is NO-GO at the planning pace, on time only, and the figures say why', () => {
    const back = walkBack(t, home, [point])!
    expect(back.verified).toBe(true)
    expect(back.feasible).toBe(false)
    expect(back.maxDistance).toBeLessThan(D)
    expect(back.maxTime).toBeGreaterThan(T)
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back })
    expect(checks.find((c) => c.id === 'walkback-distance')!.state).toBe('ok')
    expect(checks.find((c) => c.id === 'walkback-time')!.state).toBe('fail')
    expect(checks.find((c) => c.id === 'walkback-time')!.label).toContain('2 km/h')
    expect(missionVerdict(true, true, checks)).toBe('nogo')
  })

  it('is recomputed, not the model time rescaled', () => {
    const model = walkBack(t, home, [point], undefined, walkingSpeedMs)!
    const plan = walkBack(t, home, [point])!
    // The level kilometre takes 1.6 / (2000/3600) = 2.88 times longer; the climb takes the same.
    const level = FLAT * CELL
    expect(plan.maxTime - model.maxTime).toBeCloseTo(level / CAP - level / 1.6, 3)
    expect(plan.maxTime / model.maxTime).toBeLessThan(2.88)
    expect(plan.maxTime / model.maxTime).toBeGreaterThan(1.2)
  })

  it('is NO-GO in every routing mode alike', () => {
    const input = { points: [home, point], roundTrip: true, massKg: 180 }
    const plans = computeAllPlans(t, input)
    for (const m of ROUTE_MODES) {
      const s = summarise(plans[m.id], input, 0)!
      expect(s.verdict).toBe('nogo')
      expect(s.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['walkback-time'])
    }
  })

  it('is UNVERIFIED, not NO-GO and never GO, when the search cannot finish', () => {
    // A terrain with a real trade-off, limits between two of its ways back, and no work budget.
    const wall = (x: number, y: number) => (x === 6 && y !== 6 && y !== 27 ? 40 : 0)
    const ground = (x: number, y: number) => (x <= 5 ? (y <= 12 ? 3.6 : Math.max(0, 3.6 - (y - 12) * 0.3)) : y === 6 && x <= 8 ? (9 - x) * 1.2 : 0)
    const tt = makeTerrain(13, 30, wall, ground)
    const h = at(tt, 2, 6)
    const p = at(tt, 10, 6)
    const loose = new WalkBackField(tt, h, { distance_m: 1e9, time_s: 1e9 })
    const fastest = loose.cell(6 * 13 + 10)!
    // Enough time for the fastest way back, but not its length; then no budget for the exact search.
    const lim = { distance_m: fastest.dist * 0.6, time_s: fastest.time * 3 }
    const full = new WalkBackField(tt, h, lim)
    const truth = full.assess([p])!
    const starved = new WalkBackField(tt, h, lim, 0)
    const back = starved.assess([p])!
    if (starved.stats.exactSearches === 0) {
      // The fields settled it without a search: then the answer is verified and the same.
      expect(back.verified).toBe(true)
      expect(back.feasible).toBe(truth.feasible)
    } else {
      expect(back.verified).toBe(false)
      expect(back.feasible).toBe(false)
      expect(missionVerdict(true, true, buildChecks({ evaSeconds: 600, walkBack: back }))).toBe('unverified')
    }
  })
})

describe('the 8-hour limit uses the planning EVA duration', () => {
  const LIMIT = EVA.maxDuration_h * 3600
  // Level ground, one target 500 m away, there and back: 1 km of walking.
  //   Model:    1000 m at 1.6 m/s  =  625 s.
  //   Planning: 1000 m at 2 km/h   = 1800 s.
  const t = makeTerrain(140, 5, () => 0)
  const input = { points: [at(t, 5, 2), at(t, 130, 2)], roundTrip: true, massKg: 180 }
  const plans = computeAllPlans(t, input)
  const walk = plans.fastest!.walkTime
  const planWalk = plans.fastest!.planWalkTime

  it('has the two walking times it should', () => {
    expect(walk).toBeCloseTo(1000 / 1.6, 6)
    expect(planWalk).toBeCloseTo(1800, 6)
  })

  it('adds the same time at the targets to both', () => {
    const s = summarise(plans.fastest, input, 90)!
    expect(s.evaSeconds).toBeCloseTo(walk + 90 * 60, 9)
    expect(s.planEvaSeconds).toBeCloseTo(planWalk + 90 * 60, 9)
    expect(s.planEvaSeconds - s.evaSeconds).toBeCloseTo(planWalk - walk, 9)
  })

  it('judges the limit on the planning duration: model under 8 h, planning over, NO-GO', () => {
    // A stop that puts the model duration ten minutes under the limit: the planning duration is then about ten over.
    const stop = (LIMIT - walk) / 60 - 10
    for (const m of ROUTE_MODES) {
      const s = summarise(plans[m.id], input, stop)!
      expect(s.evaSeconds).toBeLessThan(LIMIT)
      expect(s.planEvaSeconds).toBeGreaterThan(LIMIT)
      const duration = s.checks!.find((c) => c.id === 'duration')!
      expect(duration.ok).toBe(false)
      expect(duration.ratio).toBeCloseTo(s.planEvaSeconds / LIMIT, 12)
      expect(s.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['duration'])
      expect(s.verdict).toBe('nogo')
    }
  })

  it('is GO when the planning duration is at or under 8 hours, in every mode', () => {
    for (const m of ROUTE_MODES) {
      const p = plans[m.id]!
      const exactly = (LIMIT - p.planWalkTime) / 60
      const at8h = summarise(p, input, exactly)!
      // The stop that makes the planning duration 8 hours to within rounding of the division.
      expect(Math.abs(at8h.planEvaSeconds - LIMIT)).toBeLessThan(1e-6)
      expect(at8h.verdict).toBe(at8h.planEvaSeconds <= LIMIT ? 'go' : 'nogo')
      expect(summarise(p, input, exactly - 0.01)!.verdict).toBe('go')
      expect(summarise(p, input, exactly + 0.01)!.verdict).toBe('nogo')
    }
  })

  it('reports the model duration unchanged alongside', () => {
    const s = summarise(plans.fastest, input, 20)!
    expect(s.evaSeconds).toBeCloseTo(walk + 20 * 60, 9)
    expect(s.walkTime).toBe(walk)
    expect(s.planWalkTime).toBe(planWalk)
  })

  it('gives every mode the verdict its own planning duration calls for', () => {
    // Routes differ between modes, so their durations do; each verdict must follow its own figure.
    const hill = (x: number, y: number) => 6 * Math.exp(-((x - 20) ** 2 + (y - 15) ** 2) / 30)
    const tt = makeTerrain(40, 30, () => 0, hill)
    const inp = { points: [at(tt, 6, 15), at(tt, 34, 15)], roundTrip: true, massKg: 180 }
    const ps = computeAllPlans(tt, inp)
    for (const stop of [1, 200, 470, 475, 478, 480, 600]) {
      for (const m of ROUTE_MODES) {
        const s = summarise(ps[m.id], inp, stop)!
        expect(s.verdict).toBe(s.planEvaSeconds <= LIMIT ? 'go' : 'nogo')
      }
    }
  })
})

describe('background dose for both EVA durations', () => {
  const RATE = 0.67 // mSv per day, written out here
  const hill = (x: number, y: number) => 6 * Math.exp(-((x - 20) ** 2 + (y - 15) ** 2) / 30)
  const t = makeTerrain(40, 30, () => 0, hill)
  const input = { points: [at(t, 6, 15), at(t, 34, 15), at(t, 20, 26)], roundTrip: true, massKg: 180 }
  const plans = computeAllPlans(t, input)

  it('is each duration times the same rate, in every mode', () => {
    for (const m of ROUTE_MODES) {
      for (const stop of [0, 20, 215]) {
        const s = summarise(plans[m.id], input, stop)!
        expect(s.doseMsv).toBeCloseTo((RATE * s.evaSeconds) / 86_400, 12)
        expect(s.planDoseMsv).toBeCloseTo((RATE * s.planEvaSeconds) / 86_400, 12)
        // The two differ exactly as the two durations do.
        expect(s.planDoseMsv - s.doseMsv).toBeCloseTo((RATE * (s.planWalkTime - s.walkTime)) / 86_400, 12)
        expect(s.planDoseMsv).toBeGreaterThanOrEqual(s.doseMsv)
      }
    }
  })

  it('follows its own EVA duration, not the other one', () => {
    const s = summarise(plans.fastest, input, 20)!
    expect(s.planEvaSeconds).toBeGreaterThan(s.evaSeconds + 60)
    expect(Math.abs(s.doseMsv - (RATE * s.planEvaSeconds) / 86_400)).toBeGreaterThan(1e-6)
    expect(Math.abs(s.planDoseMsv - (RATE * s.evaSeconds) / 86_400)).toBeGreaterThan(1e-6)
  })

  it('does not enter GO / NO-GO: the checks are the same three, and no stop time makes radiation fail', () => {
    for (const m of ROUTE_MODES) {
      const s = summarise(plans[m.id], input, 20)!
      expect(s.checks!.map((c) => c.id)).toEqual(['duration', 'walkback-distance', 'walkback-time'])
      // Far over 8 hours the plan is NO-GO on duration alone, whatever the dose.
      const long = summarise(plans[m.id], input, 600)!
      expect(long.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['duration'])
    }
  })
})
