// Raster overlays painted in the browser from the prepared terrain grids.
// These are display products only: they visualise elevation.bin / slope.bin
// and do not change any value the planner uses.

import { MAX_SLOPE_DEG, SLOPE_CLASSES } from './model'
import { elevationAt, slopeAt, type Terrain } from './terrain'

export type HazardMode = 'hazards' | 'classes'

function paint(t: Terrain, fill: (i: number, x: number, y: number, out: Uint8ClampedArray, o: number) => void): string {
  const canvas = document.createElement('canvas')
  canvas.width = t.width
  canvas.height = t.height
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(t.width, t.height)
  for (let y = 0, i = 0; y < t.height; y++) {
    for (let x = 0; x < t.width; x++, i++) fill(i, x, y, img.data, i * 4)
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL()
}

const STEEP = SLOPE_CLASSES.find((c) => c.id === 'steep')!
const SLOW = SLOPE_CLASSES.find((c) => c.id === 'slow')!
const NOGO = SLOPE_CLASSES.find((c) => c.id === 'nogo')!

/**
 * Slope hazard overlay.
 * - 'hazards': only terrain that restricts walking is drawn (steep = tint,
 *   no-go = hatch), so the imagery stays readable.
 * - 'classes': all slope classes of the walking model.
 */
export function hazardImage(t: Terrain, mode: HazardMode): string {
  return paint(t, (i, x, y, out, o) => {
    const s = slopeAt(t, i)
    if (Number.isNaN(s)) return
    if (s > MAX_SLOPE_DEG) {
      const stripe = (x + y) % 5 < 2
      out[o] = NOGO.rgb[0]
      out[o + 1] = NOGO.rgb[1]
      out[o + 2] = NOGO.rgb[2]
      out[o + 3] = stripe ? 215 : 70
    } else if (s > SLOW.maxDeg) {
      out[o] = STEEP.rgb[0]
      out[o + 1] = STEEP.rgb[1]
      out[o + 2] = STEEP.rgb[2]
      out[o + 3] = 105
    } else if (mode === 'classes' && s > SLOPE_CLASSES[0].maxDeg) {
      out[o] = SLOW.rgb[0]
      out[o + 1] = SLOW.rgb[1]
      out[o + 2] = SLOW.rgb[2]
      out[o + 3] = 70
    }
  })
}

/** Colour ramp for the elevation tint, low to high. */
export const ELEVATION_RAMP: [number, number, number][] = [
  [38, 52, 96],
  [52, 118, 142],
  [118, 176, 160],
  [222, 200, 138],
  [246, 240, 228],
]

export function elevationImage(t: Terrain): string {
  const lo = t.meta.elevation.min_m
  const span = t.meta.elevation.max_m - lo
  const n = ELEVATION_RAMP.length - 1
  return paint(t, (i, _x, _y, out, o) => {
    const f = Math.min(Math.max((elevationAt(t, i) - lo) / span, 0), 1) * n
    const k = Math.min(Math.floor(f), n - 1)
    const u = f - k
    const a = ELEVATION_RAMP[k]
    const b = ELEVATION_RAMP[k + 1]
    out[o] = a[0] + (b[0] - a[0]) * u
    out[o + 1] = a[1] + (b[1] - a[1]) * u
    out[o + 2] = a[2] + (b[2] - a[2]) * u
    out[o + 3] = 255
  })
}

export const CONTOUR_INTERVAL_M = 25
export const CONTOUR_INDEX_M = 100

/** Elevation contours: a cell is on a contour when the level changes to its east or south neighbour. */
export function contourImage(t: Terrain): string {
  const w = t.width
  const h = t.height
  const level = (i: number, step: number) => Math.floor(elevationAt(t, i) / step)
  return paint(t, (i, x, y, out, o) => {
    if (x === w - 1 || y === h - 1) return
    const index = level(i, CONTOUR_INDEX_M) !== level(i + 1, CONTOUR_INDEX_M) || level(i, CONTOUR_INDEX_M) !== level(i + w, CONTOUR_INDEX_M)
    const minor =
      index ||
      level(i, CONTOUR_INTERVAL_M) !== level(i + 1, CONTOUR_INTERVAL_M) ||
      level(i, CONTOUR_INTERVAL_M) !== level(i + w, CONTOUR_INTERVAL_M)
    if (!minor) return
    out[o] = 244
    out[o + 1] = 236
    out[o + 2] = 222
    out[o + 3] = index ? 210 : 105
  })
}
