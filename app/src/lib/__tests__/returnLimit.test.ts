// The return distance limit is a planning assumption the user can set. It must
// reach the return check itself, not only the figure shown beside it.
import { describe, expect, it } from 'vitest'
import { buildChecks, missionVerdict } from '../mission'
import { clampReturnDistance, RETURN_DISTANCE_AT_PACE_M, RETURN_DISTANCE_RANGE, RETURN_LIMITS } from '../model'
import { ROUTE_MODES } from '../objectives'
import { computeAllPlans, returnFieldFor, returnLimitsOf, summarise, type PlanInput } from '../planner'
import { routeDisplay } from '../routeDisplay'
import { WalkBackField } from '../returnCheck'
import { cellAt, type Terrain } from '../terrain'
import { at, CELL, makeTerrain } from './synthetic'

// Level ground, one row to walk along. The habitat is at column 5; a target n steps east is n * 4 m away.
const t: Terrain = makeTerrain(780, 3, () => 0)
const habitat = at(t, 5, 1)
const target = (metres: number) => at(t, 5 + metres / CELL, 1)
const mission = (metres: number, returnDistanceM?: number): PlanInput => ({ points: [habitat, target(metres)], roundTrip: true, massKg: 180, returnDistanceM })
const verdicts = (input: PlanInput) => ROUTE_MODES.map((m) => summarise(computeAllPlans(t, input)[m.id], input, 0)!)

describe('the range the limit can take', () => {
  it('defaults to 2 km', () => {
    expect(RETURN_DISTANCE_RANGE.default_m).toBe(2000)
    expect(RETURN_LIMITS.distance_m).toBe(2000)
    expect(clampReturnDistance(undefined)).toBe(2000)
    expect(clampReturnDistance(null)).toBe(2000)
    expect(clampReturnDistance(NaN)).toBe(2000)
    expect(clampReturnDistance(Infinity)).toBe(2000)
  })

  it('is kept between 0.5 and 3 km, in steps of 100 m', () => {
    expect(RETURN_DISTANCE_RANGE).toMatchObject({ min_m: 500, max_m: 3000, step_m: 100 })
    expect(clampReturnDistance(100)).toBe(500)
    expect(clampReturnDistance(-5)).toBe(500)
    expect(clampReturnDistance(9000)).toBe(3000)
    expect(clampReturnDistance(1549)).toBe(1500)
    expect(clampReturnDistance(1550)).toBe(1600)
    for (const m of [500, 1500, 2000, 2500, 3000]) expect(clampReturnDistance(m)).toBe(m)
  })

  it('leaves the time limit alone: 60 minutes whatever the distance', () => {
    expect(returnLimitsOf({})).toEqual({ distance_m: 2000, time_s: 3600 })
    expect(returnLimitsOf({ returnDistanceM: 1500 })).toEqual({ distance_m: 1500, time_s: 3600 })
    expect(returnLimitsOf({ returnDistanceM: 3000 })).toEqual({ distance_m: 3000, time_s: 3600 })
    expect(returnLimitsOf({ returnDistanceM: 123456 }).distance_m).toBe(3000)
  })

  it('knows where the time limit takes over: 2 km in an hour at 2 km/h', () => {
    expect(RETURN_DISTANCE_AT_PACE_M).toBeCloseTo(2000, 9)
  })
})

describe('the limit reaches the return check itself', () => {
  it('builds the check with the limit of the plan', () => {
    expect(returnFieldFor(t, mission(1000)).limits).toEqual({ distance_m: 2000, time_s: 3600 })
    expect(returnFieldFor(t, mission(1000, 1200)).limits).toEqual({ distance_m: 1200, time_s: 3600 })
  })

  it('decides feasibility by it, not only the figure shown', () => {
    // 1.6 km from the habitat: within 2 km, outside 1.5 km.
    const wide = computeAllPlans(t, mission(1600)).fastest!.walkBack!
    const tight = computeAllPlans(t, mission(1600, 1500)).fastest!.walkBack!
    expect(wide.feasible).toBe(true)
    expect(tight.feasible).toBe(false)
    expect(tight.verified).toBe(true)
    // The same way back in both cases; only the limit it is held to differs.
    expect(tight.maxDistance).toBe(wide.maxDistance)
    expect(tight.maxDistance).toBe(1600)
  })
})

