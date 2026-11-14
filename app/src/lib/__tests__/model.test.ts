import { describe, expect, it } from 'vitest'
import { backgroundDoseMsv, MAX_SLOPE_DEG, MAX_SPEED_MS, PLANNING_PACE, planningSpeedMs, RADIATION, segmentEnergy, slopeClass, surfaceDistanceM, walkingSpeedMs } from '../model'

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

describe('planning pace', () => {
  const CAP = 2000 / 3600

  it('is 2 km/h, stated in both units', () => {
    expect(PLANNING_PACE.max_kmh).toBe(2)
    expect(PLANNING_PACE.max_ms).toBe(CAP)
    expect(PLANNING_PACE.max_ms * 3.6).toBeCloseTo(2, 12)
  })

  it('is the model speed, never above the cap, at every grade', () => {
    for (let g = -40; g <= 40; g += 0.01) {
      const v = planningSpeedMs(g)
      expect(v).toBe(Math.min(walkingSpeedMs(g), CAP))
      expect(v).toBeLessThanOrEqual(CAP)
      expect(v).toBeLessThanOrEqual(walkingSpeedMs(g))
      expect(v).toBeGreaterThan(0)
    }
  })

  it('caps level ground and gentle slopes, uphill and downhill', () => {
    for (const g of [-14, -10, -5, -1, 0, 1, 3, 5]) {
      expect(walkingSpeedMs(g)).toBeGreaterThan(CAP)
      expect(planningSpeedMs(g)).toBe(CAP)
    }
  })

  it('leaves the model alone where the model is already slower', () => {
    for (const g of [-25, -20, -18, -15, 5.5, 6, 8, 10, 12, 14, 14.9, 15, 15.1, 18, 20, 30]) {
      expect(walkingSpeedMs(g)).toBeLessThan(CAP)
      expect(planningSpeedMs(g)).toBe(walkingSpeedMs(g))
    }
  })

  it('takes over from the model where the two cross', () => {
    // Uphill the model falls to the cap at (1.6 - cap) / 0.2 degrees; downhill at (cap - 1.95) / 0.095.
    const up = (1.6 - CAP) / 0.2
    const down = (CAP - 1.95) / 0.095
    expect(up).toBeCloseTo(5.222, 3)
    expect(down).toBeCloseTo(-14.678, 3)
    expect(planningSpeedMs(up - 0.01)).toBe(CAP)
    expect(planningSpeedMs(up + 0.01)).toBeLessThan(CAP)
    expect(planningSpeedMs(down + 0.01)).toBe(CAP)
    expect(planningSpeedMs(down - 0.01)).toBeLessThan(CAP)
  })

  it('does not change the model around 15 degrees, where SEXTANT holds the speed at 0.05 m/s', () => {
    // The fitted line reaches 0.049 m/s at 15 degrees; beyond it the speed is held at 0.05 m/s.
    expect(walkingSpeedMs(15)).toBeCloseTo(0.049, 6)
    expect(walkingSpeedMs(15.0001)).toBe(0.05)
    expect(walkingSpeedMs(20)).toBe(0.05)
    expect(walkingSpeedMs(-20)).toBeCloseTo(0.05, 9)
    expect(walkingSpeedMs(-20.0001)).toBe(0.05)
    for (const g of [14.99, 15, 15.01, 19.99, 20, -19.99, -20, -20.01]) expect(planningSpeedMs(g)).toBe(walkingSpeedMs(g))
  })

  it('leaves the model\'s own coefficients untouched', () => {
    expect(walkingSpeedMs(0)).toBe(1.6)
    expect(walkingSpeedMs(6)).toBeCloseTo(0.4, 12)
    expect(walkingSpeedMs(3)).toBeCloseTo(1.0, 12)
    expect(walkingSpeedMs(-10)).toBeCloseTo(1.0, 12)
    expect(walkingSpeedMs(-5)).toBeCloseTo(1.3, 12)
    expect(walkingSpeedMs(10)).toBeCloseTo(0.244, 12)
  })
})

describe('background radiation dose', () => {
  it('keeps the rate it had', () => {
    expect(RADIATION.doseEquivalent_mSv_per_day).toBe(0.67)
    expect(RADIATION.careerLimit_mSv).toBe(600)
  })

  it('is the surface rate times the time outside, and nothing else', () => {
    expect(backgroundDoseMsv(0)).toBe(0)
    expect(backgroundDoseMsv(86_400)).toBeCloseTo(0.67, 12)
    expect(backgroundDoseMsv(3600)).toBeCloseTo(0.67 / 24, 12)
    expect(backgroundDoseMsv(8 * 3600)).toBeCloseTo(0.67 / 3, 12)
    for (const s of [60, 4_680, 6_060, 28_800, 100_000]) expect(backgroundDoseMsv(s)).toBe((0.67 * s) / 86_400)
  })

  it('is proportional to the duration', () => {
    expect(backgroundDoseMsv(7200)).toBeCloseTo(2 * backgroundDoseMsv(3600), 15)
    expect(backgroundDoseMsv(6060) / backgroundDoseMsv(4680)).toBeCloseTo(6060 / 4680, 12)
  })
})
