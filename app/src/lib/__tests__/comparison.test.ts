// Comparing the three route priorities: differences from Fastest, how they are
// rounded and worded, and what is said when there is nothing to compare.
import { describe, expect, it } from 'vitest'
import { compareModes, comparisonTable, fmtDelta, modeCards, OBJECTIVE, REFERENCE_MODE, type Summaries } from '../comparison'
import type { Check, Verdict } from '../mission'
import { ROUTE_MODES, type RouteMode } from '../objectives'
import { computeAllPlans, summarise, type ModeSummary, type PlanInput } from '../planner'
import type { Terrain } from '../terrain'
import { at, makeTerrain } from './synthetic'

const MODES = ROUTE_MODES.map((m) => m.id)

const check = (id: Check['id'], value: string, ok = true, state: Check['state'] = ok ? 'ok' : 'fail'): Check => ({
  id,
  label: id === 'duration' ? 'EVA duration' : id === 'walkback-distance' ? 'Way back to habitat: distance' : 'Way back to habitat: time at ≤ 2 km/h',
  value,
  limit: '≤ x',
  ok,
  state,
  ratio: 0.5,
  margin: '',
})

/** A summary of a feasible route; the figures are those of the example mission unless overridden. */
function route(mode: RouteMode, over: Partial<ModeSummary> = {}): ModeSummary {
  return {
    mode,
    verdict: 'go',
    feasible: true,
    distance: 2029,
    walkTime: 38.1 * 60,
    planWalkTime: 60.9 * 60,
    evaSeconds: 58.1 * 60,
    planEvaSeconds: 80.9 * 60,
    energyKcal: 291,
    doseMsv: 0.03,
    planDoseMsv: 0.04,
    ascent: 40,
    descent: 40,
    exposure: { load: 4.1, perKm: 2.0, cellShare: 0.05, worst: 0.5 },
    checks: [check('duration', '1 h 21 min'), check('walkback-distance', '0.80 km'), check('walkback-time', '24 min')],
    reason: '',
    ...over,
  }
}

const noRoute = (mode: RouteMode): ModeSummary =>
  route(mode, { verdict: 'noroute', feasible: false, distance: 0, walkTime: 0, planWalkTime: 0, energyKcal: 0, exposure: null, checks: null, reason: 'No route to target 1.' })

/** The example mission as the app measures it. */
const EXAMPLE: Summaries = {
  fastest: route('fastest'),
  energy: route('energy', { distance: 1435, walkTime: 44.2 * 60, planWalkTime: 55.3 * 60, energyKcal: 235, exposure: { load: 1.0, perKm: 0.7, cellShare: 0.02, worst: 0.2 } }),
  cautious: route('cautious', { distance: 2017, walkTime: 38.14 * 60, planWalkTime: 60.6 * 60, energyKcal: 290, exposure: { load: 3.0, perKm: 1.5, cellShare: 0.04, worst: 0.4 } }),
}

const NONE: Summaries = { fastest: null, energy: null, cautious: null }

describe('differences from Fastest', () => {
  it('are this route minus Fastest, figure by figure', () => {
    const c = compareModes(EXAMPLE)
    expect(c.energy.deltas!.distance).toBeCloseTo(1435 - 2029, 9)
    expect(c.energy.deltas!.walkTime).toBeCloseTo((44.2 - 38.1) * 60, 9)
    expect(c.energy.deltas!.planWalkTime).toBeCloseTo((55.3 - 60.9) * 60, 9)
    expect(c.energy.deltas!.energyKcal).toBeCloseTo(235 - 291, 9)
    expect(c.energy.deltas!.steepPerKm).toBeCloseTo(0.7 - 2.0, 9)
  })

  it('keeps model time and planning time apart: one can rise while the other falls', () => {
    const d = compareModes(EXAMPLE).energy.deltas!
    expect(d.walkTime).toBeGreaterThan(0)
    expect(d.planWalkTime).toBeLessThan(0)
  })

  it('gives Fastest no differences: it is the reference', () => {
    const c = compareModes(EXAMPLE)
    expect(REFERENCE_MODE).toBe('fastest')
    expect(c.fastest.isReference).toBe(true)
    expect(c.fastest.deltas).toBeNull()
    expect(c.energy.isReference).toBe(false)
  })

  it('has no steepness difference when either route has no subcell data', () => {
    const c = compareModes({ ...EXAMPLE, energy: route('energy', { exposure: null }) })
    expect(c.energy.deltas!.steepPerKm).toBeNull()
    expect(c.cautious.deltas!.steepPerKm).not.toBeNull()
    const d = compareModes({ ...EXAMPLE, fastest: route('fastest', { exposure: null }) })
    expect(d.cautious.deltas!.steepPerKm).toBeNull()
  })
})

