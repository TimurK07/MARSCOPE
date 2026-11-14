import { describe, expect, it } from 'vitest'
import { buildChecks, missionVerdict } from '../mission'
import { EVA } from '../model'
import type { WalkBack } from '../router'

const here = { lat: -4.82, lon: 137.39 }
const back = (maxDistance: number, maxTime: number, reachable = true): WalkBack => ({
  maxDistance,
  maxTime,
  maxDistanceAt: here,
  maxTimeAt: here,
  reachable,
})

describe('mission checks', () => {
  it('passes a short EVA close to the habitat, with margins', () => {
    const checks = buildChecks({ evaSeconds: 2 * 3600, walkBack: back(800, 15 * 60) })
    expect(checks.map((c) => c.ok)).toEqual([true, true, true])
    expect(checks[0].margin).toBe('6 h 00 min to spare')
    expect(checks[1].margin).toBe('1.20 km to spare')
    expect(checks[2].ratio).toBeCloseTo(0.25, 9)
  })

  it('fails each limit independently', () => {
    const dur = buildChecks({ evaSeconds: 9 * 3600, walkBack: back(800, 15 * 60) })
    expect(dur.map((c) => c.ok)).toEqual([false, true, true])
    expect(dur[0].margin).toBe('over by 1 h 00 min')

    const dist = buildChecks({ evaSeconds: 3600, walkBack: back(EVA.walkRadius_km * 1000 + 1, 15 * 60) })
    expect(dist.map((c) => c.ok)).toEqual([true, false, true])

    const time = buildChecks({ evaSeconds: 3600, walkBack: back(900, EVA.walkBackTime_min * 60 + 1) })
    expect(time.map((c) => c.ok)).toEqual([true, true, false])
  })

  it('keeps the distance limit and the time limit apart', () => {
    // Close by but slow to return (a climb), and far but quick: each trips only its own check.
    const closeButSlow = buildChecks({ evaSeconds: 3600, walkBack: back(600, 90 * 60) })
    expect(closeButSlow.find((c) => c.id === 'walkback-distance')!.ok).toBe(true)
    expect(closeButSlow.find((c) => c.id === 'walkback-time')!.ok).toBe(false)
  })

  it('fails when part of the route has no safe way back', () => {
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back(500, 600, false) })
    expect(checks.find((c) => c.id === 'walkback-distance')!.ok).toBe(false)
    expect(checks.find((c) => c.id === 'walkback-time')!.ok).toBe(false)
    expect(buildChecks({ evaSeconds: 3600, walkBack: null }).filter((c) => !c.ok)).toHaveLength(2)
  })
})

describe('mission verdict', () => {
  const pass = buildChecks({ evaSeconds: 3600, walkBack: back(500, 600) })
  const fail = buildChecks({ evaSeconds: 10 * 3600, walkBack: back(500, 600) })

  it('is GO only for a feasible route that passes every check', () => {
    expect(missionVerdict(true, true, pass)).toBe('go')
    expect(missionVerdict(true, true, fail)).toBe('nogo')
  })

  it('can never be GO without a feasible route', () => {
    expect(missionVerdict(true, false, pass)).toBe('noroute')
    expect(missionVerdict(true, false, null)).toBe('noroute')
    expect(missionVerdict(true, true, null)).toBe('noroute')
  })

  it('is standby before there is a plan', () => {
    expect(missionVerdict(false, false, null)).toBe('standby')
  })
})
