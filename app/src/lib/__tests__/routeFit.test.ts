// Framing a route on the map: its bounds, the free part of the map, the fitted
// view, and when a fit may happen without being asked.
import { describe, expect, it } from 'vitest'
import { computeAllPlans, type PlanInput } from '../planner'
import {
  FIT_MARGIN_PX,
  FIT_MAX_ZOOM,
  FIT_ZOOM_SNAP,
  degPerPx,
  fitInsets,
  fitRequestStale,
  fitView,
  project,
  routeBounds,
  sheetCover,
  shouldAutoFit,
  type Bounds,
  type Insets,
  type Size,
} from '../routeFit'
import type { LatLon } from '../terrain'
import { at, makeTerrain } from './synthetic'

const H: LatLon = { lat: -4.826, lon: 137.3889 }
const T1: LatLon = { lat: -4.821, lon: 137.3856 }
const T2: LatLon = { lat: -4.8161, lon: 137.3824 }

/** True when every point lies inside the free part of the container. */
function allInside(pts: LatLon[], b: Bounds, size: Size, insets: Insets, slack = 0.5) {
  const view = fitView(b, size, insets)!
  return pts.every((p) => {
    const { x, y } = project(p, view, size)
    return x >= insets.left - slack && x <= size.width - insets.right + slack && y >= insets.top - slack && y <= size.height - insets.bottom + slack
  })
}

describe('what a fitted view has to show', () => {
  it('covers the habitat and every target', () => {
    expect(routeBounds([H, T1, T2])).toEqual({ south: H.lat, north: T2.lat, west: T2.lon, east: H.lon })
  })

  it('covers the legs too, the return included, where they leave the box of the checkpoints', () => {
    const out = [H, { lat: -4.824, lon: 137.392 }, T1]
    const back = [T1, { lat: -4.83, lon: 137.38 }, H]
    const b = routeBounds([H, T1], [out, back])!
    expect(b.east).toBe(137.392)
    expect(b.south).toBe(-4.83)
    expect(b.west).toBe(137.38)
    expect(b.north).toBe(T1.lat)
  })

  it('is the bounds of what exists when the route is missing or partial', () => {
    expect(routeBounds([H, T1, T2], [])).toEqual(routeBounds([H, T1, T2]))
    // Only the first leg was found: the unreached target is still shown.
    const partial = routeBounds([H, T1, T2], [[H, T1]])!
    expect(partial.north).toBe(T2.lat)
    expect(routeBounds([H])).toEqual({ south: H.lat, north: H.lat, west: H.lon, east: H.lon })
  })

  it('is nothing when there is nothing to show, and ignores broken coordinates', () => {
    expect(routeBounds([])).toBeNull()
    expect(routeBounds([], [[]])).toBeNull()
    expect(routeBounds([{ lat: NaN, lon: 1 }])).toBeNull()
    expect(routeBounds([H, { lat: NaN, lon: NaN }])).toEqual({ south: H.lat, north: H.lat, west: H.lon, east: H.lon })
  })

  it('covers every sample of the routes the planner draws, for each priority', () => {
    const t = makeTerrain(120, 80, (x, y) => (x > 40 && x < 60 && y > 10 ? 40 : 0))
    const input: PlanInput = { points: [at(t, 10, 40), at(t, 100, 40)], roundTrip: true, massKg: 180 }
    const plans = computeAllPlans(t, input)
    for (const mode of ['fastest', 'energy', 'cautious'] as const) {
      const legs = plans[mode]!.legs.map((l) => l.samples)
      expect(legs).toHaveLength(2)
      const b = routeBounds(input.points, legs)!
      for (const p of legs.flat()) {
        expect(p.lat).toBeGreaterThanOrEqual(b.south)
        expect(p.lat).toBeLessThanOrEqual(b.north)
        expect(p.lon).toBeGreaterThanOrEqual(b.west)
        expect(p.lon).toBeLessThanOrEqual(b.east)
      }
      // The wall forces the route outside the box of the two checkpoints.
      expect(b.north - b.south).toBeGreaterThan(routeBounds(input.points)!.north - routeBounds(input.points)!.south)
    }
  })
})