describe('how a difference is written', () => {
  it('is signed, with a true minus sign, in the unit of its row', () => {
    expect(fmtDelta('distance', -594)).toBe('−594 m')
    expect(fmtDelta('distance', 1234)).toBe('+1.23 km')
    expect(fmtDelta('time', 366)).toBe('+6 min')
    expect(fmtDelta('time', -336)).toBe('−6 min')
    expect(fmtDelta('time', 3900)).toBe('+1 h 05 min')
    expect(fmtDelta('energy', -56)).toBe('−56 kcal')
    expect(fmtDelta('steep', -1.3)).toBe('−1.3')
    expect(fmtDelta('steep', 0.26)).toBe('+0.3')
  })

  it('never writes a real difference as zero', () => {
    expect(fmtDelta('time', 2.4)).toBe('+<1 min')
    expect(fmtDelta('time', -20)).toBe('−<1 min')
    expect(fmtDelta('energy', 0.3)).toBe('+<1 kcal')
    expect(fmtDelta('distance', 0.7)).toBe('+<1 m')
    expect(fmtDelta('steep', -0.02)).toBe('−<0.1')
    for (const kind of ['distance', 'time', 'energy', 'steep'] as const) {
      for (const v of [0.6, 3, 17, 29.9, -0.6, -3, -29.9]) expect(fmtDelta(kind, v)).not.toMatch(/^[+−]0(\.0+)? /)
    }
  })

  it('writes no difference as "same", and an unknown one as a dash', () => {
    for (const kind of ['distance', 'time', 'energy', 'steep'] as const) {
      expect(fmtDelta(kind, 0)).toBe('same')
      expect(fmtDelta(kind, null)).toBe('—')
      expect(fmtDelta(kind, NaN)).toBe('—')
    }
  })

  it('rounds like the figures it sits under', () => {
    // 89 s is 1 min, 91 s is 2 min, as fmtDur rounds.
    expect(fmtDelta('time', 89)).toBe('+1 min')
    expect(fmtDelta('time', 91)).toBe('+2 min')
    expect(fmtDelta('energy', 0.5)).toBe('+1 kcal')
    expect(fmtDelta('distance', 999.4)).toBe('+999 m')
  })
})

describe('the trade-off sentence', () => {
  it('is built from the figures, each named with its scenario', () => {
    const t = compareModes(EXAMPLE).energy.tradeoff
    expect(t).toBe(
      'Energy-efficient: 594 m shorter, 6 min slower by the model, 6 min quicker at ≤ 2 km/h, 56 kcal less model energy than Fastest. Hidden steep ground per km: 0.7 against 2.0.',
    )
  })

  it('leaves out figures that do not differ', () => {
    const t = compareModes({ ...EXAMPLE, cautious: route('cautious', { distance: 2100 }) }).cautious.tradeoff
    expect(t).toBe('Cautious: 71 m longer than Fastest.')
  })

  it('ranks nothing and promises nothing', () => {
    const all = [EXAMPLE, NONE, { ...EXAMPLE, cautious: noRoute('cautious') }, { ...EXAMPLE, fastest: noRoute('fastest') }]
    for (const s of all) {
      for (const pending of [false, true]) {
        const c = compareModes(s, pending)
        const cards = modeCards(s, 'cautious', pending)
        const text = [...MODES.map((m) => c[m].tradeoff), ...cards.flatMap((k) => [k.description, k.objective, k.timeLabel, k.timeDelta ?? '', `${k.detail.label} ${k.detail.text}`])].join(' ')
        expect(text).not.toMatch(/\b(best|better|worse|worst|safest|safer|optimal|recommended|risk-free|guarantee)/i)
        // "safe" appears only in the statement that the heuristic is not a safety rating.
        expect(text.replace(/not a safety rating/g, '')).not.toMatch(/safe/i)
      }
    }
  })

  it('states each objective as the interface must', () => {
    expect(OBJECTIVE.fastest.full).toBe('Minimises model walking time.')
    expect(OBJECTIVE.energy.full).toBe('Minimises model walking energy.')
    expect(OBJECTIVE.cautious.full).toBe('Minimises terrain-weighted model walking time, using a heuristic that is not a safety rating.')
    expect(OBJECTIVE.cautious.short).toMatch(/heuristic/)
  })
})