describe('default 2 km', () => {
  it('behaves as it did when no limit is given', () => {
    for (const [metres, want] of [[1200, 'go'], [1996, 'go'], [2004, 'nogo'], [2200, 'nogo']] as const) {
      const implicit = verdicts(mission(metres)).map((s) => s.verdict)
      const explicit = verdicts(mission(metres, 2000)).map((s) => s.verdict)
      expect(implicit).toEqual([want, want, want])
      expect(explicit).toEqual(implicit)
    }
  })

  it('states the limit as 2 km in the check', () => {
    const s = verdicts(mission(1200))[0]
    expect(s.checks!.find((c) => c.id === 'walkback-distance')!.limit).toBe('≤ 2 km')
  })
})

describe('a limit below 2 km', () => {
  it('turns a plan that passed into NO-GO, on distance only, in every mode', () => {
    for (const s of verdicts(mission(1800, 1500))) {
      expect(s.verdict).toBe('nogo')
      expect(s.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['walkback-distance'])
      const dist = s.checks!.find((c) => c.id === 'walkback-distance')!
      expect(dist.limit).toBe('≤ 1.5 km')
      expect(dist.value).toBe('1.80 km')
      expect(dist.margin).toBe('over by 300 m')
      expect(dist.ratio).toBeCloseTo(1800 / 1500, 12)
    }
  })

  it('and back to GO when the limit is restored', () => {
    expect(verdicts(mission(1800, 2000)).map((s) => s.verdict)).toEqual(['go', 'go', 'go'])
    expect(verdicts(mission(1800, 1500)).map((s) => s.verdict)).toEqual(['nogo', 'nogo', 'nogo'])
    expect(verdicts(mission(1800)).map((s) => s.verdict)).toEqual(['go', 'go', 'go'])
  })

  it('still passes what is inside it, with the margin measured from the limit chosen', () => {
    const s = verdicts(mission(1200, 1500))[0]
    expect(s.verdict).toBe('go')
    expect(s.checks!.find((c) => c.id === 'walkback-distance')!.margin).toBe('300 m to spare')
  })
})

describe('exactly at the limit', () => {
  it('passes at the limit and fails one step beyond it', () => {
    // 450 steps of 4 m are exactly 1800 m.
    const at1800 = computeAllPlans(t, mission(1800, 1800)).fastest!.walkBack!
    expect(at1800.maxDistance).toBe(1800)
    expect(at1800.feasible).toBe(true)
    expect(verdicts(mission(1800, 1800)).map((s) => s.verdict)).toEqual(['go', 'go', 'go'])
    // One step further, 1804 m.
    const beyond = computeAllPlans(t, mission(1804, 1800)).fastest!.walkBack!
    expect(beyond.maxDistance).toBe(1804)
    expect(beyond.feasible).toBe(false)
    const s = verdicts(mission(1804, 1800))[0]
    expect(s.verdict).toBe('nogo')
    expect(s.checks!.find((c) => c.id === 'walkback-distance')!.value).toBe('1.81 km')
    expect(s.checks!.find((c) => c.id === 'walkback-distance')!.margin).toBe('over by 4 m')
    // And one limit step lower, the plan that sat exactly on the limit fails.
    expect(verdicts(mission(1800, 1700)).map((s) => s.verdict)).toEqual(['nogo', 'nogo', 'nogo'])
  })

  it('holds for limits that are not on the step, when the check is asked directly', () => {
    const field = (distance_m: number) => new WalkBackField(t, habitat, { distance_m, time_s: 3600 }).cell(cellAt(t, target(1800)))!
    expect(field(1800).feasible).toBe(true)
    expect(field(1800 * (1 - Number.EPSILON)).feasible).toBe(false)
    expect(field(1799.999).feasible).toBe(false)
    expect(field(1800.001).feasible).toBe(true)
  })
})

describe('a limit above 2 km', () => {
  it('cannot make a plan pass: the hour at 2 km/h still caps the way back at 2 km', () => {
    // 2.2 km away. With a 3 km limit the distance is fine; the time is 66 minutes.
    for (const s of verdicts(mission(2200, 3000))) {
      expect(s.verdict).toBe('nogo')
      expect(s.checks!.find((c) => c.id === 'walkback-distance')!.ok).toBe(true)
      expect(s.checks!.find((c) => c.id === 'walkback-distance')!.limit).toBe('≤ 3 km')
      expect(s.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['walkback-time'])
      expect(s.checks!.find((c) => c.id === 'walkback-time')!.value).toBe('66 min')
    }
  })

  it('changes which check fails, not the verdict', () => {
    const atDefault = verdicts(mission(2200))[0]
    const raised = verdicts(mission(2200, 3000))[0]
    expect(atDefault.verdict).toBe('nogo')
    expect(raised.verdict).toBe('nogo')
    expect(atDefault.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['walkback-distance', 'walkback-time'])
  })

  it('leaves a plan that passed at 2 km passing', () => {
    expect(verdicts(mission(1996, 3000)).map((s) => s.verdict)).toEqual(['go', 'go', 'go'])
  })
})

