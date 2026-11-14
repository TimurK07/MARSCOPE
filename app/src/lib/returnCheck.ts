// Return to the habitat: from every point of a route, is there ONE way back
// that is both short enough and quick enough?
//
// The two limits are MARSCOPE planning assumptions (see RETURN_LIMITS in
// model.ts). They are checked together, on the same return path. The shortest
// way back and the fastest way back are in general different paths, so testing
// each limit on its own best path would accept a point from which no single
// path meets both. This is a shortest-path problem with a resource constraint,
// and it is decided exactly:
//
//   1. Lower bounds. For a weight w between 0 and 1, the cheapest way back by
//      the combined cost  w * distance / D + (1 - w) * time / T  is found for
//      every cell by a search outwards from the habitat. A path within both
//      limits costs at most 1 for every w, so a cell whose cheapest cost is
//      above 1 for some w has no such path. (w = 1 is "shortest way back is
//      longer than D"; w = 0 is "fastest way back is slower than T".)
//   2. Witnesses. Each of those searches also yields a real path for every
//      cell. If one of them is within both limits, the cell passes.
//   3. Exact search. Cells still undecided get a search over (distance, time)
//      labels from the cell towards the habitat. A label is dropped only when
//      a bound from step 1 proves it cannot finish within both limits, or when
//      another label at the same cell is no longer and no slower. It stops at
//      the first label to reach the habitat, or when none is left.
//
// Steps 1 and 2 never give a wrong answer; step 3 settles what they leave open.
// Step 3 has a work budget. If it runs out, that point is reported as not
// verified: the plan is then neither passed (no path within both limits was
// found) nor called a proven failure (none was ruled out). The check is never
// relaxed to save time.
//
// The same field serves every route priority of a plan, so all three are held
// to the same answer. Costs depend on direction (a climb is slower than a
// descent), so everything here is computed for walking towards the habitat.
// Paths are grid paths, not straightened ones: their length is never shorter
// than the straightened equivalent, so the check errs on the careful side.

import { RETURN_LIMITS, walkingSpeedMs } from './model'
import { cellAt, elevationAt, type LatLon, type Terrain } from './terrain'
import { DX, DY, gradeAllowed, gradeDeg, isWalkable, MinHeap, stepLengths } from './traverse'

export interface ReturnLimits {
  /** Longest acceptable way back, metres. */
  distance_m: number
  /** Slowest acceptable way back, seconds. */
  time_s: number
}

export interface WalkBack {
  /**
   * The return from the worst point of the route: length and duration of one
   * and the same path back. When `feasible`, both are within the limits.
   * When not, it is the least bad return found, and at least one is over.
   */
  maxDistance: number
  maxTime: number
  /** The worst point (the same for both values). */
  maxDistanceAt: LatLon
  maxTimeAt: LatLon
  /** False when some point of the route has no way back at all within the slope limit. */
  reachable: boolean
  /** True when every point of the route has one way back within both limits. */
  feasible: boolean
  /**
   * False when the plan was not shown to pass and was not shown to fail: for
   * some point the exact search ran out of its work budget, and no other point
   * is a proven failure. Such a plan is neither GO nor a confirmed NO-GO.
   */
  verified: boolean
}

/** Tolerance for comparing a lower bound with 1: a bound must be clearly above 1 to rule a cell out. */
const EPS = 1e-9
/** Most fields one habitat gets: fastest, shortest, and up to two weighted for the cells left open. */
const MAX_FIELDS = 4
/**
 * A field for any weight but the first stops at this combined cost: a cell
 * dearer than 1 is ruled out by that fact alone, so its exact value is not needed.
 * The fastest-way-back field has no cap, because it also tells whether a cell
 * has any way back at all.
 */
const FIELD_CAP = 1 + 1e-6
/** Work budget of all exact searches of one field (one plan), in labels expanded. */
const DEFAULT_LABEL_BUDGET = 3_000_000

/**
 * Cheapest way back to the habitat from every cell by one combined cost,
 * searched outwards from the habitat over reversed steps and extended on demand.
 */
