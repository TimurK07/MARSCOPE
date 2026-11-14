import { describe, expect, it } from 'vitest'
import {
  altitudeForZoom,
  angularDistance,
  densifyPath,
  equirectUv,
  latLonToUnit,
  slerp,
  tileGridFor,
  unitToLatLon,
  wrapLon,
  wrapTileX,
  zoomForAltitude,
} from '../globe'
import { MARS_FEATURES } from '../marsFeatures'
import {
  GALE_IMAGERY,
  GLOBAL_FLOOR_ZOOM,
  LOCAL_ENTER_ZOOM,
  canOpenWorkspaceAt,
  LOCAL_EXIT_ZOOM,
  canStartTransition,
  floorZoomAt,
  focusOffset,
  shouldAutoEnter,
} from '../viewTransition'

const STUDY: [number, number, number, number] = [-4.86, 137.355, -4.79, 137.425]
const curiosity = { lat: -4.826, lon: 137.3889 }

describe('globe coordinates', () => {
  it('places the poles and the prime meridian on the axes', () => {
    expect(latLonToUnit({ lat: 90, lon: 0 })[1]).toBeCloseTo(1)
    expect(latLonToUnit({ lat: 0, lon: 0 })[0]).toBeCloseTo(1)
    // East-positive: 90°E is at -Z, which is to the right when looking at 0°E with north up.
    expect(latLonToUnit({ lat: 0, lon: 90 })[2]).toBeCloseTo(-1)
  })

  it('round-trips coordinates, including near the antimeridian and the poles', () => {
    for (const p of [curiosity, { lat: 18.65, lon: -133.8 }, { lat: -83.35, lon: 157.7 }, { lat: 12, lon: 179.999 }, { lat: 12, lon: -179.999 }]) {
      const q = unitToLatLon(latLonToUnit(p))
      expect(q.lat).toBeCloseTo(p.lat, 9)
      expect(q.lon).toBeCloseTo(p.lon, 9)
    }
  })

  it('keeps sub-metre precision at the study area', () => {
    // 1e-7 degrees is about 6 mm on Mars.
    const p = { lat: -4.8260001, lon: 137.3889001 }
    const q = unitToLatLon(latLonToUnit(p))
    expect(Math.abs(q.lat - p.lat)).toBeLessThan(1e-9)
    expect(Math.abs(q.lon - p.lon)).toBeLessThan(1e-9)
  })

  it('wraps longitudes given in 0-360 into -180..180', () => {
    expect(wrapLon(226.1975)).toBeCloseTo(-133.8025)
    expect(wrapLon(137.4)).toBeCloseTo(137.4)
    expect(wrapLon(-190)).toBeCloseTo(170)
  })

  it('maps the texture so Gale sits where the equirectangular mosaic has it', () => {
    const gale = MARS_FEATURES.find((f) => f.name === 'Gale crater')!
    expect(gale.lat).toBeCloseTo(-5.3672, 3)
    expect(gale.lon).toBeCloseTo(137.811, 3)
    const { u, v } = equirectUv(gale)
    expect(u).toBeCloseTo((137.811 + 180) / 360, 6)
    expect(v).toBeCloseTo((90 + 5.3672) / 180, 6)
    // In a 2048 x 1024 mosaic that is pixel (1808, 543).
    expect(Math.round(u * 2048)).toBe(1808)
    expect(Math.round(v * 1024)).toBe(543)
  })

  it('has the study area inside Gale crater', () => {
    const gale = MARS_FEATURES.find((f) => f.name === 'Gale crater')!
    const radiusRad = gale.diameterKm / 2 / 3396.19
    expect(angularDistance(gale, curiosity)).toBeLessThan(radiusRad)
  })
})

