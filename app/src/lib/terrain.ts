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
  source: { dataset: string; provider: string; url: string; retrieved: string }
}

export interface Terrain {
  meta: TerrainMeta
  width: number
  height: number
  elevRaw: Uint16Array
  slopeRaw: Uint16Array
}

export interface LatLon {
  lat: number
  lon: number
}

const BASE = `${import.meta.env.BASE_URL}data/gale/`

export async function loadTerrain(): Promise<Terrain> {
  const meta: TerrainMeta = await fetch(`${BASE}meta.json`).then((r) => r.json())
  const [elevBuf, slopeBuf] = await Promise.all([
    fetch(BASE + meta.elevation.file).then((r) => r.arrayBuffer()),
    fetch(BASE + meta.slope.file).then((r) => r.arrayBuffer()),
  ])
  return {
    meta,
    width: meta.width,
    height: meta.height,
    elevRaw: new Uint16Array(elevBuf),
    slopeRaw: new Uint16Array(slopeBuf),
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
