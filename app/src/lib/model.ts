// Physical model behind the planner. Every constant here is given with where it
// comes from. Some are measurements or published models; several are MARSCOPE
// planning assumptions informed by lunar EVA documents, and say so. None is a
// validated value for EVAs on Mars. See SOURCES at the bottom and docs/DATA_SOURCES.md.

import type { LatLon } from './terrain'

/** Mars 2000 sphere radius (IAU), metres. Matches the CRS of the NASA map data. */
export const MARS_RADIUS_M = 3_396_190

/** Mean surface gravity of Mars, m/s² (NASA NSSDC Mars Fact Sheet). */
export const MARS_GRAVITY = 3.73

/**
 * Steepest ground the planner lets a route cross, for cells and for every step
 * between cells. From NASA EVA-EXP-0075 (Artemis lunar EVA concept of
 * operations summary), which lists as a suit capability: "walking
 * up/down/across a slope of up to 20°". Applying it to Mars is our assumption.
 */
export const MAX_SLOPE_DEG = 20

/** Fastest walking speed in the model (level ground), m/s. */
export const MAX_SPEED_MS = 1.6

/**
 * Walking speed of a suited astronaut as a function of the grade along the
 * direction of travel (degrees, positive = uphill).
 *
 * Marquez (2007), as implemented in the SEXTANT traverse planner used by
 * NASA's BASALT field programme. What it rests on, from the thesis itself:
 * twelve average speeds from the second Apollo 14 EVA (Waligora & Horrigan
 * 1975), on slopes between about -8 and +6.5 degrees, in lunar gravity and
 * Apollo suits. The profile was drawn to resemble those points and is defined
 * from -15 to +15 degrees. Beyond that range SEXTANT holds the speed at
 * 0.05 m/s on purpose, so that such ground is heavily penalised: that value is
 * a placeholder outside the model, not a measured speed. Nothing here is
 * specific to Mars.
 */
export function walkingSpeedMs(gradeDeg: number): number {
  const s = gradeDeg
  if (s <= -20) return 0.05
  if (s <= -10) return 0.095 * s + 1.95
  if (s <= 0) return 0.06 * s + 1.6
  if (s <= 6) return -0.2 * s + 1.6
  if (s <= 15) return -0.039 * s + 0.634
  return 0.05
}

/**
 * Planning pace. A MARSCOPE planning assumption, kept here so it can be changed.
 *
 * NASA EVA-EXP-0075, a 2020 summary of the Artemis lunar-surface EVA concept,
 * sizes walking excursions assuming "~2 km/hr walking pace on relatively level
 * regolith". We adopt that lunar planning reference as an upper speed for
 * conservative planning. It is not a measured or validated walking speed for
 * Mars, and capping the model with it does not make the model valid.
 */
export const PLANNING_PACE = {
  max_kmh: 2,
  /** The same in metres per second: 2000 m in 3600 s. */
  max_ms: 2000 / 3600,
}

/**
 * Walking speed for conservative planning: the model's speed for the grade,
 * but never above the planning pace.
 *
 *   v_planning(grade) = min(v_model(grade), 2000 / 3600)
 *
 * The model is untouched: where it is already slower than the planning pace
 * (uphill steeper than about 5.2 degrees, downhill steeper than about 14.7),
 * the two are the same. Used for the second walking-time estimate and for the
 * return-to-habitat time limit. Routes are still optimised with the model.
 */
export function planningSpeedMs(gradeDeg: number): number {
  return Math.min(walkingSpeedMs(gradeDeg), PLANNING_PACE.max_ms)
}

/**
 * Metabolic energy to walk one path segment, split so the result can be
 * evaluated for any suited mass m (kg): E [J] = perKg * m + fixed.
 *
 * Santee et al. (2001) load-carriage model as implemented in SEXTANT:
 *   level:    (3.28 m + 71.1) (0.661 cos a + 0.115 / v) d
 *   uphill:   3.5 m g d sin a
 *   downhill: 2.4 m g d sin a * 0.3^(|a| / 7.65)
 * Gravity only enters the slope terms.
 */
export function segmentEnergy(distM: number, gradeDeg: number, speedMs: number): { perKg: number; fixed: number } {
  const a = (gradeDeg * Math.PI) / 180
  const level = (0.661 * Math.cos(a) + 0.115 / speedMs) * distM
  let slopePerKg: number
  if (gradeDeg >= 0) slopePerKg = 3.5 * MARS_GRAVITY * distM * Math.sin(a)
  else slopePerKg = 2.4 * MARS_GRAVITY * distM * Math.sin(a) * Math.pow(0.3, Math.abs(gradeDeg) / 7.65)
  return { perKg: 3.28 * level + slopePerKg, fixed: 71.1 * level }
}

/**
 * Longest EVA. A MARSCOPE planning assumption, kept here so it can be changed.
 * It is not an official safety standard for EVAs on Mars.
 *
 * Informed by NASA EVA-EXP-0075, a 2020 summary of the Artemis lunar-surface EVA
 * concept of operations, which lists as a capability of the lunar suit:
 * "Supports EVAs of up to 8 hours in duration (6±2 hours)".
 *
 * The limit is applied to the EVA duration at the planning pace: walking time
 * with the speed capped at PLANNING_PACE, plus the time spent at the targets.
 */
export const EVA = {
  maxDuration_h: 8,
}