class CostField {
  readonly w: number
  /** Length and duration of the cheapest way back from each cell. Infinity until known. */
  readonly dist: Float64Array
  readonly time: Float64Array
  /** The next cell on that way back, -1 at the habitat and where unknown. */
  readonly next: Int32Array
  private readonly closed: Uint8Array
  private readonly heap = new MinHeap()
  private readonly t: Terrain
  private readonly limits: ReturnLimits
  private readonly stepLen: number[]
  /** Fields with a cap stop once every remaining cell would cost more than the cap. */
  private readonly cap: number
  private exhausted = false

  constructor(t: Terrain, home: number, w: number, limits: ReturnLimits, cap: number) {
    this.t = t
    this.w = w
    this.limits = limits
    this.cap = cap
    const n = t.width * t.height
    this.dist = new Float64Array(n).fill(Infinity)
    this.time = new Float64Array(n).fill(Infinity)
    this.next = new Int32Array(n).fill(-1)
    this.closed = new Uint8Array(n)
    this.stepLen = stepLengths(t)
    this.dist[home] = 0
    this.time[home] = 0
    this.heap.push(home, 0)
  }

  private cost(d: number, s: number): number {
    if (d === Infinity) return Infinity
    return (this.w * d) / this.limits.distance_m + ((1 - this.w) * s) / this.limits.time_s
  }

  /** Continues the search until every listed cell is settled, or cannot be. */
  settle(cells: Iterable<number>) {
    const { t, dist, time, closed, heap, stepLen } = this
    const w = t.width
    const h = t.height
    const wanted = new Set<number>()
    for (const c of cells) if (c >= 0 && !closed[c]) wanted.add(c)
    while (wanted.size > 0 && !this.exhausted) {
      if (heap.size === 0 || heap.peekKey() > this.cap) {
        this.exhausted = true
        break
      }
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
        if (closed[u] || !isWalkable(t, u)) continue
        if (DX[k] !== 0 && DY[k] !== 0 && (!isWalkable(t, y * w + ux) || !isWalkable(t, uy * w + x))) continue
        const d = stepLen[k]
        // The step is walked from u to v, towards the habitat.
        const dz = zv - elevationAt(t, u)
        const grade = gradeDeg(dz, d)
        if (!gradeAllowed(grade)) continue
        const nd = dist[v] + Math.hypot(d, dz)
        const nt = time[v] + d / walkingSpeedMs(grade)
        const cand = this.cost(nd, nt)
        if (cand < this.cost(dist[u], time[u])) {
          dist[u] = nd
          time[u] = nt
          this.next[u] = v
          heap.push(u, cand)
        }
      }
    }
  }

  /** The cells of the cheapest way back from a settled cell, from the cell to the habitat. */
  path(c: number): number[] {
    const out = [c]
    for (let v = this.next[c]; v >= 0; v = this.next[v]) out.push(v)
    return out
  }

  /** True when the cheapest way back from the cell is known. */
  known(c: number): boolean {
    return this.closed[c] === 1
  }

  /**
   * Cheapest combined cost of a way back from the cell: exact when known,
   * otherwise Infinity (no way back, or dearer than this field's cap).
   * Either way it is a valid lower bound for the purpose of ruling paths out
   * against 1, because the cap is above 1.
   */
  bound(c: number): number {
    if (!this.closed[c]) this.settle([c])
    return this.closed[c] ? this.cost(this.dist[c], this.time[c]) : Infinity
  }
}

interface Decision {
  feasible: boolean
  verified: boolean
  reachable: boolean
  /** A return path for the cell: a witness when feasible, the least bad one found when not. */
  dist: number
  time: number
  /** Where that path comes from: the index of a field, or the cells themselves. */
  via?: number | number[]
}

/** The rest of a return path found earlier, from one of its cells onwards. */
interface Hint {
  d: number
  s: number
  /** The whole path it belongs to, and the position of this cell in it. */
  path: number[]
  from: number
}

/**
 * Return-to-habitat check for one habitat. Build it once per plan and use it
 * for every route priority.
 */
export class WalkBackField {
  private readonly t: Terrain
  private readonly home: number
  readonly limits: ReturnLimits
  private readonly fields: CostField[] = []
  private readonly decided = new Map<number, Decision>()
  /** For cells on return paths found by the exact search: length and time of the rest of that path. */
  private readonly hints = new Map<number, Hint>()
  private readonly labelBudget: number
  /** Work done so far, for benchmarks and tests. */
  readonly stats = { fields: 0, exactSearches: 0, labels: 0, unverified: 0 }

