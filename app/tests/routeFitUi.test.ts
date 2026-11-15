// How the route fit and the globe's mission card are wired into the interface
// (Phase 5.4B). These read the sources: a change that makes the camera follow
// the route priority, or drops the reason from the globe card, fails here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8')
const app = read('App.tsx')
const mapView = read('components/MapView.tsx')
const panel = read('components/MissionPanel.tsx')
const hook = read('hooks/usePlan.ts')
const hud = read('components/GlobeHud.tsx')
const mapCss = read('styles/map.css')

describe('fitting the route on the map', () => {
  it('is asked for in one place only: when an example mission is loaded', () => {
    expect(app.match(/fitRequest\.current = \{/g)).toHaveLength(1)
    const load = app.slice(app.indexOf('const loadExample = () => {'), app.indexOf('const setHabitat'))
    expect(load).toContain('fitRequest.current = { points: example }')
    // The example is no longer sent to the whole study area first.
    expect(load).not.toContain('fitSite()')
  })

  it('is carried out once, by a rule that needs a pending request', () => {
    const effect = app.slice(app.indexOf('// The one automatic fit.'), app.indexOf('// Keyboard: undo and escape.'))
    expect(effect).toContain('shouldAutoFit({')
    expect(effect).toContain('request: fitRequest.current')
    expect(effect).toContain('if (!ready) return')
    // The request is dropped when the fit is made.
    expect(effect).toMatch(/fitRequest\.current = null\s*fitRouteRef\.current\(\)/)
  })

  it('is never called by the route priority, the constraints or the plan hook', () => {
    for (const src of [panel, hook, read('lib/planService.ts'), read('components/MobileSheet.tsx')]) {
      expect(src).not.toMatch(/fitRoute|fitRequest|fitSite|flyTo|setView\(/)
    }
    // In the app the fit is reachable from the example request and from the button, nothing else.
    const calls = [...app.matchAll(/fitRouteRef\.current\(\)|onClick=\{fitRoute\}/g)].map((m) => m[0])
    expect(calls.sort()).toEqual(['fitRouteRef.current()', 'onClick={fitRoute}'])
    expect(app).not.toMatch(/setMode[^\n]*fit/i)
  })

  it('frames the checkpoints and every leg, in the part of the map that is visible', () => {
    const fit = app.slice(app.indexOf('const fitRoute = () => {'), app.indexOf('const fitRouteRef'))
    expect(fit).toContain('routeBounds(plan.points, legs)')
    expect(fit).toContain('plan.plan?.legs.map((l) => l.samples)')
    expect(fit).toContain("querySelector<HTMLElement>('.route-overlay')")
    expect(fit).toContain('sheetCover: isMobile ? sheetCover(sheetSnap, sheetHeights()) : 0')
  })

  it('measures the map afresh, stops following the study area, and respects reduced motion', () => {
    const fit = mapView.slice(mapView.indexOf('fitRoute: (bounds, insets) => {'), mapView.indexOf('/** Pan just enough'))
    expect(fit).toContain('m.invalidateSize({ animate: false })')
    expect(fit).toContain('fitView(bounds, { width: size.x, height: size.y }, insets, { minZoom: MIN_ZOOM })')
    expect(fit).toContain('if (!v) return false')
    expect(fit).toContain('autoFit.current = false')
    expect(fit).toContain('prefers-reduced-motion: reduce')
  })
})

describe('the Fit route control', () => {
  const button = app.slice(app.indexOf('className="map-fit"') - 80, app.indexOf('className="map-fit"') + 320)

  it('is a labelled button, shown once there is something to frame', () => {
    expect(button).toContain('<button type="button" className="map-fit" onClick={fitRoute}')
    expect(button).toContain('aria-label="Fit route: show the whole route on the map"')
    expect(button).toContain('<span>Fit route</span>')
    expect(app).toContain("{view === 'local' && plan.points.length > 0 && (")
  })

  it('is 40 px on a phone and on touch screens, and leaves the route key room', () => {
    expect(mapCss).toMatch(/\.is-mobile \.map-fit \{\s*width: 40px;\s*min-height: 40px;/)
    expect(mapCss).toMatch(/@media \(pointer: coarse\) \{\s*\.map-fit \{\s*min-height: 40px;\s*min-width: 40px;/)
    expect(mapCss).toMatch(/\.is-mobile \.route-overlay \{[^}]*max-width: calc\(100% - 24px - 48px\);/)
  })
})

describe('the mission card on the globe', () => {
  it('shows the status, the route priority, the reason and the route key', () => {
    const card = hud.slice(hud.indexOf('hud-card hud-mission'), hud.indexOf('{p.inspect && !p.compact'))
    for (const part of ['{p.mission.title}', '{p.mission.mode}', '{p.mission.reason}', 'p.mission.moreReasons > 0', 'p.mission.legend.map', '{p.mission.detail}']) {
      expect(card).toContain(part)
    }
    expect(card).toContain('<i>Route priority</i>')
    expect(card).toContain('aria-busy={p.mission.busy}')
    expect(card).toContain('className={`key-${item.id}`}')
  })

  it('is built from the same display as the 2D map', () => {
    expect(app).toContain('const summary = missionSummary(plan, display)')
    expect(app).toContain('mission={mission}')
    expect(app).toContain('const mission = summary')
  })

  it('draws the key with the map\'s own colours: cyan solid out, orange dashed back', () => {
    expect(mapCss).toMatch(/\.key-outbound \{\s*border-top: 3px solid var\(--route\);/)
    expect(mapCss).toMatch(/\.key-return \{\s*border-top: 3px dashed var\(--route-return\);/)
  })
})

describe('focusing on the mission on the globe', () => {
  it('centres on the route and stops short of the handover to the 2D map', () => {
    const zoom = Number(app.match(/const MISSION_FOCUS_ZOOM = ([\d.]+)/)![1])
    const enter = Number(read('lib/viewTransition.ts').match(/export const LOCAL_ENTER_ZOOM = ([\d.]+)/)![1])
    expect(zoom).toBeLessThan(enter - 0.05)
    expect(zoom).toBeGreaterThan(11.2)
    const focus = app.slice(app.indexOf('onFocus={() => {'), app.indexOf('onOpenWorkspace={'))
    expect(focus).toContain('routeBounds(plan.points')
    expect(focus).toContain('zoom: plan.points.length > 0 ? MISSION_FOCUS_ZOOM : 8.2')
  })

  it('leaves the route geometry and its colours to the engine, untouched', () => {
    const engine = read('lib/globeEngine.ts')
    expect(engine).toContain('ROUTE_COLOR_HEX[role]')
    expect(engine).not.toContain('MISSION_FOCUS_ZOOM')
  })
})
