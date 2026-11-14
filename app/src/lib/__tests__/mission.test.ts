import { describe, expect, it } from 'vitest'
import { buildChecks, missionVerdict } from '../mission'
import { EVA, RETURN_LIMITS } from '../model'
import type { WalkBack } from '../returnCheck'

const here = { lat: -4.82, lon: 137.39 }
// The return from the worst point of a route: one path, with its length and its duration.
const back = (maxDistance: number, maxTime: number, reachable = true, over: Partial<WalkBack> = {}): WalkBack => ({
  maxDistance,
  maxTime,
  maxDistanceAt: here,
  maxTimeAt: here,
  reachable,
  feasible: reachable && maxDistance <= RETURN_LIMITS.distance_m && maxTime <= RETURN_LIMITS.time_s,
  verified: true,
  ...over,
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

    const dist = buildChecks({ evaSeconds: 3600, walkBack: back(RETURN_LIMITS.distance_m + 1, 15 * 60) })
    expect(dist.map((c) => c.ok)).toEqual([true, false, true])

    const time = buildChecks({ evaSeconds: 3600, walkBack: back(900, RETURN_LIMITS.time_s + 1) })
    expect(time.map((c) => c.ok)).toEqual([true, true, false])
  })

  it('keeps the distance limit and the time limit apart', () => {
    // Close by but slow to return (a climb), and far but quick: each trips only its own check.
    const closeButSlow = buildChecks({ evaSeconds: 3600, walkBack: back(600, 90 * 60) })
    expect(closeButSlow.find((c) => c.id === 'walkback-distance')!.ok).toBe(true)
    expect(closeButSlow.find((c) => c.id === 'walkback-time')!.ok).toBe(false)
  })

  it('never reads as passed when no single way back was shown to meet both limits', () => {
    // Defensive: figures that look fine must not turn into a pass without the joint result.
    const odd = buildChecks({ evaSeconds: 3600, walkBack: back(900, 900, true, { feasible: false }) })
    expect(odd.find((c) => c.id === 'walkback-distance')!.ok).toBe(false)
    expect(odd.find((c) => c.id === 'walkback-time')!.ok).toBe(false)
    expect(missionVerdict(true, true, odd)).toBe('nogo')
  })

  it('calls an exhausted calculation UNVERIFIED: not GO, and not a confirmed NO-GO', () => {
    // The figures are whatever the search had found; they must not be shown as a proven violation.
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back(2100, 3000, true, { feasible: false, verified: false }) })
    const dist = checks.find((c) => c.id === 'walkback-distance')!
    const time = checks.find((c) => c.id === 'walkback-time')!
    expect(dist.ok).toBe(false)
    expect(time.ok).toBe(false)
    expect(dist.state).toBe('unverified')
    expect(time.state).toBe('unverified')
    expect(dist.value).toBe('not verified')
    expect(dist.margin).toContain('calculation limit')
    expect(dist.margin).not.toContain('over by')
    expect(missionVerdict(true, true, checks)).toBe('unverified')
  })

  it('is never GO when the return is unverified, whatever the figures look like', () => {
    for (const [d, s] of [[100, 60], [1999, 3599], [2000, 3600], [5000, 9000]]) {
      const checks = buildChecks({ evaSeconds: 600, walkBack: back(d, s, true, { feasible: false, verified: false }) })
      expect(missionVerdict(true, true, checks)).toBe('unverified')
    }
    // Even a result that claims to be feasible is not GO unless it is also verified.
    const odd = buildChecks({ evaSeconds: 600, walkBack: back(100, 60, true, { feasible: true, verified: false }) })
    expect(missionVerdict(true, true, odd)).not.toBe('go')
  })

  it('keeps a confirmed violation a NO-GO even when the return is unverified', () => {
    const checks = buildChecks({ evaSeconds: 9 * 3600, walkBack: back(2100, 3000, true, { feasible: false, verified: false }) })
    expect(checks[0].state).toBe('fail')
    expect(missionVerdict(true, true, checks)).toBe('nogo')
  })

  it('marks a proven return failure as a failure, not as unverified', () => {
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back(2310, 1900) })
    expect(checks.find((c) => c.id === 'walkback-distance')!.state).toBe('fail')
    expect(checks.find((c) => c.id === 'walkback-time')!.state).toBe('ok')
    expect(missionVerdict(true, true, checks)).toBe('nogo')
  })

  it('states the limits it applies', () => {
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back(500, 600) })
    expect(checks.find((c) => c.id === 'walkback-distance')!.limit).toBe('≤ 2 km')
    expect(checks.find((c) => c.id === 'walkback-time')!.limit).toBe('≤ 60 min')
  })

  it('fails when part of the route has no way back within the slope limit', () => {
    const checks = buildChecks({ evaSeconds: 3600, walkBack: back(500, 600, false) })
    expect(checks.find((c) => c.id === 'walkback-distance')!.ok).toBe(false)
    expect(checks.find((c) => c.id === 'walkback-time')!.ok).toBe(false)
    expect(buildChecks({ evaSeconds: 3600, walkBack: null }).filter((c) => !c.ok)).toHaveLength(2)
  })
})

