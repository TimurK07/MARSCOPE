// Geometry of the Mars globe. Pure functions, no rendering library.
//
// Conventions (same as the NASA map data the 2D workspace uses):
//   - Mars 2000 sphere, so planetocentric and planetographic latitude coincide
//   - latitude positive north, longitude positive east, in -180..180
//   - globe space: unit sphere, +Y through the north pole, +X through (0°, 0°),
//     and -Z through (0°, 90°E), so east is to the right with north up

import type { LatLon } from './terrain'

export type Vec3 = [number, number, number]

/** [south, west, north, east] in degrees. */
export type BBox = [number, number, number, number]

const RAD = Math.PI / 180

/** Normalises a longitude to -180..180. */
export function wrapLon(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180
  return w === -180 && lon > 0 ? 180 : w
}

export function latLonToUnit(p: LatLon): Vec3 {
  const phi = p.lat * RAD
  const lam = p.lon * RAD
  return [Math.cos(phi) * Math.cos(lam), Math.sin(phi), -Math.cos(phi) * Math.sin(lam)]
}

export function unitToLatLon(v: Vec3): LatLon {
  const len = Math.hypot(v[0], v[1], v[2])
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v[1] / len))) / RAD,
    lon: Math.atan2(-v[2], v[0]) / RAD,
  }
}

/** Texture coordinates of a point on an equirectangular map with origin at (-180°, 90°). */
export function equirectUv(p: LatLon): { u: number; v: number } {
  return { u: (wrapLon(p.lon) + 180) / 360, v: (90 - p.lat) / 180 }
}

/** Great-circle angle between two points, radians. */
export function angularDistance(a: LatLon, b: LatLon): number {
  const u = latLonToUnit(a)
  const v = latLonToUnit(b)
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  return Math.acos(Math.max(-1, Math.min(1, dot)))
}

/** Point a fraction t of the way along the great circle from a to b. Safe across the antimeridian. */
export function slerp(a: LatLon, b: LatLon, t: number): LatLon {
  const u = latLonToUnit(a)
  const v = latLonToUnit(b)
  const omega = angularDistance(a, b)
  if (omega < 1e-9) return { ...a }
  const s = Math.sin(omega)
  const ka = Math.sin((1 - t) * omega) / s
  const kb = Math.sin(t * omega) / s
  return unitToLatLon([ka * u[0] + kb * v[0], ka * u[1] + kb * v[1], ka * u[2] + kb * v[2]])
}

/**
 * Splits a path so that no segment spans more than maxStepRad on the sphere,
 * adding great-circle points where needed. A straight chord between distant
 * points would cut through the planet.
 */
export function densifyPath(path: LatLon[], maxStepRad: number): LatLon[] {
  const out: LatLon[] = []
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const omega = angularDistance(path[i - 1], path[i])
      const n = Math.ceil(omega / maxStepRad)
      for (let k = 1; k < n; k++) out.push(slerp(path[i - 1], path[i], k / n))
    }
    out.push(path[i])
  }
  return out
}

/**
 * Camera altitude (in planet radii) at which a nadir view through a perspective
 * camera shows the same north-south extent as the 2D map at a given zoom.
 *
 * The 2D map is equirectangular with 256 px tiles and two tiles across at zoom 0,
 * so one pixel spans pi / (256 * 2^zoom) radians of latitude.
 */
export function altitudeForZoom(zoom: number, viewportHeightPx: number, fovDeg: number): number {
  const theta = (fovDeg / 2) * RAD
  const alpha = (viewportHeightPx / 2) * (Math.PI / (256 * 2 ** zoom))
  // Beyond this the whole disc is in view and the relation no longer holds.
  const a = Math.min(alpha, Math.PI / 2 - theta - 1e-6)
  return Math.sin(a + theta) / Math.sin(theta) - 1
}

/** Inverse of altitudeForZoom. */
export function zoomForAltitude(altitude: number, viewportHeightPx: number, fovDeg: number): number {
  const theta = (fovDeg / 2) * RAD
  const s = Math.min(1, (1 + altitude) * Math.sin(theta))
  const alpha = Math.max(Math.asin(s) - theta, 1e-12)
  return Math.log2((Math.PI * viewportHeightPx) / (512 * alpha))
}

export function inBBox(p: LatLon, b: BBox): boolean {
  return p.lat >= b[0] && p.lat <= b[2] && p.lon >= b[1] && p.lon <= b[3]
}

/** Grows a box by a fraction of its size on every side. */
export function expandBBox(b: BBox, fraction: number): BBox {
  const dLat = (b[2] - b[0]) * fraction
  const dLon = (b[3] - b[1]) * fraction
  return [b[0] - dLat, b[1] - dLon, b[2] + dLat, b[3] + dLon]
}

export interface TileGrid {
  z: number
  /** Inclusive tile ranges. Columns may run past the antimeridian and are wrapped when requested. */
  x0: number
  x1: number
  y0: number
  y1: number
  /** Geographic bounds of the whole grid. */
  bounds: BBox
}

/**
 * Tiles of the Mars Trek equirectangular pyramid that cover a view.
 * At zoom z the grid has 2^(z+1) columns and 2^z rows of 180/2^z degree tiles,
 * with the origin at (-180°, 90°).
 */
export function tileGridFor(center: LatLon, spanLatDeg: number, spanLonDeg: number, z: number, maxCols = 8, maxRows = 6): TileGrid {
  const size = 180 / 2 ** z
  const rows = 2 ** z
  const cx = (center.lon + 180) / size
  const cy = (90 - center.lat) / size
  const halfX = Math.min(spanLonDeg / size, maxCols) / 2
  const halfY = Math.min(spanLatDeg / size, maxRows) / 2
  const x0 = Math.floor(cx - halfX)
  const x1 = Math.max(x0, Math.ceil(cx + halfX) - 1)
  const y0 = Math.max(0, Math.floor(cy - halfY))
  const y1 = Math.min(rows - 1, Math.max(y0, Math.ceil(cy + halfY) - 1))
  return { z, x0, x1, y0, y1, bounds: [90 - (y1 + 1) * size, x0 * size - 180, 90 - y0 * size, (x1 + 1) * size - 180] }
}

/** Column index wrapped into the valid range for zoom z. */
export function wrapTileX(x: number, z: number): number {
  const cols = 2 ** (z + 1)
  return ((x % cols) + cols) % cols
}
