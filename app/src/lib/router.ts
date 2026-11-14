// Route search (A*) over the terrain grid.
//
// Each step between neighbouring cells has a cost set by the route priority
// (time, energy, or weighted time), given the grade along the direction of
// travel. Which steps exist at all is decided in traverse.ts and is the same
// for every priority.

import { cellAt, cellCenter, elevationAt, type LatLon, type Terrain } from './terrain'
import { DX, DY, gradeAllowed, gradeDeg, isWalkable, MinHeap, stepLengths } from './traverse'
import { timeObjective, type Objective } from './objectives'
import { measurePath, smoothPath, type PathMeasure, type PathSample } from './pathGeometry'

export { isWalkable } from './traverse'
export { WalkBackField, walkBack, type WalkBack } from './returnCheck'

export type RouteSample = PathSample

export interface RouteLeg extends PathMeasure {
  /** Corner points of the route, joined by straight lines. */
  vertices: LatLon[]
  /** The same leg as the grid search found it, before straightening, for comparison. */
  grid: { distance: number; duration: number; cells: number; cost: number }
}

export type LegResult = { ok: true; leg: RouteLeg } | { ok: false; reason: string }

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
  if (!isWalkable(t, start)) return { ok: false, reason: 'Start point is on terrain steeper than the slope limit.' }
  if (!isWalkable(t, goal)) return { ok: false, reason: 'Target is on terrain steeper than the slope limit.' }

  const w = t.width
  const h = t.height
  const cx = t.meta.cellSizeX_m
  const cy = t.meta.cellSizeY_m
  const stepLen = stepLengths(t)

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
      if (closed[n] || !isWalkable(t, n)) continue
      // A diagonal step passes the corner of two other cells: both must be walkable.
      if (DX[k] !== 0 && DY[k] !== 0 && (!isWalkable(t, y * w + nx) || !isWalkable(t, ny * w + x))) continue
      const d = stepLen[k]
      const grade = gradeDeg(elevationAt(t, n) - zCur, d)
      // The step itself must be within the slope limit, whatever the two cells say.
      if (!gradeAllowed(grade)) continue
      const cand = g[cur] + obj.pieceCost(d, grade, n)
      if (cand < g[n]) {
        g[n] = cand
        came[n] = cur
        heap.push(n, cand + heuristic(n))
      }
    }
  }

  if (!Number.isFinite(g[goal])) {
    return { ok: false, reason: 'No route within the slope limit: the target is cut off by steeper ground.' }
  }

  const cells: number[] = []
  for (let c = goal; c !== -1; c = came[c]) cells.push(c)
  cells.reverse()

  const grid = measurePath(t, cells, obj)
  if (!grid) return { ok: false, reason: 'No route within the slope limit: the path found does not stay on walkable ground.' }
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