describe('the free part of the map', () => {
  it('keeps a margin for the pins on every side', () => {
    expect(fitInsets()).toEqual({ top: FIT_MARGIN_PX, right: FIT_MARGIN_PX, bottom: FIT_MARGIN_PX, left: FIT_MARGIN_PX })
    // A 30 px pin is centred on its point: half of it, and room to spare, stays inside.
    expect(FIT_MARGIN_PX).toBeGreaterThanOrEqual(15 + 20)
  })

  it('starts below the route key and the NO-GO line', () => {
    expect(fitInsets({ overlayHeight: 70 }).top).toBe(FIT_MARGIN_PX + 70 + 12)
    expect(fitInsets({ overlayHeight: 0 }).top).toBe(FIT_MARGIN_PX)
  })

  it('stays clear of a pane open over the left of the map', () => {
    expect(fitInsets({ leftPane: 312 }).left).toBe(FIT_MARGIN_PX + 312)
  })

  it('ends above the mobile bottom sheet', () => {
    expect(fitInsets({ sheetCover: 344 }).bottom).toBe(FIT_MARGIN_PX + 344)
    expect(fitInsets({ sheetCover: -5 }).bottom).toBe(FIT_MARGIN_PX)
  })
})

describe('how much of the map the sheet covers', () => {
  const heights = { peek: 78, half: 422, full: 752 }

  it('is nothing when the sheet is collapsed: it sits below the map', () => {
    expect(sheetCover('peek', heights)).toBe(0)
  })

  it('is the half-open sheet less its collapsed height', () => {
    expect(sheetCover('half', heights)).toBe(344)
  })

  it('is taken as half-open when the sheet is fully open, which leaves no map to fit into', () => {
    expect(sheetCover('full', heights)).toBe(sheetCover('half', heights))
  })
})

describe('the fitted view', () => {
  const desktop: Size = { width: 1032, height: 646 }
  const phone: Size = { width: 375, height: 686 }
  const b = routeBounds([H, T1, T2])!

  it('shows every checkpoint inside the free part of a desktop map', () => {
    const insets = fitInsets()
    expect(allInside([H, T1, T2], b, desktop, insets)).toBe(true)
  })

  it('shows every checkpoint above the half-open sheet on a phone', () => {
    const insets = fitInsets({ overlayHeight: 34, sheetCover: 344 })
    const view = fitView(b, phone, insets)!
    expect(allInside([H, T1, T2], b, phone, insets)).toBe(true)
    // The lowest pin clears the sheet by the margin: its bottom edge is not behind it.
    const lowest = Math.max(...[H, T1, T2].map((p) => project(p, view, phone).y))
    expect(lowest + 15).toBeLessThanOrEqual(phone.height - 344)
  })

  it('puts the route in the middle of the free part, not of the container', () => {
    const insets = fitInsets({ sheetCover: 344, overlayHeight: 34 })
    const view = fitView(b, phone, insets)!
    const mid = project({ lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }, view, phone)
    expect(mid.x).toBeCloseTo((insets.left + phone.width - insets.right) / 2, 6)
    expect(mid.y).toBeCloseTo((insets.top + phone.height - insets.bottom) / 2, 6)
    // With even insets that is the centre of the container, and the map centre is the route's.
    const even = fitView(b, desktop, fitInsets())!
    expect(even.center.lat).toBeCloseTo((b.south + b.north) / 2, 12)
    expect(even.center.lon).toBeCloseTo((b.west + b.east) / 2, 12)
  })

  it('zooms as close as still fits, on the zoom step, and no closer', () => {
    const insets = fitInsets()
    const view = fitView(b, desktop, insets)!
    expect((view.zoom / FIT_ZOOM_SNAP) % 1).toBe(0)
    // One step closer and the route would no longer fit.
    const closer = { ...view, zoom: view.zoom + FIT_ZOOM_SNAP }
    const pts = [H, T1, T2].map((p) => project(p, closer, desktop))
    const fits = pts.every((p) => p.x >= insets.left && p.x <= desktop.width - insets.right && p.y >= insets.top && p.y <= desktop.height - insets.bottom)
    expect(fits).toBe(false)
  })

  it('never zooms past the limit, so a short route keeps its terrain context', () => {
    const tiny = routeBounds([H, { lat: H.lat + 0.0002, lon: H.lon + 0.0002 }])!
    expect(fitView(tiny, desktop, fitInsets())!.zoom).toBe(FIT_MAX_ZOOM)
    expect(fitView(routeBounds([H]), desktop, fitInsets())!.zoom).toBe(FIT_MAX_ZOOM)
    // At the limit a 1032 px map still shows about 0.9 km of ground (59.27 km per degree on Mars).
    const metresPerPx = degPerPx(FIT_MAX_ZOOM) * 59_274
    expect(metresPerPx * desktop.width).toBeGreaterThan(800)
    expect(metresPerPx).toBeLessThan(1.5)
  })

  it('holds the zoom between the limits it is given', () => {
    const wide: Bounds = { south: -10, north: 10, west: 120, east: 150 }
    expect(fitView(wide, desktop, fitInsets(), { minZoom: 6 })!.zoom).toBe(6)
    expect(fitView(b, desktop, fitInsets(), { maxZoom: 12 })!.zoom).toBe(12)
  })

  it('gives no view, and so moves nothing, without a route or without room', () => {
    expect(fitView(null, desktop, fitInsets())).toBeNull()
    expect(fitView(b, { width: 0, height: 0 }, fitInsets())).toBeNull()
    // A sheet that leaves less than a strip of map.
    expect(fitView(b, phone, fitInsets({ sheetCover: 600 }))).toBeNull()
    expect(fitView(b, { width: NaN, height: 600 }, fitInsets())).toBeNull()
  })

  it('fits the same on a larger window, only closer', () => {
    const big: Size = { width: 1512, height: 826 }
    expect(allInside([H, T1, T2], b, big, fitInsets())).toBe(true)
    expect(fitView(b, big, fitInsets())!.zoom).toBeGreaterThanOrEqual(fitView(b, desktop, fitInsets())!.zoom)
  })
})

