// Safety invariants checked on the real Gale terrain grid.
import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG } from '../src/lib/model'
import { findLeg, isWalkable, walkBack } from '../src/lib/router'
import { cellAt, slopeAt } from '../src/lib/terrain'
import { EXAMPLE, loadTerrainFromDisk } from './loadTerrain'

const t = loadTerrainFromDisk()

function checkPath(path: { lat: number; lon: number }[]) {
  const w = t.width
  const cells = path.map((p) => cellAt(t, p))
  for (let i = 0; i < cells.length; i++) {
    expect(slopeAt(t, cells[i])).toBeLessThanOrEqual(MAX_SLOPE_DEG)
    if (i === 0) continue
    const ax = cells[i - 1] % w
    const ay = Math.floor(cells[i - 1] / w)
    const bx = cells[i] % w
    const by = Math.floor(cells[i] / w)
    if (ax !== bx && ay !== by) {
      expect(isWalkable(t, ay * w + bx)).toBe(true)
      expect(isWalkable(t, by * w + ax)).toBe(true)
    }
  }
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
    }
    expect(found).toBeGreaterThan(0)
  })
})
