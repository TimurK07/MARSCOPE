import { describe, expect, it } from 'vitest'
import { adviceFor, durationAdvice, rangeAdvice } from '../advice'
import { EVA } from '../model'

const habitat = { lat: -4.826, lon: 137.389 }
// About 59.27 km per degree of latitude on Mars.
const north = (km: number) => ({ lat: habitat.lat + km / 59.27, lon: habitat.lon })

describe('duration advice', () => {
  it('gives the longest stop time that fits the EVA limit', () => {
    const walkTime = 2 * 3600
    const text = durationAdvice({ points: [habitat, north(0.5), north(1)], walkTime, stopMinutes: 240, farthest: 1000 })
    // (8 h - 2 h) / 2 targets = 180 min each
    expect(text).toContain('180 min or less')
    expect(walkTime + 2 * 180 * 60).toBeLessThanOrEqual(EVA.maxDuration_h * 3600)
  })

  it('says so when walking alone is already over the limit', () => {
    const text = durationAdvice({ points: [habitat, north(1)], walkTime: 9 * 3600, stopMinutes: 20, farthest: 1000 })
    expect(text).toContain('Walking alone takes 9 h 00 min')
  })
})

describe('range advice', () => {
  it('names the targets beyond the walking range', () => {
    const text = rangeAdvice({ points: [habitat, north(1), north(2.5)], walkTime: 0, stopMinutes: 20, farthest: 2500 })
    expect(text).toContain('target 2 (2.50 km)')
    expect(text).not.toContain('target 1')
  })

  it('explains a detour when every checkpoint is in range', () => {
    const text = rangeAdvice({ points: [habitat, north(1.5)], walkTime: 0, stopMinutes: 20, farthest: 2300 })
    expect(text).toContain('swings out to 2.30 km')
  })
})

describe('adviceFor', () => {
  it('has no advice for the slope check, which the route search already enforces', () => {
    expect(adviceFor('slope', { points: [habitat], walkTime: 0, stopMinutes: 0, farthest: 0 })).toBeNull()
  })
})