describe('the scale of the map grid', () => {
  it('is the one measured on the running map', () => {
    // Leaflet's EPSG:4326 at zoom 15.5: the example route, 0.0099 degrees from the habitat to
    // target 2, was 653 px tall. A wrong factor here frames the route a whole zoom level out.
    expect(0.0099 / degPerPx(15.5)).toBeCloseTo(653, -1)
    expect(degPerPx(10) / degPerPx(11)).toBe(2)
  })
})

describe('fitting without being asked', () => {
  const example = [H, T1, T2]
  const request = { points: example }

  it('happens once the route of a loaded example is ready on the 2D map', () => {
    expect(shouldAutoFit({ request, points: example, routeReady: true, mapShown: true })).toBe(true)
  })

  it('waits for the route, and for the map', () => {
    expect(shouldAutoFit({ request, points: example, routeReady: false, mapShown: true })).toBe(false)
    expect(shouldAutoFit({ request, points: example, routeReady: true, mapShown: false })).toBe(false)
  })

  it('never happens without a request: a new route for the same checkpoints leaves the camera alone', () => {
    // Switching Fastest, Energy-efficient or Cautious, changing a limit or a parameter, a
    // recalculation: each puts a new route on screen, and none of them makes a request.
    for (const routeReady of [true, false]) {
      expect(shouldAutoFit({ request: null, points: example, routeReady, mapShown: true })).toBe(false)
    }
  })

  it('is dropped when the user has changed the checkpoints since', () => {
    const edited = [...example, { lat: -4.81, lon: 137.39 }]
    expect(shouldAutoFit({ request, points: edited, routeReady: true, mapShown: true })).toBe(false)
    expect(fitRequestStale(request, edited)).toBe(true)
    expect(fitRequestStale(request, example)).toBe(false)
    expect(fitRequestStale(null, example)).toBe(false)
    // The same coordinates in a new list are a new plan: identity, not equality, decides.
    expect(fitRequestStale(request, [...example])).toBe(true)
  })
})
