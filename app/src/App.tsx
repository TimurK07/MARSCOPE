import { useCallback, useEffect, useRef, useState } from 'react'
import DataPanel from './components/DataPanel'
import Inspector from './components/Inspector'
import MapView, { type HoverInfo, type LayerState, type MapHandle } from './components/MapView'
import MissionPanel from './components/MissionPanel'
import Onboarding from './components/Onboarding'
import SurfaceDrawer from './components/SurfaceDrawer'
import { Segmented } from './components/ui'
import { fmtLat, fmtLon, usePlan } from './hooks/usePlan'
import { TILE_LAYERS, THEMIS_DAY } from './lib/layers'
import { surfaceDistanceM } from './lib/model'
import { fetchLatestWeather, fetchRoverTrack, type RoverStop, type RoverTrack, type WeatherSol } from './lib/nasa'
import type { HazardMode } from './lib/overlays'
import type { RouteSample } from './lib/router'
import { loadTerrain, type LatLon, type Terrain } from './lib/terrain'
import './App.css'

const BRIEFED_KEY = 'marscope.briefed'
const REGIONAL_ZOOM = THEMIS_DAY.maxUsefulZoom ?? 11.5

const initialTiles = (): Record<string, LayerState> =>
  Object.fromEntries(TILE_LAYERS.map((d) => [d.id, { on: d.defaultOn, opacity: d.defaultOpacity }]))

function wasBriefed(): boolean {
  try {
    return localStorage.getItem(BRIEFED_KEY) === '1'
  } catch {
    return false
  }
}

interface Toast {
  id: number
  text: string
  undo: boolean
}

