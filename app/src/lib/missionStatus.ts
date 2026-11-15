// The mission status as the interface words it: the verdict of the plan on
// screen, and what is said while there is none. Nothing here decides a verdict;
// that is done by the planner and the mission checks.

import type { PlanState } from '../hooks/usePlan'
import { fmtDur, fmtKm } from './format'
import type { Verdict } from './mission'
import { PLANNING_PACE } from './model'
import { ROUTE_MODES } from './objectives'
import { missionTone, type LegendItem, type MissionTone, type RouteDisplay } from './routeDisplay'

export function verdictOf(s: PlanState): Verdict {
  // GO only when the planner itself says so; anything unsettled is never shown as GO.
  if (!s.plan) return 'standby'
  if (s.plan.error) return 'noroute'
  return s.verdict === 'go' && s.go ? 'go' : s.verdict === 'unverified' ? 'unverified' : 'nogo'
}

export const VERDICT_TITLE: Record<Verdict, string> = {
  standby: 'STANDBY',
  go: 'GO',
  nogo: 'NO-GO',
  unverified: 'UNVERIFIED',
  noroute: 'NO ROUTE',
}

/** True while routes are being calculated and there is no result to show for the current plan. */
export const isCalculating = (s: PlanState) => s.pending && verdictOf(s) === 'standby'

/**
 * The word shown for the mission status. While routes are being calculated it says so:
 * STANDBY is for a plan that is waiting for the user, not for one that is being worked on.
 * This changes the wording only; the verdict itself is untouched.
 */
export const statusTitle = (s: PlanState) => (isCalculating(s) ? 'CALCULATING' : VERDICT_TITLE[verdictOf(s)])

/** The mission in a few lines, for the globe: its marker label and its summary card. */
export interface MissionSummary {
  /** At least a habitat has been placed. */
  hasPlan: boolean
  tone: MissionTone
  /** "EVA plan" and the status word: a verdict, or CALCULATING. */
  title: string
  /** Distance, EVA duration and targets of the route on screen, or what to do next. */
  detail: string
  /** The route priority the summary is for; null until there is a route to plan. */
  mode: string | null
  /** Why the plan is not a GO, in one line: the first limit that is not met. Null for GO and while there is no verdict. */
  reason: string | null
  /** How many further limits are not met, beyond the one in `reason`. */
  moreReasons: number
  /** The key to what is drawn: the same items, in the same order, as on the 2D map. */
  legend: LegendItem[]
  /** Routes are being calculated. */
  busy: boolean
}

/**
 * The summary of the mission on screen. It reads the plan and the display built
 * for the 2D map, so the globe says the same thing in the same words; it decides
 * nothing itself.
 */
export function missionSummary(plan: PlanState, display: RouteDisplay): MissionSummary {
  const verdict = verdictOf(plan)
  const route = plan.plan && !plan.plan.error ? plan.plan : null
  const targets = Math.max(plan.points.length - 1, 0)
  const hasPlan = plan.points.length > 0
  const failed = plan.checks?.filter((c) => !c.ok) ?? []
  let reason: string | null = null
  let moreReasons = 0
  if (verdict === 'nogo' && failed.length > 0) {
    const c = failed[0]
    reason = `${c.label}: ${c.value}, limit ${c.limit.replace('≤ ', '')}`
    moreReasons = failed.length - 1
  } else if (verdict === 'unverified') reason = 'The return to the habitat could not be verified. Not a confirmed violation, and not a GO.'
  else if (verdict === 'noroute') reason = plan.plan?.error ?? 'No route within the slope limit.'
  return {
    hasPlan,
    tone: missionTone(verdict),
    title: hasPlan ? `EVA plan · ${statusTitle(plan)}` : 'Gale crater study area',
    detail: route
      ? `${fmtKm(route.distance)} · EVA ${fmtDur(plan.planEvaSeconds)} at ≤ ${PLANNING_PACE.max_kmh} km/h · ${targets} target${targets === 1 ? '' : 's'}`
      : plan.pending
        ? 'Calculating routes…'
        : verdict === 'noroute'
          ? 'Legs that were found are drawn. Nothing else is assessed.'
          : hasPlan
            ? 'Habitat set. Add a science target in the workspace.'
            : 'Terrain data and EVA routing are available here.',
    // A priority means something once there is a route to plan: a habitat and a target.
    mode: plan.points.length >= 2 ? ROUTE_MODES.find((m) => m.id === plan.mode)!.label : null,
    reason,
    moreReasons,
    legend: display.legend,
    busy: isCalculating(plan),
  }
}