describe('identical routes', () => {
  const same: Summaries = { fastest: route('fastest'), energy: route('energy'), cautious: route('cautious') }

  it('are said to be the same, with no differences listed', () => {
    const c = compareModes(same)
    for (const m of ['energy', 'cautious'] as const) {
      expect(c[m].sameAsReference).toBe(true)
      expect(c[m].tradeoff).toMatch(/the same route as Fastest/)
      expect(Object.values(c[m].deltas!).every((v) => v === 0)).toBe(true)
    }
    const cards = modeCards(same, 'fastest')
    for (const k of [cards[1], cards[2]]) {
      expect(k.detail).toEqual({ label: '', text: 'same as Fastest' })
      expect(k.timeDelta).toBeNull()
    }
  })

  it('show "same" under every figure of the table', () => {
    const t = comparisonTable(same)
    for (const r of t.primary) {
      expect(r.cells.fastest.delta).toBeNull()
      expect(r.cells.energy.delta).toBe('same')
      expect(r.cells.cautious.delta).toBe('same')
    }
  })

  it('are not declared the same over floating-point noise, nor different', () => {
    const noisy = { ...same, energy: route('energy', { distance: 2029 + 1e-9, walkTime: 38.1 * 60 - 1e-9 }) }
    expect(compareModes(noisy).energy.sameAsReference).toBe(true)
    const differs = { ...same, energy: route('energy', { energyKcal: 291.2 }) }
    expect(compareModes(differs).energy.sameAsReference).toBe(false)
    expect(compareModes(differs).energy.tradeoff).toBe('Energy-efficient: <1 kcal more model energy than Fastest.')
  })

  it('come out of the planner on flat ground', () => {
    const t = makeTerrain(60, 40, () => 0)
    const input: PlanInput = { points: [at(t, 5, 20), at(t, 40, 20)], roundTrip: true, massKg: 180 }
    const plans = computeAllPlans(t, input)
    const s = Object.fromEntries(MODES.map((m) => [m, summarise(plans[m], input, 20)])) as Summaries
    const c = compareModes(s)
    expect(c.energy.sameAsReference).toBe(true)
    expect(c.cautious.sameAsReference).toBe(true)
  })
})

describe('results that are missing or incomplete', () => {
  it('says "calculating" only while a calculation runs', () => {
    const idle = compareModes(NONE)
    const busy = compareModes(NONE, true)
    for (const m of MODES) {
      expect(idle[m].state).toBe('idle')
      expect(busy[m].state).toBe('pending')
      expect(idle[m].deltas).toBeNull()
      expect(busy[m].deltas).toBeNull()
      expect(idle[m].verdict).toBe('standby')
      expect(idle[m].tradeoff).toMatch(/no route planned yet/)
      expect(busy[m].tradeoff).toMatch(/still being calculated/)
    }
  })

  it('compares nothing with a mode that has no route', () => {
    const c = compareModes({ ...EXAMPLE, cautious: noRoute('cautious') })
    expect(c.cautious.state).toBe('noroute')
    expect(c.cautious.verdict).toBe('noroute')
    expect(c.cautious.deltas).toBeNull()
    expect(c.cautious.sameAsReference).toBe(false)
    expect(c.cautious.tradeoff).toMatch(/nothing to compare/)
    // The other mode is still compared.
    expect(c.energy.deltas).not.toBeNull()
  })

  it('compares nothing when Fastest has no route, and does not treat its figures as zero', () => {
    const c = compareModes({ ...EXAMPLE, fastest: noRoute('fastest') })
    for (const m of ['energy', 'cautious'] as const) {
      expect(c[m].state).toBe('ready')
      expect(c[m].deltas).toBeNull()
      expect(c[m].tradeoff).toMatch(/no Fastest route to compare with\.$/)
    }
    const cards = modeCards({ ...EXAMPLE, fastest: noRoute('fastest') }, 'energy')
    expect(cards[1].detail).toEqual({ label: '', text: 'no Fastest route' })
    expect(cards[1].timeDelta).toBeNull()
    expect(cards[1].time).toBe('44 min')
    expect(cards[0].time).toBe('—')
  })

  it('handles one result arriving before the others', () => {
    const part: Summaries = { fastest: null, energy: EXAMPLE.energy, cautious: null }
    const c = compareModes(part, true)
    expect(c.fastest.state).toBe('pending')
    expect(c.energy.state).toBe('ready')
    expect(c.energy.deltas).toBeNull()
    expect(c.energy.tradeoff).toMatch(/no Fastest route to compare with yet/)
    const t = comparisonTable(part, true)
    expect(t.primary[0].cells.fastest).toEqual({ value: '…', delta: null })
    expect(t.primary[0].cells.energy).toEqual({ value: '1.44 km', delta: null })
  })

  it('shows dashes, not zeros, for a mode without a route', () => {
    const t = comparisonTable({ ...EXAMPLE, cautious: noRoute('cautious') })
    for (const r of [...t.primary, ...t.more]) expect(r.cells.cautious).toEqual({ value: '—', delta: null })
    expect(t.verdicts.cautious).toBe('noroute')
    expect(t.reasons.cautious).toBe('a checkpoint cannot be reached')
  })
})

