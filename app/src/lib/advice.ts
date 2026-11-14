// Plain-language guidance for a NO-GO plan.
//
// This module does not decide GO / NO-GO: that is done by the checks in
// hooks/usePlan.ts. It only explains a failed check, using quantities the
// planner has already computed.

import { EVA, surfaceDistanceM } from './model'
import type { LatLon } from './terrain'

export interface AdviceInput {
  points: LatLon[]
  /** Walking time of the whole route, seconds. */
  walkTime: number
  /** Time spent at each science target, minutes. */
  stopMinutes: number
  /** Farthest point of the route from the habitat, metres. */
  farthest: number
}

const dur = (s: number) => {
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`
}
const km = (m: number) => `${(m / 1000).toFixed(2)} km`

/** What would bring the EVA duration back under the limit. */
export function durationAdvice(a: AdviceInput): string {
  const targets = Math.max(a.points.length - 1, 0)
  const budget = EVA.maxDuration_h * 3600 - a.walkTime
  if (targets === 0 || budget <= 0) {
    return `Walking alone takes ${dur(a.walkTime)}. Remove a target or move checkpoints closer together.`
  }
  const maxStop = Math.floor(budget / targets / 60)
  if (maxStop < 1) {
    return `Walking takes ${dur(a.walkTime)}, which leaves no time at the targets. Remove a target or shorten the route.`
  }
  return `Reduce time at each target to ${maxStop} min or less (now ${a.stopMinutes} min), or remove a target.`
}

/** Which checkpoints are beyond the walking range, or that the route itself swings out too far. */
export function rangeAdvice(a: AdviceInput): string {
  const limit = EVA.walkRadius_km * 1000
  const habitat = a.points[0]
  const beyond = a.points
    .slice(1)
    .map((p, i) => ({ n: i + 1, d: surfaceDistanceM(habitat, p) }))
    .filter((t) => t.d > limit)
  if (beyond.length > 0) {
    const list = beyond.map((t) => `target ${t.n} (${km(t.d)})`).join(', ')
    return `Beyond walking range: ${list}. Move ${beyond.length > 1 ? 'them' : 'it'} closer or move the habitat.`
  }
  return `All checkpoints are within range, but the safe route swings out to ${km(a.farthest)} to avoid steep ground. Move a checkpoint to shorten the detour.`
}

export function adviceFor(checkId: string, a: AdviceInput): string | null {
  if (checkId === 'duration') return durationAdvice(a)
  if (checkId === 'range') return rangeAdvice(a)
  return null
}
