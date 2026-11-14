// Least-time route search (A*) over the terrain grid.
//
// Each step between neighbouring cells costs the time a suited astronaut needs
// to walk it, given the grade along the direction of travel. Cells whose terrain
// slope exceeds the traversable limit are blocked.

import { cellAt, cellCenter, elevationAt, slopeAt, type LatLon, type Terrain } from './terrain'
import { MAX_SLOPE_DEG, MAX_SPEED_MS, segmentEnergy, walkingSpeedMs } from './model'

export interface RouteSample extends LatLon {
  /** Distance from the start of the route, metres (along the surface). */
  dist: number
  elevation: number
  /** Grade along the direction of travel, degrees (positive = uphill). */
  grade: number
  /** Terrain slope at this cell, degrees. */
  slope: number
  /** Time from the start of the route, seconds. */
  time: number
}

export interface RouteLeg {
  samples: RouteSample[]
  distance: number
  duration: number
  ascent: number
  descent: number
  maxSlope: number
  /** Metabolic energy = energyPerKg * suited mass (kg) + energyFixed, joules. */
  energyPerKg: number
  energyFixed: number
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

export function findLeg(t: Terrain, from: LatLon, to: LatLon): LegResult {
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

  const g = new Float32Array(w * h).fill(Infinity)
  const came = new Int32Array(w * h).fill(-1)
  const closed = new Uint8Array(w * h)
  const heap = new MinHeap()

  const gx = goal % w
  const gy = (goal - gx) / w
  const heuristic = (idx: number) => {
    const x = idx % w
    const y = (idx - x) / w
    return Math.hypot((x - gx) * cx, (y - gy) * cy) / MAX_SPEED_MS
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
      const speed = walkingSpeedMs(grade)
      if (speed <= 0) continue
      const cand = g[cur] + d / speed
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
  return { ok: true, leg: buildLeg(t, cells) }
}

function buildLeg(t: Terrain, cells: number[]): RouteLeg {
  const w = t.width
  const cx = t.meta.cellSizeX_m
  const cy = t.meta.cellSizeY_m
  const samples: RouteSample[] = []
  let dist = 0
  let time = 0
  let ascent = 0
  let descent = 0
  let maxSlope = 0
  let energyPerKg = 0
  let energyFixed = 0

  for (let i = 0; i < cells.length; i++) {
    const idx = cells[i]
    const z = elevationAt(t, idx)
    const slope = slopeAt(t, idx)
    let grade = 0
    if (i > 0) {
      const prev = cells[i - 1]
      const dxm = ((idx % w) - (prev % w)) * cx
      const dym = (Math.floor(idx / w) - Math.floor(prev / w)) * cy
      const d = Math.hypot(dxm, dym)
      const dz = z - elevationAt(t, prev)
      grade = (Math.atan2(dz, d) * 180) / Math.PI
      const speed = walkingSpeedMs(grade)
      const dt = d / speed
      dist += Math.hypot(d, dz)
      time += dt
      const e = segmentEnergy(d, grade, speed)
      energyPerKg += e.perKg
      energyFixed += e.fixed
      if (dz > 0) ascent += dz
      else descent -= dz
    }
    if (slope > maxSlope) maxSlope = slope
    samples.push({ ...cellCenter(t, idx), dist, elevation: z, grade, slope, time })
  }
  return { samples, distance: dist, duration: time, ascent, descent, maxSlope, energyPerKg, energyFixed }
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
 * Worst-case walk back to the habitat from anywhere on a route.
 *
 * For every cell it finds the fastest safe way to the habitat over the terrain,
 * with the same rules and walking model as the route search. Costs depend on
 * direction (climbing is slower than descending), so this is computed towards
 * the habitat and is not the outbound time reversed.
 */
export function walkBack(t: Terrain, habitat: LatLon, route: LatLon[]): WalkBack | null {
  const home = cellAt(t, habitat)
  if (home < 0 || isBlocked(t, home) || route.length === 0) return null
  const w = t.width
  const h = t.height
  const cx = t.meta.cellSizeX_m
  const cy = t.meta.cellSizeY_m
  const stepLen = DX.map((dx, k) => Math.hypot(dx * cx, DY[k] * cy))

  // Cells of the route still waiting for their answer; the search stops when none are left.
  const wanted = new Uint8Array(w * h)
  let pending = 0
  const cells: number[] = []
  for (const p of route) {
    const c = cellAt(t, p)
    cells.push(c)
    if (c >= 0 && !wanted[c]) {
      wanted[c] = 1
      pending++
    }
  }

  const time = new Float32Array(w * h).fill(Infinity)
  const dist = new Float32Array(w * h).fill(Infinity)
  const closed = new Uint8Array(w * h)
  const heap = new MinHeap()
  time[home] = 0
  dist[home] = 0
  heap.push(home, 0)

  // Dijkstra outwards from the habitat over reversed steps: when cell v is settled,
  // each neighbour u is offered the cost of walking u -> v.
  while (heap.size > 0 && pending > 0) {
    const v = heap.pop()
    if (closed[v]) continue
    closed[v] = 1
    if (wanted[v]) pending--
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

  let maxTime = 0
  let maxDistance = 0
  let maxTimeAt = route[0]
  let maxDistanceAt = route[0]
  let reachable = true
  cells.forEach((c, i) => {
    if (c < 0 || !closed[c]) {
      reachable = false
      return
    }
    if (time[c] > maxTime) {
      maxTime = time[c]
      maxTimeAt = route[i]
    }
    if (dist[c] > maxDistance) {
      maxDistance = dist[c]
      maxDistanceAt = route[i]
    }
  })
  return { maxTime, maxTimeAt, maxDistance, maxDistanceAt, reachable }
}
