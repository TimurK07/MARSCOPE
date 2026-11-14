// Mission-level checks: is a feasible route also acceptable as an EVA?
//
// Feasibility (can the route be walked at all within the slope limit?) is
// decided by the route search. The checks here come after it and compare the
// planned EVA with operational limits. A plan without a feasible route never
// reaches them, so it can never be GO.

import { fmtDur, fmtKm } from './format'
import { EVA } from './model'
import type { WalkBack } from './router'

export interface Check {
  id: 'duration' | 'walkback-distance' | 'walkback-time'
  label: string
  value: string
  limit: string
  ok: boolean
  /** Measured value as a fraction of its limit. */
  ratio: number
  /** How far inside or outside the limit the plan is. */
  margin: string
}

export type Verdict = 'standby' | 'go' | 'nogo' | 'noroute'

export interface MissionInput {
  /** Whole EVA, walking plus time at targets, seconds. */
  evaSeconds: number
  /** Worst-case walk back to the habitat, or null when it could not be computed. */
  walkBack: WalkBack | null
}

const spare = (ok: boolean, text: string) => (ok ? `${text} to spare` : `over by ${text}`)

export function buildChecks(i: MissionInput): Check[] {
  const durLimit = EVA.maxDuration_h * 3600
  const distLimit = EVA.walkRadius_km * 1000
  const timeLimit = EVA.walkBackTime_min * 60
  const back = i.walkBack
  // No safe way back from somewhere on the route fails both walk-back checks outright.
  const lost = !back || !back.reachable

  const durOk = i.evaSeconds <= durLimit
  const distOk = !lost && back.maxDistance <= distLimit
  const timeOk = !lost && back.maxTime <= timeLimit

  return [
    {
      id: 'duration',
      label: 'EVA duration',
      value: fmtDur(i.evaSeconds),
      limit: `≤ ${EVA.maxDuration_h} h`,
      ok: durOk,
      ratio: i.evaSeconds / durLimit,
      margin: spare(durOk, fmtDur(Math.abs(durLimit - i.evaSeconds))),
    },
    {
      id: 'walkback-distance',
      label: 'Longest walk back to habitat',
      value: lost ? 'no safe way back' : fmtKm(back.maxDistance),
      limit: `≤ ${EVA.walkRadius_km} km`,
      ok: distOk,
      ratio: lost ? Infinity : back.maxDistance / distLimit,
      margin: lost ? 'part of the route has no safe return' : spare(distOk, fmtKm(Math.abs(distLimit - back.maxDistance))),
    },
    {
      id: 'walkback-time',
      label: 'Slowest walk back to habitat',
      value: lost ? 'no safe way back' : fmtDur(back.maxTime),
      limit: `≤ ${EVA.walkBackTime_min} min`,
      ok: timeOk,
      ratio: lost ? Infinity : back.maxTime / timeLimit,
      margin: lost ? 'part of the route has no safe return' : spare(timeOk, fmtDur(Math.abs(timeLimit - back.maxTime))),
    },
  ]
}

/**
 * Overall verdict. A plan with no feasible route is NO ROUTE whatever else is true;
 * only a feasible route that passes every check is GO.
 */
export function missionVerdict(hasPlan: boolean, feasible: boolean, checks: Check[] | null): Verdict {
  if (!hasPlan) return 'standby'
  if (!feasible || !checks) return 'noroute'
  return checks.every((c) => c.ok) ? 'go' : 'nogo'
}
