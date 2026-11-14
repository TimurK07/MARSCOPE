// Terrain grid for the study area, produced by scripts/prepare_terrain.py
// from the MRO HiRISE Gale Crater DEM (NASA JPL Mars Trek).

export interface TerrainMeta {
  name: string
  bbox: { west: number; south: number; east: number; north: number }
  width: number
  height: number
  cellSizeX_m: number
  cellSizeY_m: number
  elevation: { file: string; min_m: number; max_m: number; scale_m: number }
  /** Slope is stored rounded up, so a stored value is never below the true slope. */
  slope: { file: string; dtype: string; scale_deg: number; nodata: number }
  /** Steep ground hidden inside cells, measured on the ~1 m source grid. Optional. */
  subcell?: { file: string; pixelsPerCell: number; limit_deg: number; pixel_m: number }
  source: { dataset: string; provider: string; url: string; retrieved: string }
}

export interface Terrain {
  meta: TerrainMeta
  width: number
  height: number
  elevRaw: Uint16Array
  slopeRaw: Uint16Array
  /** Per cell: number of ~1 m source pixels steeper than the limit. */
  subSteep?: Uint8Array
  /** Per cell: number of ~1 m source pixels with a valid slope. */
  subValid?: Uint8Array
}

export interface LatLon {
  lat: number
  lon: number
}

const BASE = `${import.meta.env.BASE_URL}data/gale/`

/** Splits the interleaved [steep, valid] pairs of subcell.bin. */
export function splitSubcell(buf: ArrayBuffer): { subSteep: Uint8Array; subValid: Uint8Array } {
  const pairs = new Uint8Array(buf)
  const n = pairs.length / 2
  const subSteep = new Uint8Array(n)
  const subValid = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    subSteep[i] = pairs[2 * i]
    subValid[i] = pairs[2 * i + 1]
  }
  return { subSteep, subValid }
}

export async function loadTerrain(): Promise<Terrain> {
  const meta: TerrainMeta = await fetch(`${BASE}meta.json`).then((r) => r.json())
  const [elevBuf, slopeBuf, subBuf] = await Promise.all([
    fetch(BASE + meta.elevation.file).then((r) => r.arrayBuffer()),
    fetch(BASE + meta.slope.file).then((r) => r.arrayBuffer()),
    meta.subcell ? fetch(BASE + meta.subcell.file).then((r) => r.arrayBuffer()) : Promise.resolve(null),
  ])
  return {
    meta,
    width: meta.width,
    height: meta.height,
    elevRaw: new Uint16Array(elevBuf),
    slopeRaw: new Uint16Array(slopeBuf),
    ...(subBuf ? splitSubcell(subBuf) : {}),
  }
}

/** Grid cell index for a coordinate, or -1 when outside the study area. */
export function cellAt(t: Terrain, p: LatLon): number {
  const { west, south, east, north } = t.meta.bbox
  const col = Math.floor(((p.lon - west) / (east - west)) * t.width)
  const row = Math.floor(((north - p.lat) / (north - south)) * t.height)
  if (col < 0 || row < 0 || col >= t.width || row >= t.height) return -1
  return row * t.width + col
}

/** Coordinate of a cell centre. */
export function cellCenter(t: Terrain, idx: number): LatLon {
  const { west, south, east, north } = t.meta.bbox
  const col = idx % t.width
  const row = (idx - col) / t.width
  return {
    lat: north - ((row + 0.5) / t.height) * (north - south),
    lon: west + ((col + 0.5) / t.width) * (east - west),
  }
}

/** Elevation in metres (relative to the Mars areoid, as in the source DEM). */
export function elevationAt(t: Terrain, idx: number): number {
  return t.meta.elevation.min_m + t.elevRaw[idx] * t.meta.elevation.scale_m
}

/** Terrain slope in degrees, or NaN where the DEM has no data. */
export function slopeAt(t: Terrain, idx: number): number {
  const v = t.slopeRaw[idx]
  return v === t.meta.slope.nodata ? NaN : v * t.meta.slope.scale_deg
}

/**
 * Elevation at any point of the grid, in metres, by bilinear interpolation
 * between cell centres. (fx, fy) are in cell units: the centre of cell (x, y)
 * is at (x + 0.5, y + 0.5).
 */
export function elevationAtPoint(t: Terrain, fx: number, fy: number): number {
  const gx = Math.min(Math.max(fx - 0.5, 0), t.width - 1)
  const gy = Math.min(Math.max(fy - 0.5, 0), t.height - 1)
  const x0 = Math.min(Math.floor(gx), t.width - 2 < 0 ? 0 : t.width - 2)
  const y0 = Math.min(Math.floor(gy), t.height - 2 < 0 ? 0 : t.height - 2)
  const x1 = Math.min(x0 + 1, t.width - 1)
  const y1 = Math.min(y0 + 1, t.height - 1)
  const u = gx - x0
  const v = gy - y0
  const z = (x: number, y: number) => elevationAt(t, y * t.width + x)
  return z(x0, y0) * (1 - u) * (1 - v) + z(x1, y0) * u * (1 - v) + z(x0, y1) * (1 - u) * v + z(x1, y1) * u * v
}

/** Coordinate of a point given in cell units. */
export function pointToLatLon(t: Terrain, fx: number, fy: number): LatLon {
  const { west, south, east, north } = t.meta.bbox
  return { lat: north - (fy / t.height) * (north - south), lon: west + (fx / t.width) * (east - west) }
}

/**
 * Share of a cell's ~1 m source pixels that are steeper than the slope limit,
 * from 0 to 1, or null where that is unknown (no subcell data, or no valid
 * source pixels). A derived roughness indicator, not a probability of harm.
 */
export function hiddenSteepShare(t: Terrain, idx: number): number | null {
  if (!t.subSteep || !t.subValid) return null
  const valid = t.subValid[idx]
  return valid === 0 ? null : t.subSteep[idx] / valid
}
