// Builds a whole EVA plan from checkpoints, for one routing mode or all three.
// Pure functions: the same code runs in the Web Worker, on the main thread as a
// fallback, and in the tests.

import { fmtDur } from './format'
import { buildChecks, missionVerdict, type Check, type Verdict } from './mission'
import { backgroundDoseMsv, clampReturnDistance, RETURN_LIMITS, surfaceDistanceM } from './model'
import type { ReturnLimits } from './returnCheck'
import { makeObjective, ROUTE_MODES, type RouteMode } from './objectives'
import { findLeg, WalkBackField, type LegResult, type RouteLeg, type RouteSample, type WalkBack } from './router'
import type { LatLon, Terrain } from './terrain'

export interface PlanInput {
  points: LatLon[]
  roundTrip: boolean
  /** Suited mass, kg. Changes the energy-efficient route, not the others. */
  massKg: number
  /**
   * Longest acceptable way back to the habitat, metres. A planning assumption the
   * user can set; 2 km when left out. It changes the return check and nothing else:
   * routes, their geometry and the 60-minute return time limit stay as they are.
   */
  returnDistanceM?: number
}

/** The return limits a plan is held to: the distance from the input, the time always the default. */
export function returnLimitsOf(input: Pick<PlanInput, 'returnDistanceM'>): ReturnLimits {
  return { distance_m: clampReturnDistance(input.returnDistanceM), time_s: RETURN_LIMITS.time_s }
}

/** A return-check field for a plan's habitat and its limits. Build one per plan and share it between the modes. */
export function returnFieldFor(t: Terrain, input: PlanInput): WalkBackField {
  return new WalkBackField(t, input.points[0], returnLimitsOf(input))
}

/**
 * Hidden steep ground along a route, in absolute and length-independent terms.
 * Both matter when comparing routes of different lengths: a longer route
 * collects more load even over the same kind of ground.
 */
export interface Exposure {
  /** Sum of the steep-pixel shares of the cells crossed. 1.0 = one fully steep cell. */
  load: number
  /** The same load per kilometre of route. */
  perKm: number
  /** Share of the cells crossed that contain any steep 1 m pixel. */
  cellShare: number
  /** Largest steep share in any cell crossed. */
  worst: number
}

export interface Plan {
  mode: RouteMode
  legs: RouteLeg[]
  error: string | null
  samples: RouteSample[]
  legStarts: number[]
  distance: number
  /** Walking time by the speed model, seconds. This is what Fastest minimises. */
  walkTime: number
  /** Walking time of the same route with the speed capped at the planning pace, seconds. */
  planWalkTime: number
  ascent: number
  descent: number
  maxSlope: number
  energyPerKg: number
  energyFixed: number
  /** Farthest point of the route from the habitat in a straight line, metres. For information only. */
  farthest: number
  /**
   * Return to the habitat from the point of the route that decides the outcome:
   * one way back, its length, and its duration at the planning pace. The same
   * for every routing mode: it is a safety check, not part of the optimised route.
   */
  walkBack: WalkBack | null
  /** Null when the terrain has no subcell data. */
  exposure: Exposure | null
  /** Value of the mode's own objective over the whole route. */
  objectiveValue: number
}

export type LegCache = Map<string, LegResult>

/**
 * Plans one mode. Pass the same WalkBackField for every mode of a plan: the way
 * back is then searched once and all modes are checked against the same answer.
 */
