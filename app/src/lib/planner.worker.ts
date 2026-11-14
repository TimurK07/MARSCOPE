/// <reference lib="webworker" />
// Route planning off the main thread, so the interface stays responsive while
// three routes and their walk-back checks are computed.

import type { RouteMode } from './objectives'
import { computePlan, modeOrder, type LegCache, type Plan, type PlanInput } from './planner'
import { WalkBackField } from './router'
import type { Terrain } from './terrain'

export type WorkerRequest =
  | { type: 'terrain'; terrain: Terrain }
  | { type: 'plan'; ticket: number; input: PlanInput; first: RouteMode }
/** One mode's plan. The mode on screen is sent first; done marks the last of a request. */
export type WorkerReply = { type: 'plan'; ticket: number; mode: RouteMode; plan: Plan | null; done: boolean }

type Job = { ticket: number; input: PlanInput; first: RouteMode }

let terrain: Terrain | null = null
const cache: LegCache = new Map()
let pending: Job | null = null
let running = false

/** Lets a newer request that arrived meanwhile be seen between modes. */
const pause = () => new Promise<void>((r) => setTimeout(r, 0))

async function run() {
  if (running) return
  running = true
  while (pending && terrain) {
    // Requests that arrived while we were busy are skipped: only the newest matters.
    const job = pending
    pending = null
    const field = new WalkBackField(terrain, job.input.points[0])
    const order = modeOrder(job.first)
    for (let i = 0; i < order.length; i++) {
      const plan = computePlan(terrain, job.input, order[i], cache, field)
      const reply: WorkerReply = { type: 'plan', ticket: job.ticket, mode: order[i], plan, done: i === order.length - 1 }
      postMessage(reply)
      await pause()
      // A newer plan was requested: abandon the rest of this one.
      if (pending) break
    }
  }
  running = false
}

onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'terrain') {
    terrain = msg.terrain
    cache.clear()
    return
  }
  pending = { ticket: msg.ticket, input: msg.input, first: msg.first }
  void run()
}
