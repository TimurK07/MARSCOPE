import { describe, expect, it } from 'vitest'
import { adviceFor, durationAdvice, nearestCheckpoint, walkBackAdvice } from '../advice'
import { EVA } from '../model'
import type { WalkBack } from '../router'

const habitat = { lat: -4.826, lon: 137.389 }
// About 59.27 km per degree of latitude on Mars.
const north = (km: number) => ({ lat: habitat.lat + km / 59.27, lon: habitat.lon })
const back = (over: Partial<WalkBack>): WalkBack => ({
  maxDistance: 500,
  maxTime: 600,
  maxDistanceAt: north(0.5),
  maxTimeAt: north(0.5),
  reachable: true,
  ...over,
})

describe('duration advice', () => {
  it('gives the longest stop time that fits the EVA limit', () => {
    const walkTime = 2 * 3600
    const text = durationAdvice({ points: [habitat, north(0.5), north(1)], walkTime, stopMinutes: 240, walkBack: back({}) })
    // (8 h - 2 h) / 2 targets = 180 min each
    expect(text).toContain('180 min or less')
    expect(walkTime + 2 * 180 * 60).toBeLessThanOrEqual(EVA.maxDuration_h * 3600)
  })

  it('says so when walking alone is already over the limit', () => {
    const text = durationAdvice({ points: [habitat, north(1)], walkTime: 9 * 3600, stopMinutes: 20, walkBack: back({}) })
    expect(text).toContain('Walking alone takes 9 h 00 min')
  })
})

describe('walk-back advice', () => {
  const points = [habitat, north(1), north(2.4)]

  it('names the checkpoint nearest to the worst point', () => {
    expect(nearestCheckpoint(points, north(2.3))).toBe('target 2')
    expect(nearestCheckpoint(points, north(0.1))).toBe('the habitat')
  })

  it('reports the longest way back and where it starts', () => {
    const text = walkBackAdvice({ points, walkTime: 0, stopMinutes: 20, walkBack: back({ maxDistance: 2600, maxDistanceAt: north(2.4) }) }, 'distance')
    expect(text).toContain('2.60 km')
    expect(text).toContain('target 2')
  })

  it('reports the slowest way back', () => {
    const text = walkBackAdvice({ points, walkTime: 0, stopMinutes: 20, walkBack: back({ maxTime: 75 * 60, maxTimeAt: north(1) }) }, 'time')
    expect(text).toContain('1 h 15 min')
    expect(text).toContain('target 1')
  })

  it('says when there is no safe way back', () => {
    const text = walkBackAdvice({ points, walkTime: 0, stopMinutes: 20, walkBack: back({ reachable: false }) }, 'time')
    expect(text).toContain('no safe way back')
  })
})

describe('adviceFor', () => {
  it('routes each check to its advice', () => {
    const input = { points: [habitat, north(1)], walkTime: 9 * 3600, stopMinutes: 20, walkBack: back({}) }
    expect(adviceFor('duration', input)).toContain('Walking alone')
    expect(adviceFor('walkback-distance', input)).toContain('longest way back')
    expect(adviceFor('walkback-time', input)).toContain('slowest way back')
    expect(adviceFor('unknown', input)).toBeNull()
  })
})