describe('the comparison cards', () => {
  it('come in a fixed order, with the selected one marked', () => {
    for (const sel of MODES) {
      const cards = modeCards(EXAMPLE, sel)
      expect(cards.map((c) => c.mode)).toEqual(['fastest', 'energy', 'cautious'])
      expect(cards.map((c) => c.label)).toEqual(['Fastest', 'Energy-efficient', 'Cautious'])
      expect(cards.filter((c) => c.selected).map((c) => c.mode)).toEqual([sel])
    }
  })

  it('do not change with the selection, apart from the mark', () => {
    const strip = (sel: RouteMode) => modeCards(EXAMPLE, sel).map((c) => ({ ...c, selected: false }))
    expect(strip('energy')).toEqual(strip('fastest'))
    expect(strip('cautious')).toEqual(strip('fastest'))
  })

  it('show the model walking time, named as such, and one or two differences', () => {
    const [fast, energy, cautious] = modeCards(EXAMPLE, 'fastest')
    expect(fast.time).toBe('38 min')
    expect(energy.time).toBe('44 min')
    // The time is named in full on every card: never a bare "time".
    for (const c of [fast, energy, cautious]) expect(c.timeLabel).toBe('Model time')
    expect(fast.timeDelta).toBeNull()
    expect(fast.detail).toEqual({ label: '', text: 'reference' })
    // The difference in model time sits beside the model time; a second figure follows.
    expect(energy.timeDelta).toBe('+6 min')
    expect(energy.detail).toEqual({ label: 'energy', text: '−56 kcal' })
    // Cautious shows the figure its weighting acts on.
    expect(cautious.timeDelta).toBe('+<1 min')
    expect(cautious.detail).toEqual({ label: 'steep/km', text: '−0.5' })
  })

  it('fall back to energy for Cautious when there is no subcell data', () => {
    const cards = modeCards({ ...EXAMPLE, cautious: route('cautious', { distance: 2017, energyKcal: 290, exposure: null }) }, 'fastest')
    expect(cards[2].detail).toEqual({ label: 'energy', text: '−1 kcal' })
  })

  it('carry the verdict of their own mode, whatever is selected', () => {
    const mixed: Summaries = { ...EXAMPLE, energy: route('energy', { verdict: 'nogo' }), cautious: route('cautious', { verdict: 'unverified' }) }
    for (const sel of MODES) expect(modeCards(mixed, sel).map((c) => c.verdict)).toEqual(['go', 'nogo', 'unverified'])
  })

  it('show placeholders while calculating and before any route', () => {
    for (const c of modeCards(NONE, 'fastest', true)) {
      expect(c.state).toBe('pending')
      expect(c.time).toBe('…')
      expect(c.detail).toEqual({ label: '', text: 'calculating…' })
      expect(c.timeDelta).toBeNull()
    }
    for (const c of modeCards(NONE, 'fastest')) {
      expect(c.state).toBe('idle')
      expect(c.time).toBe('—')
      expect(c.detail).toEqual({ label: '', text: 'no route yet' })
      expect(c.timeDelta).toBeNull()
    }
  })
})

