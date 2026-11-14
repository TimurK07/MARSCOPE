// Comparing the three route priorities. Pure functions: what the comparison
// cards and the comparison table show is worked out here, from the summaries
// the planner already produced, and tested without a browser.
//
// Rules this module keeps:
//   - Differences are taken against Fastest, and only between two routes that
//     both exist. A missing, pending or unreachable result is said to be so; it
//     is never compared and never treated as zero.
//   - Each figure keeps its scenario: model walking time, walking time at the
//     planning pace and model walking energy are different quantities.
//   - Nothing is ranked. Words like "shorter" and "slower" describe a
//     difference in one figure; no route is called better, best or safer.
//     Cautious follows a heuristic weighting, which is not a safety rating.

import { fmtDur, fmtKm } from './format'
import type { Verdict } from './mission'
import { PLANNING_PACE } from './model'
import { ROUTE_MODES, type RouteMode } from './objectives'
import type { ModeSummary } from './planner'

/** The mode every difference is taken against. */
export const REFERENCE_MODE: RouteMode = 'fastest'

/** What each priority minimises, in the words the interface uses. */
export const OBJECTIVE: Record<RouteMode, { short: string; full: string }> = {
  fastest: {
    short: 'Minimises model time',
    full: 'Minimises model walking time.',
  },
  energy: {
    short: 'Minimises model energy',
    full: 'Minimises model walking energy.',
  },
  cautious: {
    short: 'Weighted model time · heuristic',
    full: 'Minimises terrain-weighted model walking time, using a heuristic that is not a safety rating.',
  },
}

export type MetricKind = 'distance' | 'time' | 'energy' | 'steep'

/** Differences from Fastest: this route's figure minus Fastest's. Null where one of the two is unknown. */
export interface Deltas {
  /** Route length, metres. */
  distance: number
  /** Model walking time, seconds. */
  walkTime: number
  /** Walking time at the planning pace, seconds. */
  planWalkTime: number
  /** Model walking energy, kcal. */
  energyKcal: number
  /** Hidden steep ground per kilometre; null without subcell data on either route. */
  steepPerKm: number | null
}

/**
 * Why a mode has figures or not.
 *   ready     a route exists (whatever the mission verdict)
 *   pending   being calculated; no result yet
 *   idle      nothing to calculate: no route has been planned
 *   noroute   a checkpoint cannot be reached; there is no route to compare
 */
export type ModeState = 'ready' | 'pending' | 'idle' | 'noroute'

export interface ModeComparison {
  mode: RouteMode
  label: string
  state: ModeState
  verdict: Verdict
  isReference: boolean
  /** Differences from Fastest, or null when this mode or Fastest has no route. */
  deltas: Deltas | null
  /** True when the route measures the same as Fastest in distance, time and energy. */
  sameAsReference: boolean
  /** One neutral sentence on how this route differs from Fastest, or why it cannot be compared. */
  tradeoff: string
}

// Below these, two figures are the same route measured twice, not a difference.
const SAME = { distance: 0.5, time: 0.5, energy: 0.05, steep: 0.005 }

const sign = (v: number) => (v > 0 ? '+' : '−')

/**
 * A difference as it is shown: signed, in the unit of its row, rounded the way
 * the absolute figures are. A difference too small to show at that rounding is
 * written "<1", never as zero; a true zero is "same".
 */
export function fmtDelta(kind: MetricKind, value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—'
  const a = Math.abs(value)
  if (kind === 'distance') {
    if (a < SAME.distance) return 'same'
    if (a < 1000) return a < 1 ? `${sign(value)}<1 m` : `${sign(value)}${Math.round(a)} m`
    return `${sign(value)}${(a / 1000).toFixed(2)} km`
  }
  if (kind === 'time') {
    if (a < SAME.time) return 'same'
    const min = Math.round(a / 60)
    if (min < 1) return `${sign(value)}<1 min`
    return min >= 60 ? `${sign(value)}${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${sign(value)}${min} min`
  }
  if (kind === 'energy') {
    if (a < SAME.energy) return 'same'
    return a < 0.5 ? `${sign(value)}<1 kcal` : `${sign(value)}${Math.round(a)} kcal`
  }
  if (a < SAME.steep) return 'same'
  return a < 0.05 ? `${sign(value)}<0.1` : `${sign(value)}${a.toFixed(1)}`
}