export function computePlan(t: Terrain, input: PlanInput, mode: RouteMode, cache?: LegCache, field?: WalkBackField): Plan | null {
  const { points, roundTrip, massKg } = input
  if (points.length < 2) return null
  const objective = makeObjective(mode, t, massKg)
  const seq = roundTrip ? [...points, points[0]] : points
  const legs: RouteLeg[] = []
  let error: string | null = null
  for (let i = 0; i < seq.length - 1; i++) {
    // Only the energy-efficient route depends on the suited mass.
    const key = `${mode}|${mode === 'energy' ? massKg : ''}|${seq[i].lat},${seq[i].lon}>${seq[i + 1].lat},${seq[i + 1].lon}`
    let res = cache?.get(key)
    if (!res) {
      res = findLeg(t, seq[i], seq[i + 1], { objective })
      cache?.set(key, res)
    }
    if (!res.ok) {
      const to = i + 1 === seq.length - 1 && roundTrip ? 'habitat' : `target ${i + 1}`
      error = `Leg to ${to}: ${res.reason}`
      break
    }
    legs.push(res.leg)
  }

  const samples: RouteSample[] = []
  const legStarts: number[] = []
  let dist = 0
  let time = 0
  let farthest = 0
  for (const leg of legs) {
    if (dist > 0) legStarts.push(dist)
    for (const s of leg.samples) {
      samples.push({ ...s, dist: s.dist + dist, time: s.time + time })
      const d = surfaceDistanceM(points[0], s)
      if (d > farthest) farthest = d
    }
    dist += leg.distance
    time += leg.duration
  }

  const sum = (f: (l: RouteLeg) => number) => legs.reduce((a, l) => a + f(l), 0)
  const cells = sum((l) => l.cellsCrossed)
  const withData = legs.length > 0 && legs.every((l) => l.hiddenLoad != null)
  const load = sum((l) => l.hiddenLoad ?? 0)
  return {
    mode,
    legs,
    error,
    samples,
    legStarts,
    distance: dist,
    walkTime: time,
    planWalkTime: sum((l) => l.planDuration),
    ascent: sum((l) => l.ascent),
    descent: sum((l) => l.descent),
    maxSlope: legs.reduce((a, l) => Math.max(a, l.maxSlope), 0),
    energyPerKg: sum((l) => l.energyPerKg),
    energyFixed: sum((l) => l.energyFixed),
    farthest,
    // Only a complete, feasible route is assessed for the way back.
    walkBack: error ? null : (field ?? returnFieldFor(t, input)).assess(samples),
    exposure: withData
      ? {
          load,
          perKm: dist > 0 ? load / (dist / 1000) : 0,
          cellShare: cells > 0 ? sum((l) => (l.hiddenCells ?? 0) * l.cellsCrossed) / cells : 0,
          worst: legs.reduce((a, l) => Math.max(a, l.hiddenMax ?? 0), 0),
        }
      : null,
    objectiveValue: sum((l) => l.cost),
  }
}

export type Plans = Record<RouteMode, Plan | null>

/** The order to plan the modes in: the one on screen first. */
export function modeOrder(first?: RouteMode): RouteMode[] {
  const all = ROUTE_MODES.map((m) => m.id)
  return first ? [first, ...all.filter((m) => m !== first)] : all
}

export function computeAllPlans(t: Terrain, input: PlanInput, cache?: LegCache): Plans {
  const out = {} as Plans
  const field = input.points.length >= 2 ? returnFieldFor(t, input) : undefined
  for (const m of modeOrder()) out[m] = computePlan(t, input, m, cache, field)
  return out
}

/** One mode's plan reduced to what the comparison shows. Same method for every mode. */
export interface ModeSummary {
  mode: RouteMode
  verdict: Verdict
  feasible: boolean
  distance: number
  walkTime: number
  /** The same route walked no faster than the planning pace. */
  planWalkTime: number
  /** Whole EVA with model walking time: walking plus time at the targets. */
  evaSeconds: number
  /** Whole EVA with planning-pace walking time. The 8-hour limit is applied to this one. */
  planEvaSeconds: number
  energyKcal: number
  /** Background dose over the model EVA duration, mSv. A simplified estimate (see backgroundDoseMsv). */
  doseMsv: number
  /** The same over the planning EVA duration. A second scenario, not an upper bound. */
  planDoseMsv: number
  ascent: number
  descent: number
  exposure: Exposure | null
  checks: Check[] | null
  reason: string
}

export function summarise(plan: Plan | null, input: PlanInput, stopMinutes: number): ModeSummary | null {
  if (!plan) return null
  const feasible = !plan.error
  const targets = Math.max(input.points.length - 1, 0)
  const evaSeconds = plan.walkTime + targets * stopMinutes * 60
  // The mission limits are judged on the planning-pace figures: EVA duration and the way back alike.
  const planEvaSeconds = plan.planWalkTime + targets * stopMinutes * 60
  const checks = feasible ? buildChecks({ evaSeconds: planEvaSeconds, walkBack: plan.walkBack, returnDistanceM: returnLimitsOf(input).distance_m }) : null
  const verdict = missionVerdict(true, feasible, checks)
  const failed = checks?.filter((c) => !c.ok) ?? []
  return {
    mode: plan.mode,
    verdict,
    feasible,
    distance: plan.distance,
    walkTime: plan.walkTime,
    planWalkTime: plan.planWalkTime,
    evaSeconds,
    planEvaSeconds,
    energyKcal: (plan.energyPerKg * input.massKg + plan.energyFixed) / 4184,
    doseMsv: backgroundDoseMsv(evaSeconds),
    planDoseMsv: backgroundDoseMsv(planEvaSeconds),
    ascent: plan.ascent,
    descent: plan.descent,
    exposure: plan.exposure,
    checks,
    reason: !feasible ? (plan.error ?? '') : failed.length ? failed.map((c) => c.label).join('; ') : `EVA ${fmtDur(evaSeconds)}`,
  }
}
