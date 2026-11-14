// What a route is optimised for. Each mode gives every step a cost; the route
// search minimises the sum. All modes share the same hard limits (walkable
// cells, no corner cutting): the mode changes preference, never what is allowed.

import { MAX_SPEED_MS, segmentEnergy, walkingSpeedMs } from './model'
import { hiddenSteepShare, type Terrain } from './terrain'

export type RouteMode = 'fastest' | 'energy' | 'cautious'

export const ROUTE_MODES: { id: RouteMode; label: string; short: string; summary: string }[] = [
  {
    id: 'fastest',
    label: 'Fastest',
    short: 'Least walking time',
    summary: 'Minimises predicted walking time. In the walking model a climb is slow, so this route often winds to keep the grade gentle.',
  },
  {
    id: 'energy',
    label: 'Energy-efficient',
    short: 'Least walking energy',
    summary:
      'Minimises predicted walking energy. It usually takes a shorter, more direct line and accepts slower, steeper walking. The energy model is an approximation: Santee et al. (2001), from treadmill walking on Earth with light loads. Mars gravity enters its climb and descent terms only; the level-walking term, most of the total, is the Earth value.',
  },
  {
    id: 'cautious',
    label: 'Cautious',
    short: 'Avoids hidden steep ground',
    summary: 'Like Fastest, but time on cells that hide steep ground at the 1 m scale counts for more, so it goes round them when the detour is small. The weight is a heuristic of ours, not a NASA-certified safety model and not a measured risk.',
  },
]

/**
 * Weight of hidden steep ground in the Cautious mode.
 *
 * This is a planning preference chosen by us, not a NASA standard and not a
 * measured risk. With a weight of 4, time spent crossing a cell whose 1 m pixels
 * are all steeper than the limit counts five times; a cell with a quarter of
 * such pixels counts double. Change it to make the mode more or less averse.
 */
export const CAUTION_WEIGHT = 4

export interface Objective {
  mode: RouteMode
  /** Unit of the cost, for display. */
  unit: string
  /**
   * Cost of walking one straight piece.
   * d: horizontal length, metres. gradeDeg: grade along the direction of travel.
   * cell: the cell the piece ends in.
   */
  pieceCost: (d: number, gradeDeg: number, cell: number) => number
  /**
   * A lower bound of the cost per horizontal metre over any ground. Multiplied by
   * the straight-line distance to the goal it never overestimates the remaining
   * cost, which is what keeps the A* search optimal.
   */
  minPerMetre: number
}

/** Fastest: seconds of walking. */
export function timeObjective(): Objective {
  return {
    mode: 'fastest',
    unit: 's',
    pieceCost: (d, grade) => d / walkingSpeedMs(grade),
    minPerMetre: 1 / MAX_SPEED_MS,
  }
}

/** Joules to walk a piece, for a suited mass, by the Santee et al. (2001) model. */
export function pieceEnergyJ(d: number, gradeDeg: number, massKg: number): number {
  const e = segmentEnergy(d, gradeDeg, walkingSpeedMs(gradeDeg))
  return e.perKg * massKg + e.fixed
}

/**
 * Smallest energy per horizontal metre over all grades, found numerically.
 * The model is smooth between its breakpoints, so a fine scan with a small
 * safety margin is a valid lower bound.
 */
export function minEnergyPerMetre(massKg: number): number {
  let min = Infinity
  for (let g = -60; g <= 60; g += 0.005) {
    const e = pieceEnergyJ(1, g, massKg)
    if (e < min) min = e
  }
  return min * 0.999
}

/** Energy-efficient: joules of walking energy for the given suited mass. */
export function energyObjective(massKg: number): Objective {
  return {
    mode: 'energy',
    unit: 'J',
    pieceCost: (d, grade) => pieceEnergyJ(d, grade, massKg),
    minPerMetre: minEnergyPerMetre(massKg),
  }
}

/**
 * Share of hidden steep ground used by the Cautious mode. A cell whose 1 m
 * pixels are all missing is treated as fully steep: unknown ground is not
 * assumed to be good ground.
 */
export function cautionShare(t: Terrain, cell: number): number {
  if (!t.subSteep) return 0
  return hiddenSteepShare(t, cell) ?? 1
}

/**
 * Cautious: walking time, with time on hidden steep ground weighted up.
 *   cost = time * (1 + CAUTION_WEIGHT * share of steep 1 m pixels in the cell)
 * The factor is never below 1, so the time lower bound still holds.
 */
export function cautiousObjective(t: Terrain, weight: number = CAUTION_WEIGHT): Objective {
  return {
    mode: 'cautious',
    unit: 'weighted s',
    pieceCost: (d, grade, cell) => (d / walkingSpeedMs(grade)) * (1 + weight * cautionShare(t, cell)),
    minPerMetre: 1 / MAX_SPEED_MS,
  }
}

export function makeObjective(mode: RouteMode, t: Terrain, massKg: number): Objective {
  if (mode === 'energy') return energyObjective(massKg)
  if (mode === 'cautious') return cautiousObjective(t)
  return timeObjective()
}