describe('great-circle paths', () => {
  it('interpolates across the antimeridian without going the long way round', () => {
    const mid = slerp({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }, 0.5)
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 6)
    expect(mid.lat).toBeCloseTo(0, 9)
  })

  it('keeps every densified point on the surface and limits the step', () => {
    const path = densifyPath([{ lat: 10, lon: 170 }, { lat: -20, lon: -160 }], 0.02)
    expect(path.length).toBeGreaterThan(10)
    for (let i = 1; i < path.length; i++) expect(angularDistance(path[i - 1], path[i])).toBeLessThanOrEqual(0.02 + 1e-9)
    expect(path[0]).toEqual({ lat: 10, lon: 170 })
    expect(path[path.length - 1]).toEqual({ lat: -20, lon: -160 })
  })

  it('leaves a route sampled every few metres untouched', () => {
    const route = [curiosity, { lat: -4.82604, lon: 137.38894 }]
    expect(densifyPath(route, 0.001)).toHaveLength(2)
  })
})

describe('camera altitude and map zoom', () => {
  it('round-trips for the zooms used in the handover', () => {
    for (const z of [5, GLOBAL_FLOOR_ZOOM, 9.25, LOCAL_ENTER_ZOOM]) {
      for (const h of [500, 800, 1100]) {
        expect(zoomForAltitude(altitudeForZoom(z, h, 35), h, 35)).toBeCloseTo(z, 6)
      }
    }
  })

  it('gets lower as the map zooms in', () => {
    expect(altitudeForZoom(12, 800, 35)).toBeLessThan(altitudeForZoom(8, 800, 35))
  })

  it('matches the ground extent of the 2D map', () => {
    // At zoom 12.5 an 800 px tall map spans 800 * 180 / (256 * 2^12.5) degrees.
    const spanDeg = (800 * 180) / (256 * 2 ** 12.5)
    const alt = altitudeForZoom(12.5, 800, 35)
    // For a low camera the visible ground is about 2 * alt * tan(fov / 2) radii.
    const approxDeg = ((2 * alt * Math.tan((17.5 * Math.PI) / 180)) * 180) / Math.PI
    expect(approxDeg).toBeCloseTo(spanDeg, 3)
  })
})

describe('tile grid', () => {
  it('covers the view with whole tiles of the Mars Trek pyramid', () => {
    const g = tileGridFor(curiosity, 1, 1.5, 9)
    const size = 180 / 2 ** 9
    expect(g.bounds[1]).toBeLessThanOrEqual(curiosity.lon - 0.75)
    expect(g.bounds[3]).toBeGreaterThanOrEqual(curiosity.lon + 0.75)
    expect((g.bounds[2] - g.bounds[0]) / size).toBeCloseTo(g.y1 - g.y0 + 1, 9)
    // Curiosity's tile at zoom 10 is row 539, column 1805 (checked against the live service).
    const g10 = tileGridFor(curiosity, 0.01, 0.01, 10)
    expect(g10.y0).toBe(539)
    expect(g10.x0).toBe(1805)
  })

  it('wraps columns across the antimeridian', () => {
    const g = tileGridFor({ lat: 0, lon: 179.9 }, 10, 40, 4)
    expect(g.x1).toBeGreaterThan(2 ** 5 - 1)
    expect(wrapTileX(g.x1, 4)).toBeLessThan(2 ** 5)
    expect(wrapTileX(-1, 4)).toBe(31)
  })
})

describe('view transition rules', () => {
  it('lets the globe zoom deep only inside the Gale imagery', () => {
    expect(floorZoomAt(curiosity)).toBe(LOCAL_ENTER_ZOOM)
    expect(floorZoomAt({ lat: 18.65, lon: -133.8 })).toBe(GLOBAL_FLOOR_ZOOM)
    expect(floorZoomAt({ lat: GALE_IMAGERY[0] + 0.01, lon: 137 })).toBe(GLOBAL_FLOOR_ZOOM)
  })

  it('opens the workspace by itself only at the floor and near the study area', () => {
    expect(shouldAutoEnter(curiosity, LOCAL_ENTER_ZOOM, STUDY)).toBe(true)
    expect(shouldAutoEnter(curiosity, 11, STUDY)).toBe(false)
    // Elsewhere in Gale the user has to ask for it.
    expect(shouldAutoEnter({ lat: -5.4, lon: 138.4 }, LOCAL_ENTER_ZOOM, STUDY)).toBe(false)
    expect(canOpenWorkspaceAt({ lat: -5.4, lon: 138.4 })).toBe(true)
    expect(canOpenWorkspaceAt({ lat: 18.65, lon: -133.8 })).toBe(false)
  })

  it('refuses to switch while a transition runs or right after one', () => {
    expect(canStartTransition('entering', 'global', 0, 5000)).toBe(false)
    expect(canStartTransition('local', 'local', 0, 5000)).toBe(false)
    expect(canStartTransition('local', 'global', 4800, 5000)).toBe(false)
    expect(canStartTransition('local', 'global', 1000, 5000)).toBe(true)
  })
})

