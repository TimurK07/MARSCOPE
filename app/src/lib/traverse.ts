// What may be walked at all. These are the hard limits shared by every route
// priority, by route straightening and by the return-to-habitat check: nothing
// else in the planner decides whether a piece of ground is allowed.
//
// A step between neighbouring cells is allowed only when
//   1. both cells have terrain data and a terrain slope within the limit,
//   2. a diagonal step does not pass between two cells of which either is blocked,
//   3. the grade of the step itself, from the elevation difference of the two
//      cell centres over their horizontal distance, is within the limit.
// Rule 3 is needed because a cell's slope is a central difference across its
// neighbours and does not see the drop between the cell and the one next to it.

import { MAX_SLOPE_DEG } from './model'
import { elevationAt, slopeAt, type Terrain } from './terrain'

// 8-connected neighbourhood
export const DX = [1, 1, 0, -1, -1, -1, 0, 1]
export const DY = [0, 1, 1, 1, 0, -1, -1, -1]

/** A cell can be walked on when it has terrain data and its slope is within the limit. */
export function isWalkable(t: Terrain, idx: number): boolean {
  const s = slopeAt(t, idx)
  return !Number.isNaN(s) && s <= MAX_SLOPE_DEG
}

/** Grade in degrees of a rise dz over a horizontal distance d (positive = uphill). */
export const gradeDeg = (dz: number, d: number): number => (Math.atan2(dz, d) * 180) / Math.PI

/**
 * Whether a grade may be walked, uphill or downhill. Anything that is not a
 * number within the limit is refused, so missing or broken data never passes.
 */
export const gradeAllowed = (g: number): boolean => Math.abs(g) <= MAX_SLOPE_DEG

/** Horizontal length in metres of each of the eight neighbour steps. */
export function stepLengths(t: Terrain): number[] {
  return DX.map((dx, k) => Math.hypot(dx * t.meta.cellSizeX_m, DY[k] * t.meta.cellSizeY_m))
}

/**
 * Whether the step from cell (x, y) to its k-th neighbour is allowed.
 * The rule is the same in both directions: the limit applies to walking up and down alike.
 */
export function stepAllowed(t: Terrain, x: number, y: number, k: number, d: number): boolean {
  const nx = x + DX[k]
  const ny = y + DY[k]
  if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) return false
  const from = y * t.width + x
  const to = ny * t.width + nx
  if (!isWalkable(t, from) || !isWalkable(t, to)) return false
  if (DX[k] !== 0 && DY[k] !== 0 && (!isWalkable(t, y * t.width + nx) || !isWalkable(t, ny * t.width + x))) return false
  return gradeAllowed(gradeDeg(elevationAt(t, to) - elevationAt(t, from), d))
}

/** Binary min-heap of (id, key) pairs. */
export class MinHeap {
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
  /** Key of the entry pop() would return. */
  peekKey(): number {
    return this.keys[0]
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
