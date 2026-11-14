import { useCallback, useEffect, useRef, useState } from 'react'
import BottomDock, { DOCK_DEFAULT_H, DockContent, type DockTab } from './components/BottomDock'
import DataPane from './components/DataPanel'
import MapView, { type HoverInfo, type LayerState, type MapHandle } from './components/MapView'
import MissionPanel, { MissionHead, verdictOf } from './components/MissionPanel'
import MobileSheet, { SHEET_PEEK_H, sheetHeights, type SheetSnap, type SheetTab } from './components/MobileSheet'
import Onboarding from './components/Onboarding'
import ToolRail, { RAIL_PANES, type RailPane } from './components/ToolRail'
import { Icon, Segmented } from './components/ui'
import { useMediaQuery } from './hooks/useMediaQuery'
import { fmtDur, fmtKm, fmtLat, fmtLon, usePlan } from './hooks/usePlan'
import { TILE_LAYERS, THEMIS_DAY } from './lib/layers'
import { surfaceDistanceM } from './lib/model'
import { fetchLatestWeather, fetchRoverTrack, type RoverStop, type RoverTrack, type WeatherSol } from './lib/nasa'
import type { HazardMode } from './lib/overlays'
import type { RouteSample } from './lib/router'
import { loadTerrain, type LatLon, type Terrain } from './lib/terrain'
import './styles/base.css'
import './styles/shell.css'
import './styles/map.css'
import './styles/data.css'
import './styles/mission.css'
import './styles/dock.css'
import './styles/briefing.css'
import './styles/mobile.css'