describe('viewport-aware focus alignment', () => {
  // Layouts measured in the app: [globe overlay, 2D map stage].
  const layouts = {
    'desktop 1440, dock closed': [{ left: 0, top: 0, width: 1440, height: 900 }, { left: 48, top: 40, width: 1032, height: 801 }],
    'desktop 1920, dock open': [{ left: 0, top: 0, width: 1920, height: 1080 }, { left: 48, top: 40, width: 1512, height: 826 }],
    'tablet 768': [{ left: 0, top: 0, width: 768, height: 1024 }, { left: 48, top: 40, width: 400, height: 925 }],
    'phone 375': [{ left: 0, top: 0, width: 375, height: 734 }, { left: 0, top: 40, width: 375, height: 694 }],
  }

  it('points from the centre of the globe to the centre of the 2D map', () => {
    for (const [globe, map] of Object.values(layouts)) {
      const o = focusOffset(globe, map)
      expect(globe.left + globe.width / 2 + o.x).toBeCloseTo(map.left + map.width / 2, 9)
      expect(globe.top + globe.height / 2 + o.y).toBeCloseTo(map.top + map.height / 2, 9)
    }
  })

  it('is zero when both views share the same rectangle', () => {
    const r = { left: 10, top: 20, width: 800, height: 600 }
    expect(focusOffset(r, r)).toEqual({ x: 0, y: 0 })
  })

  it('gives the 156 px shift the first version had on a 1440 px desktop', () => {
    const [globe, map] = layouts['desktop 1440, dock closed']
    expect(focusOffset(globe, map).x).toBe(-156)
  })

  it('keeps one map pixel equal to one globe pixel, whatever the viewport height', () => {
    // The handover matches zoom, not altitude: the same zoom must give the same
    // ground extent per pixel in a 900 px globe and an 801 px map.
    const zoom = LOCAL_ENTER_ZOOM
    const radPerPx = Math.PI / (256 * 2 ** zoom)
    for (const h of [694, 801, 900, 1080]) {
      const alt = altitudeForZoom(zoom, h, 35)
      const theta = (17.5 * Math.PI) / 180
      // Half the viewport height spans this angle on the ground.
      const half = Math.asin((1 + alt) * Math.sin(theta)) - theta
      expect(half / (h / 2)).toBeCloseTo(radPerPx, 12)
    }
  })
})

describe('transition thresholds', () => {
  it('leaves a wide band between entering and leaving the 2D map', () => {
    expect(LOCAL_ENTER_ZOOM - LOCAL_EXIT_ZOOM).toBeGreaterThan(3)
    expect(GLOBAL_FLOOR_ZOOM).toBeGreaterThan(LOCAL_EXIT_ZOOM)
  })

  it('ignores a burst of switch requests', () => {
    // Mars, Study area, Mars pressed within half a second: only the first runs.
    let phase: 'global' | 'entering' | 'local' | 'exiting' = 'local'
    let last = 0
    const accepted: string[] = []
    const press = (target: 'local' | 'global', now: number) => {
      if (!canStartTransition(phase, target, last, now)) return
      accepted.push(target)
      phase = target === 'local' ? 'entering' : 'exiting'
    }
    press('global', 5000)
    press('local', 5200)
    press('global', 5400)
    expect(accepted).toEqual(['global'])
    // Once it has finished, the next request is honoured after the cool-down.
    phase = 'global'
    last = 6000
    press('local', 6300)
    expect(accepted).toEqual(['global'])
    press('local', 6800)
    expect(accepted).toEqual(['global', 'local'])
  })
})