describe('distance and time are still judged together, on one way back', () => {
  // Home is at the top of a 5.7 degree ramp, 900 m long, after 400 m on the level: 1.3 km by distance, slow by time.
  const ramp = makeTerrain(340, 3, () => 0, (x) => (x <= 2 + 225 ? (2 + 225 - Math.max(x, 2)) * 0.4 : 0))
  const home = at(ramp, 2, 1)
  const far = at(ramp, 2 + 225 + 100, 1)
  const run = (returnDistanceM?: number) => {
    const input = { points: [home, far], roundTrip: true, massKg: 180, returnDistanceM }
    return summarise(computeAllPlans(ramp, input).fastest, input, 0)!
  }

  it('needs both: a way back short enough for the limit chosen, and within the hour', () => {
    const s = run(1500)
    const back = s.checks!
    expect(back.find((c) => c.id === 'walkback-distance')!.ok).toBe(true)
    // 400 m at 2 km/h is 12 min; 900 m up the ramp at the model's 0.46 m/s is 33 min: 45 min in all.
    expect(back.find((c) => c.id === 'walkback-time')!.ok).toBe(true)
    expect(s.verdict).toBe('go')
  })

  it('fails on distance alone when the limit is set under the way back', () => {
    const s = run(1200)
    expect(s.verdict).toBe('nogo')
    expect(s.checks!.filter((c) => !c.ok).map((c) => c.id)).toEqual(['walkback-distance'])
  })
})

describe('what is said and drawn follows the limit chosen', () => {
  it('names the chosen limit in the note on the map', () => {
    const input = mission(1800, 1500)
    const plan = computeAllPlans(t, input).fastest!
    const s = summarise(plan, input, 0)!
    const d = routeDisplay({ points: input.points, roundTrip: true, plan, checks: s.checks, verdict: s.verdict, returnDistanceM: 1500 })
    expect(d.notes).toHaveLength(1)
    expect(d.notes[0].kind).toBe('return-limit')
    expect(d.notes[0].label).toContain('1.80 km (limit 1.5 km)')
    expect(d.alert!.text).toContain('limit 1.5 km')
    // Route colours are untouched by any of this.
    expect(d.roles).toEqual(['outbound', 'return'])
  })

  it('reports an unverified return against the chosen limit as UNVERIFIED', () => {
    const here = target(1000)
    const open = { maxDistance: 1400, maxTime: 3000, maxDistanceAt: here, maxTimeAt: here, reachable: true, feasible: false, verified: false }
    const checks = buildChecks({ evaSeconds: 3600, walkBack: open, returnDistanceM: 1500 })
    expect(checks.find((c) => c.id === 'walkback-distance')!.limit).toBe('≤ 1.5 km')
    expect(checks.find((c) => c.id === 'walkback-distance')!.state).toBe('unverified')
    expect(missionVerdict(true, true, checks)).toBe('unverified')
  })

  it('is UNVERIFIED, not NO-GO, when the search has no budget, whatever limit is chosen', () => {
    // The wall-and-ramp terrain of the return-check tests: a real trade-off between a short slow way back and a long quick one.
    const wall = (x: number, y: number) => (x === 6 && y !== 6 && y !== 27 ? 40 : 0)
    const ground = (x: number, y: number) => (x <= 5 ? (y <= 12 ? 3.6 : Math.max(0, 3.6 - (y - 12) * 0.3)) : y === 6 && x <= 8 ? (9 - x) * 1.2 : 0)
    const tt = makeTerrain(13, 30, wall, ground)
    const h = at(tt, 2, 6)
    const c = 6 * 13 + 10
    const loose = new WalkBackField(tt, h, { distance_m: 1e9, time_s: 1e9 }).cell(c)!
    for (const distance_m of [loose.dist * 0.5, loose.dist * 0.7]) {
      const lim = { distance_m, time_s: loose.time * 3 }
      const full = new WalkBackField(tt, h, lim).cell(c)!
      const starved = new WalkBackField(tt, h, lim, 0)
      const got = starved.cell(c)!
      if (starved.stats.exactSearches === 0) expect(got).toMatchObject({ verified: true, feasible: full.feasible })
      else expect(got).toMatchObject({ verified: false, feasible: false })
    }
  })
})
