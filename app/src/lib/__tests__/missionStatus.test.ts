// The mission as the globe states it: status word, route priority, the reason a
// plan is not a GO, and the key to the route. Built from real plans on synthetic
// terrain, so the summary is checked against what the planner decides.
import { describe, expect, it } from 'vitest'
import type { PlanState } from '../../hooks/usePlan'
import { isCalculating, missionSummary, statusTitle, verdictOf } from '../missionStatus'
import type { RouteMode } from '../objectives'
import { computeAllPlans, summarise, type PlanInput } from '../planner'
import { routeDisplay } from '../routeDisplay'
import type { Terrain } from '../terrain'
import { at, makeTerrain } from './synthetic'

/** The part of the plan state the summary reads, for one mode of a computed plan. */
function stateOf(t: Terrain, input: PlanInput, mode: RouteMode = 'fastest', over: Partial<PlanState> = {}) {
  const plan = computeAllPlans(t, input)[mode]!
  const s = summarise(plan, input, 20)!
  const state = {
    points: input.points,
    roundTrip: input.roundTrip,
    mode,
    plan,
    pending: false,
    checks: s.checks,
    verdict: s.verdict,
    go: s.verdict === 'go',
    planEvaSeconds: s.planEvaSeconds,
    ...over,
  } as unknown as PlanState
  const display = routeDisplay({ points: input.points, roundTrip: input.roundTrip, plan: state.plan, checks: state.checks, verdict: verdictOf(state) })
  return { state, display, summary: s }
}

/** A plan state with no result: nothing planned, or a calculation running. */
function noResult(points: PlanInput['points'], pending: boolean, mode: RouteMode = 'fastest') {
  const state = { points, roundTrip: true, mode, plan: null, pending, checks: null, verdict: 'standby', go: false, planEvaSeconds: 0 } as unknown as PlanState
  const display = routeDisplay({ points, roundTrip: true, plan: null, checks: null, verdict: 'standby' })
  return { state, display }
}

const flat = makeTerrain(60, 40, () => 0)
const long = makeTerrain(620, 5, () => 0)
const walled = makeTerrain(60, 40, (x) => (x === 45 ? 40 : 0))
const GO: PlanInput = { points: [at(flat, 5, 20), at(flat, 40, 20)], roundTrip: true, massKg: 180 }
const NOGO: PlanInput = { points: [at(long, 5, 2), at(long, 610, 2)], roundTrip: true, massKg: 180 }
const NOROUTE: PlanInput = { points: [at(walled, 5, 20), at(walled, 55, 20)], roundTrip: true, massKg: 180 }

describe('the status word on the globe', () => {
  it('is the verdict of the plan, as the 2D workspace shows it', () => {
    for (const [input, t, word, tone] of [
      [GO, flat, 'GO', 'go'],
      [NOGO, long, 'NO-GO', 'nogo'],
      [NOROUTE, walled, 'NO ROUTE', 'noroute'],
    ] as const) {
      const { state, display, summary } = stateOf(t, input)
      const m = missionSummary(state, display)
      expect(m.title).toBe(`EVA plan · ${word}`)
      expect(m.tone).toBe(tone)
      // The summary reads the verdict; it does not form one.
      expect(verdictOf(state)).toBe(summary.verdict)
      expect(m.busy).toBe(false)
    }
  })

  it('is UNVERIFIED when the return could not be settled: not a GO, not a NO-GO', () => {
    const { state } = stateOf(flat, GO)
    const open = { ...state, verdict: 'unverified', go: false, checks: state.checks!.map((c) => (c.id === 'duration' ? c : { ...c, ok: false, state: 'unverified' })) } as PlanState
    const display = routeDisplay({ points: GO.points, roundTrip: true, plan: open.plan, checks: open.checks, verdict: 'unverified' })
    const m = missionSummary(open, display)
    expect(m.title).toBe('EVA plan · UNVERIFIED')
    expect(m.tone).toBe('unverified')
    expect(m.reason).toMatch(/could not be verified/)
    expect(m.reason).toMatch(/not a GO/)
    expect(m.moreReasons).toBe(0)
  })

  it('is CALCULATING while routes are computed, never a verdict left over', () => {
    const { state, display } = noResult(GO.points, true)
    const m = missionSummary(state, display)
    expect(isCalculating(state)).toBe(true)
    expect(statusTitle(state)).toBe('CALCULATING')
    expect(m.title).toBe('EVA plan · CALCULATING')
    expect(m.busy).toBe(true)
    expect(m.tone).toBe('idle')
    expect(m.detail).toBe('Calculating routes…')
    expect(m.reason).toBeNull()
    expect(m.legend).toEqual([])
  })

  it('is STANDBY for a plan that waits for the user', () => {
    const { state, display } = noResult([GO.points[0]], false)
    const m = missionSummary(state, display)
    expect(m.title).toBe('EVA plan · STANDBY')
    expect(m.busy).toBe(false)
    expect(m.detail).toMatch(/Add a science target/)
  })

  it('names the study area when no mission exists', () => {
    const { state, display } = noResult([], false)
    const m = missionSummary(state, display)
    expect(m.hasPlan).toBe(false)
    expect(m.title).toBe('Gale crater study area')
    expect(m.mode).toBeNull()
    expect(m.reason).toBeNull()
    expect(m.legend).toEqual([])
  })
})

