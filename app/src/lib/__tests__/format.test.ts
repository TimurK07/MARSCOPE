import { describe, expect, it } from 'vitest'
import { fmtDose, fmtSlope } from '../format'
import { backgroundDoseMsv, MAX_SLOPE_DEG } from '../model'
import { isWalkable } from '../traverse'
import { makeTerrain } from './synthetic'

describe('slope shown next to the 20 degree limit', () => {
  const show = (deg: number) => fmtSlope(deg, MAX_SLOPE_DEG)

  it('never shows a blocked slope as 20.0', () => {
    for (const deg of [20.0001, 20.01, 20.03, 20.049, 20.05, 20.09, 20.1]) {
      expect(show(deg)).toBe('20.1°')
      expect(parseFloat(show(deg))).toBeGreaterThan(MAX_SLOPE_DEG)
    }
    expect(show(20.11)).toBe('20.2°')
    expect(show(24.96)).toBe('25.0°')
  })

  it('never shows a walkable slope above the limit, or above what it is', () => {
    expect(show(20)).toBe('20.0°')
    expect(show(19.99)).toBe('19.9°')
    expect(show(19.96)).toBe('19.9°')
    expect(show(19.9)).toBe('19.9°')
    expect(show(17.35)).toBe('17.3°')
    expect(show(0)).toBe('0.0°')
    for (let deg = 0; deg <= 20; deg += 0.013) expect(parseFloat(show(deg))).toBeLessThanOrEqual(deg + 1e-9)
  })

  it('agrees with what is walkable for every stored slope value around the limit', () => {
    // Slopes are stored in hundredths of a degree, rounded up. Every value from 19.00 to 21.00:
    for (let cdeg = 1900; cdeg <= 2100; cdeg++) {
      const deg = cdeg / 100
      const t = makeTerrain(2, 2, () => deg)
      const walkable = isWalkable(t, 0)
      const shown = parseFloat(show(deg))
      expect(walkable).toBe(deg <= MAX_SLOPE_DEG)
      // The figure on screen is on the same side of the limit as the cell itself.
      expect(shown <= MAX_SLOPE_DEG).toBe(walkable)
    }
  })

  it('stays within a tenth of a degree of the value', () => {
    for (let deg = 0; deg < 45; deg += 0.037) expect(Math.abs(parseFloat(show(deg)) - deg)).toBeLessThan(0.1 + 1e-9)
  })
})

describe('background dose shown', () => {
  it('has two significant figures and its unit', () => {
    expect(fmtDose(0.036444)).toBe('0.036 mSv')
    expect(fmtDose(0.04698)).toBe('0.047 mSv')
    expect(fmtDose(0.1294)).toBe('0.13 mSv')
    expect(fmtDose(0.1875)).toBe('0.19 mSv')
    expect(fmtDose(1.234)).toBe('1.2 mSv')
    expect(fmtDose(0)).toBe('0 mSv')
  })

  it('shows the estimate for a duration, not more digits than that', () => {
    expect(fmtDose(backgroundDoseMsv(78 * 60))).toBe('0.036 mSv')
    expect(fmtDose(backgroundDoseMsv(8 * 3600))).toBe('0.22 mSv')
    for (const s of [600, 4680, 6060, 28_800]) expect(fmtDose(backgroundDoseMsv(s))).toMatch(/^0\.\d{1,4} mSv$/)
  })
})
