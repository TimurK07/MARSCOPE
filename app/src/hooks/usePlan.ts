import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteMode } from '../lib/objectives'
import { ROUTE_MODES } from '../lib/objectives'
import { clampReturnDistance, RETURN_DISTANCE_RANGE } from '../lib/model'
import { summarise, type ModeSummary, type Plan, type PlanInput } from '../lib/planner'
import { PlanService, type PlanUpdate, type WorkerLike } from '../lib/planService'
import type { LatLon, Terrain } from '../lib/terrain'

export type { Check } from '../lib/mission'
export type { Plan } from '../lib/planner'

export { fmtCoord, fmtDur, fmtKm, fmtLat, fmtLon } from '../lib/format'

const HISTORY_LIMIT = 50

/**
 * EVA plan state: checkpoints with undo, mission parameters, the routes for all
 * three priorities and the safety checks of the selected one.
 *
 * Routes come from a PlanService: a Web Worker when available, the main thread
 * otherwise. Only the answer to the latest request is used, so quick edits can
 * never leave an outdated route on screen.
 */
export function usePlan(terrain: Terrain | null) {
  const [state, setState] = useState<{ points: LatLon[]; history: LatLon[][] }>({ points: [], history: [] })
  const points = state.points
  const [roundTrip, setRoundTrip] = useState(true)
  const [stopMinutes, setStopMinutes] = useState(20)
  const [massKg, setMassKg] = useState(180)
  // Longest acceptable way back, metres. A planning assumption the user can set; 2 km by default.
  const [returnDistanceM, setReturnDistanceRaw] = useState(RETURN_DISTANCE_RANGE.default_m)
  const setReturnDistanceM = useCallback((m: number) => setReturnDistanceRaw(clampReturnDistance(m)), [])
  const [mode, setMode] = useState<RouteMode>('fastest')
  const [result, setResult] = useState<PlanUpdate | null>(null)
  const [pending, setPending] = useState(false)
  const modeRef = useRef(mode)
  modeRef.current = mode

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

  const service = useRef<PlanService | null>(null)
  const [serviceReady, setServiceReady] = useState(0)

  // One planning service per terrain.
  useEffect(() => {
    if (!terrain) return
    const s = new PlanService({
      terrain,
      createWorker: () =>
        new Worker(new URL('../lib/planner.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
      onUpdate: (u) => {
        setResult(u)
        if (u.done) setPending(false)
      },
    })
    service.current = s
    setServiceReady((n) => n + 1)
    return () => {
      s.dispose()
      service.current = null
    }
  }, [terrain])

  // Ask for new routes whenever something that shapes them changes.
  useEffect(() => {
    const s = service.current
    if (!s) return
    if (points.length < 2) {
      s.cancel()
      setResult(null)
      setPending(false)
      return
    }
    const input: PlanInput = { points, roundTrip, massKg, returnDistanceM }
    setPending(true)
    s.request(input, modeRef.current)
  }, [serviceReady, points, roundTrip, massKg, returnDistanceM])

  // A result is shown only for the checkpoints it was computed for.
  // ...and for the return limit it was checked against: a verdict for another limit is never shown.
  // ...and for the same round trip and carried mass: both shape the routes, so a result for other
  // values is an old one and is not shown as current while the new one is being calculated.
  const fresh =
    result &&
    result.input.points === points &&
    result.input.returnDistanceM === returnDistanceM &&
    result.input.roundTrip === roundTrip &&
    result.input.massKg === massKg
      ? result
      : null
  const plan: Plan | null = fresh?.plans[mode] ?? null

  const comparison = useMemo(() => {
    const out = {} as Record<RouteMode, ModeSummary | null>
    for (const m of ROUTE_MODES) out[m.id] = fresh ? summarise(fresh.plans[m.id], fresh.input, stopMinutes) : null
    return out
  }, [fresh, stopMinutes])

  const selected = comparison[mode]
  const evaSeconds = selected?.evaSeconds ?? 0
  const planEvaSeconds = selected?.planEvaSeconds ?? 0
  // Background dose for each of the two EVA durations, by the same rate and formula.
  const doseMsv = selected?.doseMsv ?? 0
  const planDoseMsv = selected?.planDoseMsv ?? 0
  const energyKcal = plan ? (plan.energyPerKg * massKg + plan.energyFixed) / 4184 : 0
  // Mission-level checks apply only to a feasible route, and are the same for every priority.
  const checks = selected?.checks ?? null
  const go = selected?.verdict === 'go'
  const verdict = selected?.verdict ?? 'standby'

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
    /** Return distance limit in metres, and whether it is the default. */
    returnDistanceM,
    setReturnDistanceM,
    returnDistanceIsDefault: returnDistanceM === RETURN_DISTANCE_RANGE.default_m,
    mode,
    setMode,
    /** True while routes for the current checkpoints are still being computed. */
    pending: pending && points.length >= 2,
    plan,
    comparison,
    checks,
    go,
    /** Verdict of the selected priority. */
    verdict,
    evaSeconds,
    /** EVA duration at the planning pace: the one the 8-hour limit is judged on. */
    planEvaSeconds,
    doseMsv,
    planDoseMsv,
    energyKcal,
  }
}

export type PlanState = ReturnType<typeof usePlan>
