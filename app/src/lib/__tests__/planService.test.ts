import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAllPlans, type PlanInput } from '../planner'
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