  constructor(t: Terrain, habitat: LatLon, limits: ReturnLimits = RETURN_LIMITS, labelBudget = DEFAULT_LABEL_BUDGET) {
    this.t = t
    this.home = cellAt(t, habitat)
    this.limits = limits
    this.labelBudget = labelBudget
    if (this.valid) this.addField(0, Infinity)
  }

  /** False when the habitat is outside the grid or on ground that is not walkable. */
  get valid(): boolean {
    return this.home >= 0 && isWalkable(this.t, this.home)
  }

  private addField(w: number, cap: number) {
    this.fields.push(new CostField(this.t, this.home, w, this.limits, cap))
    this.stats.fields++
  }

  private within(d: number, s: number): boolean {
    return d <= this.limits.distance_m && s <= this.limits.time_s
  }

  /** How far outside the limits a return is: at most 1 when within both. */
  private excess(d: number, s: number): number {
    return Math.max(d / this.limits.distance_m, s / this.limits.time_s)
  }

  /**
   * What the first `count` fields say about a cell, or null when they leave it
   * open. Every one of those fields must already have been asked for the cell.
   */
  private fromFields(c: number, count: number): Decision | null {
    if (!this.fields[0].known(c)) {
      // Not reached by the uncapped search, which ran until it either was or could not be: there is no way back.
      return { feasible: false, verified: true, reachable: false, dist: Infinity, time: Infinity }
    }
    let ruledOut = false
    for (let i = 0; i < count; i++) {
      const f = this.fields[i]
      if (!f.known(c)) {
        // A capped field that was asked and did not reach the cell: its cheapest cost is above the cap, hence above 1.
        ruledOut = true
        continue
      }
      const d = f.dist[c]
      const s = f.time[c]
      // A real path within both limits settles the matter. The first field is the fastest way back.
      if (this.within(d, s)) return { feasible: true, verified: true, reachable: true, dist: d, time: s, via: i }
      if ((f.w * d) / this.limits.distance_m + ((1 - f.w) * s) / this.limits.time_s > 1 + EPS) ruledOut = true
    }
    if (ruledOut) {
      const lb = this.leastBad(c)
      return { feasible: false, verified: true, reachable: true, dist: lb.d, time: lb.s, via: lb.via }
    }
    return null
  }

  /** The least bad return the fields know for a cell, for reporting a failure. */
  private leastBad(c: number): { d: number; s: number; via: number } {
    let best = { d: Infinity, s: Infinity, via: 0 }
    this.fields.forEach((f, i) => {
      if (!f.known(c)) return
      if (this.excess(f.dist[c], f.time[c]) < this.excess(best.d, best.s)) best = { d: f.dist[c], s: f.time[c], via: i }
    })
    return best
  }

