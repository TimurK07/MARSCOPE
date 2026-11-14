// How a plan is drawn: outbound and return colours, what may be marked on the
// map, and what is only said in words.
import { describe, expect, it } from 'vitest'
import { buildChecks, missionVerdict } from '../mission'
import { ROUTE_MODES } from '../objectives'
import { computeAllPlans, summarise, type Plan, type PlanInput } from '../planner'
import { legRoles, missionTone, ROUTE_COLOR_HEX, ROUTE_COLORS, routeDisplay, type RouteDisplay } from '../routeDisplay'
import { cellAt, type Terrain } from '../terrain'
import { at, makeTerrain } from './synthetic'

/** The display of one mode of a plan, as the app builds it. */
function show(t: Terrain, input: PlanInput, mode: 'fastest' | 'energy' | 'cautious' = 'fastest', stop = 20): { d: RouteDisplay; plan: Plan } {
  const plan = computeAllPlans(t, input)[mode]!
  const s = summarise(plan, input, stop)!
  return { d: routeDisplay({ points: input.points, roundTrip: input.roundTrip, plan, checks: s.checks, verdict: s.verdict }), plan }
}

describe('which legs are outbound and which is the return', () => {
  it('makes the leg from the last target home the return, and nothing else', () => {
    expect(legRoles(3, true, 3)).toEqual(['outbound', 'outbound', 'return'])
    expect(legRoles(2, true, 2)).toEqual(['outbound', 'return'])
    expect(legRoles(5, true, 5)).toEqual(['outbound', 'outbound', 'outbound', 'outbound', 'return'])
  })

  it('has no return when the plan does not go back', () => {
    expect(legRoles(3, false, 2)).toEqual(['outbound', 'outbound'])
    expect(legRoles(2, false, 1)).toEqual(['outbound'])
  })

  it('gives roles only to legs that exist', () => {
    // A plan that stopped at an unreachable checkpoint has fewer legs.
    expect(legRoles(4, true, 2)).toEqual(['outbound', 'outbound'])
    expect(legRoles(3, true, 0)).toEqual([])
    expect(legRoles(0, true, 0)).toEqual([])
  })
})

describe('route colours', () => {
  it('are cyan out and orange back', () => {
    expect(ROUTE_COLORS.outbound).toBe('#62d4e8')
    expect(ROUTE_COLORS.return).toBe('#ee8c60')
    expect(ROUTE_COLOR_HEX.outbound).toBe(0x62d4e8)
    expect(ROUTE_COLOR_HEX.return).toBe(0xee8c60)
  })

  it('keeps red for marks, never for a route', () => {
    expect(new Set(Object.values(ROUTE_COLORS)).size).toBe(4)
    expect(Object.keys(ROUTE_COLOR_HEX).sort()).toEqual(['outbound', 'return'])
    expect(ROUTE_COLORS.alert).not.toBe(ROUTE_COLORS.outbound)
    expect(ROUTE_COLORS.alert).not.toBe(ROUTE_COLORS.return)
  })
})

describe('a plan that passes', () => {
  const t = makeTerrain(60, 40, () => 0)
  const input = { points: [at(t, 5, 20), at(t, 40, 10), at(t, 45, 30)], roundTrip: true, massKg: 180 }

  it('is drawn as outbound and return, with no marks and no warning, in every mode', () => {
    for (const m of ROUTE_MODES) {
      const { d, plan } = show(t, input, m.id)
      expect(d.roles).toEqual(['outbound', 'outbound', 'return'])
      expect(d.roles).toHaveLength(plan.legs.length)
      expect(d.notes).toEqual([])
      expect(d.alert).toBeNull()
      expect(d.legend.map((l) => l.id)).toEqual(['outbound', 'return'])
      expect(d.legend.map((l) => l.color)).toEqual([ROUTE_COLORS.outbound, ROUTE_COLORS.return])
    }
  })

  it('has no return in the key when the plan is one way', () => {
    const { d } = show(t, { ...input, roundTrip: false })
    expect(d.roles).toEqual(['outbound', 'outbound'])
    expect(d.legend.map((l) => l.id)).toEqual(['outbound'])
  })
})

describe('NO-GO on the return limits', () => {
  // Level ground; the target is 2.2 km from the habitat, so no way back from it is within 2 km.
  const t = makeTerrain(620, 5, () => 0)
  const input = { points: [at(t, 5, 2), at(t, 555, 2)], roundTrip: true, massKg: 180 }

  it('keeps every leg its own colour: the route is not painted by the verdict', () => {
    for (const m of ROUTE_MODES) {
      const { d, plan } = show(t, input, m.id)
      expect(summarise(plan, input, 20)!.verdict).toBe('nogo')
      expect(d.roles).toEqual(['outbound', 'return'])
    }
  })

  it('marks one place, the one the return check established, and says what is over', () => {
    const { d, plan } = show(t, input)
    expect(d.notes).toHaveLength(1)
    const note = d.notes[0]
    expect(note.kind).toBe('return-limit')
    expect(note.at).toEqual(plan.walkBack!.maxDistanceAt)
    // It is a point of the route itself.
    expect(plan.samples.some((s) => cellAt(t, s) === cellAt(t, note.at))).toBe(true)
    expect(note.label).toContain('limit 2 km')
    expect(note.label).not.toMatch(/hazard|danger|unsafe|steep/i)
    expect(d.alert!.tone).toBe('nogo')
    expect(d.alert!.title).toBe('NO-GO')
    expect(d.alert!.text).toContain('Way back to habitat: distance')
    expect(d.legend.map((l) => l.id)).toEqual(['outbound', 'return', 'return-limit'])
  })
})

