// Route geometry: measuring a path over the terrain, and straightening the
// staircase a grid search produces without ever leaving safe ground.
//
// A straight shortcut is accepted only when all of these hold:
//   1. every cell the line passes through is walkable, including both cells
//      beside any grid corner the line touches;
//   2. by the objective the route is optimised for (time, energy, or the
//      cautious weighting), it costs no more than the grid path it replaces;
//   3. it does not cross more hidden steep ground, in total, than the path it replaces.
// A shorter line is therefore not assumed to be better: it has to prove it.

import { MAX_SLOPE_DEG, segmentEnergy, walkingSpeedMs } from './model'
import { timeObjective, type Objective } from './objectives'
import { elevationAtPoint, hiddenSteepShare, pointToLatLon, slopeAt, type LatLon, type Terrain } from './terrain'

export interface PathSample extends LatLon {
  /** Distance from the start, metres, along the surface. */
  dist: number
  elevation: number
  /** Grade along the direction of travel, degrees (positive = uphill). */
  grade: number
  /** Terrain slope of the cell under the sample, degrees. */
  slope: number
  /** Time from the start, seconds. */
  time: number
}

export interface PathMeasure {
  samples: PathSample[]
  distance: number
  duration: number
  ascent: number
  descent: number
  /** Steepest terrain slope of any cell the path passes through. */
  maxSlope: number
  energyPerKg: number
  energyFixed: number
  /**
   * Hidden steep ground met along the path: the shares of the cells crossed, added up.
   * 1.0 is the equivalent of one whole cell of ground steeper than the limit at 1 m.
   * Null without subcell data. Straightening never increases it.
   */
  hiddenLoad: number | null
  /** Largest share of hidden steep ground in any cell crossed. */
  hiddenMax: number | null
  /** Share of the cells crossed that contain any hidden steep ground. */
  hiddenCells: number | null
  /** Number of distinct cells the path passes through. */
  cellsCrossed: number
  /** Value of the objective the path was measured against (seconds, joules, or weighted seconds). */
  cost: number
}

const walkable = (t: Terrain, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= t.width || y >= t.height) return false
  const s = slopeAt(t, y * t.width + x)
  return !Number.isNaN(s) && s <= MAX_SLOPE_DEG
}

/**
 * Cells the straight line between two cell centres passes through, in order.
 * Returns null when the line would touch ground that is not walkable.
 *
 * Integer arithmetic keeps the corner case exact: when the line passes through
 * the corner shared by four cells, the two cells beside it are checked as well,
 * so a line can never slip between two blocked cells that touch at a corner.
 */
export function lineCells(t: Terrain, x0: number, y0: number, x1: number, y1: number): number[] | null {
  const nx = Math.abs(x1 - x0)
  const ny = Math.abs(y1 - y0)
  const sx = x1 > x0 ? 1 : -1
  const sy = y1 > y0 ? 1 : -1
  let x = x0
  let y = y0
  if (!walkable(t, x, y)) return null
  const cells = [y * t.width + x]
  let ix = 0
  let iy = 0
  while (ix < nx || iy < ny) {
    // Where the line next crosses a vertical / horizontal cell border, on a common scale.
    const tx = (1 + 2 * ix) * ny
    const ty = (1 + 2 * iy) * nx
    if (tx === ty) {
      // Exactly through a corner: both neighbours of the corner must be safe too.
      // They are only touched at a point, so they are checked but not listed as crossed.
      if (!walkable(t, x + sx, y) || !walkable(t, x, y + sy)) return null
      x += sx
      y += sy
      ix++
      iy++
    } else if (tx < ty) {
      x += sx
      ix++
    } else {
      y += sy
      iy++
    }
    if (!walkable(t, x, y)) return null
    cells.push(y * t.width + x)
  }
  return cells
}

interface Totals {
  dist: number
  time: number
  ascent: number
  descent: number
  perKg: number
  fixed: number
  cost: number
}

/**
 * Walks the straight line between two cell centres in pieces no longer than
 * about one and a half cells, reading elevation at each end of a piece.
 * A step between neighbouring cells is a single piece, so a grid path measured
 * this way gives exactly what the route search charged for it.
 */
function walkSegment(t: Terrain, x0: number, y0: number, x1: number, y1: number, tot: Totals, out: PathSample[] | null, obj: Objective) {
  const cx = t.meta.cellSizeX_m
  const cy = t.meta.cellSizeY_m
  const length = Math.hypot((x1 - x0) * cx, (y1 - y0) * cy)
  const n = Math.max(1, Math.ceil(length / (1.5 * Math.min(cx, cy)) - 1e-9))
  const d = length / n
  let fxPrev = x0 + 0.5
  let fyPrev = y0 + 0.5
  let zPrev = elevationAtPoint(t, fxPrev, fyPrev)
  for (let i = 1; i <= n; i++) {
    const fx = x0 + 0.5 + ((x1 - x0) * i) / n
    const fy = y0 + 0.5 + ((y1 - y0) * i) / n
    const z = elevationAtPoint(t, fx, fy)
    const dz = z - zPrev
    const grade = (Math.atan2(dz, d) * 180) / Math.PI
    const speed = walkingSpeedMs(grade)
    tot.dist += Math.hypot(d, dz)
    tot.time += d / speed
    if (dz > 0) tot.ascent += dz
    else tot.descent -= dz
    const e = segmentEnergy(d, grade, speed)
    tot.perKg += e.perKg
    tot.fixed += e.fixed
    const cell = Math.min(Math.floor(fy), t.height - 1) * t.width + Math.min(Math.floor(fx), t.width - 1)
    tot.cost += obj.pieceCost(d, grade, cell)
    if (out) {
      out.push({ ...pointToLatLon(t, fx, fy), dist: tot.dist, elevation: z, grade, slope: slopeAt(t, cell), time: tot.time })
    }
    fxPrev = fx
    fyPrev = fy
    zPrev = z
  }
}

