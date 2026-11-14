// Least-time route search (A*) over the terrain grid.
//
// Each step between neighbouring cells costs the time a suited astronaut needs
// to walk it, given the grade along the direction of travel. Cells whose terrain
// slope exceeds the traversable limit are blocked.

import { cellAt, cellCenter, elevationAt, slopeAt, type LatLon, type Terrain } from './terrain'
import { MAX_SLOPE_DEG, walkingSpeedMs } from './model'
import { timeObjective, type Objective } from './objectives'
import { measurePath, smoothPath, type PathMeasure, type PathSample } from './pathGeometry'

export type RouteSample = PathSample

export interface RouteLeg extends PathMeasure {
  /** Corner points of the route, joined by straight lines. */
  vertices: LatLon[]
  /** The same leg as the grid search found it, before straightening, for comparison. */
  grid: { distance: number; duration: number; cells: number; cost: number }
}

export type LegResult = { ok: true; leg: RouteLeg } | { ok: false; reason: string }

// 8-connected neighbourhood
const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]

class MinHeap {
  private ids: number[] = []
  private keys: number[] = []
  get size() {
    return this.ids.length
  }
  push(id: number, key: number) {
    const ids = this.ids
    const keys = this.keys
    let i = ids.length
    ids.push(id)
    keys.push(key)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      ids[i] = ids[p]
      keys[i] = keys[p]
      i = p
    }
    ids[i] = id
    keys[i] = key
  }
  pop(): number {
    const ids = this.ids
    const keys = this.keys
    const top = ids[0]
    const lastId = ids.pop()!
    const lastKey = keys.pop()!
    const n = ids.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && keys[c + 1] < keys[c]) c++
        if (keys[c] >= lastKey) break
        ids[i] = ids[c]
        keys[i] = keys[c]
        i = c
      }
      ids[i] = lastId
      keys[i] = lastKey
    }
    return top
  }
}

/** A cell can be walked on when it has terrain data and its slope is within the limit. */
export function isWalkable(t: Terrain, idx: number): boolean {
  const s = slopeAt(t, idx)
  return !Number.isNaN(s) && s <= MAX_SLOPE_DEG
}

const isBlocked = (t: Terrain, idx: number) => !isWalkable(t, idx)

/**
 * Whether a step between neighbouring cells is allowed.
 * A diagonal step passes the corner shared by two other cells; if either of
 * them is blocked, the step would clip no-go terrain, so it is refused.
 */
function canStep(t: Terrain, x: number, y: number, k: number): boolean {
  if (DX[k] === 0 || DY[k] === 0) return true
  return isWalkable(t, y * t.width + (x + DX[k])) && isWalkable(t, (y + DY[k]) * t.width + x)
}

export interface LegOptions {
  /** Straighten the grid path where that is safe and no worse by the objective. On by default. */
  smooth?: boolean
  /** What the route is optimised for. Walking time by default. */
  objective?: Objective
}

export function findLeg(t: Terrain, from: LatLon, to: LatLon, opts: LegOptions = {}): LegResult {
  const obj = opts.objective ?? timeObjective()
  const start = cellAt(t, from)
  const goal = cellAt(t, to)
  if (start < 0 || goal < 0) return { ok: false, reason: 'Point is outside the mapped study area.' }
  if (isBlocked(t, start)) return { ok: false, reason: 'Start point is on terrain steeper than the safe limit.' }
  if (isBlocked(t, goal)) return { ok: false, reason: 'Target is on terrain steeper than the safe limit.' }

  const w = t.width
  const h = t.height
  const cx = t.meta.cellSizeX_m
  const cy = t.meta.cellSizeY_m
  const stepLen = DX.map((dx, k) => Math.hypot(dx * cx, DY[k] * cy))

  // 64-bit sums: energy costs reach millions of joules and must still resolve single steps.
  const g = new Float64Array(w * h).fill(Infinity)
  const came = new Int32Array(w * h).fill(-1)
  const closed = new Uint8Array(w * h)
  const heap = new MinHeap()

  const gx = goal % w
  const gy = (goal - gx) / w
  const heuristic = (idx: number) => {
    const x = idx % w
    const y = (idx - x) / w
    // Straight-line distance times the cheapest possible cost per metre: never an overestimate.
    return Math.hypot((x - gx) * cx, (y - gy) * cy) * obj.minPerMetre
  }

  g[start] = 0
  heap.push(start, heuristic(start))

  while (heap.size > 0) {
    const cur = heap.pop()
    if (closed[cur]) continue
    if (cur === goal) break
    closed[cur] = 1
    const x = cur % w
    const y = (cur - x) / w
    const zCur = elevationAt(t, cur)
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const n = ny * w + nx
      if (closed[n] || isBlocked(t, n) || !canStep(t, x, y, k)) continue
      const d = stepLen[k]
      const grade = (Math.atan2(elevationAt(t, n) - zCur, d) * 180) / Math.PI
      const cand = g[cur] + obj.pieceCost(d, grade, n)
      if (cand < g[n]) {
        g[n] = cand
        came[n] = cur
        heap.push(n, cand + heuristic(n))
      }
    }
  }

  if (!Number.isFinite(g[goal])) {
    return { ok: false, reason: 'No safe route: the target is cut off by slopes steeper than the limit.' }
  }

  const cells: number[] = []
  for (let c = goal; c !== -1; c = came[c]) cells.push(c)
  cells.reverse()

  const grid = measurePath(t, cells, obj)
  if (!grid) return { ok: false, reason: 'No safe route: the path found does not stay on walkable ground.' }
  let chosen = grid
  let vertices = cells
  if (opts.smooth !== false) {
    const straight = smoothPath(t, cells, obj)
    const m = measurePath(t, straight, obj)
    // Keep the straightened path only if it is safe and really no worse by the objective.
    if (m && m.cost <= grid.cost * (1 + 1e-9) + 1e-6) {
      chosen = m
      vertices = straight
    }
  }
  return {
    ok: true,
    leg: {
      ...chosen,
      vertices: vertices.map((c) => cellCenter(t, c)),
      grid: { distance: grid.distance, duration: grid.duration, cells: cells.length, cost: grid.cost },
    },
  }
}

