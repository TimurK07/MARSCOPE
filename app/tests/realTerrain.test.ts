// Safety invariants checked on the real Gale terrain grid.
import { describe, expect, it, vi } from 'vitest'
import { MAX_SLOPE_DEG } from '../src/lib/model'
import { lineCells } from '../src/lib/pathGeometry'
import { findLeg, isWalkable, walkBack } from '../src/lib/router'
import { cellAt, elevationAt, hiddenSteepShare, slopeAt } from '../src/lib/terrain'
import { EXAMPLE, loadTerrainFromDisk } from './loadTerrain'

// These tests search the full 1024 x 1024 grid; when the whole suite runs in parallel they need more than the default 5 s.
vi.setConfig({ testTimeout: 120_000 })

const t = loadTerrainFromDisk()

/** Every line of a route is re-checked independently of the code that built it. */
function checkVertices(vertices: { lat: number; lon: number }[]) {
  const w = t.width
  const cells = vertices.map((p) => cellAt(t, p))
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1]
    const b = cells[i]
    const crossed = lineCells(t, a % w, Math.floor(a / w), b % w, Math.floor(b / w))
    expect(crossed).not.toBeNull()
    for (const c of crossed!) expect(slopeAt(t, c)).toBeLessThanOrEqual(MAX_SLOPE_DEG)
  }
}

function checkPath(path: { lat: number; lon: number }[]) {
  // Samples of a straightened route are a few metres apart: each must lie on walkable ground.
  for (const p of path) expect(isWalkable(t, cellAt(t, p))).toBe(true)
}

describe('real terrain', () => {
  it('stores slope in hundredths of a degree, rounded up', () => {
    expect(t.meta.slope.scale_deg).toBe(0.01)
    expect(t.slopeRaw.length).toBe(t.width * t.height)
    // Some cells sit just above the limit; none of them may read as walkable.
    let justOver = 0
    for (let i = 0; i < t.slopeRaw.length; i++) {
      const s = slopeAt(t, i)
      if (s > 20 && s <= 20.25) {
        justOver++
        expect(isWalkable(t, i)).toBe(false)
      }
    }
    expect(justOver).toBeGreaterThan(1000)
  })

  it('keeps the example mission on safe ground, with a way back', () => {
    const seq = [...EXAMPLE, EXAMPLE[0]]
    const samples: { lat: number; lon: number }[] = []
    for (let i = 0; i < seq.length - 1; i++) {
      const r = findLeg(t, seq[i], seq[i + 1])
      expect(r.ok).toBe(true)
      if (!r.ok) return
      checkPath(r.leg.samples)
      checkVertices(r.leg.vertices)
      // Straightening may only help: never slower, never more hidden steep ground.
      expect(r.leg.duration).toBeLessThanOrEqual(r.leg.grid.duration + 1e-6)
      const raw = findLeg(t, seq[i], seq[i + 1], { smooth: false })
      if (raw.ok) expect(r.leg.hiddenLoad!).toBeLessThanOrEqual(raw.leg.hiddenLoad! + 1e-9)
      samples.push(...r.leg.samples)
    }
    const back = walkBack(t, EXAMPLE[0], samples)!
    expect(back.reachable).toBe(true)
    expect(back.maxDistance).toBeGreaterThan(0)
    expect(back.maxTime).toBeGreaterThan(0)
  })

  it('keeps long routes across the study area on safe ground', () => {
    const b = t.meta.bbox
    const pairs = [
      [{ lat: b.south + 0.008, lon: b.west + 0.012 }, { lat: b.north - 0.012, lon: b.east - 0.02 }],
      [EXAMPLE[0], { lat: -4.8442, lon: 137.372 }],
      [{ lat: -4.8355, lon: 137.3652 }, EXAMPLE[2]],
    ]
    let found = 0
    for (const [from, to] of pairs) {
      const r = findLeg(t, from, to)
      if (!r.ok) continue
      found++
      checkPath(r.leg.samples)
      checkVertices(r.leg.vertices)
      expect(r.leg.duration).toBeLessThanOrEqual(r.leg.grid.duration + 1e-6)
      expect(r.leg.maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG)
    }
    expect(found).toBeGreaterThan(0)
  })

  it('stores elevation in 2 cm steps that cover the whole relief', () => {
    expect(t.meta.elevation.scale_m).toBe(0.02)
    let max = 0
    for (let i = 0; i < t.elevRaw.length; i += 97) if (t.elevRaw[i] > max) max = t.elevRaw[i]
    expect(max).toBeLessThan(65535)
    expect(elevationAt(t, 0)).toBeGreaterThan(-4000)
    expect(elevationAt(t, 0)).toBeLessThan(-2900)
  })

  it('has a consistent hidden-steepness grid from the 1 m DEM', () => {
    expect(t.subSteep!.length).toBe(t.width * t.height)
    expect(t.subValid!.length).toBe(t.width * t.height)
    let walkable = 0
    let withHidden = 0
    let blockedCells = 0
    let blockedShare = 0
    for (let i = 0; i < t.subSteep!.length; i++) {
      expect(t.subValid![i]).toBeLessThanOrEqual(16)
      expect(t.subSteep![i]).toBeLessThanOrEqual(t.subValid![i])
      const share = hiddenSteepShare(t, i)
      if (isWalkable(t, i)) {
        walkable++
        if (share) withHidden++
      } else if (share != null) {
        blockedCells++
        blockedShare += share
      }
    }
    // Some walkable cells hide steep ground, but they are a minority.
    expect(withHidden / walkable).toBeGreaterThan(0.02)
    expect(withHidden / walkable).toBeLessThan(0.4)
    // Cells over the limit at 4 m are, on average, mostly steep at 1 m too: the two grids agree.
    expect(blockedShare / blockedCells).toBeGreaterThan(0.5)
  })
})