const zero = (): Totals => ({ dist: 0, time: 0, ascent: 0, descent: 0, perKg: 0, fixed: 0, cost: 0 })

/** Cost of the straight line between two cell centres, by the given objective. */
function segmentCost(t: Terrain, x0: number, y0: number, x1: number, y1: number, obj: Objective): number {
  const tot = zero()
  walkSegment(t, x0, y0, x1, y1, tot, null, obj)
  return tot.cost
}

/**
 * Hidden steep ground met on one straight line: the shares of the cells it
 * crosses, added up, leaving out the first cell (it belongs to the line before).
 */
const hiddenAlong = (t: Terrain, cells: number[]): number => {
  let sum = 0
  for (let k = 1; k < cells.length; k++) sum += hiddenSteepShare(t, cells[k]) ?? 0
  return sum
}

/**
 * Measures a path given as cell indices joined by straight lines.
 * Returns null if any line touches ground that is not walkable: an unsafe
 * path is never measured as if it were usable.
 */
export function measurePath(t: Terrain, vertices: number[], obj: Objective = timeObjective()): PathMeasure | null {
  const w = t.width
  const tot = zero()
  const x = (c: number) => c % w
  const y = (c: number) => Math.floor(c / w)
  const first = vertices[0]
  if (!walkable(t, x(first), y(first))) return null
  const z0 = elevationAtPoint(t, x(first) + 0.5, y(first) + 0.5)
  const samples: PathSample[] = [
    { ...pointToLatLon(t, x(first) + 0.5, y(first) + 0.5), dist: 0, elevation: z0, grade: 0, slope: slopeAt(t, first), time: 0 },
  ]
  const crossed = new Set<number>([first])
  let hiddenLoad = hiddenSteepShare(t, first) ?? 0
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1]
    const b = vertices[i]
    const cells = lineCells(t, x(a), y(a), x(b), y(b))
    if (!cells) return null
    for (const c of cells) crossed.add(c)
    hiddenLoad += hiddenAlong(t, cells)
    walkSegment(t, x(a), y(a), x(b), y(b), tot, samples, obj)
  }
  let maxSlope = 0
  let hiddenMax: number | null = t.subSteep ? 0 : null
  let hiddenAny = 0
  for (const c of crossed) {
    const s = slopeAt(t, c)
    if (s > maxSlope) maxSlope = s
    const hShare = hiddenSteepShare(t, c)
    if (hShare != null && hiddenMax != null) {
      if (hShare > hiddenMax) hiddenMax = hShare
      if (hShare > 0) hiddenAny++
    }
  }
  const all = [...crossed]
  return {
    samples,
    distance: tot.dist,
    duration: tot.time,
    ascent: tot.ascent,
    descent: tot.descent,
    maxSlope,
    energyPerKg: tot.perKg,
    energyFixed: tot.fixed,
    hiddenLoad: t.subSteep ? hiddenLoad : null,
    hiddenMax,
    hiddenCells: t.subSteep ? hiddenAny / all.length : null,
    cellsCrossed: all.length,
    cost: tot.cost,
  }
}

/** How far ahead a single shortcut may reach, in cells of the grid path. */
const MAX_SPAN = 400
/** Stop looking further ahead after this many rejected shortcuts in a row. */
const MAX_MISSES = 24

/**
 * Straightens a grid path. Returns the cells to keep as vertices; joined by
 * straight lines they form a path that is safe, costs no more than the grid
 * path by the given objective, and crosses no more hidden steep ground.
 *
 * This is a greedy pass. It never makes the route worse, but it is not proven
 * to give the best possible straightened geometry.
 */
export function smoothPath(t: Terrain, cells: number[], obj: Objective = timeObjective()): number[] {
  if (cells.length < 3) return cells.slice()
  const w = t.width
  const x = (c: number) => c % w
  const y = (c: number) => Math.floor(c / w)

  // Running totals along the grid path, for comparing any stretch of it with a shortcut.
  const cost = new Float64Array(cells.length)
  const hidden = new Float64Array(cells.length)
  for (let i = 1; i < cells.length; i++) {
    cost[i] = cost[i - 1] + segmentCost(t, x(cells[i - 1]), y(cells[i - 1]), x(cells[i]), y(cells[i]), obj)
    const step = t.subSteep ? lineCells(t, x(cells[i - 1]), y(cells[i - 1]), x(cells[i]), y(cells[i])) : null
    hidden[i] = hidden[i - 1] + (step ? hiddenAlong(t, step) : 0)
  }

  const accept = (i: number, j: number): boolean => {
    const a = cells[i]
    const b = cells[j]
    const line = lineCells(t, x(a), y(a), x(b), y(b))
    if (!line) return false
    const replaced = cost[j] - cost[i]
    if (segmentCost(t, x(a), y(a), x(b), y(b), obj) > replaced * (1 + 1e-12) + 1e-9) return false
    // Same accounting as for the grid path: total hidden steep ground must not grow.
    if (t.subSteep && hiddenAlong(t, line) > hidden[j] - hidden[i] + 1e-9) return false
    return true
  }

  const out = [cells[0]]
  let i = 0
  const last = cells.length - 1
  while (i < last) {
    let best = i + 1
    let misses = 0
    for (let j = i + 2; j <= Math.min(last, i + MAX_SPAN); j++) {
      if (accept(i, j)) {
        best = j
        misses = 0
      } else if (++misses >= MAX_MISSES) break
    }
    out.push(cells[best])
    i = best
  }
  return out
}
