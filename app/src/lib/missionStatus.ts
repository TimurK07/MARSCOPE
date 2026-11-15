// The mission status as the interface words it: the verdict of the plan on
// screen, and what is said while there is none. Nothing here decides a verdict;
// that is done by the planner and the mission checks.

import type { PlanState } from '../hooks/usePlan'
import type { Verdict } from './mission'

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
