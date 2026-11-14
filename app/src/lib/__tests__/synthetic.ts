// Small synthetic terrains for routing tests.
import { cellCenter, type LatLon, type Terrain } from '../terrain'

export const CELL = 4 // metres
const M_PER_DEG = (Math.PI * 3_396_190) / 180
const SCALE_DEG = 0.01
const NODATA = 65535

/**
 * Builds a terrain from per-cell values.
 * slope: degrees (NaN = no data). elevation: metres (default 0).
 */
export function makeTerrain(
  width: number,
  height: number,
  slope: (x: number, y: number) => number,
  elevation: (x: number, y: number) => number = () => 0,
  /** Steep 1 m source pixels in each cell, 0..16. Omit for terrain without subcell data. */
  hiddenSteep?: (x: number, y: number) => number,
): Terrain {
  const elevRaw = new Uint16Array(width * height)
  const slopeRaw = new Uint16Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = slope(x, y)
      // Same conservative encoding as scripts/prepare_terrain.py: round up.
      slopeRaw[y * width + x] = Number.isNaN(s) ? NODATA : Math.min(Math.ceil(s / SCALE_DEG - 1e-9), NODATA - 1)
      elevRaw[y * width + x] = Math.round(elevation(x, y) / 0.1)
    }
  }
  const sub = hiddenSteep
    ? {
        subSteep: Uint8Array.from({ length: width * height }, (_, i) => hiddenSteep(i % width, Math.floor(i / width))),
        subValid: new Uint8Array(width * height).fill(16),
      }
    : {}
  return {
    width,
    height,
    elevRaw,
    slopeRaw,
    ...sub,
    meta: {
      name: 'synthetic',
      bbox: { west: 0, south: 0, east: (width * CELL) / M_PER_DEG, north: (height * CELL) / M_PER_DEG },
      width,
      height,
      cellSizeX_m: CELL,
      cellSizeY_m: CELL,
      elevation: { file: '', min_m: 0, max_m: 0, scale_m: 0.1 },
      slope: { file: '', dtype: 'uint16-le', scale_deg: SCALE_DEG, nodata: NODATA },
      source: { dataset: '', provider: '', url: '', retrieved: '' },
    },
  }
}

export const at = (t: Terrain, x: number, y: number): LatLon => cellCenter(t, y * t.width + x)

/** Column and row of a point returned by the router (cell centres). */
export function cellOf(t: Terrain, p: LatLon): { x: number; y: number } {
  const b = t.meta.bbox
  return {
    x: Math.floor(((p.lon - b.west) / (b.east - b.west)) * t.width),
    y: Math.floor(((b.north - p.lat) / (b.north - b.south)) * t.height),
  }
}

/** Deterministic pseudo-random numbers, so failures can be reproduced. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
