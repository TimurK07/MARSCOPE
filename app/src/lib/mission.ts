// Mission-level checks: is a feasible route also acceptable as an EVA?
//
// Feasibility (can the route be walked at all within the slope limit?) is
// decided by the route search. The checks here come after it and compare the
// planned EVA with operational limits. A plan without a feasible route never
// reaches them, so it can never be GO.

import { fmtDur, fmtKm } from './format'
import { EVA, PLANNING_PACE, RETURN_LIMITS } from './model'
import type { WalkBack } from './returnCheck'

export interface Check {
  id: 'duration' | 'walkback-distance' | 'walkback-time'
  label: string
  value: string
  limit: string
  /** True only when the check is shown to be met. */
  ok: boolean
  /**
   * 'fail' is a limit shown to be broken. 'unverified' means the calculation
   * could not settle it: not met, and not shown to be broken either.
   */
  state: 'ok' | 'fail' | 'unverified'
  /** Measured value as a fraction of its limit. */
  ratio: number
  /** How far inside or outside the limit the plan is. */
  margin: string
}

export type Verdict = 'standby' | 'go' | 'nogo' | 'unverified' | 'noroute'

export interface MissionInput {
  /**
   * Whole EVA at the planning pace, seconds: walking time with the speed capped at the
   * planning pace, plus time at the targets. This is the duration the limit is applied to.
   */
  evaSeconds: number
  /** Worst-case walk back to the habitat, or null when it could not be computed. */
  walkBack: WalkBack | null
}

// Return figures are rounded against the plan, so a display can never look better than
// the number behind it: a length or time is rounded up, room to spare is rounded down
// and an overrun is rounded up.
const kmUp = (m: number) => `${(Math.ceil(m / 10 - 1e-9) / 100).toFixed(2)} km`
const minUp = (s: number) => `${Math.ceil(s / 60 - 1e-9)} min`
function distanceMargin(d: number, limit: number): string {
  if (d > limit) {
    const over = Math.max(1, Math.ceil(d - limit))
    return over >= 1000 ? `over by ${(Math.ceil(over / 10) / 100).toFixed(2)} km` : `over by ${over} m`
  }
  const room = Math.floor(limit - d)
  return room < 1 ? 'less than 1 m to spare' : room >= 1000 ? `${(Math.floor(room / 10) / 100).toFixed(2)} km to spare` : `${room} m to spare`
}
function durationMargin(s: number, limit: number): string {
  if (s > limit) return `over by ${fmtDur(Math.max(1, Math.ceil((s - limit) / 60)) * 60)}`
  const room = Math.floor((limit - s) / 60)
  return room < 1 ? 'less than 1 min to spare' : `${fmtDur(room * 60)} to spare`
}
function timeMargin(s: number, limit: number): string {
  if (s > limit) return `over by ${Math.max(1, Math.ceil((s - limit) / 60))} min`
  const room = Math.floor((limit - s) / 60)
  return room < 1 ? 'less than 1 min to spare' : `${room} min to spare`
}

export function buildChecks(i: MissionInput): Check[] {
  const durLimit = EVA.maxDuration_h * 3600
  const distLimit = RETURN_LIMITS.distance_m
  const timeLimit = RETURN_LIMITS.time_s
  const back = i.walkBack
  // No way back at all from somewhere on the route fails both return checks outright.
  const lost = !back || !back.reachable
  // The search for a way back within both limits ran out of work: nothing was shown either way.
  const open = !lost && !back.verified

  const durOk = i.evaSeconds <= durLimit
  // Both values describe one return path, from the point of the route that decides the outcome.
  // Its time is counted at the planning pace (see planningSpeedMs).
  let distOk = !lost && !open && back.maxDistance <= distLimit
  let timeOk = !lost && !open && back.maxTime <= timeLimit
  // The plan passes only when one way back meets both limits from every point. If that
  // was not established, the two checks must not both read as passed.
  if (!lost && !open && !back.feasible && distOk && timeOk) distOk = timeOk = false
  const state = (ok: boolean): Check['state'] => (ok ? 'ok' : open ? 'unverified' : 'fail')
  const notVerified = 'not shown to pass or to fail: the calculation limit was reached'

  return [
    {
      id: 'duration',
      label: `EVA duration at ≤ ${PLANNING_PACE.max_kmh} km/h`,
      // Rounded against the plan, like the return figures: the duration up, room to spare down, an overrun up.
      value: fmtDur(Math.ceil(i.evaSeconds / 60 - 1e-9) * 60),
      limit: `≤ ${EVA.maxDuration_h} h`,
      ok: durOk,
      state: durOk ? 'ok' : 'fail',
      ratio: i.evaSeconds / durLimit,
      margin: durationMargin(i.evaSeconds, durLimit),
    },
    {
      id: 'walkback-distance',
      label: 'Way back to habitat: distance',
      value: lost ? 'no safe way back' : open ? 'not verified' : kmUp(back.maxDistance),
      limit: `≤ ${fmtKm(distLimit).replace('.00', '')}`,
      ok: distOk,
      state: state(distOk),
      ratio: lost ? Infinity : open ? 0 : back.maxDistance / distLimit,
      margin: lost ? 'part of the route has no safe return' : open ? notVerified : distanceMargin(back.maxDistance, distLimit),
    },
    {
      id: 'walkback-time',
      label: `Way back to habitat: time at ≤ ${PLANNING_PACE.max_kmh} km/h`,
      value: lost ? 'no safe way back' : open ? 'not verified' : minUp(back.maxTime),
      limit: `≤ ${Math.round(timeLimit / 60)} min`,
      ok: timeOk,
      state: state(timeOk),
      ratio: lost ? Infinity : open ? 0 : back.maxTime / timeLimit,
      margin: lost ? 'part of the route has no safe return' : open ? notVerified : timeMargin(back.maxTime, timeLimit),
    },
  ]
}

/**
 * Overall verdict.
 *   NO ROUTE    no feasible route, whatever else is true.
 *   NO-GO       a limit is shown to be broken.
 *   UNVERIFIED  nothing is shown to be broken, but the return to the habitat could
 *               not be established within the calculation limit. Not a GO.
 *   GO          every check is shown to be met, which for the return means a real
 *               path within both limits was found from every point of the route.
 */
export function missionVerdict(hasPlan: boolean, feasible: boolean, checks: Check[] | null): Verdict {
  if (!hasPlan) return 'standby'
  if (!feasible || !checks) return 'noroute'
  if (checks.some((c) => c.state === 'fail')) return 'nogo'
  if (checks.some((c) => c.state !== 'ok' || !c.ok)) return 'unverified'
  return 'go'
}