  /**
   * Exact search for one cell: is there a way back within both limits?
   * Returns the path's length and time, null when there is provably none, or
   * 'budget' when the work budget ran out first.
   */
  private exact(start: number, budget: number): { d: number; s: number; path: number[] } | null | 'budget' {
    const { t, home, limits, fields } = this
    const w = t.width
    const h = t.height
    const stepLen = stepLengths(t)
    const D = limits.distance_m
    const T = limits.time_s
    this.stats.exactSearches++
    let spent = 0

    // Largest lower bound of the final combined cost over all fields; above 1 means hopeless.
    const worstBound = (c: number, d: number, s: number): number => {
      let worst = 0
      for (const f of fields) {
        const b = (f.w * d) / D + ((1 - f.w) * s) / T + f.bound(c)
        if (b > worst) worst = b
        if (worst > 1 + EPS) break
      }
      return worst
    }

    // The cells from the start to a label, in walking order.
    const trail = (id: number): number[] => {
      const out: number[] = []
      for (let i = id; i >= 0; i = parent[i]) out.push(node[i])
      return out.reverse()
    }
    // A label may stop early at a cell from which a path already known finishes within both limits.
    // Returns the whole path, start to habitat, with its length and duration.
    const finish = (id: number, c: number, d: number, s: number): { d: number; s: number; path: number[] } | null => {
      const hint = this.hints.get(c)
      if (hint && d + hint.d <= D && s + hint.s <= T) {
        return { d: d + hint.d, s: s + hint.s, path: [...trail(id), ...hint.path.slice(hint.from + 1)] }
      }
      for (const f of fields) {
        if (f.known(c) && d + f.dist[c] <= D && s + f.time[c] <= T) {
          return { d: d + f.dist[c], s: s + f.time[c], path: [...trail(id), ...f.path(c).slice(1)] }
        }
      }
      return null
    }
    // Remembers, for every cell the search walked on a path found, the rest of that path: later searches can join it.
    const remember = (id: number, total: { d: number; s: number; path: number[] }) => {
      let at = trail(id).length - 1
      for (let i = id; i >= 0; i = parent[i], at--) {
        const rest = { d: total.d - dist[i], s: total.s - time[i] }
        const old = this.hints.get(node[i])
        if (!old || this.excess(rest.d, rest.s) < this.excess(old.d, old.s)) this.hints.set(node[i], { ...rest, path: total.path, from: at })
      }
    }

    const node: number[] = []
    const dist: number[] = []
    const time: number[] = []
    const parent: number[] = []
    // Per cell: the labels kept so far, as flat [distance, time] pairs, none dominating another.
    const fronts = new Map<number, number[]>()
    const heap = new MinHeap()
    const add = (c: number, d: number, s: number, key: number, from: number): number => {
      node.push(c)
      dist.push(d)
      time.push(s)
      parent.push(from)
      heap.push(node.length - 1, key)
      return node.length - 1
    }
    add(start, 0, 0, worstBound(start, 0, 0), -1)
    fronts.set(start, [0, 0])

    while (heap.size > 0) {
      const id = heap.pop()
      const c = node[id]
      const d0 = dist[id]
      const s0 = time[id]
      if (c === home) {
        const total = { d: d0, s: s0, path: trail(id) }
        remember(id, total)
        return total
      }
      // Skip a label that has since been beaten at its cell.
      const here = fronts.get(c)!
      let beaten = false
      for (let i = 0; i < here.length; i += 2) {
        if ((here[i] < d0 && here[i + 1] <= s0) || (here[i] <= d0 && here[i + 1] < s0)) {
          beaten = true
          break
        }
      }
      if (beaten) continue
      this.stats.labels++
      if (++spent > budget) return 'budget'
      const x = c % w
      const y = (c - x) / w
      const zc = elevationAt(t, c)
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const n = ny * w + nx
        if (!isWalkable(t, n)) continue
        if (DX[k] !== 0 && DY[k] !== 0 && (!isWalkable(t, y * w + nx) || !isWalkable(t, ny * w + x))) continue
        const len = stepLen[k]
        const dz = elevationAt(t, n) - zc
        const grade = gradeDeg(dz, len)
        if (!gradeAllowed(grade)) continue
        const d = d0 + Math.hypot(len, dz)
        const s = s0 + len / walkingSpeedMs(grade)
        if (d > D || s > T) continue
        const key = worstBound(n, d, s)
        if (key > 1 + EPS) continue
        let front = fronts.get(n)
        if (front) {
          let dominated = false
          for (let i = 0; i < front.length; i += 2) {
            if (front[i] <= d && front[i + 1] <= s) {
              dominated = true
              break
            }
          }
          if (dominated) continue
          const kept: number[] = []
          for (let i = 0; i < front.length; i += 2) if (!(d <= front[i] && s <= front[i + 1])) kept.push(front[i], front[i + 1])
          kept.push(d, s)
          front = kept
        } else front = [d, s]
        fronts.set(n, front)
        const made = add(n, d, s, key, id)
        const done = finish(made, n, d, s)
        if (done) {
          remember(made, done)
          return done
        }
      }
    }
    return null
  }

  /**
   * The weight at which the fastest and the shortest way back from a cell cost
   * the same: the most telling one to try next for that cell.
   */
  private balancedWeight(c: number): number {
    const [fast, short] = this.fields
    const a0 = fast.dist[c] / this.limits.distance_m
    const b0 = fast.time[c] / this.limits.time_s
    const a1 = short.dist[c] / this.limits.distance_m
    const b1 = short.time[c] / this.limits.time_s
    const w = (b1 - b0) / (a0 - a1 + (b1 - b0))
    return Number.isFinite(w) ? Math.min(Math.max(w, 0.05), 0.95) : 0.5
  }

  /** Decides every listed cell, using as little work as the cells need. */
  private decide(cells: number[]) {
    let open = [...new Set(cells)].filter((c) => c >= 0 && !this.decided.has(c))
    const sweep = (count: number) => {
      open = open.filter((c) => {
        const d = this.fromFields(c, count)
        if (d) this.decided.set(c, d)
        return !d
      })
    }
    // Each field can rule cells out, or produce a real path within both limits.
    // First the fastest way back, then the shortest, then any built for earlier routes.
    for (let i = 0; open.length > 0 && i < Math.max(2, this.fields.length); i++) {
      if (this.fields.length <= i) this.addField(1, FIELD_CAP)
      this.fields[i].settle(open)
      sweep(i + 1)
    }
    // Still open: the fastest way back is too long and the shortest too slow.
    // One more field, weighted for these cells, usually settles them or leaves little to search.
    if (open.length > 0 && this.fields.length < MAX_FIELDS) {
      const ws = open.map((c) => this.balancedWeight(c)).sort((a, b) => a - b)
      this.addField(ws[ws.length >> 1], FIELD_CAP)
      this.fields[this.fields.length - 1].settle(open)
      sweep(this.fields.length)
    }
    // What is left is settled by exact search.
    for (const c of open) {
      const res = this.exact(c, this.labelBudget - this.stats.labels)
      if (res && res !== 'budget') {
        this.decided.set(c, { feasible: true, verified: true, reachable: true, dist: res.d, time: res.s, via: res.path })
      } else {
        if (res === 'budget') this.stats.unverified++
        const lb = this.leastBad(c)
        this.decided.set(c, { feasible: false, verified: res !== 'budget', reachable: true, dist: lb.d, time: lb.s, via: lb.via })
      }
    }
  }

  /** The return from one cell. For tests and inspection. */
  cell(c: number): Decision | null {
    if (!this.valid || c < 0) return null
    this.decide([c])
    return this.decided.get(c) ?? null
  }

  /**
   * The cells of the return path reported for a cell, from the cell to the
   * habitat: the path whose length and duration `cell()` gives. Null when the
   * cell has no way back.
   */
  returnPath(c: number): number[] | null {
    const d = this.cell(c)
    if (!d || !d.reachable || d.via === undefined) return null
    return typeof d.via === 'number' ? this.fields[d.via].path(c) : d.via
  }

  /** Assesses a whole route: every point of it must have a way back within both limits. */
  assess(route: LatLon[]): WalkBack | null {
    if (!this.valid || route.length === 0) return null
    const cells = route.map((p) => cellAt(this.t, p))
    this.decide(cells)
    // Three outcomes. A point that provably has no way back within both limits fails the
    // plan. Otherwise a point whose search ran out of budget leaves the plan unverified.
    // Only when every point has a real path within both limits does the plan pass.
    let reachable = true
    let proven = -1
    let provenExcess = -1
    let open = -1
    let worst = -1
    let worstExcess = -1
    cells.forEach((c, i) => {
      const d = c >= 0 ? this.decided.get(c) : undefined
      if (!d || !d.reachable) {
        reachable = false
        return
      }
      const e = this.excess(d.dist, d.time)
      if (!d.feasible && d.verified && e > provenExcess) {
        provenExcess = e
        proven = i
      }
      if (!d.verified && open < 0) open = i
      if (e > worstExcess) {
        worstExcess = e
        worst = i
      }
    })
    if (worst < 0) {
      return { maxDistance: Infinity, maxTime: Infinity, maxDistanceAt: route[0], maxTimeAt: route[0], reachable, feasible: false, verified: true }
    }
    const failed = !reachable || proven >= 0
    // Report the point that decides the outcome: a proven failure first, then an unverified point, then the tightest pass.
    const at = proven >= 0 ? proven : open >= 0 ? open : worst
    const d = this.decided.get(cells[at])!
    return {
      maxDistance: d.dist,
      maxTime: d.time,
      maxDistanceAt: route[at],
      maxTimeAt: route[at],
      reachable,
      feasible: !failed && open < 0,
      verified: failed || open < 0,
    }
  }
}

/** Return check for one route. See WalkBackField. */
export function walkBack(t: Terrain, habitat: LatLon, route: LatLon[], limits: ReturnLimits = RETURN_LIMITS): WalkBack | null {
  return new WalkBackField(t, habitat, limits).assess(route)
}
