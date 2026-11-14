// The colours and verdict styles as they are written in the style sheets and the
// drawing code: the 2D map, the 3D globe and the legends must use the same ones.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROUTE_COLORS } from '../src/lib/routeDisplay'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(join(APP, p), 'utf8')

describe('route colours in the style sheets and the globe', () => {
  it('come from the same two values everywhere', () => {
    const tokens = read('src/index.css')
    expect(tokens).toContain(`--route: ${ROUTE_COLORS.outbound};`)
    expect(tokens).toContain(`--route-return: ${ROUTE_COLORS.return};`)
    const map = read('src/styles/map.css')
    expect(map).toMatch(/\.route-line \{[^}]*stroke: var\(--route\);/)
    expect(map).toMatch(/\.route-line\.route-return \{[^}]*stroke: var\(--route-return\);/)
    expect(map).toMatch(/\.key-outbound \{[^}]*var\(--route\)/)
    expect(map).toMatch(/\.key-return \{[^}]*var\(--route-return\)/)
    // The globe takes its colours from the same module, by role; the old hard-coded cyan is gone.
    const globe = read('src/lib/globeEngine.ts')
    expect(globe).toContain('ROUTE_COLOR_HEX[role]')
    expect(globe).not.toContain('0x62d4e8')
    expect(read('src/components/MapView.tsx')).toContain('`route-line route-${role}`')
  })

  it('never paint a route by the verdict', () => {
    const map = read('src/styles/map.css')
    expect(map).not.toMatch(/route-line[^{]*(nogo|alert|noroute|unverified)/)
    // (.route-alert is the warning chip over the map, not a line style.)
    expect(map).not.toMatch(/\.route-line\.route-(nogo|alert|noroute|unverified)/)
    expect(map).not.toMatch(/\.route-(nogo|noroute)\b/)
    const view = read('src/components/MapView.tsx')
    expect(view).not.toMatch(/route-line[^`']*(nogo|verdict)/)
    expect(read('src/lib/globeEngine.ts')).not.toMatch(/makeLine\(path, 0xe5504f/)
  })

  it('draw the return differently in more than colour, in 2D and in 3D', () => {
    expect(read('src/styles/map.css')).toMatch(/\.route-line\.route-return \{[^}]*stroke-dasharray/)
    expect(read('src/lib/globeEngine.ts')).toContain("role === 'return', 1, RETURN_DASH")
  })

  it('give the 2D map and the globe the same roles and marks', () => {
    const app = read('src/App.tsx')
    expect(app).toContain('legRoles={display.roles}')
    expect(app).toContain('notes={display.notes}')
    expect(app).toContain('legRoles: display.roles,')
    expect(app).toContain('notes: display.notes,')
    const globe = read('src/lib/globeEngine.ts')
    expect(globe).toContain('mk-note-${note.kind}')
    expect(read('src/components/MapView.tsx')).toContain('mk-note-${note.kind}')
  })
})

describe('one look per verdict', () => {
  it('styles each verdict separately in the panel, the mobile summary and the globe', () => {
    const mission = read('src/styles/mission.css')
    const mobile = read('src/styles/mobile.css')
    const globe = read('src/styles/globe.css')
    for (const v of ['go', 'nogo', 'unverified', 'noroute']) {
      expect(mission).toContain(`.m-status-${v}`)
      expect(mobile).toContain(`.sheet-verdict.v-${v}`)
      expect(globe).toContain(`.hud-mission.tone-${v}`)
      expect(globe).toContain(`.gl-mission.tone-${v}`)
    }
    // NO ROUTE no longer shares the red of a broken limit.
    expect(mission).not.toMatch(/\.m-status-nogo,\s*\.m-status-noroute/)
    expect(mobile).not.toMatch(/\.v-nogo,\s*\.sheet-verdict\.v-noroute/)
    expect(read('src/index.css')).toContain('--noroute:')
  })

  it('never calls GO safe, and says why a plan is NO-GO', () => {
    const panel = read('src/components/MissionPanel.tsx')
    expect(panel).toContain('Not a safety clearance.')
    expect(panel).toContain('Outside MARSCOPE planning limits.')
    const overlay = read('src/components/RouteOverlay.tsx')
    expect(overlay).toContain('alert.text')
  })
})
