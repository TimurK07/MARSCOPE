// How a plan is drawn: which legs are outbound and which is the return, what
// may be marked on the map, and what the map says when a plan does not pass.
//
// This module decides nothing about the plan. It reads what the planner and
// the mission checks have already established and turns it into drawing
// instructions, under three rules:
//
//   1. A route is never coloured by the verdict. Every leg that was found is a
//      route within the slope limit, and is drawn as outbound or as return.
//   2. Something is marked on the map only where the planner knows the place:
//      the point of the route whose way back is over the return limits (or
//      could not be verified), and a checkpoint no route reaches.
//   3. A limit that has no place (the EVA duration) is reported in words. No
//      stretch of route is painted as if the problem were there.

import type { Check, Verdict } from './mission'
import { RETURN_LIMITS } from './model'
import type { Plan } from './planner'
import type { LatLon } from './terrain'

export type LegRole = 'outbound' | 'return'

/** Colours of the route, shared by the 2D map, the 3D globe and the legends. */
export const ROUTE_COLORS = {
  /** Habitat to the targets. The colour the route has always had. */
  outbound: '#62d4e8',
  /** Last target back to the habitat. The accent of the habitat marker. */
  return: '#ee8c60',
  /** A place where a limit is shown to be broken, or a checkpoint that cannot be reached. */
  alert: '#e5504f',
  /** A place whose answer could not be established. */
  unverified: '#e0b246',
} as const

/** The same colours as numbers, for the globe's line materials. */
export const ROUTE_COLOR_HEX: Record<LegRole, number> = {
  outbound: parseInt(ROUTE_COLORS.outbound.slice(1), 16),
  return: parseInt(ROUTE_COLORS.return.slice(1), 16),
}

/**
 * The role of each leg that was found. With a return to the habitat, the leg
 * from the last target home is the return; every other leg is outbound. A plan
 * that stopped at an unreachable checkpoint has only the legs before it.
 */
export function legRoles(pointCount: number, roundTrip: boolean, legCount: number): LegRole[] {
  const roles: LegRole[] = []
  for (let i = 0; i < legCount; i++) roles.push(roundTrip && pointCount >= 2 && i === pointCount - 1 ? 'return' : 'outbound')
  return roles
}

/** How the mission reads at a glance on the globe: one tone per verdict, plus none yet. */
export type MissionTone = 'idle' | 'go' | 'nogo' | 'unverified' | 'noroute'

/** The tone of a verdict. Each verdict has its own; none borrows another's colour. */
export function missionTone(verdict: Verdict): MissionTone {
  return verdict === 'standby' ? 'idle' : verdict
}

export type NoteKind = 'return-limit' | 'return-unverified' | 'unreachable'

/** One thing marked on the map, at a place the planner established. */
export interface RouteNote {
  kind: NoteKind
  at: LatLon
  /** What the mark means, for a tooltip and for screen readers. */
  label: string
  /** For an unreachable checkpoint: its index in the checkpoint list (0 is the habitat). */
  pointIndex?: number
}

export interface RouteAlert {
  tone: 'nogo' | 'unverified' | 'noroute'
  /** The verdict word. */
  title: string
  /** Why, in one line, from the checks that failed. */
  text: string
}

export interface LegendItem {
  id: LegRole | NoteKind
  label: string
  color: string
}

export interface RouteDisplay {
  roles: LegRole[]
  notes: RouteNote[]
  alert: RouteAlert | null
  legend: LegendItem[]
}

export interface DisplayInput {
  points: LatLon[]
  roundTrip: boolean
  plan: Plan | null
  /** Checks of the selected priority; null when there is no feasible route. */
  checks: Check[] | null
  verdict: Verdict
}

const pointName = (index: number) => (index === 0 ? 'the habitat' : `target ${index}`)

/** Everything the map, the globe and the legends need to draw a plan. */
export function routeDisplay(i: DisplayInput): RouteDisplay {
  const { plan, points, roundTrip, checks, verdict } = i
  const roles = plan ? legRoles(points.length, roundTrip, plan.legs.length) : []
  const notes: RouteNote[] = []
  let alert: RouteAlert | null = null

  if (plan && verdict === 'noroute') {
    // The leg after the last one found is the one that failed; its far end is the checkpoint not reached.
    const sequence = roundTrip ? [...points.keys(), 0] : [...points.keys()]
    const index = sequence[plan.legs.length + 1]
    if (index !== undefined && points[index]) {
      notes.push({ kind: 'unreachable', at: points[index], pointIndex: index, label: `No route within the slope limit reaches ${pointName(index)}.` })
    }
    alert = { tone: 'noroute', title: 'NO ROUTE', text: plan.error ?? 'No route within the slope limit.' }
  } else if (plan && checks && (verdict === 'nogo' || verdict === 'unverified')) {
    const failed = checks.filter((c) => !c.ok)
    const back = plan.walkBack
    const returnFailed = failed.some((c) => c.id !== 'duration')
    // The return check knows which point of the route decided it. The EVA duration has no such place.
    if (returnFailed && back && back.reachable && Number.isFinite(back.maxDistance)) {
      const km = RETURN_LIMITS.distance_m / 1000
      const min = RETURN_LIMITS.time_s / 60
      if (!back.verified) {
        notes.push({ kind: 'return-unverified', at: back.maxDistanceAt, label: `From this point a way back within ${km} km and ${min} min could not be verified.` })
      } else {
        const dist = failed.find((c) => c.id === 'walkback-distance')
        const time = failed.find((c) => c.id === 'walkback-time')
        const over = [dist && `${dist.value} (limit ${km} km)`, time && `${time.value} (limit ${min} min)`].filter(Boolean).join(', ')
        notes.push({ kind: 'return-limit', at: back.maxDistanceAt, label: `From this point no way back is within the return limits: ${over}.` })
      }
    }
    alert =
      verdict === 'unverified'
        ? { tone: 'unverified', title: 'UNVERIFIED', text: 'The return to the habitat could not be verified. Not a confirmed violation, and not a GO.' }
        : { tone: 'nogo', title: 'NO-GO', text: failed.map((c) => `${c.label}: ${c.value}, limit ${c.limit.replace('≤ ', '')}`).join(' · ') }
  }

  const legend: LegendItem[] = []
  if (roles.includes('outbound')) legend.push({ id: 'outbound', label: 'Outbound route', color: ROUTE_COLORS.outbound })
  if (roles.includes('return')) legend.push({ id: 'return', label: 'Return to habitat', color: ROUTE_COLORS.return })
  for (const n of notes) {
    if (n.kind === 'return-limit') legend.push({ id: n.kind, label: 'Return limits exceeded from here', color: ROUTE_COLORS.alert })
    if (n.kind === 'return-unverified') legend.push({ id: n.kind, label: 'Return not verified from here', color: ROUTE_COLORS.unverified })
    if (n.kind === 'unreachable') legend.push({ id: n.kind, label: 'Checkpoint not reached', color: ROUTE_COLORS.alert })
  }
  return { roles, notes, alert, legend }
}