/** The same difference in words, for a sentence: "0.58 km shorter", "6 min slower". Null when there is none to speak of. */
function phrase(kind: 'distance' | 'time' | 'energy', value: number, more: string, less: string): string | null {
  const shown = fmtDelta(kind, value)
  if (shown === 'same') return null
  return `${shown.slice(1)} ${value > 0 ? more : less}`
}

const feasible = (s: ModeSummary | null): s is ModeSummary => !!s && s.feasible

function deltasOf(s: ModeSummary, ref: ModeSummary): Deltas {
  return {
    distance: s.distance - ref.distance,
    walkTime: s.walkTime - ref.walkTime,
    planWalkTime: s.planWalkTime - ref.planWalkTime,
    energyKcal: s.energyKcal - ref.energyKcal,
    steepPerKm: s.exposure && ref.exposure ? s.exposure.perKm - ref.exposure.perKm : null,
  }
}

function tradeoffOf(label: string, s: ModeSummary, ref: ModeSummary, d: Deltas, same: boolean): string {
  if (same) return `${label}: the same route as Fastest for these checkpoints.`
  const parts = [
    phrase('distance', d.distance, 'longer', 'shorter'),
    // Each figure is named with its scenario, so a model time is never read as a planning time.
    phrase('time', d.walkTime, 'slower by the model', 'quicker by the model'),
    phrase('time', d.planWalkTime, `slower at ≤ ${PLANNING_PACE.max_kmh} km/h`, `quicker at ≤ ${PLANNING_PACE.max_kmh} km/h`),
    phrase('energy', d.energyKcal, 'more model energy', 'less model energy'),
  ].filter((p): p is string => p !== null)
  let text = parts.length ? `${label}: ${parts.join(', ')} than Fastest.` : `${label}: no difference from Fastest at the precision shown.`
  if (s.exposure && ref.exposure && Math.abs(s.exposure.perKm - ref.exposure.perKm) >= SAME.steep) {
    text += ` Hidden steep ground per km: ${s.exposure.perKm.toFixed(1)} against ${ref.exposure.perKm.toFixed(1)}.`
  }
  return text
}

export type Summaries = Record<RouteMode, ModeSummary | null>

/**
 * The comparison of the three priorities, from their summaries. `pending` says
 * a calculation is running, which is the only thing that tells a result that
 * has not arrived from a plan that was never asked for.
 */
export function compareModes(summaries: Summaries, pending = false): Record<RouteMode, ModeComparison> {
  const ref = summaries[REFERENCE_MODE]
  const out = {} as Record<RouteMode, ModeComparison>
  for (const m of ROUTE_MODES) {
    const s = summaries[m.id]
    const isReference = m.id === REFERENCE_MODE
    const state: ModeState = !s ? (pending ? 'pending' : 'idle') : s.feasible ? 'ready' : 'noroute'
    const verdict: Verdict = s ? s.verdict : 'standby'
    let deltas: Deltas | null = null
    let sameAsReference = false
    let tradeoff: string
    if (state === 'pending') tradeoff = `${m.label}: still being calculated.`
    else if (state === 'idle') tradeoff = `${m.label}: no route planned yet.`
    else if (state === 'noroute') tradeoff = `${m.label}: no route within the slope limit, so there is nothing to compare.`
    else if (isReference) tradeoff = `${m.label}: the route the other two are compared with.`
    else if (!feasible(ref)) tradeoff = `${m.label}: no Fastest route to compare with${ref || !pending ? '' : ' yet'}.`
    else {
      deltas = deltasOf(s!, ref)
      sameAsReference =
        Math.abs(deltas.distance) < SAME.distance && Math.abs(deltas.walkTime) < SAME.time && Math.abs(deltas.planWalkTime) < SAME.time && Math.abs(deltas.energyKcal) < SAME.energy
      tradeoff = tradeoffOf(m.label, s!, ref, deltas, sameAsReference)
    }
    out[m.id] = { mode: m.id, label: m.label, state, verdict, isReference, deltas, sameAsReference, tradeoff }
  }
  return out
}

/** One figure on a card: what it is, and its difference from Fastest as shown. */
export interface CardDelta {
  label: string
  text: string
}