describe('the route priority on the globe', () => {
  it('is the selected one, by the name the workspace uses', () => {
    for (const [mode, label] of [
      ['fastest', 'Fastest'],
      ['energy', 'Energy-efficient'],
      ['cautious', 'Cautious'],
    ] as const) {
      const { state, display } = stateOf(flat, GO, mode)
      expect(missionSummary(state, display).mode).toBe(label)
    }
  })

  it('is shown while calculating too, and not before there is a route to plan', () => {
    expect(missionSummary(...Object.values(noResult(GO.points, true, 'energy')) as [PlanState, ReturnType<typeof routeDisplay>]).mode).toBe('Energy-efficient')
    const habitatOnly = noResult([GO.points[0]], false)
    expect(missionSummary(habitatOnly.state, habitatOnly.display).mode).toBeNull()
  })
})

describe('why a plan is not a GO', () => {
  it('is not given for a GO', () => {
    const { state, display } = stateOf(flat, GO)
    const m = missionSummary(state, display)
    expect(m.reason).toBeNull()
    expect(m.moreReasons).toBe(0)
  })

  it('is the first limit not met, with its measurement and its limit, and a count of the rest', () => {
    const { state, display } = stateOf(long, NOGO)
    const failed = state.checks!.filter((c) => !c.ok)
    expect(failed.length).toBeGreaterThan(0)
    const m = missionSummary(state, display)
    expect(m.reason).toBe(`${failed[0].label}: ${failed[0].value}, limit ${failed[0].limit.replace('≤ ', '')}`)
    expect(m.reason).toMatch(/Way back to habitat/)
    expect(m.moreReasons).toBe(failed.length - 1)
    // The same reason the 2D map states first.
    expect(display.alert!.text.startsWith(m.reason!)).toBe(true)
  })

  it('is the planner\'s own message when a checkpoint cannot be reached', () => {
    const { state, display } = stateOf(walled, NOROUTE)
    const m = missionSummary(state, display)
    expect(m.reason).toBe(state.plan!.error)
    expect(m.reason).toMatch(/No route/)
    expect(m.detail).toMatch(/Nothing else is assessed/)
  })
})

describe('the route key on the globe', () => {
  it('is the key of the 2D map: outbound and return, with their colours', () => {
    const { state, display } = stateOf(flat, GO)
    const m = missionSummary(state, display)
    expect(m.legend).toBe(display.legend)
    expect(m.legend.map((l) => [l.id, l.label, l.color])).toEqual([
      ['outbound', 'Outbound route', '#62d4e8'],
      ['return', 'Return to habitat', '#ee8c60'],
    ])
  })

  it('has no return entry for a one-way plan', () => {
    const { state, display } = stateOf(flat, { ...GO, roundTrip: false })
    expect(missionSummary(state, display).legend.map((l) => l.id)).toEqual(['outbound'])
  })

  it('adds the mark for a return over the limits, as the map does', () => {
    const { state, display } = stateOf(long, NOGO)
    expect(missionSummary(state, display).legend.map((l) => l.id)).toContain('return-limit')
  })
})
