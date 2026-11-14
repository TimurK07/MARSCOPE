import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAllPlans, summarise, type PlanInput } from '../planner'
import type { WorkerReply, WorkerRequest } from '../planner.worker'
import { PlanService, type PlanUpdate, type WorkerLike } from '../planService'
import { at, makeTerrain } from './synthetic'

const terrain = makeTerrain(30, 30, () => 0, () => 0, () => 0)
const input = (x: number): PlanInput => ({ points: [at(terrain, 3, 3), at(terrain, x, 20)], roundTrip: true, massKg: 180 })

/** A stand-in worker the test drives by hand. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: WorkerReply }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onmessageerror: ((e: unknown) => void) | null = null
  sent: WorkerRequest[] = []
  terminated = false
  throwOnPost = false
  postMessage(msg: WorkerRequest) {
    if (this.throwOnPost) throw new Error('cannot post')
    this.sent.push(msg)
  }
  terminate() {
    this.terminated = true
  }
  /** Answers a plan request the way the real worker does: one message per mode. */
  answer(ticket: number, inp: PlanInput) {
    const plans = computeAllPlans(terrain, inp)
    const modes = ['fastest', 'energy', 'cautious'] as const
    modes.forEach((mode, i) => this.onmessage?.({ data: { type: 'plan', ticket, mode, plan: plans[mode], done: i === modes.length - 1 } }))
  }
  planRequests() {
    return this.sent.filter((m): m is Extract<WorkerRequest, { type: 'plan' }> => m.type === 'plan')
  }
}