export default function App() {
  const [terrain, setTerrain] = useState<Terrain | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [track, setTrack] = useState<RoverTrack | null>(null)
  const [weather, setWeather] = useState<WeatherSol | null | 'loading'>('loading')

  const [tiles, setTiles] = useState(initialTiles)
  const [hazard, setHazard] = useState<LayerState & { mode: HazardMode }>({ on: true, opacity: 0.65, mode: 'hazards' })
  const [elevation, setElevation] = useState<LayerState>({ on: false, opacity: 0.55 })
  const [contours, setContours] = useState<LayerState>({ on: false, opacity: 0.8 })
  const [showTrack, setShowTrack] = useState(true)

  const [zoom, setZoom] = useState(13)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [cursor, setCursor] = useState<RouteSample | null>(null)
  const [inspect, setInspect] = useState<LatLon | null>(null)
  const [stop, setStop] = useState<RoverStop | null>(null)
  const [briefing, setBriefing] = useState(() => !wasBriefed())
  const [toast, setToast] = useState<Toast | null>(null)
  const [tab, setTab] = useState<'plan' | 'data'>('plan')
  const [drawer, setDrawer] = useState(false)

  const plan = usePlan(terrain)
  const map = useRef<MapHandle>(null)

  useEffect(() => {
    loadTerrain().then(setTerrain, (e) => setLoadError(String(e)))
    fetchRoverTrack().then(setTrack, () => setTrack(null))
    fetchLatestWeather().then(setWeather, () => setWeather(null))
  }, [])

  const notify = useCallback((text: string, undo = true) => setToast({ id: Date.now(), text, undo }), [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  const dismissBriefing = useCallback(() => {
    setBriefing(false)
    try {
      localStorage.setItem(BRIEFED_KEY, '1')
    } catch {
      // Private mode: the briefing simply shows again next visit.
    }
  }, [])

  const { setPoints, undo, canUndo } = plan

  // Keyboard: undo and escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        undo()
      }
      if (e.key === 'Escape') {
        setInspect(null)
        setDrawer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo])

  const loadExample = () => {
    if (!track || !terrain) return
    const { west, south, east, north } = terrain.meta.bbox
    const inside = track.stops.filter((s) => s.lon > west && s.lon < east && s.lat > south && s.lat < north)
    const now = inside[inside.length - 1]
    if (!now) return
    // Two earlier Curiosity stops, roughly 350 m and 700 m away from the rover.
    const pick = (want: number) =>
      inside.reduce((best, s) =>
        Math.abs(surfaceDistanceM(now, s) - want) < Math.abs(surfaceDistanceM(now, best) - want) ? s : best,
      )
    setPoints([now, pick(350), pick(700)].map((s) => ({ lat: s.lat, lon: s.lon })))
    plan.setRoundTrip(true)
    setInspect(null)
    dismissBriefing()
    map.current?.fitSite()
  }

  const setHabitat = (p: LatLon) => {
    setPoints((prev) => (prev.length === 0 ? [p] : [p, ...prev.slice(1)]))
    setInspect(null)
  }
  const addTarget = (p: LatLon) => {
    setPoints((prev) => [...prev, p])
    setInspect(null)
  }
  const removePoint = (i: number) => {
    setPoints((prev) => prev.filter((_, j) => j !== i))
    notify(i === 0 ? 'Habitat removed.' : `Target ${i} removed.`)
  }
  const reorder = (i: number, dir: -1 | 1) => {
    setPoints((prev) => {
      const next = [...prev]
      const j = i + dir
      if (j < 1 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  const movePoint = (i: number, p: LatLon) => {
    setPoints((prev) => prev.map((q, j) => (j === i ? p : q)))
    notify(i === 0 ? 'Habitat moved.' : `Target ${i} moved.`)
  }
  const clearPlan = () => {
    setPoints([])
    notify('Plan cleared.')
  }

  if (loadError) return <div className="boot">Could not load terrain data: {loadError}</div>
  if (!terrain) return <div className="boot">Loading Mount Sharp terrain…</div>

  const rover = track?.stops[track.stops.length - 1] ?? null
  const view = zoom <= REGIONAL_ZOOM ? 'crater' : 'site'
  const verdict = !plan.plan ? 'standby' : plan.plan.error ? 'noroute' : plan.go ? 'go' : 'nogo'
  const verdictShort = { standby: 'STANDBY', noroute: 'NO ROUTE', go: 'GO', nogo: 'NO-GO' }[verdict]

  return (
    <div className="shell" data-tab={tab} data-drawer={drawer ? 'open' : 'closed'}>
      <aside className="panel panel-data" aria-label="Scientific data">
        <header className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <h1>MARSCOPE</h1>
            <p>Marswalk mission planner</p>
          </div>
          <button type="button" className="icon-btn drawer-close" onClick={() => setDrawer(false)} aria-label="Close data panel">
            ✕
          </button>
        </header>
        <div className="panel-title">
          <h2>Scientific data</h2>
          <code>Mount Sharp · Gale</code>
        </div>
        <div className="panel-scroll">
          <DataPanel
            terrain={terrain}
            zoom={zoom}
            tiles={tiles}
            setTile={(id, s) => setTiles((prev) => ({ ...prev, [id]: s }))}
            hazard={hazard}
            setHazard={setHazard}
            elevation={elevation}
            setElevation={setElevation}
            contours={contours}
            setContours={setContours}
            showTrack={showTrack}
            setShowTrack={setShowTrack}
            weather={weather}
            rover={rover}
            onFitCrater={() => map.current?.fitCrater()}
            onFitSite={() => map.current?.fitSite()}
          />
        </div>
      </aside>

      <main className="stage">
        <MapView
          ref={map}
          terrain={terrain}
          tiles={tiles}
          hazard={hazard}
          elevation={elevation}
          contours={contours}
          showTrack={showTrack}
          track={track}
          points={plan.points}
          legs={plan.plan?.legs ?? []}
          selectedSol={stop?.sol ?? null}
          cursor={cursor}
          inspect={inspect}
          onInspect={(p) => {
            setInspect(p)
            if (briefing) dismissBriefing()
          }}
          onStopClick={(s) => {
            setStop(s)
            setInspect({ lat: s.lat, lon: s.lon })
          }}
          onHover={setHover}
          onZoom={setZoom}
          onMovePoint={movePoint}
        />

        <div className="map-top">
          <div className="toolbar">
            <button type="button" className="btn tool-data" onClick={() => setDrawer(true)}>
              Data layers
            </button>
            <Segmented
              label="Map extent"
              value={view}
              onChange={(v) => (v === 'site' ? map.current?.fitSite() : map.current?.fitCrater())}
              options={[
                { value: 'site', label: 'Study area' },
                { value: 'crater', label: 'Gale crater' },
              ]}
            />
          </div>
          <div className="zoom">
            <button type="button" onClick={() => map.current?.zoomIn()} aria-label="Zoom in">
              +
            </button>
            <button type="button" onClick={() => map.current?.zoomOut()} aria-label="Zoom out">
              −
            </button>
          </div>
        </div>

        {inspect && !briefing && (
          <Inspector
            terrain={terrain}
            point={inspect}
            habitat={plan.points[0] ?? null}
            targetCount={Math.max(plan.points.length - 1, 0)}
            onSetHabitat={() => setHabitat(inspect)}
            onAddTarget={() => addTarget(inspect)}
            onClose={() => setInspect(null)}
          />
        )}

        {briefing && plan.points.length === 0 && (
          <Onboarding onStart={dismissBriefing} onExample={loadExample} canExample={!!track} />
        )}

        <ul className="map-key" aria-label="Map key">
          <li>
            <i className="key-route" />
            Planned route
          </li>
          {showTrack && (
            <li>
              <i className="key-track" />
              Curiosity traverse
            </li>
          )}
          {hazard.on && (
            <li>
              <i className="key-nogo" />
              No-go slope
            </li>
          )}
        </ul>

        {stop && <SurfaceDrawer stop={stop} onClose={() => setStop(null)} />}

        {toast && (
          <div className="toast" role="status" key={toast.id}>
            <span>{toast.text}</span>
            {toast.undo && canUndo && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  undo()
                  setToast(null)
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}

        <footer className="status">
          {hover ? (
            <>
              <span>
                <b>LAT</b>
                {fmtLat(hover.lat)}
              </span>
              <span>
                <b>LON</b>
                {fmtLon(hover.lon)}
              </span>
              <span>
                <b>ELEV</b>
                {hover.elevation != null ? `${hover.elevation.toFixed(0)} m` : '—'}
              </span>
              <span>
                <b>SLOPE</b>
                {hover.slope != null && !Number.isNaN(hover.slope) ? `${hover.slope.toFixed(1)}°` : '—'}
              </span>
            </>
          ) : (
            <span className="status-hint">
              {plan.points.length === 0
                ? 'Click the map to inspect a location and set the habitat.'
                : 'Click the map to inspect a location. Drag checkpoints to move them.'}
            </span>
          )}
        </footer>
      </main>

      <aside className="panel panel-mission" aria-label="Mission planning">
        <div className="panel-title">
          <h2>Mission planning</h2>
          <code>Surface EVA</code>
        </div>
        <div className="panel-scroll">
          <MissionPanel
            plan={plan}
            cursor={cursor}
            onCursor={setCursor}
            onLoadExample={loadExample}
            canLoadExample={!!track}
            onRemove={removePoint}
            onMove={reorder}
            onClear={clearPlan}
          />
        </div>
      </aside>

      <nav className="tabs" aria-label="Panels">
        <button type="button" aria-pressed={tab === 'plan'} onClick={() => setTab('plan')}>
          Mission <span className={`chip chip-${verdict}`}>{verdictShort}</span>
        </button>
        <button type="button" aria-pressed={tab === 'data'} onClick={() => setTab('data')}>
          Data layers
        </button>
      </nav>
      <div className="scrim" onClick={() => setDrawer(false)} />
    </div>
  )
}