const BRIEFED_KEY = 'marscope.briefed'
const REGIONAL_ZOOM = THEMIS_DAY.maxUsefulZoom ?? 11

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

  // Map layers
  const [tiles, setTiles] = useState(initialTiles)
  const [hazard, setHazard] = useState<LayerState & { mode: HazardMode }>({ on: true, opacity: 0.65, mode: 'hazards' })
  const [elevation, setElevation] = useState<LayerState>({ on: false, opacity: 0.55 })
  const [contours, setContours] = useState<LayerState>({ on: false, opacity: 0.8 })
  const [showTrack, setShowTrack] = useState(true)

  // Map interaction
  const [zoom, setZoom] = useState(13)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [cursor, setCursor] = useState<RouteSample | null>(null)
  const [inspect, setInspect] = useState<LatLon | null>(null)
  const [stop, setStop] = useState<RoverStop | null>(null)

  // Workspace chrome
  const isMobile = useMediaQuery('(max-width: 760px)')
  const [briefing, setBriefing] = useState(() => !wasBriefed())
  const [toast, setToast] = useState<Toast | null>(null)
  const [railPane, setRailPane] = useState<RailPane | null>(null)
  const [dockTab, setDockTab] = useState<DockTab>('profile')
  const [dockOpen, setDockOpen] = useState(false)
  const [dockH, setDockH] = useState(DOCK_DEFAULT_H)
  const [sheetTab, setSheetTab] = useState<SheetTab>('mission')
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('peek')

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

  // Crossing the mobile breakpoint changes the map's shape: fit the study area again.
  useEffect(() => {
    const timer = setTimeout(() => map.current?.fitSite(), 80)
    return () => clearTimeout(timer)
  }, [isMobile])

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
        if (briefing) dismissBriefing()
        else if (railPane) setRailPane(null)
        else setInspect(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, briefing, railPane, dismissBriefing])

  /** Bring one of the detail views forward: dock tab on desktop, sheet tab on mobile. */
  const showDetail = (t: DockTab, reveal?: LatLon) => {
    setDockTab(t)
    setDockOpen(true)
    setSheetTab(t)
    if (isMobile) {
      setSheetSnap((s) => (s === 'peek' ? 'half' : s))
      // Keep the point visible above the half-height sheet.
      if (reveal) setTimeout(() => map.current?.reveal(reveal, sheetHeights().half - SHEET_PEEK_H), 60)
    }
  }

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
    setDockTab('profile')
    setDockOpen(true)
    setSheetTab('mission')
    map.current?.fitSite()
  }

  const setHabitat = (p: LatLon) => {
    setPoints((prev) => (prev.length === 0 ? [p] : [p, ...prev.slice(1)]))
    setInspect(null)
    if (isMobile) {
      setSheetTab('mission')
      setSheetSnap('peek')
    }
  }
  const addTarget = (p: LatLon) => {
    setPoints((prev) => [...prev, p])
    setInspect(null)
    setDockTab('profile')
    if (isMobile) {
      setSheetTab('mission')
      setSheetSnap('peek')
    }
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
  const layerCount =
    TILE_LAYERS.filter((d) => tiles[d.id].on).length + [hazard, elevation, contours].filter((l) => l.on).length
  const route = plan.plan && !plan.plan.error ? plan.plan : null
  const failed = plan.checks?.filter((c) => !c.ok) ?? []

  const dataProps = {
    terrain,
    zoom,
    tiles,
    setTile: (id: string, s: LayerState) => setTiles((prev) => ({ ...prev, [id]: s })),
    hazard,
    setHazard,
    elevation,
    setElevation,
    contours,
    setContours,
    showTrack,
    setShowTrack,
    weather,
    rover,
    onFitCrater: () => map.current?.fitCrater(),
    onFitSite: () => map.current?.fitSite(),
  }
  const detailProps = {
    terrain,
    plan,
    onCursor: setCursor,
    inspect,
    onSetHabitat: () => inspect && setHabitat(inspect),
    onAddTarget: () => inspect && addTarget(inspect),
    onClearInspect: () => setInspect(null),
    stop,
    onClearStop: () => setStop(null),
  }
  const missionProps = {
    plan,
    onLoadExample: loadExample,
    canLoadExample: !!track,
    onRemove: removePoint,
    onMove: reorder,
    onClear: clearPlan,
  }

  return (
    <div className={`ws ${isMobile ? 'is-mobile' : ''}`}>
      {!isMobile && (
        <ToolRail
          active={railPane}
          onSelect={setRailPane}
          layerCount={layerCount}
          canUndo={canUndo}
          onUndo={undo}
          onHelp={() => setBriefing(true)}
        />
      )}

      <div className="work">
        <header className="topbar">
          <h1 className="wordmark">MARSCOPE</h1>
          <p className="topbar-site">
            <b>Marswalk planner</b> · Mount Sharp, Gale crater
          </p>
          <div className="topbar-tools">
            <Segmented
              label="Map extent"
              value={view}
              onChange={(v) => (v === 'site' ? map.current?.fitSite() : map.current?.fitCrater())}
              options={[
                { value: 'site', label: 'Study area' },
                { value: 'crater', label: 'Gale crater' },
              ]}
            />
            <div className="zoom">
              <button type="button" onClick={() => map.current?.zoomOut()} aria-label="Zoom out">
                <Icon name="minus" size={14} />
              </button>
              <button type="button" onClick={() => map.current?.zoomIn()} aria-label="Zoom in">
                <Icon name="plus" size={14} />
              </button>
            </div>
            {isMobile && (
              <>
                <button type="button" className="icon-btn" aria-label="Undo last plan edit" disabled={!canUndo} onClick={undo}>
                  <Icon name="undo" />
                </button>
                <button type="button" className="icon-btn" aria-label="Show mission briefing" onClick={() => setBriefing(true)}>
                  <Icon name="help" />
                </button>
              </>
            )}
          </div>
        </header>

        <div className="stage">
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
              setRailPane(null)
              showDetail('point', p)
            }}
            onStopClick={(s) => {
              setStop(s)
              setInspect({ lat: s.lat, lon: s.lon })
              setRailPane(null)
              showDetail('surface', s)
            }}
            onHover={setHover}
            onZoom={setZoom}
            onMovePoint={movePoint}
          />

          {railPane && !isMobile && (
            <aside className="flyout" aria-label={RAIL_PANES.find((p) => p.id === railPane)!.label}>
              <header className="flyout-head">
                <h2>{RAIL_PANES.find((p) => p.id === railPane)!.label}</h2>
                <button type="button" className="icon-btn" onClick={() => setRailPane(null)} aria-label="Close pane">
                  <Icon name="close" size={16} />
                </button>
              </header>
              <div className="flyout-body">
                <DataPane pane={railPane} {...dataProps} />
              </div>
            </aside>
          )}

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
        </div>

        {!isMobile && (
          <BottomDock
            tab={dockTab}
            onTab={setDockTab}
            open={dockOpen}
            onOpen={setDockOpen}
            height={dockH}
            onHeight={setDockH}
            cursor={cursor}
            {...detailProps}
          />
        )}

        {!isMobile && (
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
            <ul className="status-key" aria-label="Map key">
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
          </footer>
        )}
      </div>

      {!isMobile ? (
        <aside className="mission" aria-label="Mission planning">
          <MissionHead plan={plan} />
          <div className="mission-scroll">
            <MissionPanel {...missionProps} />
          </div>
        </aside>
      ) : (
        <MobileSheet
          plan={plan}
          snap={sheetSnap}
          onSnap={setSheetSnap}
          tab={sheetTab}
          onTab={setSheetTab}
          marked={{ point: !!inspect, profile: !!route, surface: !!stop, mission: plan.points.length > 0 }}
        >
          {sheetTab === 'mission' && (
            <>
              {verdictOf(plan) === 'nogo' && (
                <div className="sheet-fail">
                  <ul className="m-fail">
                    {failed.map((c) => (
                      <li key={c.id}>
                        <span>{c.label}</span>
                        <code>
                          {c.value} <i>limit {c.limit.replace('≤ ', '')}</i>
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <MissionHead plan={plan} />
              <MissionPanel {...missionProps} />
            </>
          )}
          {sheetTab === 'layers' && RAIL_PANES.map((p) => <DataPane key={p.id} pane={p.id} {...dataProps} />)}
          {sheetTab === 'profile' && route && (
            <p className="sheet-read">
              {cursor ? (
                <>
                  <span>
                    <b>DIST</b>
                    {fmtKm(cursor.dist)}
                  </span>
                  <span>
                    <b>TIME</b>
                    {fmtDur(cursor.time)}
                  </span>
                  <span>
                    <b>ELEV</b>
                    {cursor.elevation.toFixed(0)} m
                  </span>
                  <span>
                    <b>SLOPE</b>
                    {cursor.slope.toFixed(1)}°
                  </span>
                </>
              ) : (
                'Drag along the profile to trace the route on the map.'
              )}
            </p>
          )}
          {(sheetTab === 'point' || sheetTab === 'profile' || sheetTab === 'surface') && <DockContent tab={sheetTab} {...detailProps} />}
        </MobileSheet>
      )}

      {briefing && <Onboarding onStart={dismissBriefing} onExample={loadExample} canExample={!!track} hasPlan={plan.points.length > 0} />}
    </div>
  )
}
