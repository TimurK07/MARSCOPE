// A* must return the same travel time as an exhaustive search.
// Compared before straightening: straightening can only make a route quicker.
import { describe, expect, it } from 'vitest'
import { MAX_SLOPE_DEG, walkingSpeedMs } from '../model'
import { findLeg, isWalkable } from '../router'
import { at, CELL, makeTerrain, rng } from './synthetic'
import type { Terrain } from '../terrain'

const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]

/** Plain Dijkstra with no heuristic and no priority queue: slow, simple, obviously right. */
function dijkstraTime(t: Terrain, sx: number, sy: number, gx: number, gy: number): number {
  const n = t.width * t.height
  const elev = (i: number) => t.elevRaw[i] * 0.1
  const dist = new Array<number>(n).fill(Infinity)
  const done = new Array<boolean>(n).fill(false)
  dist[sy * t.width + sx] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i
    if (u < 0) return Infinity
    if (u === gy * t.width + gx) return dist[u]
    done[u] = true
    const x = u % t.width
    const y = (u - x) / t.width
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) continue
      const v = ny * t.width + nx
      if (!isWalkable(t, v)) continue
      if (DX[k] !== 0 && DY[k] !== 0 && (!isWalkable(t, y * t.width + nx) || !isWalkable(t, ny * t.width + x))) continue
      const d = Math.hypot(DX[k] * CELL, DY[k] * CELL)
      const grade = (Math.atan2(elev(v) - elev(u), d) * 180) / Math.PI
      const cand = dist[u] + d / walkingSpeedMs(grade)
      if (cand < dist[v]) dist[v] = cand
    }
  }
}

describe('A* against exhaustive search', () => {
  it('finds the same travel time on random hilly terrain with obstacles', () => {
    const rand = rng(2026)
    let compared = 0
    let unreachable = 0
    for (let n = 0; n < 60; n++) {
      const size = 14 + Math.floor(rand() * 10)
      // Smooth hills plus noise, and scattered no-go cells.
      const phase = rand() * 6
      const amp = rand() * 6
      const t = makeTerrain(
        size,
        size,
        () => (rand() < 0.22 ? MAX_SLOPE_DEG + 5 : rand() * 18),
        (x, y) => 20 + amp * Math.sin(x / 2.5 + phase) + amp * Math.cos(y / 3 + phase) + rand() * 0.6,
      )
      const pick = () => {
        for (;;) {
          const x = Math.floor(rand() * size)
          const y = Math.floor(rand() * size)
          if (isWalkable(t, y * size + x)) return { x, y }
        }
      }
      const a = pick()
      const b = pick()
      const expected = dijkstraTime(t, a.x, a.y, b.x, b.y)
      const got = findLeg(t, at(t, a.x, a.y), at(t, b.x, b.y), { smooth: false })
      if (expected === Infinity) {
        expect(got.ok).toBe(false)
        unreachable++
      } else {
        expect(got.ok).toBe(true)
        if (got.ok) expect(got.leg.duration).toBeCloseTo(expected, 2)
        compared++
      }
    }
    // Both outcomes must actually occur for the comparison to mean something.
    expect(compared).toBeGreaterThan(20)
    expect(unreachable).toBeGreaterThan(0)
  })

  it('is not symmetric: the way back can cost a different time', () => {
    const rise = CELL * Math.tan((8 * Math.PI) / 180)
    const t = makeTerrain(20, 6, () => 8, (x) => x * rise)
    const up = dijkstraTime(t, 2, 3, 17, 3)
    const down = dijkstraTime(t, 17, 3, 2, 3)
    expect(up).toBeGreaterThan(down)
    const viaAstar = findLeg(t, at(t, 2, 3), at(t, 17, 3), { smooth: false })
    expect(viaAstar.ok && viaAstar.leg.duration).toBeCloseTo(up, 2)
  })
})
