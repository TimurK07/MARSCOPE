import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { GlobeEngine, type GlobeCallbacks, type GlobeData, type GlobeViewState } from '../lib/globeEngine'
import type { LatLon } from '../lib/terrain'

export interface GlobeHandle {
  getView: () => GlobeViewState | null
  setView: (v: { lat: number; lon: number; zoom: number }, aligned?: boolean) => void
  setLocalFocus: (dx: number, dy: number) => void
  lockFocus: (on: boolean) => void
  alignFocus: () => Promise<void>
  screenOf: (p: LatLon) => { x: number; y: number } | null
  flyTo: (v: { lat: number; lon: number; zoom: number }, ms?: number) => Promise<boolean>
  flyToOverview: (center?: LatLon) => Promise<boolean>
  whenSettled: (timeoutMs: number) => Promise<void>
  setActive: (active: boolean) => void
  zoomStep: (direction: 1 | -1) => void
}

interface Props extends GlobeCallbacks {
  data: GlobeData
  lowPower: boolean
  /** Called when WebGL cannot be started. */
  onUnavailable: () => void
  onReady: () => void
}

/** The 3D Mars globe. This module pulls in three.js, so it is loaded lazily. */
const GlobeView = forwardRef<GlobeHandle, Props>(function GlobeView(props, ref) {
  const el = useRef<HTMLDivElement>(null)
  const engine = useRef<GlobeEngine | null>(null)
  const cb = useRef(props)
  cb.current = props

  useEffect(() => {
    let e: GlobeEngine
    try {
      e = new GlobeEngine(
        el.current!,
        {
          onView: (v) => cb.current.onView(v),
          onPick: (p) => cb.current.onPick(p),
          onHover: (p) => cb.current.onHover(p),
          onFloor: (c, z) => cb.current.onFloor(c, z),
          onMissionClick: () => cb.current.onMissionClick(),
          onLoading: (b) => cb.current.onLoading(b),
        },
        { lowPower: props.lowPower, baseTextureUrl: `${import.meta.env.BASE_URL}data/mars/viking_mdim21_2048.jpg` },
      )
    } catch {
      cb.current.onUnavailable()
      return
    }
    engine.current = e
    // Development aid for inspecting the renderer from the console.
    if (import.meta.env.DEV) (window as unknown as { __globe?: GlobeEngine }).__globe = e
    e.setData(cb.current.data)
    cb.current.onReady()
    return () => {
      engine.current = null
      e.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    engine.current?.setData(props.data)
  }, [props.data])

  useImperativeHandle(ref, () => ({
    getView: () => engine.current?.getView() ?? null,
    setView: (v, aligned) => engine.current?.setView(v, aligned),
    setLocalFocus: (dx, dy) => engine.current?.setLocalFocus(dx, dy),
    lockFocus: (on) => engine.current?.lockFocus(on),
    alignFocus: () => engine.current?.alignFocus() ?? Promise.resolve(),
    screenOf: (p) => engine.current?.screenOf(p) ?? null,
    flyTo: (v, ms) => engine.current?.flyTo(v, ms) ?? Promise.resolve(false),
    flyToOverview: (c) => engine.current?.flyToOverview(c) ?? Promise.resolve(false),
    whenSettled: (ms) => engine.current?.whenSettled(ms) ?? Promise.resolve(),
    setActive: (a) => engine.current?.setActive(a),
    zoomStep: (d) => engine.current?.zoomStep(d),
  }))

  return <div ref={el} className="globe" />
})

export default GlobeView
