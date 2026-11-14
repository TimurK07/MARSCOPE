// Plain-language guidance for a NO-GO plan.
//
// This module does not decide GO / NO-GO: that is done in lib/mission.ts.
// It only explains a failed check, using quantities the planner has already computed.

import { fmtDur, fmtKm } from './format'
import { EVA, PLANNING_PACE, surfaceDistanceM } from './model'
import type { WalkBack } from './returnCheck'
import type { LatLon } from './terrain'

export interface AdviceInput {
  points: LatLon[]
  /** Walking time of the whole route at the planning pace, seconds: the one the duration limit is judged on. */
  walkTime: number
  /** Time spent at each science target, minutes. */
  stopMinutes: number
  walkBack: WalkBack | null
}

/** Names the checkpoint closest to a point on the route. */
export function nearestCheckpoint(points: LatLon[], at: LatLon): string {
  let best = 0
  for (let i = 1; i < points.length; i++) {
    if (surfaceDistanceM(points[i], at) < surfaceDistanceM(points[best], at)) best = i
  }
  return best === 0 ? 'the habitat' : `target ${best}`
}

/** What would bring the EVA duration back under the limit. */
export function durationAdvice(a: AdviceInput): string {
  const targets = Math.max(a.points.length - 1, 0)
  const budget = EVA.maxDuration_h * 3600 - a.walkTime
  if (targets === 0 || budget <= 0) {
    return `Walking alone takes ${fmtDur(a.walkTime)} at no more than ${PLANNING_PACE.max_kmh} km/h. Remove a target or move checkpoints closer together.`
  }
  const maxStop = Math.floor(budget / targets / 60)
  if (maxStop < 1) {
    return `Walking takes ${fmtDur(a.walkTime)} at no more than ${PLANNING_PACE.max_kmh} km/h, which leaves no time at the targets. Remove a target or shorten the route.`
  }
  return `Reduce time at each target to ${maxStop} min or less (now ${a.stopMinutes} min), or remove a target.`
}

/** Where the way back fails, and what to change. Both figures describe the same return path. */
export function walkBackAdvice(a: AdviceInput, kind: 'distance' | 'time'): string {
  const back = a.walkBack
  if (!back || !back.reachable) {
    return 'Part of this route has no safe way back to the habitat within the slope limit. Move the checkpoint or the habitat.'
  }
  const where = nearestCheckpoint(a.points, kind === 'distance' ? back.maxDistanceAt : back.maxTimeAt)
  if (!back.verified) {
    return `From a point near ${where}, the search for a way back within both limits reached its calculation limit. This is not a confirmed violation, and it is not a pass. Move that checkpoint closer to the habitat to get a definite answer.`
  }
  const path = `${fmtKm(back.maxDistance)} in ${fmtDur(back.maxTime)} at no more than ${PLANNING_PACE.max_kmh} km/h`
  if (kind === 'distance') {
    return `From a point near ${where}, no way back is within both limits; the best found is ${path}, which is too long. Move it closer to the habitat, or move the habitat.`
  }
  return `From a point near ${where}, no way back is within both limits; the best found is ${path}, which is too slow. Move that checkpoint, or choose a habitat site that is quicker to return to.`
}

export function adviceFor(checkId: string, a: AdviceInput): string | null {
  if (checkId === 'duration') return durationAdvice(a)
  if (checkId === 'walkback-distance') return walkBackAdvice(a, 'distance')
  if (checkId === 'walkback-time') return walkBackAdvice(a, 'time')
  return null
}