describe('return figures at the limits', () => {
  const D = RETURN_LIMITS.distance_m
  const T = RETURN_LIMITS.time_s
  const dist = (d: number, s = 600) => buildChecks({ evaSeconds: 600, walkBack: back(d, s) }).find((c) => c.id === 'walkback-distance')!
  const time = (s: number, d = 500) => buildChecks({ evaSeconds: 600, walkBack: back(d, s) }).find((c) => c.id === 'walkback-time')!

  it('passes exactly at a limit and fails just above it', () => {
    expect(dist(D).ok).toBe(true)
    expect(dist(D + 1e-9).ok).toBe(false)
    expect(dist(D - 1e-9).ok).toBe(true)
    expect(time(T).ok).toBe(true)
    expect(time(T + 1e-9).ok).toBe(false)
    expect(time(T - 1e-9).ok).toBe(true)
  })

  it('needs both: just over either limit is NO-GO', () => {
    const verdict = (d: number, s: number) => missionVerdict(true, true, buildChecks({ evaSeconds: 600, walkBack: back(d, s) }))
    expect(verdict(D, T)).toBe('go')
    expect(verdict(D - 0.5, T - 0.5)).toBe('go')
    expect(verdict(D + 0.001, T)).toBe('nogo')
    expect(verdict(D, T + 0.001)).toBe('nogo')
    expect(verdict(D + 0.001, T + 0.001)).toBe('nogo')
  })

  it('never shows a failing figure as if it were at the limit', () => {
    // 2000.3 m is over; it must not read "2.00 km".
    expect(dist(D + 0.3).value).toBe('2.01 km')
    expect(dist(D + 0.3).margin).toBe('over by 1 m')
    expect(dist(4317.9).margin).toBe('over by 2.32 km')
    expect(dist(2999.5).margin).toBe('over by 1.00 km')
    expect(dist(2998.9).margin).toBe('over by 999 m')
    expect(time(T + 0.5).value).toBe('61 min')
    expect(time(T + 0.5).margin).toBe('over by 1 min')
  })

  it('never overstates the room to spare', () => {
    // The southern mission: 1999.97 m of 2000 m.
    expect(dist(1999.97).value).toBe('2.00 km')
    expect(dist(1999.97).margin).toBe('less than 1 m to spare')
    expect(dist(D).margin).toBe('less than 1 m to spare')
    expect(dist(1995.9).margin).toBe('4 m to spare')
    expect(time(57.8 * 60).value).toBe('58 min')
    expect(time(57.8 * 60).margin).toBe('2 min to spare')
    expect(time(T - 1).margin).toBe('less than 1 min to spare')
    expect(time(T).margin).toBe('less than 1 min to spare')
  })

  it('rounds lengths and times up, never down', () => {
    expect(dist(1311.4).value).toBe('1.32 km')
    expect(dist(1310).value).toBe('1.31 km')
    expect(time(27.01 * 60).value).toBe('28 min')
    expect(time(27 * 60).value).toBe('27 min')
  })
})

describe('the 8-hour limit, on the EVA duration at the planning pace', () => {
  const LIMIT = EVA.maxDuration_h * 3600
  const fine = back(500, 600)
  const duration = (evaSeconds: number) => buildChecks({ evaSeconds, walkBack: fine })[0]
  const verdict = (evaSeconds: number) => missionVerdict(true, true, buildChecks({ evaSeconds, walkBack: fine }))

  it('is 8 hours and says which duration it is applied to', () => {
    expect(LIMIT).toBe(28_800)
    expect(duration(3600).id).toBe('duration')
    expect(duration(3600).label).toBe('EVA duration at ≤ 2 km/h')
    expect(duration(3600).limit).toBe('≤ 8 h')
  })

  it('passes at exactly 8 hours', () => {
    expect(duration(LIMIT).ok).toBe(true)
    expect(duration(LIMIT).state).toBe('ok')
    expect(duration(LIMIT).ratio).toBe(1)
    expect(verdict(LIMIT)).toBe('go')
  })

  it('passes just below and fails just above', () => {
    expect(verdict(LIMIT - 1e-6)).toBe('go')
    expect(verdict(LIMIT - 1)).toBe('go')
    expect(duration(LIMIT + 1e-6).ok).toBe(false)
    expect(duration(LIMIT + 1e-6).state).toBe('fail')
    expect(verdict(LIMIT + 1e-6)).toBe('nogo')
    expect(verdict(LIMIT + 1)).toBe('nogo')
  })

  it('does not round a failing duration down to the limit, or overstate the room left', () => {
    // 20 seconds over must not read "8 h 00 min".
    expect(duration(LIMIT + 20).value).toBe('8 h 01 min')
    expect(duration(LIMIT + 20).margin).toBe('over by 1 min')
    expect(duration(LIMIT - 20).value).toBe('8 h 00 min')
    expect(duration(LIMIT - 20).margin).toBe('less than 1 min to spare')
    expect(duration(LIMIT).margin).toBe('less than 1 min to spare')
    expect(duration(LIMIT - 90).margin).toBe('1 min to spare')
    expect(duration(2 * 3600).margin).toBe('6 h 00 min to spare')
    expect(duration(9 * 3600).margin).toBe('over by 1 h 00 min')
  })

  it('is a confirmed NO-GO over the limit even when the return is unverified, and UNVERIFIED under it', () => {
    const open = back(2100, 3000, true, { feasible: false, verified: false })
    expect(missionVerdict(true, true, buildChecks({ evaSeconds: LIMIT + 60, walkBack: open }))).toBe('nogo')
    expect(missionVerdict(true, true, buildChecks({ evaSeconds: LIMIT - 60, walkBack: open }))).toBe('unverified')
  })

  it('never makes a plan without a route anything but NO ROUTE', () => {
    expect(missionVerdict(true, false, null)).toBe('noroute')
    expect(missionVerdict(true, false, buildChecks({ evaSeconds: 60, walkBack: fine }))).toBe('noroute')
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