/** What one comparison card shows. Built here so the card itself only lays it out. */
export interface ModeCard {
  mode: RouteMode
  label: string
  selected: boolean
  state: ModeState
  verdict: Verdict
  /** Which walking time the card shows: the speed model's, not the planning pace and not the EVA duration. */
  timeLabel: string
  /** Model walking time as shown, or a placeholder while there is none. */
  time: string
  /** Its difference from Fastest, shown beside it; null for Fastest and where there is nothing to compare. */
  timeDelta: string | null
  /** A second difference from Fastest, or a word on why there is none: the reference, the same route, no route. */
  detail: CardDelta
  objective: string
  /** The whole card in one sentence, for assistive technology. */
  description: string
}

/** The three comparison cards, in the fixed order Fastest, Energy-efficient, Cautious. */
export function modeCards(summaries: Summaries, selected: RouteMode, pending = false): ModeCard[] {
  const cmp = compareModes(summaries, pending)
  return ROUTE_MODES.map((m) => {
    const c = cmp[m.id]
    const s = summaries[m.id]
    let timeDelta: string | null = null
    let detail: CardDelta
    if (c.state === 'pending') detail = { label: '', text: 'calculating…' }
    else if (c.state === 'idle') detail = { label: '', text: 'no route yet' }
    else if (c.state === 'noroute') detail = { label: '', text: 'no route' }
    else if (c.isReference) detail = { label: '', text: 'reference' }
    else if (!c.deltas) detail = { label: '', text: 'no Fastest route' }
    else if (c.sameAsReference) detail = { label: '', text: 'same as Fastest' }
    else {
      timeDelta = fmtDelta('time', c.deltas.walkTime)
      // The figure the mode minimises tells most about it: energy for Energy-efficient, hidden steep ground for Cautious.
      detail =
        m.id === 'cautious' && c.deltas.steepPerKm !== null
          ? { label: 'steep/km', text: fmtDelta('steep', c.deltas.steepPerKm) }
          : { label: 'energy', text: fmtDelta('energy', c.deltas.energyKcal) }
    }
    return {
      mode: m.id,
      label: m.label,
      selected: m.id === selected,
      state: c.state,
      verdict: c.verdict,
      timeLabel: 'Model time',
      time: c.state === 'ready' && s ? fmtDur(s.walkTime) : c.state === 'pending' ? '…' : '—',
      timeDelta,
      detail,
      objective: OBJECTIVE[m.id].short,
      description: `${m.label}. ${OBJECTIVE[m.id].full} ${c.tradeoff}`,
    }
  })
}

const REASON = { duration: 'EVA duration', 'walkback-distance': 'return distance', 'walkback-time': 'return time' } as const

/** One cell of the comparison table: the figure, and its difference from Fastest where there is one to show. */
export interface TableCell {
  value: string
  /** Null for Fastest, for a mode without a route, and for rows that carry no difference. */
  delta: string | null
}

export interface TableRow {
  id: string
  label: string
  /** What the figure is and where it comes from. */
  hint?: string
  cells: Record<RouteMode, TableCell>
}

export interface ComparisonTable {
  /** Mission verdict of each priority; 'standby' while there is none. */
  verdicts: Record<RouteMode, Verdict>
  states: Record<RouteMode, ModeState>
  /** Why a priority is not a GO, in a few words; null for GO and while there is no result. */
  reasons: Record<RouteMode, string | null>
  /** Always shown. */
  primary: TableRow[]
  /** Shown on request. */
  more: TableRow[]
}

/**
 * The comparison table. Every figure is formatted here, the same way for each
 * priority, and a difference appears only under a figure that has one.
 */