/**
 * Return-to-habitat limits. These are MARSCOPE planning assumptions, kept here
 * so they can be changed. They are NOT NASA requirements for Mars EVAs.
 *
 * A plan passes only if, from every point of the route, one and the same way
 * back is within both limits (see returnCheck.ts).
 *
 * Where the numbers come from: the same NASA document describes lunar walking
 * excursions of up to a 2 km radius from the lander ("TBR", "depending on
 * terrain"), assumes about 2 km/h on fairly level regolith, and notes that
 * secondary oxygen on the suit provides an additional hour. We apply 2 km to
 * the length of the way back over the terrain, which is never shorter than
 * the straight line, and one hour to its duration at the planning pace
 * (planningSpeedMs), the pace the hour was sized for.
 */
export const RETURN_LIMITS = {
  /** Longest acceptable way back, metres. */
  distance_m: 2000,
  /** Slowest acceptable way back, seconds. */
  time_s: 3600,
}

export const RADIATION = {
  /**
   * Average galactic-cosmic-ray dose equivalent on the surface at Gale crater,
   * measured by Curiosity's RAD, Aug 2012 – Jun 2013 (Hassler et al., 2014).
   */
  doseEquivalent_mSv_per_day: 0.67,
  /**
   * NASA-STD-3001 Vol 1 Rev B [V1 4030]: career limit, stated as NASA effective dose.
   * Kept for reference only. It is a different quantity from the dose equivalent RAD
   * measures, so the app does not express its estimates as a share of it.
   */
  careerLimit_mSv: 600,
  note:
    'One historical average: the galactic cosmic ray dose equivalent Curiosity RAD measured on the surface in Gale crater ' +
    'from August 2012 to June 2013, a period of solar maximum, when this background is lower than at solar minimum. ' +
    'Solar particle events are not included (on 20 May 2024 RAD recorded 8,100 µGy from a single storm), and neither is ' +
    'any shielding by a suit or a habitat. The same background applies inside an unshielded habitat, so this is ' +
    'exposure during the hours of the EVA, not exposure caused by going outside.',
}

/**
 * Background dose equivalent accumulated over a duration, in mSv: the surface
 * rate above times the time, and nothing else.
 *
 *   dose = rate [mSv/day] * seconds / 86400
 *
 * A simplified estimate of background exposure, not a validated astronaut
 * dose: one average rate from one period of the solar cycle, no solar particle
 * events, no shielding by suit or body, no variation with place or time.
 */
export function backgroundDoseMsv(seconds: number): number {
  return (RADIATION.doseEquivalent_mSv_per_day * seconds) / 86400
}

export interface SlopeClass {
  id: string
  label: string
  range: string
  maxDeg: number
  rgb: [number, number, number]
  /** Overlay alpha, 0–255. */
  alpha: number
}

// Class breaks follow the breakpoints of the walking-speed model (6°, 15°)
// and the 20° planning limit.
export const SLOPE_CLASSES: SlopeClass[] = [
  { id: 'easy', label: 'Easy walking', range: '0–6°', maxDeg: 6, rgb: [108, 188, 166], alpha: 70 },
  { id: 'slow', label: 'Slow going', range: '6–15°', maxDeg: 15, rgb: [224, 178, 70], alpha: 150 },
  { id: 'steep', label: 'Very slow, steep', range: '15–20°', maxDeg: MAX_SLOPE_DEG, rgb: [232, 132, 58], alpha: 190 },
  { id: 'nogo', label: 'No-go', range: `> ${MAX_SLOPE_DEG}°`, maxDeg: Infinity, rgb: [224, 62, 68], alpha: 215 },
]

export function slopeClass(slopeDeg: number): SlopeClass {
  for (const c of SLOPE_CLASSES) if (slopeDeg <= c.maxDeg) return c
  return SLOPE_CLASSES[SLOPE_CLASSES.length - 1]
}

/** Great-circle distance on the Mars sphere, metres. */
export function surfaceDistanceM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * MARS_RADIUS_M * Math.asin(Math.sqrt(h))
}

export const SOURCES = [
  {
    label: 'NASA EVA-EXP-0075: Artemis lunar EVA concept of operations summary (20° slope, 8 h EVA, 2 km range, 2 km/h pace)',
    url: 'https://www.nasa.gov/wp-content/uploads/2020/01/topic_1-_eva_lunar_surface_concept_of_operations.pdf',
  },
  {
    label: 'SEXTANT traverse planner (Marquez 2007 walking speed; Santee et al. 2001 metabolic cost)',
    url: 'https://github.com/norheim/pextant/blob/master/pextant/explorers.py',
  },
  {
    label: 'Marquez (2007), MIT PhD thesis: the walking-speed profile and the Apollo 14 data behind it (pp. 72–74)',
    url: 'https://dspace.mit.edu/handle/1721.1/38526',
  },
  {
    label: 'Curiosity RAD surface radiation (Hassler et al. 2014), SwRI release',
    url: 'https://www.swri.org/press-release/swri-scientists-publish-first-radiation-measurements-surface-mars',
  },
  {
    label: 'NASA JPL: May 2024 solar storm measured by RAD',
    url: 'https://www.jpl.nasa.gov/news/nasa-watches-mars-light-up-during-epic-solar-storm/',
  },
  {
    label: 'NASA-STD-3001 Vol 1 Rev B: career radiation limit',
    url: 'https://www.nasa.gov/wp-content/uploads/2020/10/2022-01-05_nasa-std-3001_vol.1_rev._b_final_draft_with_signature_010522.pdf',
  },
  {
    label: 'NASA NSSDC Mars Fact Sheet (gravity)',
    url: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html',
  },
]
