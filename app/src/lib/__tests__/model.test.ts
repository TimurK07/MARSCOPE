import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG, MAX_SPEED_MS, segmentEnergy, slopeClass, surfaceDistanceM, walkingSpeedMs } from '../model'

describe('walking speed model', () => {
  it('is fastest on level ground', () => {
    expect(walkingSpeedMs(0)).toBeCloseTo(MAX_SPEED_MS)
    for (let s = -30; s <= 30; s += 0.5) expect(walkingSpeedMs(s)).toBeLessThanOrEqual(MAX_SPEED_MS + 1e-9)
  })

  it('is continuous at the breakpoints of the piecewise function', () => {
    for (const b of [-20, -10, 0, 6, 15]) {
      expect(walkingSpeedMs(b - 1e-6)).toBeCloseTo(walkingSpeedMs(b + 1e-6), 2)
    }
  })

  it('never stops completely, so every traversable step has a finite cost', () => {
    for (let s = -40; s <= 40; s += 1) expect(walkingSpeedMs(s)).toBeGreaterThan(0)
  })
})

describe('metabolic cost model', () => {
  it('costs more uphill than on the level, and less downhill than uphill', () => {
    const e = (grade: number) => {
      const { perKg, fixed } = segmentEnergy(100, grade, walkingSpeedMs(grade))
      return perKg * 180 + fixed
    }
    expect(e(5)).toBeGreaterThan(e(0))
    expect(e(-5)).toBeLessThan(e(5))
    expect(e(0)).toBeGreaterThan(0)
  })
})

describe('slope classes', () => {
  it('marks terrain above the NASA limit as no-go', () => {
    expect(slopeClass(MAX_SLOPE_DEG).id).not.toBe('nogo')
    expect(slopeClass(MAX_SLOPE_DEG + 0.5).id).toBe('nogo')
    expect(slopeClass(2).id).toBe('easy')
  })
})

describe('distance on the Mars sphere', () => {
  it('gives about 59.3 km per degree of latitude', () => {
    const d = surfaceDistanceM({ lat: 0, lon: 137 }, { lat: 1, lon: 137 })
    expect(d / 1000).toBeCloseTo(59.27, 1)
  })
})