function setup(worker: (() => WorkerLike | null) | 'throws', watchdogMs = 20_000) {
  const updates: PlanUpdate[] = []
  const service = new PlanService({
    terrain,
    createWorker:
      worker === 'throws'
        ? () => {
            throw new Error('Worker is not defined')
          }
        : worker,
    onUpdate: (u) => updates.push(u),
    watchdogMs,
  })
  const finished = () => updates.filter((u) => u.done)
  return { service, updates, finished }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('planning with a worker', () => {
  it('sends the terrain once, then each request with the mode to plan first', () => {
    const w = new FakeWorker()
    const { service, finished } = setup(() => w)
    expect(service.usingWorker).toBe(true)
    expect(w.sent[0].type).toBe('terrain')
    const ticket = service.request(input(20), 'energy')
    expect(w.planRequests()).toHaveLength(1)
    expect(w.planRequests()[0].first).toBe('energy')
    w.answer(ticket, input(20))
    expect(finished()).toHaveLength(1)
    expect(finished()[0].plans.cautious).not.toBeNull()
  })

  it('reports modes as they arrive and marks the last one done', () => {
    const w = new FakeWorker()
    const { service, updates } = setup(() => w)
    const ticket = service.request(input(20), 'fastest')
    w.answer(ticket, input(20))
    expect(updates.map((u) => u.done)).toEqual([false, false, true])
    expect(updates[0].plans.fastest).not.toBeNull()
    expect(updates[0].plans.energy).toBeNull()
  })

  it('ignores the answer to a request that has been superseded', () => {
    const w = new FakeWorker()
    const { service, updates } = setup(() => w)
    const first = service.request(input(10), 'fastest')
    const second = service.request(input(25), 'fastest')
    // The slow answer to the first request arrives after the second was asked.
    w.answer(first, input(10))
    expect(updates).toHaveLength(0)
    w.answer(second, input(25))
    expect(updates.filter((u) => u.done)).toHaveLength(1)
    expect(updates[updates.length - 1].input.points[1]).toEqual(input(25).points[1])
  })

  it('ignores an answer that arrives after the plan was cleared', () => {
    const w = new FakeWorker()
    const { service, updates } = setup(() => w)
    const ticket = service.request(input(20), 'fastest')
    service.cancel()
    w.answer(ticket, input(20))
    vi.runAllTimers()
    expect(updates).toHaveLength(0)
  })

  it('ignores answers after it has been disposed', () => {
    const w = new FakeWorker()
    const { service, updates } = setup(() => w)
    const ticket = service.request(input(20), 'fastest')
    service.dispose()
    expect(w.terminated).toBe(true)
    w.answer(ticket, input(20))
    vi.runAllTimers()
    expect(updates).toHaveLength(0)
  })
})

describe('planning without a usable worker', () => {
  it('computes on the main thread when workers do not exist', () => {
    const { service, finished } = setup('throws')
    expect(service.usingWorker).toBe(false)
    service.request(input(20), 'cautious')
    expect(finished()).toHaveLength(0) // nothing is computed synchronously inside request()
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
    const plans = finished()[0].plans
    expect(plans.fastest!.error).toBeNull()
    expect(plans.energy!.error).toBeNull()
    expect(plans.cautious!.error).toBeNull()
  })

  it('computes on the main thread when the factory returns nothing', () => {
    const { service, finished } = setup(() => null)
    service.request(input(20), 'fastest')
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
  })

  it('gives the mode on screen first', () => {
    const { service, updates } = setup('throws')
    service.request(input(20), 'energy')
    vi.advanceTimersByTime(0)
    expect(updates).toHaveLength(1)
    expect(updates[0].plans.energy).not.toBeNull()
    expect(updates[0].plans.fastest).toBeNull()
    expect(updates[0].done).toBe(false)
  })

  it('matches what the worker would have produced', () => {
    const { service, finished } = setup('throws')
    service.request(input(20), 'fastest')
    vi.runAllTimers()
    const expected = computeAllPlans(terrain, input(20))
    for (const m of ['fastest', 'energy', 'cautious'] as const) {
      expect(finished()[0].plans[m]!.distance).toBeCloseTo(expected[m]!.distance, 9)
      expect(finished()[0].plans[m]!.walkTime).toBeCloseTo(expected[m]!.walkTime, 9)
    }
  })

  it('finishes the outstanding request itself when the worker fails', () => {
    const w = new FakeWorker()
    const { service, finished } = setup(() => w)
    service.request(input(20), 'fastest')
    w.onerror?.(new Error('worker script failed to load'))
    expect(w.terminated).toBe(true)
    expect(service.usingWorker).toBe(false)
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
    // And keeps working for later requests.
    service.request(input(12), 'fastest')
    vi.runAllTimers()
    expect(finished()).toHaveLength(2)
  })

  it('falls back when the worker cannot be sent a message', () => {
    const w = new FakeWorker()
    const { service, finished } = setup(() => w)
    w.throwOnPost = true
    service.request(input(20), 'fastest')
    expect(service.usingWorker).toBe(false)
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
  })

  it('falls back when the worker never answers', () => {
    const w = new FakeWorker()
    const { service, finished } = setup(() => w, 5_000)
    service.request(input(20), 'fastest')
    vi.advanceTimersByTime(4_999)
    expect(finished()).toHaveLength(0)
    vi.advanceTimersByTime(10)
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
    expect(service.usingWorker).toBe(false)
  })

  it('only computes the modes the worker had not delivered before it failed', () => {
    const w = new FakeWorker()
    const { service, updates, finished } = setup(() => w)
    const ticket = service.request(input(20), 'fastest')
    const plans = computeAllPlans(terrain, input(20))
    w.onmessage?.({ data: { type: 'plan', ticket, mode: 'fastest', plan: plans.fastest, done: false } })
    w.onerror?.(new Error('crashed'))
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
    // One update from the worker, two from the fallback.
    expect(updates).toHaveLength(3)
  })

  it('drops stale work on the main thread too', () => {
    const { service, updates, finished } = setup('throws')
    service.request(input(10), 'fastest')
    service.request(input(15), 'fastest')
    service.request(input(25), 'fastest')
    vi.runAllTimers()
    expect(finished()).toHaveLength(1)
    expect(finished()[0].input.points[1]).toEqual(input(25).points[1])
    // No update at all for the two superseded requests.
    expect(updates.every((u) => u.input.points[1].lon === input(25).points[1].lon)).toBe(true)
  })

  it('stops when the plan is cleared part-way through', () => {
    const { service, updates } = setup('throws')
    service.request(input(20), 'fastest')
    vi.advanceTimersByTime(0) // the first mode is delivered
    expect(updates).toHaveLength(1)
    service.cancel()
    vi.runAllTimers()
    expect(updates).toHaveLength(1)
  })

  it('still answers, with NO ROUTE, when a checkpoint cannot be reached', () => {
    const walled = makeTerrain(30, 30, (x) => (x === 15 ? 40 : 0), () => 0, () => 0)
    const updates: PlanUpdate[] = []
    const service = new PlanService({ terrain: walled, createWorker: () => null, onUpdate: (u) => updates.push(u) })
    service.request({ points: [at(walled, 3, 15), at(walled, 27, 15)], roundTrip: true, massKg: 180 }, 'fastest')
    vi.runAllTimers()
    const done = updates.find((u) => u.done)!
    for (const m of ['fastest', 'energy', 'cautious'] as const) expect(done.plans[m]!.error).not.toBeNull()
  })
})

describe('changing the return distance limit', () => {
  // Level ground 1.6 km long: a target 1.5 km from the habitat passes at 2 km and fails at 1.2 km.
  const long = makeTerrain(420, 3, () => 0)
  const withLimit = (returnDistanceM?: number): PlanInput => ({ points: [at(long, 5, 1), at(long, 380, 1)], roundTrip: true, massKg: 180, returnDistanceM })
  const verdictOf = (u: PlanUpdate) => summarise(u.plans.fastest, u.input, 0)!.verdict

  /** A worker that answers each request with what the real worker computes for that input. */
  class LimitWorker extends FakeWorker {
    reply(ticket: number, inp: PlanInput) {
      const plans = computeAllPlans(long, inp)
      const modes = ['fastest', 'energy', 'cautious'] as const
      modes.forEach((mode, i) => this.onmessage?.({ data: { type: 'plan', ticket, mode, plan: plans[mode], done: i === modes.length - 1 } }))
    }
  }
  const make = (worker: LimitWorker | null) => {
    const updates: PlanUpdate[] = []
    const service = new PlanService({ terrain: long, createWorker: () => worker, onUpdate: (u) => updates.push(u) })
    return { service, updates, done: () => updates.filter((u) => u.done) }
  }

  it('sends the limit to the worker with the request', () => {
    const w = new LimitWorker()
    const { service } = make(w)
    service.request(withLimit(1200), 'fastest')
    expect(w.planRequests()[0].input.returnDistanceM).toBe(1200)
  })

  it('gives the verdict of the limit asked for', () => {
    const w = new LimitWorker()
    const { service, done } = make(w)
    w.reply(service.request(withLimit(), 'fastest'), withLimit())
    expect(verdictOf(done()[0])).toBe('go')
    w.reply(service.request(withLimit(1200), 'fastest'), withLimit(1200))
    expect(verdictOf(done()[1])).toBe('nogo')
    w.reply(service.request(withLimit(2000), 'fastest'), withLimit(2000))
    expect(verdictOf(done()[2])).toBe('go')
  })

  it('keeps only the answer for the last limit when it is changed quickly', () => {
    const w = new LimitWorker()
    const { service, updates, done } = make(w)
    const limits = [2000, 1800, 1600, 1400, 1200]
    const tickets = limits.map((m) => service.request(withLimit(m), 'fastest'))
    // Answers arrive late and out of order; only the one for the last request may be used.
    for (const i of [1, 0, 3, 2]) w.reply(tickets[i], withLimit(limits[i]))
    expect(updates).toHaveLength(0)
    w.reply(tickets[4], withLimit(1200))
    expect(done()).toHaveLength(1)
    expect(done()[0].input.returnDistanceM).toBe(1200)
    expect(verdictOf(done()[0])).toBe('nogo')
    // No update at all carried a verdict for an earlier limit.
    expect(updates.every((u) => u.input.returnDistanceM === 1200)).toBe(true)
  })

  it('does the same on the main thread, quickly changed too', () => {
    const { service, updates, done } = make(null)
    for (const m of [2000, 1500, 1200]) service.request(withLimit(m), 'fastest')
    vi.runAllTimers()
    expect(done()).toHaveLength(1)
    expect(done()[0].input.returnDistanceM).toBe(1200)
    expect(updates.every((u) => u.input.returnDistanceM === 1200)).toBe(true)
    expect(verdictOf(done()[0])).toBe('nogo')
  })

  it('gets the same plan from the worker and from the main-thread fallback, for every limit and mode', () => {
    for (const m of [undefined, 1200, 1500, 2000, 3000]) {
      const viaWorker = make(new LimitWorker())
      const w = viaWorker.service as unknown as { worker: LimitWorker }
      w.worker.reply(viaWorker.service.request(withLimit(m), 'fastest'), withLimit(m))
      const local = make(null)
      local.service.request(withLimit(m), 'fastest')
      vi.runAllTimers()
      const a = viaWorker.done()[0]
      const b = local.done()[0]
      for (const mode of ['fastest', 'energy', 'cautious'] as const) {
        const sa = summarise(a.plans[mode], a.input, 20)!
        const sb = summarise(b.plans[mode], b.input, 20)!
        expect(sb.verdict).toBe(sa.verdict)
        expect(b.plans[mode]!.walkBack).toEqual(a.plans[mode]!.walkBack)
        expect(sb.checks!.map((c) => `${c.id} ${c.value} ${c.limit} ${c.ok}`)).toEqual(sa.checks!.map((c) => `${c.id} ${c.value} ${c.limit} ${c.ok}`))
      }
    }
  })

  it('falls back with the limit intact when the worker fails mid-request', () => {
    const w = new LimitWorker()
    const { service, done } = make(w)
    service.request(withLimit(1200), 'fastest')
    w.onerror?.(new Error('worker crashed'))
    vi.runAllTimers()
    expect(done()).toHaveLength(1)
    expect(done()[0].input.returnDistanceM).toBe(1200)
    expect(verdictOf(done()[0])).toBe('nogo')
  })
})