export interface WalkBack {
  /** Longest time needed to walk back to the habitat from any point of the route, seconds. */
  maxTime: number
  /** Where on the route that is. */
  maxTimeAt: LatLon
  /** Longest walk-back path from any point of the route, metres. */
  maxDistance: number
  maxDistanceAt: LatLon
  /** False when some point of the route has no safe way back. */
  reachable: boolean
}

/**
 * Fastest safe way back to the habitat from any cell, found outwards from the
 * habitat and extended on demand. One field serves every route that shares the
 * habitat, so the three routing modes are assessed against the same answer.
 *
 * Costs depend on direction (climbing is slower than descending), so this is
 * computed towards the habitat and is not the outbound time reversed. It always
 * minimises time over the grid, whatever a route was optimised for: it is a
 * safety check, not part of the route.
 */
export class WalkBackField {
  private readonly t: Terrain
  private readonly home: number
  private readonly time: Float32Array
  private readonly dist: Float32Array
  private readonly closed: Uint8Array
  private readonly heap = new MinHeap()
  private readonly stepLen: number[]

  constructor(t: Terrain, habitat: LatLon) {
    this.t = t
    this.home = cellAt(t, habitat)
    const n = t.width * t.height
    this.time = new Float32Array(n).fill(Infinity)
    this.dist = new Float32Array(n).fill(Infinity)
    this.closed = new Uint8Array(n)
    this.stepLen = DX.map((dx, k) => Math.hypot(dx * t.meta.cellSizeX_m, DY[k] * t.meta.cellSizeY_m))
    if (this.valid) {
      this.time[this.home] = 0
      this.dist[this.home] = 0
      this.heap.push(this.home, 0)
    }
  }

  /** False when the habitat is outside the grid or on ground that is not walkable. */
  get valid(): boolean {
    return this.home >= 0 && isWalkable(this.t, this.home)
  }

  /** Continues the search until every listed cell has its answer (or cannot be reached). */
  private settle(cells: number[]) {
    const { t, time, dist, closed, heap, stepLen } = this
    const w = t.width
    const h = t.height
    const wanted = new Set<number>()
    for (const c of cells) if (c >= 0 && !closed[c]) wanted.add(c)
    // Dijkstra outwards from the habitat over reversed steps: when cell v is settled,
    // each neighbour u is offered the cost of walking u -> v.
    while (heap.size > 0 && wanted.size > 0) {
      const v = heap.pop()
      if (closed[v]) continue
      closed[v] = 1
      wanted.delete(v)
      const x = v % w
      const y = (v - x) / w
      const zv = elevationAt(t, v)
      for (let k = 0; k < 8; k++) {
        const ux = x + DX[k]
        const uy = y + DY[k]
        if (ux < 0 || uy < 0 || ux >= w || uy >= h) continue
        const u = uy * w + ux
        if (closed[u] || isBlocked(t, u) || !canStep(t, x, y, k)) continue
        const d = stepLen[k]
        const dz = zv - elevationAt(t, u)
        const speed = walkingSpeedMs((Math.atan2(dz, d) * 180) / Math.PI)
        const cand = time[v] + d / speed
        if (cand < time[u]) {
          time[u] = cand
          dist[u] = dist[v] + Math.hypot(d, dz)
          heap.push(u, cand)
        }
      }
    }
  }

  /** Worst-case walk back from anywhere on a route. */
  assess(route: LatLon[]): WalkBack | null {
    if (!this.valid || route.length === 0) return null
    const cells = route.map((p) => cellAt(this.t, p))
    this.settle(cells)
    let maxTime = 0
    let maxDistance = 0
    let maxTimeAt = route[0]
    let maxDistanceAt = route[0]
    let reachable = true
    cells.forEach((c, i) => {
      if (c < 0 || !this.closed[c]) {
        reachable = false
        return
      }
      if (this.time[c] > maxTime) {
        maxTime = this.time[c]
        maxTimeAt = route[i]
      }
      if (this.dist[c] > maxDistance) {
        maxDistance = this.dist[c]
        maxDistanceAt = route[i]
      }
    })
    return { maxTime, maxTimeAt, maxDistance, maxDistanceAt, reachable }
  }
}

/** Worst-case walk back to the habitat from anywhere on a route. See WalkBackField. */
export function walkBack(t: Terrain, habitat: LatLon, route: LatLon[]): WalkBack | null {
  return new WalkBackField(t, habitat).assess(route)
}
