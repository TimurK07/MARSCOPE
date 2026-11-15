// Framing a route on the 2D map: what has to be in view, how much of the map is
// really visible, and the centre and zoom that put the one inside the other.
//
// Pure functions, so the arithmetic is tested without a map. The map itself
// (MapView) only carries out the view worked out here.
//
// A fit happens in two cases only: when a built-in example mission is loaded,
// and when the user asks for it. Changing the route priority, a constraint, or
// anything else that recalculates the same checkpoints never moves the camera.

import type { LatLon } from './terrain'

export interface Bounds {
  south: number
  west: number
  north: number
  east: number
}

/** Pixels of the map container that are covered or kept clear, per side. */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Size {
  width: number
  height: number
}

export interface FitView {
  center: LatLon
  zoom: number
}

/**
 * Everything a fitted view has to show: the habitat, the targets, and every leg
 * that was found, the return included. Legs matter because a route can swing
 * well outside the box of its checkpoints. Null when there is nothing to show.
 * A missing or partial route (no legs, or fewer than there are checkpoints)
 * still gives the bounds of what exists.
 */
export function routeBounds(points: readonly LatLon[], legs: readonly (readonly LatLon[])[] = []): Bounds | null {
  let south = Infinity
  let west = Infinity
  let north = -Infinity
  let east = -Infinity
  const take = (p: LatLon) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
    west = Math.min(west, p.lon)
    east = Math.max(east, p.lon)
  }
  points.forEach(take)
  for (const leg of legs) leg.forEach(take)
  return south === Infinity ? null : { south, west, north, east }
}

/** Clear space kept around the route, so a checkpoint pin (30 px) and its label are never cut by an edge. */
export const FIT_MARGIN_PX = 44

/**
 * The closest a fit may zoom. At 15.5 a screen pixel is about 0.9 m, the scale
 * of the 1 m terrain data, and a desktop map still shows close to a kilometre
 * of ground: a short route does not fill the screen with a few rocks.
 */
export const FIT_MAX_ZOOM = 15.5

/** The map's zoom step: a fitted zoom is rounded down to it, so the route always fits. */
export const FIT_ZOOM_SNAP = 0.25

/** Below this much free map, in pixels either way, a fit has no room to show anything. */
export const MIN_VISIBLE_PX = 96

export interface InsetInput {
  /** Height of whatever sits over the top-left of the map (the NO-GO line, the route key), 0 if nothing. */
  overlayHeight?: number
  /** Width of a pane open over the left of the map, 0 if none. */
  leftPane?: number
  /** Width kept for the controls at the top right (the Fit route button), 0 if none. */
  controlsWidth?: number
  /**
   * Mobile only: how far the bottom sheet reaches up over the map, in pixels of
   * the map container. The collapsed sheet sits below the map and covers none of it.
   */
  sheetCover?: number
}

/** The part of the map container a route may occupy, given what is drawn over it. */
export function fitInsets(i: InsetInput = {}): Insets {
  const overlay = Math.max(0, i.overlayHeight ?? 0)
  return {
    // The overlay hangs 12 px below the top edge; the route starts below it.
    top: FIT_MARGIN_PX + (overlay > 0 ? overlay + 12 : 0),
    right: FIT_MARGIN_PX,
    bottom: FIT_MARGIN_PX + Math.max(0, i.sheetCover ?? 0),
    left: FIT_MARGIN_PX + Math.max(0, i.leftPane ?? 0),
  }
}

/**
 * How much of the map the bottom sheet covers when a fit is made. A fully open
 * sheet leaves no map to fit into, so the fit is made for the half-open sheet:
 * that is what the user sees on pulling the sheet back down.
 */
export function sheetCover(snap: 'peek' | 'half' | 'full', heights: { peek: number; half: number; full: number }): number {
  return snap === 'peek' ? 0 : Math.max(0, heights.half - heights.peek)
}

// The map uses Leaflet's EPSG:4326 grid: at zoom z, 180 degrees span 256 * 2^z pixels, and a
// degree of latitude is as many pixels as a degree of longitude. (Measured on the running map:
// 0.0099 degrees across 653 px at zoom 15.5.)
export const degPerPx = (zoom: number) => 180 / (256 * 2 ** zoom)
const zoomFor = (dpp: number) => Math.log2(180 / (256 * dpp))

export interface FitOptions {
  minZoom?: number
  maxZoom?: number
  snap?: number
}

/**
 * The view that shows `bounds` inside the free part of a map of `size`.
 * The zoom is the closest that still fits, rounded down to the zoom step and
 * held between the limits; the centre is shifted so the route sits in the
 * middle of the free part, not of the whole container. Null when the map has
 * no usable size, so the caller leaves the camera alone.
 */
export function fitView(bounds: Bounds | null, size: Size, insets: Insets, o: FitOptions = {}): FitView | null {
  if (!bounds) return null
  const w = size.width - insets.left - insets.right
  const h = size.height - insets.top - insets.bottom
  if (!(w >= MIN_VISIBLE_PX) || !(h >= MIN_VISIBLE_PX)) return null
  const maxZoom = o.maxZoom ?? FIT_MAX_ZOOM
  const minZoom = o.minZoom ?? 0
  const snap = o.snap ?? FIT_ZOOM_SNAP
  const lonSpan = bounds.east - bounds.west
  const latSpan = bounds.north - bounds.south
  // A single point has no span: it is shown at the closest zoom allowed.
  const need = Math.max(lonSpan / w, latSpan / h)
  let zoom = need > 0 ? zoomFor(need) : maxZoom
  zoom = Math.floor(zoom / snap + 1e-9) * snap
  zoom = Math.max(minZoom, Math.min(maxZoom, zoom))
  const dpp = degPerPx(zoom)
  // The free part's middle, measured from the container's middle: right and down are positive.
  const dx = (insets.left - insets.right) / 2
  const dy = (insets.top - insets.bottom) / 2
  return {
    center: {
      lat: (bounds.south + bounds.north) / 2 + dy * dpp,
      lon: (bounds.west + bounds.east) / 2 - dx * dpp,
    },
    zoom,
  }
}

/** Where a point lands in the container for a view, in pixels from its top-left corner. */
export function project(p: LatLon, view: FitView, size: Size): { x: number; y: number } {
  const dpp = degPerPx(view.zoom)
  return { x: size.width / 2 + (p.lon - view.center.lon) / dpp, y: size.height / 2 - (p.lat - view.center.lat) / dpp }
}

/** A request to fit once the route for these checkpoints is ready. */
export interface FitRequest {
  /** The checkpoint list the request was made for, by identity. */
  points: readonly LatLon[]
}

export interface AutoFitState {
  request: FitRequest | null
  /** The checkpoint list now on screen. */
  points: readonly LatLon[]
  /** A complete route for those checkpoints is on screen. */
  routeReady: boolean
  /** The 2D map is the view in use. */
  mapShown: boolean
}

/**
 * Whether the map should fit the route now, without being asked. Only a pending
 * request does it, and only for the checkpoints it was made for: the request is
 * made when an example mission is loaded and dropped once it is carried out, so
 * a new route for the same checkpoints (another priority, another limit, a
 * recalculation) finds no request and leaves the camera where the user put it.
 */
export function shouldAutoFit(s: AutoFitState): boolean {
  return !!s.request && s.request.points === s.points && s.routeReady && s.mapShown
}

/** Whether a request has gone stale: the user has changed the checkpoints since it was made. */
export function fitRequestStale(request: FitRequest | null, points: readonly LatLon[]): boolean {
  return !!request && request.points !== points
}
