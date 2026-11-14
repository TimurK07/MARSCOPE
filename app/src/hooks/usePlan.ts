import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RADIATION } from '../lib/model'
import type { RouteMode } from '../lib/objectives'
import { ROUTE_MODES } from '../lib/objectives'
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
    const input: PlanInput = { points, roundTrip, massKg }
    setPending(true)
    s.request(input, modeRef.current)
  }, [serviceReady, points, roundTrip, massKg])

  // A result is shown only for the checkpoints it was computed for.
  const fresh = result && result.input.points === points ? result : null
  const plan: Plan | null = fresh?.plans[mode] ?? null

  const comparison = useMemo(() => {
    const out = {} as Record<RouteMode, ModeSummary | null>
    for (const m of ROUTE_MODES) out[m.id] = fresh ? summarise(fresh.plans[m.id], fresh.input, stopMinutes) : null
    return out
  }, [fresh, stopMinutes])

  const selected = comparison[mode]
  const evaSeconds = selected?.evaSeconds ?? 0
  const doseMsv = (RADIATION.doseEquivalent_mSv_per_day * evaSeconds) / 86400
  const energyKcal = plan ? (plan.energyPerKg * massKg + plan.energyFixed) / 4184 : 0
  // Mission-level checks apply only to a feasible route, and are the same for every priority.
  const checks = selected?.checks ?? null
  const go = selected?.verdict === 'go'

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
    mode,
    setMode,
    /** True while routes for the current checkpoints are still being computed. */
    pending: pending && points.length >= 2,
    plan,
    comparison,
    checks,
    go,
    evaSeconds,
    doseMsv,
    energyKcal,
  }
}

export type PlanState = ReturnType<typeof usePlan>