export function comparisonTable(summaries: Summaries, pending = false): ComparisonTable {
  const cmp = compareModes(summaries, pending)
  const ids = ROUTE_MODES.map((m) => m.id)
  const each = <T,>(f: (id: RouteMode) => T) => Object.fromEntries(ids.map((id) => [id, f(id)])) as Record<RouteMode, T>
  const blank = (id: RouteMode) => (cmp[id].state === 'pending' ? '…' : '—')
  const row = (
    id: string,
    label: string,
    hint: string | undefined,
    value: (s: ModeSummary) => string | null,
    delta?: (d: Deltas) => string,
  ): TableRow => ({
    id,
    label,
    hint,
    cells: each((m) => {
      const s = summaries[m]
      const shown = s && s.feasible ? value(s) : null
      const d = cmp[m].deltas
      return { value: shown ?? blank(m), delta: shown !== null && delta && d ? delta(d) : null }
    }),
  })
  const check = (s: ModeSummary, id: 'walkback-distance' | 'walkback-time') => {
    const c = s.checks?.find((k) => k.id === id)
    return c ? (c.state === 'unverified' ? 'not verified' : c.value) : null
  }
  const pace = `≤ ${PLANNING_PACE.max_kmh} km/h`
  return {
    verdicts: each((m) => cmp[m].verdict),
    states: each((m) => cmp[m].state),
    reasons: each((m) => {
      const s = summaries[m]
      if (!s || s.verdict === 'go') return null
      if (!s.feasible) return 'a checkpoint cannot be reached'
      const failed = s.checks?.filter((c) => !c.ok) ?? []
      if (!failed.length) return null
      // Short names: the full checks, with their figures and limits, are in the mission status and under Mission constraints.
      if (failed.some((c) => c.state === 'unverified')) return 'return not verified'
      return failed.map((c) => REASON[c.id]).join(', ')
    }),
    primary: [
      row('distance', 'Distance', undefined, (s) => fmtKm(s.distance), (d) => fmtDelta('distance', d.distance)),
      row('walk-model', 'Model walking time', 'By the walking-speed model (Marquez 2007, as in SEXTANT). This is what Fastest minimises.', (s) => fmtDur(s.walkTime), (d) => fmtDelta('time', d.walkTime)),
      row(
        'walk-plan',
        `Planning walking time, ${pace}`,
        `The same route with the speed capped at the planning pace of ${PLANNING_PACE.max_kmh} km/h. A second scenario, not a bound or a confidence interval.`,
        (s) => fmtDur(s.planWalkTime),
        (d) => fmtDelta('time', d.planWalkTime),
      ),
      row(
        'energy',
        'Model walking energy',
        'Metabolic energy of walking by the adopted model (Santee et al. 2001), at the model speed. Mars gravity enters only its climb and descent terms.',
        (s) => `${Math.round(s.energyKcal)} kcal`,
        (d) => fmtDelta('energy', d.energyKcal),
      ),
      row(
        'steep-km',
        'Hidden steepness exposure, per km',
        'Steep-pixel shares of the 4 m cells crossed, added up and divided by the route length. 1.0 equals one cell per kilometre that is entirely steeper than 20° at the 1 m scale.',
        (s) => (s.exposure ? s.exposure.perKm.toFixed(1) : null),
        (d) => fmtDelta('steep', d.steepPerKm),
      ),
    ],
    more: [
      row('eva-plan', `EVA duration, ${pace}`, 'Walking at the planning pace plus time at the targets. The 8-hour limit is judged on this figure.', (s) => fmtDur(s.planEvaSeconds)),
      row('eva-model', 'EVA duration, model', 'Walking by the speed model plus time at the targets.', (s) => fmtDur(s.evaSeconds)),
      row('back-distance', 'Way back to habitat, distance', 'Worst case along the route, as in Mission constraints. Checked against the return distance limit.', (s) => check(s, 'walkback-distance')),
      row('back-time', `Way back to habitat, time ${pace}`, 'Worst case along the route at the planning pace, as in Mission constraints. Checked against the return time limit.', (s) => check(s, 'walkback-time')),
      row('climb', 'Climb / descent', undefined, (s) => `+${Math.round(s.ascent)} / −${Math.round(s.descent)} m`),
      row('steep-total', 'Hidden steepness exposure, total', 'Steep-pixel shares of the cells crossed, added up. 1.0 equals one 4 m cell that is entirely steeper than 20° at the 1 m scale.', (s) => (s.exposure ? s.exposure.load.toFixed(1) : null)),
      row('steep-cells', 'Cells with hidden steep ground', 'Share of the cells crossed that contain any steep 1 m pixel.', (s) => (s.exposure ? `${(s.exposure.cellShare * 100).toFixed(1)}%` : null)),
      row('steep-worst', 'Steepest cell, steep share', 'The largest share of steep 1 m pixels in any one cell crossed.', (s) => (s.exposure ? `${Math.round(s.exposure.worst * 100)}%` : null)),
    ],
  }
}
