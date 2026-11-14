import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG, MAX_SPEED_MS } from '../model'
import { findLeg } from '../router'
import { cellCenter, type Terrain } from '../terrain'

const N = 64
const CELL = 4 // metres

/** Synthetic terrain: flat ground, optionally with a wall of no-go slope. */
function makeTerrain(wall?: { col: number; gapRow?: number }): Terrain {
  const elevRaw = new Uint16Array(N * N)
  const slopeRaw = new Uint8Array(N * N)
  if (wall) {
    for (let row = 0; row < N; row++) {
      if (row === wall.gapRow) continue
      slopeRaw[row * N + wall.col] = (MAX_SLOPE_DEG + 10) / 0.5
    }
  }
  const mPerDeg = (Math.PI * 3_396_190) / 180
  const span = (N * CELL) / mPerDeg
  return {
    width: N,
    height: N,
    elevRaw,
    slopeRaw,
    meta: {
      name: 'test',
      bbox: { west: 0, south: 0, east: span, north: span },
      width: N,
      height: N,
      cellSizeX_m: CELL,
      cellSizeY_m: CELL,
      elevation: { file: '', min_m: 0, max_m: 0, scale_m: 0.1 },
      slope: { file: '', scale_deg: 0.5, nodata: 255 },
      source: { dataset: '', provider: '', url: '', retrieved: '' },
    },
  }
}

const cell = (t: Terrain, col: number, row: number) => cellCenter(t, row * N + col)

describe('route search', () => {
  it('walks straight across flat ground at full speed', () => {
    const t = makeTerrain()
    const res = findLeg(t, cell(t, 5, 32), cell(t, 55, 32))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.distance).toBeCloseTo(50 * CELL, 5)
    expect(res.leg.duration).toBeCloseTo((50 * CELL) / MAX_SPEED_MS, 5)
    expect(res.leg.ascent).toBe(0)
  })

  it('detours through a gap instead of crossing no-go terrain', () => {
    const t = makeTerrain({ col: 30, gapRow: 5 })
    const res = findLeg(t, cell(t, 5, 32), cell(t, 55, 32))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.leg.distance).toBeGreaterThan(50 * CELL * 1.3)
    expect(res.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
    // The only crossing of the wall column is at the gap.
    const crossing = res.leg.samples.filter((s) => Math.abs(s.lon - cell(t, 30, 0).lon) < 1e-9)
    expect(crossing.length).toBeGreaterThan(0)
    for (const s of crossing) expect(s.lat).toBeCloseTo(cell(t, 30, 5).lat, 9)
  })

  it('reports when a target is cut off', () => {
    const t = makeTerrain({ col: 30 })
    const res = findLeg(t, cell(t, 5, 32), cell(t, 55, 32))
    expect(res.ok).toBe(false)
  })

  it('refuses a target placed on no-go terrain or outside the grid', () => {
    const t = makeTerrain({ col: 30 })
    expect(findLeg(t, cell(t, 5, 32), cell(t, 30, 32)).ok).toBe(false)
    expect(findLeg(t, cell(t, 5, 32), { lat: 5, lon: 5 }).ok).toBe(false)
  })
})