describe('NO-GO on EVA duration', () => {
  const t = makeTerrain(60, 40, () => 0)
  const input = { points: [at(t, 5, 20), at(t, 40, 10)], roundTrip: true, massKg: 180 }

  it('marks nothing on the map: a duration has no place', () => {
    for (const m of ROUTE_MODES) {
      const { d, plan } = show(t, input, m.id, 600)
      expect(summarise(plan, input, 600)!.verdict).toBe('nogo')
      expect(d.notes).toEqual([])
      expect(d.roles).toEqual(['outbound', 'return'])
      expect(d.legend.map((l) => l.id)).toEqual(['outbound', 'return'])
    }
  })

  it('says which limit, in words', () => {
    const { d } = show(t, input, 'fastest', 600)
    expect(d.alert!.tone).toBe('nogo')
    expect(d.alert!.text).toContain('EVA duration at ≤ 2 km/h')
    expect(d.alert!.text).toContain('limit 8 h')
    expect(d.alert!.text).not.toContain('Way back')
  })
})

describe('UNVERIFIED', () => {
  const t = makeTerrain(60, 40, () => 0)
  const input = { points: [at(t, 5, 20), at(t, 40, 10)], roundTrip: true, massKg: 180 }
  const plan = computeAllPlans(t, input).fastest!
  // The search for a way back ran out of work at some point of the route.
  const here = plan.samples[Math.floor(plan.samples.length / 2)]
  const open: Plan = { ...plan, walkBack: { maxDistance: 1900, maxTime: 3400, maxDistanceAt: here, maxTimeAt: here, reachable: true, feasible: false, verified: false } }
  const checks = buildChecks({ evaSeconds: 3600, walkBack: open.walkBack })
  const verdict = missionVerdict(true, true, checks)
  const d = routeDisplay({ points: input.points, roundTrip: true, plan: open, checks, verdict })

  it('is its own state: amber mark, own wording, route colours unchanged', () => {
    expect(verdict).toBe('unverified')
    expect(d.roles).toEqual(['outbound', 'return'])
    expect(d.notes).toHaveLength(1)
    expect(d.notes[0].kind).toBe('return-unverified')
    expect(d.notes[0].at).toEqual(here)
    expect(d.alert!.tone).toBe('unverified')
    expect(d.alert!.text).toContain('not a GO')
    expect(d.alert!.text).toMatch(/Not a confirmed violation/)
    expect(d.legend.find((l) => l.id === 'return-unverified')!.color).toBe(ROUTE_COLORS.unverified)
  })

  it('is NO-GO, with no return mark, when only the duration is shown broken', () => {
    const late = buildChecks({ evaSeconds: 9 * 3600, walkBack: { ...open.walkBack!, verified: true, feasible: true, maxDistance: 500, maxTime: 900 } })
    const v = missionVerdict(true, true, late)
    const dd = routeDisplay({ points: input.points, roundTrip: true, plan, checks: late, verdict: v })
    expect(v).toBe('nogo')
    expect(dd.notes).toEqual([])
  })
})

describe('NO ROUTE', () => {
  // A wall cuts the third target off. The first two legs exist; the third does not.
  const t = makeTerrain(60, 40, (x) => (x === 45 ? 40 : 0))
  const input = { points: [at(t, 5, 20), at(t, 30, 10), at(t, 55, 20)], roundTrip: true, massKg: 180 }

  it('draws only the legs that were found: no path to the checkpoint that cannot be reached', () => {
    for (const m of ROUTE_MODES) {
      const { d, plan } = show(t, input, m.id)
      expect(plan.error).not.toBeNull()
      expect(plan.legs).toHaveLength(1)
      expect(d.roles).toEqual(['outbound'])
      // Nothing on the far side of the wall is part of any drawn leg.
      for (const leg of plan.legs) for (const s of leg.samples) expect(cellAt(t, s) % t.width).toBeLessThan(45)
    }
  })

  it('marks the checkpoint itself and says so in the terms of the slope limit', () => {
    const { d } = show(t, input)
    expect(d.notes).toHaveLength(1)
    expect(d.notes[0].kind).toBe('unreachable')
    expect(d.notes[0].pointIndex).toBe(2)
    expect(d.notes[0].at).toEqual(input.points[2])
    expect(d.notes[0].label).toBe('No route within the slope limit reaches target 2.')
    expect(d.alert!.tone).toBe('noroute')
    expect(d.alert!.title).toBe('NO ROUTE')
    expect(d.alert!.text).toContain('No route within the slope limit')
  })

  it('names the habitat when it is the way home that does not exist', () => {
    // The habitat is on an island; the target is too. One way works, then nothing leads back... build it one-way blocked:
    const tt = makeTerrain(60, 40, (x) => (x === 45 ? 40 : 0))
    const cut = { points: [at(tt, 55, 20), at(tt, 5, 20)], roundTrip: true, massKg: 180 }
    const { d, plan } = show(tt, cut)
    expect(plan.legs).toHaveLength(0)
    expect(d.roles).toEqual([])
    expect(d.notes[0].pointIndex).toBe(1)
    expect(d.legend.map((l) => l.id)).toEqual(['unreachable'])
  })
})

describe('one tone per verdict', () => {
  it('gives each verdict its own', () => {
    expect(missionTone('standby')).toBe('idle')
    const tones = (['go', 'nogo', 'unverified', 'noroute'] as const).map(missionTone)
    expect(tones).toEqual(['go', 'nogo', 'unverified', 'noroute'])
    expect(new Set(tones).size).toBe(4)
  })
})
