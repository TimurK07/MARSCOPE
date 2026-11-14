import { useCallback, useMemo, useRef, useState } from 'react'
import { EVA, MAX_SLOPE_DEG, RADIATION, surfaceDistanceM } from '../lib/model'
import { findLeg, type LegResult, type RouteLeg, type RouteSample } from '../lib/router'
import type { LatLon, Terrain } from '../lib/terrain'

export interface Plan {
  legs: RouteLeg[]
  error: string | null
  samples: RouteSample[]
  legStarts: number[]
  distance: number
  walkTime: number
  ascent: number
  descent: number
  maxSlope: number
  energyPerKg: number
  energyFixed: number
  farthest: number
}

export interface Check {
  id: string
  label: string
  value: string
  limit: string
  ok: boolean
}

export const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`)
export const fmtDur = (s: number) => {
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`
}
export const fmtLat = (lat: number) => `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}`
export const fmtLon = (lon: number) => `${lon.toFixed(4)}°E`
export const fmtCoord = (p: LatLon) => `${fmtLat(p.lat)} ${fmtLon(p.lon)}`

const HISTORY_LIMIT = 50

/** EVA plan state: checkpoints with undo, mission parameters, route and safety checks. */
export function usePlan(terrain: Terrain | null) {
  const [state, setState] = useState<{ points: LatLon[]; history: LatLon[][] }>({ points: [], history: [] })
  const points = state.points
  const [roundTrip, setRoundTrip] = useState(true)
  const [stopMinutes, setStopMinutes] = useState(20)
  const [massKg, setMassKg] = useState(180)

  /** Replace the checkpoint list, remembering the previous one for undo. */
  const setPoints = useCallback((next: LatLon[] | ((prev: LatLon[]) => LatLon[])) => {
    setState((s) => ({
      points: typeof next === 'function' ? next(s.points) : next,
      history: [...s.history.slice(-HISTORY_LIMIT + 1), s.points],
    }))
  }, [])

  const undo = useCallback(() => {
    setState((s) =>
      s.history.length === 0 ? s : { points: s.history[s.history.length - 1], history: s.history.slice(0, -1) },
    )
  }, [])

  // Route legs, cached so editing one checkpoint only recomputes its legs.
  const legCache = useRef(new Map<string, LegResult>())
  const plan = useMemo<Plan | null>(() => {
    if (!terrain || points.length < 2) return null
    const seq = roundTrip ? [...points, points[0]] : points
    const legs: RouteLeg[] = []
    let error: string | null = null
    for (let i = 0; i < seq.length - 1; i++) {
      const key = `${seq[i].lat},${seq[i].lon}>${seq[i + 1].lat},${seq[i + 1].lon}`
      let res = legCache.current.get(key)
      if (!res) {
        res = findLeg(terrain, seq[i], seq[i + 1])
        legCache.current.set(key, res)
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
    return {
      legs,
      error,
      samples,
      legStarts,
      distance: dist,
      walkTime: time,
      ascent: legs.reduce((a, l) => a + l.ascent, 0),
      descent: legs.reduce((a, l) => a + l.descent, 0),
      maxSlope: legs.reduce((a, l) => Math.max(a, l.maxSlope), 0),
      energyPerKg: legs.reduce((a, l) => a + l.energyPerKg, 0),
      energyFixed: legs.reduce((a, l) => a + l.energyFixed, 0),
      farthest,
    }
  }, [terrain, points, roundTrip])

  const targets = Math.max(points.length - 1, 0)
  const evaSeconds = plan ? plan.walkTime + targets * stopMinutes * 60 : 0
  const evaHours = evaSeconds / 3600
  const doseMsv = (RADIATION.doseEquivalent_mSv_per_day * evaSeconds) / 86400
  const energyKcal = plan ? (plan.energyPerKg * massKg + plan.energyFixed) / 4184 : 0

  const checks: Check[] | null =
    plan && !plan.error
      ? [
          {
            id: 'duration',
            label: 'EVA duration',
            value: fmtDur(evaSeconds),
            limit: `≤ ${EVA.maxDuration_h} h`,
            ok: evaHours <= EVA.maxDuration_h,
          },
          {
            id: 'range',
            label: 'Farthest point from habitat',
            value: fmtKm(plan.farthest),
            limit: `≤ ${EVA.walkRadius_km} km`,
            ok: plan.farthest / 1000 <= EVA.walkRadius_km,
          },
          {
            id: 'slope',
            label: 'Steepest terrain on route',
            value: `${plan.maxSlope.toFixed(1)}°`,
            limit: `≤ ${MAX_SLOPE_DEG}°`,
            ok: plan.maxSlope <= MAX_SLOPE_DEG,
          },
        ]
      : null
  const go = checks ? checks.every((c) => c.ok) : false

  return {
    points,
    setPoints,
    undo,
    canUndo: state.history.length > 0,
    roundTrip,
    setRoundTrip,
    stopMinutes,
    setStopMinutes,
    massKg,
    setMassKg,
    plan,
    checks,
    go,
    evaSeconds,
    doseMsv,
    energyKcal,
  }
}

export type PlanState = ReturnType<typeof usePlan>