describe('the comparison table', () => {
  it('shows the five required rows by default, in order', () => {
    expect(comparisonTable(EXAMPLE).primary.map((r) => r.label)).toEqual([
      'Distance',
      'Model walking time',
      'Planning walking time, ≤ 2 km/h',
      'Model walking energy',
      'Hidden steepness exposure, per km',
    ])
  })

  it('keeps the secondary figures for the "More" part', () => {
    const more = comparisonTable(EXAMPLE).more.map((r) => r.id)
    expect(more).toEqual(['eva-plan', 'eva-model', 'back-distance', 'back-time', 'climb', 'steep-total', 'steep-cells', 'steep-worst'])
  })

  it('puts a difference under every default figure of the other two modes, and none under Fastest', () => {
    const t = comparisonTable(EXAMPLE)
    const byId = Object.fromEntries(t.primary.map((r) => [r.id, r.cells]))
    for (const r of t.primary) expect(r.cells.fastest.delta).toBeNull()
    expect(byId.distance.energy).toEqual({ value: '1.44 km', delta: '−594 m' })
    expect(byId['walk-model'].energy).toEqual({ value: '44 min', delta: '+6 min' })
    expect(byId['walk-plan'].energy).toEqual({ value: '55 min', delta: '−6 min' })
    expect(byId.energy.energy).toEqual({ value: '235 kcal', delta: '−56 kcal' })
    expect(byId['steep-km'].energy).toEqual({ value: '0.7', delta: '−1.3' })
    expect(byId['steep-km'].cautious).toEqual({ value: '1.5', delta: '−0.5' })
  })

  it('formats every mode the same way', () => {
    const same: Summaries = { fastest: route('fastest'), energy: route('energy'), cautious: route('cautious') }
    const t = comparisonTable(same)
    for (const r of [...t.primary, ...t.more]) {
      expect(r.cells.energy.value).toBe(r.cells.fastest.value)
      expect(r.cells.cautious.value).toBe(r.cells.fastest.value)
    }
  })

  it('reports the way back from the mission checks, and says when it is not verified', () => {
    const open = route('energy', {
      verdict: 'unverified',
      checks: [check('duration', '1 h 21 min'), check('walkback-distance', 'not verified', false, 'unverified'), check('walkback-time', 'not verified', false, 'unverified')],
    })
    const t = comparisonTable({ ...EXAMPLE, energy: open })
    const back = t.more.find((r) => r.id === 'back-distance')!
    expect(back.cells.fastest.value).toBe('0.80 km')
    expect(back.cells.energy.value).toBe('not verified')
    expect(t.verdicts.energy).toBe('unverified')
    expect(t.reasons.energy).toBe('return not verified')
    expect(t.reasons.fastest).toBeNull()
  })

  it('names the limits a NO-GO is over, briefly', () => {
    const over = route('cautious', { verdict: 'nogo', checks: [check('duration', '9 h', false), check('walkback-distance', '2.22 km', false), check('walkback-time', '72 min', false)] })
    const t = comparisonTable({ ...EXAMPLE, cautious: over })
    expect(t.reasons.cautious).toBe('EVA duration, return distance, return time')
    expect(t.verdicts.cautious).toBe('nogo')
  })

  it('shows a dash for steepness without subcell data, with no difference', () => {
    const t = comparisonTable({ ...EXAMPLE, energy: route('energy', { exposure: null }) })
    const row = t.primary.find((r) => r.id === 'steep-km')!
    expect(row.cells.energy).toEqual({ value: '—', delta: null })
  })
})

describe('mission verdicts are taken as they are', () => {
  const t = makeTerrain(60, 40, (x) => (x === 45 ? 40 : 0), undefined, (x) => (x > 20 && x < 30 ? 6 : 0))
  // Long and narrow: the far end is more than 2 km from the habitat.
  const long = makeTerrain(620, 5, () => 0)
  const cases: [string, Terrain, PlanInput][] = [
    ['reachable', t, { points: [at(t, 5, 20), at(t, 40, 20)], roundTrip: true, massKg: 180 }],
    ['behind a wall', t, { points: [at(t, 5, 20), at(t, 55, 20)], roundTrip: true, massKg: 180 }],
    ['beyond the return limit', long, { points: [at(long, 5, 2), at(long, 610, 2)], roundTrip: true, massKg: 180 }],
  ]

  it.each(cases)('%s: cards and table repeat the planner verdict of every mode', (_name, t, input) => {
    const plans = computeAllPlans(t, input)
    const s = Object.fromEntries(MODES.map((m) => [m, summarise(plans[m], input, 20)])) as Summaries
    const before = JSON.stringify(s)
    const expected = MODES.map((m) => s[m]!.verdict) as Verdict[]
    const table = comparisonTable(s)
    expect(MODES.map((m) => table.verdicts[m])).toEqual(expected)
    for (const sel of MODES) expect(modeCards(s, sel).map((c) => c.verdict)).toEqual(expected)
    expect(MODES.map((m) => compareModes(s)[m].verdict)).toEqual(expected)
    // Comparing changes nothing in the summaries it reads.
    expect(JSON.stringify(s)).toBe(before)
  })

  it('covers a GO, a NO-GO and a NO ROUTE among these cases', () => {
    const seen = new Set<Verdict>()
    for (const [, t, input] of cases) {
      const plans = computeAllPlans(t, input)
      for (const m of MODES) seen.add(summarise(plans[m], input, 20)!.verdict)
    }
    expect(seen.has('go')).toBe(true)
    expect(seen.has('nogo')).toBe(true)
    expect(seen.has('noroute')).toBe(true)
  })
})
