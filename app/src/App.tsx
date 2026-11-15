import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BottomDock, { DOCK_DEFAULT_H, DockContent, type DockTab } from './components/BottomDock'
import DataPane from './components/DataPanel'
import GlobeHud from './components/GlobeHud'
import type { GlobeHandle } from './components/GlobeView'
import MapView, { type HoverInfo, type LayerState, type MapHandle } from './components/MapView'
import MissionPanel, { MissionHead } from './components/MissionPanel'
import { missionSummary, verdictOf } from './lib/missionStatus'
import { fitInsets, fitRequestStale, routeBounds, sheetCover, shouldAutoFit, type FitRequest } from './lib/routeFit'
import MobileSheet, { SHEET_PEEK_H, sheetHeights, type SheetSnap, type SheetTab } from './components/MobileSheet'
import Onboarding from './components/Onboarding'
import RouteOverlay from './components/RouteOverlay'
import ToolRail, { RAIL_PANES, type RailPane } from './components/ToolRail'
import { Icon, Segmented } from './components/ui'
import { useMediaQuery } from './hooks/useMediaQuery'
import { fmtDur, fmtKm, fmtLat, fmtLon, usePlan } from './hooks/usePlan'
import type { BBox } from './lib/globe'
import type { GlobeData, GlobeViewState } from './lib/globeEngine'
import { TILE_LAYERS, THEMIS_DAY } from './lib/layers'
import { surfaceDistanceM } from './lib/model'
import { fetchLatestWeather, fetchRoverTrack, type RoverStop, type RoverTrack, type WeatherSol } from './lib/nasa'
import type { HazardMode } from './lib/overlays'
import { routeDisplay } from './lib/routeDisplay'
import type { RouteSample } from './lib/router'
import { loadTerrain, type LatLon, type Terrain } from './lib/terrain'
import { LOCAL_ENTER_ZOOM, canOpenWorkspaceAt, canStartTransition, focusOffset, shouldAutoEnter, type ViewPhase } from './lib/viewTransition'
import './styles/base.css'
import './styles/shell.css'
import './styles/map.css'
import './styles/data.css'
import './styles/mission.css'
import './styles/dock.css'
import './styles/briefing.css'
import './styles/mobile.css'
import './styles/globe.css'

// three.js stays out of the first bundle.
const GlobeView = lazy(() => import('./components/GlobeView'))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Globe zoom of "Focus on the mission". The globe hands over to the 2D map at LOCAL_ENTER_ZOOM
 * (12.5) only when the user zooms into its floor; a flight to 12.1 stops short of that.
 */
