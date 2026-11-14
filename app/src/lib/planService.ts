// Asks for route plans and delivers only the answer to the latest request.
//
// Plans are computed in a Web Worker when one is available. If the worker
// cannot be created, fails, stops answering or cannot be reached, the same
// computation runs on the main thread instead, so the interface can never be
// left waiting for routes that will not come.

import { LatestOnly } from './latest'
import type { RouteMode } from './objectives'
import { computePlan, modeOrder, type LegCache, type Plan, type PlanInput, type Plans } from './planner'
import type { WorkerReply, WorkerRequest } from './planner.worker'
import { WalkBackField } from './router'
import type { Terrain } from './terrain'

/** The part of a Worker this service uses. */
export interface WorkerLike {
  postMessage: (msg: WorkerRequest) => void
  terminate: () => void
  onmessage: ((e: { data: WorkerReply }) => void) | null
  onerror: ((e: unknown) => void) | null
  onmessageerror?: ((e: unknown) => void) | null
}

export interface PlanUpdate {
  ticket: number
  input: PlanInput
  /** Plans received so far for this request; modes still being computed are null. */
  plans: Plans
  done: boolean
}

export interface PlanServiceOptions {
  terrain: Terrain
  /** Returns a worker, or throws / returns null when workers are unavailable. */
  createWorker: () => WorkerLike | null
  onUpdate: (u: PlanUpdate) => void
  /** How long a worker may stay silent on a request before it is given up on, ms. */
  watchdogMs?: number
}

const NO_PLANS = (): Plans => ({ fastest: null, energy: null, cautious: null })

export class PlanService {
  private readonly opts: PlanServiceOptions
  private readonly latest = new LatestOnly()
  private readonly cache: LegCache = new Map()
  private worker: WorkerLike | null = null
  private current: { ticket: number; input: PlanInput; first: RouteMode; plans: Plans } | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(opts: PlanServiceOptions) {
    this.opts = opts
    try {
      this.worker = opts.createWorker()
    } catch {
      this.worker = null
    }
    if (this.worker) {
      this.worker.onmessage = (e) => this.onReply(e.data)
      this.worker.onerror = () => this.abandonWorker()
      this.worker.onmessageerror = () => this.abandonWorker()
      try {
        this.worker.postMessage({ type: 'terrain', terrain: opts.terrain })
      } catch {
        this.abandonWorker()
      }
    }
  }

  /** True while plans come from the worker rather than the main thread. */
  get usingWorker(): boolean {
    return this.worker !== null
  }

  /** Asks for plans for all modes. Any earlier request becomes stale at once. */
  request(input: PlanInput, first: RouteMode): number {
    const ticket = this.latest.next()
    this.current = { ticket, input, first, plans: NO_PLANS() }
    this.clearWatchdog()
    this.dispatch()
    return ticket
  }

  /** Drops the outstanding request, for example when the plan is cleared. */
  cancel(): void {
    this.latest.cancel()
    this.current = null
    this.clearWatchdog()
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.worker?.terminate()
    this.worker = null
  }

  private dispatch() {
    const job = this.current
    if (!job) return
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'plan', ticket: job.ticket, input: job.input, first: job.first })
        this.watchdog = setTimeout(() => this.abandonWorker(), this.opts.watchdogMs ?? 10_000)
        return
      } catch {
        this.abandonWorker()
        return
      }
    }
    this.runLocally(job.ticket)
  }

  private onReply(reply: WorkerReply) {
    const job = this.current
    // An answer to an older request: a newer plan is already on its way.
    if (!job || reply.ticket !== job.ticket || !this.latest.isCurrent(reply.ticket)) return
    this.deliver(reply.mode, reply.plan, reply.done)
  }

  private deliver(mode: RouteMode, plan: Plan | null, done: boolean) {
    const job = this.current
    if (!job || this.disposed) return
    job.plans = { ...job.plans, [mode]: plan }
    if (done) this.clearWatchdog()
    this.opts.onUpdate({ ticket: job.ticket, input: job.input, plans: job.plans, done })
    if (done) this.current = null
  }

  /** The worker is unusable: stop using it and finish the outstanding request here. */
  private abandonWorker() {
    this.clearWatchdog()
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch {
        // Already gone.
      }
    }
    this.worker = null
    if (this.current && !this.disposed) this.runLocally(this.current.ticket)
  }

  /**
   * Computes on the main thread, one mode per task, the mode on screen first.
   * Between modes the browser can paint and a newer request can take over.
   */
  private runLocally(ticket: number) {
    const job = this.current
    if (!job || job.ticket !== ticket) return
    const order = modeOrder(job.first).filter((m) => job.plans[m] === null)
    const field = new WalkBackField(this.opts.terrain, job.input.points[0])
    const step = (i: number) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        const now = this.current
        if (this.disposed || !now || now.ticket !== ticket || !this.latest.isCurrent(ticket)) return
        const mode = order[i]
        let plan: Plan | null = null
        try {
          plan = computePlan(this.opts.terrain, now.input, mode, this.cache, field)
        } catch {
          plan = null
        }
        const last = i === order.length - 1
        this.deliver(mode, plan, last)
        if (!last) step(i + 1)
      }, 0)
      this.timers.add(timer)
    }
    if (order.length === 0) this.deliver(job.first, job.plans[job.first], true)
    else step(0)
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }
}
