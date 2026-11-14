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

function isBlocked(t: Terrain, idx: number): boolean {
  const s = slopeAt(t, idx)
  return Number.isNaN(s) || s > MAX_SLOPE_DEG
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
      if (closed[n] || isBlocked(t, n)) continue
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