const MISSION_FOCUS_ZOOM = 12.1
/** Duration of the globe cross-fade; matches .globe-wrap in globe.css. */
const FADE_MS = 540

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
  const [hiddenSteep, setHiddenSteep] = useState<LayerState>({ on: false, opacity: 0.85 })
  const [showTrack, setShowTrack] = useState(true)

  // Map interaction
  const [zoom, setZoom] = useState(13)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [cursor, setCursor] = useState<RouteSample | null>(null)
  const [inspect, setInspect] = useState<LatLon | null>(null)
  const [stop, setStop] = useState<RoverStop | null>(null)

  // Workspace chrome
  const isMobile = useMediaQuery('(max-width: 760px)')
  // Between phone and desktop the status bar is too short for the whole map key, so the map carries the route key.
  const narrowKey = useMediaQuery('(max-width: 1180px)')
  const [briefing, setBriefing] = useState(() => !wasBriefed())
  const [toast, setToast] = useState<Toast | null>(null)
  const [railPane, setRailPane] = useState<RailPane | null>(null)
  const [dockTab, setDockTab] = useState<DockTab>('profile')
  const [dockOpen, setDockOpen] = useState(false)
  const [dockH, setDockH] = useState(DOCK_DEFAULT_H)
  const [sheetTab, setSheetTab] = useState<SheetTab>('mission')
  const [sheetSnap, setSheetSnap] = useState<SheetSnap>('peek')

  // Global (3D globe) or local (2D workspace) representation of the same place
  const [view, setView] = useState<'global' | 'local'>(() => (new URLSearchParams(window.location.search).get('view') === '2d' ? 'local' : 'global'))
  const [globeShown, setGlobeShown] = useState(true)
  // "?view=2d" opens straight in the 2D workspace, for machines where WebGL is slow or missing.
  const [globeOk, setGlobeOk] = useState(() => new URLSearchParams(window.location.search).get('view') !== '2d')
  const [globeView, setGlobeView] = useState<GlobeViewState | null>(null)
  const [globeHover, setGlobeHover] = useState<LatLon | null>(null)
  const [globeBusy, setGlobeBusy] = useState(true)
  /** True while the 2D map is being revealed under the globe; its analysis overlays fade in after. */
  const [arriving, setArriving] = useState(false)
  const stageEl = useRef<HTMLDivElement>(null)
  const globeEl = useRef<HTMLDivElement>(null)
  const hudTick = useRef({ view: 0, hover: 0 })
  const phase = useRef<ViewPhase>(new URLSearchParams(window.location.search).get('view') === '2d' ? 'local' : 'global')
  const lastSwitch = useRef(0)

  const plan = usePlan(terrain)
  const map = useRef<MapHandle>(null)
  const globe = useRef<GlobeHandle>(null)

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
    const timer = setTimeout(() => phase.current === 'local' && map.current?.fitSite(), 80)
    return () => clearTimeout(timer)
  }, [isMobile])

  const { setPoints, undo, canUndo } = plan

  /** Set when an example mission is loaded; carried out once, when its route is ready. */
  const fitRequest = useRef<FitRequest | null>(null)
  /**
   * Frames the checkpoints and every leg found, the return included, in the part of the map
   * that is actually visible. Called by the Fit route control and once after an example loads.
   */
  const fitRoute = () => {
    const legs = plan.plan?.legs.map((l) => l.samples) ?? []
    const overlay = stageEl.current?.querySelector<HTMLElement>('.route-overlay')
    const flyout = stageEl.current?.querySelector<HTMLElement>('.flyout')
    return (
      map.current?.fitRoute(
        routeBounds(plan.points, legs),
        fitInsets({
          overlayHeight: overlay?.offsetHeight ?? 0,
          leftPane: flyout?.offsetWidth ?? 0,
          sheetCover: isMobile ? sheetCover(sheetSnap, sheetHeights()) : 0,
        }),
      ) ?? false
    )
  }
  const fitRouteRef = useRef(fitRoute)
  fitRouteRef.current = fitRoute
  const planForFit = plan.plan
  const pointsForFit = plan.points
  // The one automatic fit. It depends on the route only to learn that it has arrived: without a
  // pending request (and only loading an example makes one) a new route never moves the camera,
  // so switching the route priority or changing a limit leaves the view where the user put it.
  useEffect(() => {
    if (fitRequestStale(fitRequest.current, pointsForFit)) fitRequest.current = null
    const ready = shouldAutoFit({
      request: fitRequest.current,
      points: pointsForFit,
      routeReady: !!planForFit && !planForFit.error,
      mapShown: view === 'local' && !arriving,
    })
    if (!ready) return
    // After the layout has settled: loading an example also opens the dock, which resizes the map.
    // The request is dropped only when the fit is made, so a further update in between cannot lose it.
    const timer = setTimeout(() => {
      fitRequest.current = null
      fitRouteRef.current()
    }, 120)
    return () => clearTimeout(timer)
  }, [planForFit, pointsForFit, view, arriving])

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

  const siteCenter = (): LatLon => {
    const b = terrain!.meta.bbox
    return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }
  }

  /**
   * Tells the globe where the centre of the 2D map is on screen. Measured from
   * the live layout, so it follows the rail, mission panel, dock, sheet and window size.
   */
  const syncFocus = useCallback(() => {
    const stage = stageEl.current?.getBoundingClientRect()
    const wrap = globeEl.current?.getBoundingClientRect()
    if (!stage || !wrap || stage.width < 2 || wrap.width < 2) return
    const o = focusOffset(wrap, stage)
    globe.current?.setLocalFocus(o.x, o.y)
  }, [])

  /**
   * Globe -> 2D workspace. On the way down the globe's view slides so that its
   * focus sits exactly where the 2D map's centre is; the map is then placed at
   * the same centre and scale underneath, and the globe fades out over it.
   * Both show the same NASA tiles, north up.
   */
  const enterLocal = async (o: { center?: LatLon; fly?: boolean; then?: 'site' | 'crater' | 'stay' } = {}) => {
    if (!terrain) return
    if (!canStartTransition(phase.current, 'local', lastSwitch.current, performance.now())) return
    const g = globe.current
    const m = map.current
    const target = o.center ?? siteCenter()
    phase.current = 'entering'
    setRailPane(null)
    if (g && globeOk) {
      syncFocus()
      // Let the 2D tiles load under the globe while the camera travels.
      m?.jumpTo(target, LOCAL_ENTER_ZOOM)
      if (o.fly !== false) {
        const ok = await g.flyTo({ ...target, zoom: LOCAL_ENTER_ZOOM })
        if (!ok) {
          // The user grabbed the globe mid-flight: stay in global view.
          phase.current = 'global'
          return
        }
      }
      await g.alignFocus()
      await g.whenSettled(1400)
      const v = g.getView()
      if (v) m?.jumpTo(v, v.zoom)
    } else m?.jumpTo(target, LOCAL_ENTER_ZOOM)
    setArriving(true)
    await sleep(140)
    setGlobeShown(false)
    setView('local')
    await sleep(FADE_MS)
    g?.setActive(false)
    g?.lockFocus(false)
    setArriving(false)
    phase.current = 'local'
    lastSwitch.current = performance.now()
    if (o.then === 'crater') m?.fitCrater()
    else if (o.then !== 'stay') m?.fitSite()
  }

  /** 2D workspace -> globe, at the same centre and scale, then optionally out to the whole planet. */
  const exitToGlobal = async (overview: boolean) => {
    const g = globe.current
    const m = map.current
    if (!g || !m || !globeOk) return
    if (!canStartTransition(phase.current, 'global', lastSwitch.current, performance.now())) return
    phase.current = 'exiting'
    setRailPane(null)
    syncFocus()
    const mv = m.getView()
    g.setActive(true)
    // Start lined up with the 2D map, then let the view drift back to the middle of the window.
    g.setView(mv, true)
    await g.whenSettled(1500)
    setView('global')
    setGlobeShown(true)
    await sleep(FADE_MS)
    g.lockFocus(false)
    phase.current = 'global'
    lastSwitch.current = performance.now()
    if (overview) g.flyToOverview(mv)
  }

  // The 2D map's centre moves with the dock, the panels and the window: keep the globe informed.
  useEffect(() => {
    if (!terrain) return
    syncFocus()
    const ro = new ResizeObserver(syncFocus)
    if (stageEl.current) ro.observe(stageEl.current)
    if (globeEl.current) ro.observe(globeEl.current)
    return () => ro.disconnect()
  }, [terrain, syncFocus, isMobile])

  /** The user pushed the globe's zoom past the deepest imagery at this spot. */
  const onGlobeFloor = (center: LatLon, zoom: number) => {
    if (!terrain) return
    const b = terrain.meta.bbox
    const study: BBox = [b.south, b.west, b.north, b.east]
    if (shouldAutoEnter(center, zoom, study)) enterLocal({ center, fly: false, then: 'stay' })
    else if (canOpenWorkspaceAt(center)) notify('Deepest imagery here. Use "Enter Gale crater workspace" for the 2D map.', false)
    else notify('Resolution limit of the global mosaic. High-resolution data covers Gale crater.', false)
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
    const example = [now, pick(350), pick(700)].map((s) => ({ lat: s.lat, lon: s.lon }))
    setPoints(example)
    // Frame the route once it has been calculated. Nothing else ever asks for this.
    fitRequest.current = { points: example }
    plan.setRoundTrip(true)
    setInspect(null)
    dismissBriefing()
    setDockTab('profile')
    setDockOpen(true)
    setSheetTab('mission')
    // The map is framed on the route when it arrives, so it is not sent to the whole study area first.
    if (phase.current === 'global') enterLocal({ then: 'stay' })
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

  // What the globe draws: the same mission state the 2D workspace edits.
  const planPoints = plan.points
  const planRoute = plan.plan
  const planChecks = plan.checks
  const planRoundTrip = plan.roundTrip
  const planReturnM = plan.returnDistanceM
  const planVerdict = verdictOf(plan)
  // How the plan is drawn, for the 2D map, the globe and the legends alike.
  const display = useMemo(
    () => routeDisplay({ points: planPoints, roundTrip: planRoundTrip, plan: planRoute, checks: planChecks, verdict: planVerdict, returnDistanceM: planReturnM }),
    [planPoints, planRoundTrip, planRoute, planChecks, planVerdict, planReturnM],
  )
  const summary = missionSummary(plan, display)
  const summaryKey = `${summary.title}|${summary.detail}|${summary.tone}|${summary.mode}`
  const hirisOn = tiles.hirise.on
  const globeData = useMemo<GlobeData | null>(() => {
    if (!terrain) return null
    const b = terrain.meta.bbox
    const last = track?.stops[track.stops.length - 1]
    return {
      site: [b.south, b.west, b.north, b.east],
      points: planPoints,
      // Legs that were found are drawn, with the same roles and marks as on the 2D map.
      legs: planRoute ? planRoute.legs.map((l) => l.samples) : [],
      legRoles: display.roles,
      notes: display.notes,
      rover: last ? { lat: last.lat, lon: last.lon } : null,
      inspect,
      hirise: hirisOn,
      mission: summary,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain, track, planPoints, planRoute, display, inspect, summaryKey, hirisOn])

  if (loadError) return <div className="boot">Could not load terrain data: {loadError}</div>
  if (!terrain) return <div className="boot">Loading Mount Sharp terrain…</div>

  const rover = track?.stops[track.stops.length - 1] ?? null
  const extent = view === 'global' ? 'mars' : zoom <= REGIONAL_ZOOM ? 'crater' : 'site'
  const layerCount =
    TILE_LAYERS.filter((d) => tiles[d.id].on).length + [hazard, elevation, contours, hiddenSteep].filter((l) => l.on).length
  const route = plan.plan && !plan.plan.error ? plan.plan : null
  const failed = plan.checks?.filter((c) => !c.ok) ?? []
  const mission = summary

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
    hiddenSteep,
    setHiddenSteep,
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

  // The same bar heads the globe and the workspace.
  const topbar = (
    <header className="topbar">
      <h1 className="wordmark">MARSCOPE</h1>
      <p className="topbar-site">
        <b>Marswalk planner</b> · Mount Sharp, Gale crater
      </p>
      <div className="topbar-tools">
        <Segmented
          label="Map extent"
          value={extent}
          onChange={(v) => {
            if (v === 'mars') exitToGlobal(true)
            else if (view === 'global') enterLocal({ then: v })
            else if (v === 'site') map.current?.fitSite()
            else map.current?.fitCrater()
          }}
          options={[
            ...(globeOk ? [{ value: 'mars' as const, label: 'Mars' }] : []),
            { value: 'crater' as const, label: 'Gale crater' },
            { value: 'site' as const, label: 'Study area' },
          ]}
        />
        <div className="zoom">
          <button
            type="button"
            onClick={() => (view === 'global' ? globe.current?.zoomStep(-1) : map.current?.zoomOut())}
            aria-label="Zoom out"
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            onClick={() => (view === 'global' ? globe.current?.zoomStep(1) : map.current?.zoomIn())}
            aria-label="Zoom in"
          >
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
  )

  const toastEl = toast && (
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
  )

  // While the globe covers the window, the workspace under it is not reachable.
  const covered = view === 'global'

  return (
    <div className={`ws ${isMobile ? 'is-mobile' : ''}`} data-view={view}>
      {!isMobile && (
        <ToolRail
          active={railPane}
          onSelect={setRailPane}
          layerCount={layerCount}
          canUndo={canUndo}
          onUndo={undo}
          onHelp={() => setBriefing(true)}
          inert={covered}
        />
      )}

      <div className="work" inert={covered}>
        {view === 'local' ? topbar : <div className="topbar" aria-hidden="true" />}

        <div ref={stageEl} className={`stage ${arriving ? 'is-arriving' : ''}`}>
          <MapView
            ref={map}
            terrain={terrain}
            tiles={tiles}
            hazard={hazard}
            elevation={elevation}
            contours={contours}
            hidden={hiddenSteep}
            showTrack={showTrack}
            track={track}
            points={plan.points}
            legs={plan.plan?.legs ?? []}
            legRoles={display.roles}
            notes={display.notes}
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
            onMinZoom={() => exitToGlobal(false)}
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

          {view === 'local' && toastEl}
          {view === 'local' && <RouteOverlay display={display} compact={isMobile || narrowKey} />}
          {view === 'local' && plan.points.length > 0 && (
            <button type="button" className="map-fit" onClick={fitRoute} aria-label="Fit route: show the whole route on the map" title="Show the whole route">
              <Icon name="expand" size={15} />
              <span>Fit route</span>
            </button>
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
              {display.legend.length === 0 && (
                <li>
                  <i className="key-route" />
                  Planned route
                </li>
              )}
              {display.legend.map((item) => (
                <li key={item.id}>
                  <i className={`key-${item.id}`} />
                  {item.label}
                </li>
              ))}
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
        <aside className="mission" aria-label="Mission planning" inert={covered}>
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
              {(verdictOf(plan) === 'nogo' || verdictOf(plan) === 'unverified') && (
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

      {globeOk && globeData && (
        <div ref={globeEl} className={`globe-wrap ${globeShown ? '' : 'is-hidden'}`} aria-hidden={!globeShown} inert={!globeShown}>
          <Suspense fallback={<div className="globe-loading">Loading Mars…</div>}>
            <GlobeView
              ref={globe}
              data={globeData}
              lowPower={isMobile}
              onReady={syncFocus}
              onUnavailable={() => {
                // No WebGL: the 2D workspace is the whole application.
                setGlobeOk(false)
                setGlobeShown(false)
                setView('local')
                phase.current = 'local'
              }}
              onView={(v) => {
                // The HUD does not need every frame.
                const now = performance.now()
                if (now - hudTick.current.view < 90) return
                hudTick.current.view = now
                setGlobeView(v)
              }}
              onLoading={setGlobeBusy}
              onHover={(p) => {
                const now = performance.now()
                if (p && now - hudTick.current.hover < 60) return
                hudTick.current.hover = now
                setGlobeHover(p)
              }}
              onPick={(p) => {
                setInspect(p)
                if (isMobile) {
                  setSheetTab('point')
                  setSheetSnap((s) => (s === 'peek' ? 'half' : s))
                }
              }}
              onFloor={onGlobeFloor}
              onMissionClick={() => enterLocal({ then: 'site' })}
            />
          </Suspense>
          {view === 'global' && topbar}
          {view === 'global' && toastEl}
          {view === 'global' && (
            <GlobeHud
              view={globeView}
              hover={globeHover}
              inspect={inspect}
              site={globeData.site}
              mission={mission}
              compact={isMobile}
                busy={globeBusy}
              onOverview={() => globe.current?.flyToOverview()}
              onFocus={() => {
                // The middle of the route, not the habitat alone, so the whole route is in view.
                const b = routeBounds(plan.points, plan.plan?.legs.map((l) => l.samples) ?? [])
                const c = b ? { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 } : siteCenter()
                // Close enough to tell the way out from the way back, short of the handover to 2D.
                globe.current?.flyTo({ ...c, zoom: plan.points.length > 0 ? MISSION_FOCUS_ZOOM : 8.2 })
              }}
              onOpenWorkspace={(at) => {
                if (at) {
                  enterLocal({ center: at, then: 'stay' })
                  setDockTab('point')
                  setDockOpen(true)
                } else enterLocal({ then: 'site' })
              }}
              onClearInspect={() => setInspect(null)}
            />
          )}
        </div>
      )}

      {briefing && <Onboarding onStart={dismissBriefing} onExample={loadExample} canExample={!!track} hasPlan={plan.points.length > 0} />}
    </div>
  )
}
