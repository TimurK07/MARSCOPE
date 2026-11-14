// Physical model behind the planner. Every constant here comes from a cited
// source; see SOURCES at the bottom and docs/DATA_SOURCES.md.

import type { LatLon } from './terrain'

/** Mars 2000 sphere radius (IAU), metres. Matches the CRS of the NASA map data. */
export const MARS_RADIUS_M = 3_396_190

/** Mean surface gravity of Mars, m/s² (NASA NSSDC Mars Fact Sheet). */
export const MARS_GRAVITY = 3.73

/**
 * Steepest terrain a suited crew member is expected to walk on.
 * NASA EVA-EXP-0075 (Artemis EVA concept of operations): "walking up/down/across
 * a slope of up to 20°".
 */
export const MAX_SLOPE_DEG = 20

/** Fastest walking speed in the model (level ground), m/s. */
export const MAX_SPEED_MS = 1.6

/**
 * Walking speed of a suited astronaut as a function of the grade along the
 * direction of travel (degrees, positive = uphill).
 *
 * Marquez (2008), derived from Apollo traverse data, as implemented in the
 * SEXTANT traverse planner used by NASA's BASALT field programme.
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

/** EVA limits from NASA EVA-EXP-0075 (Exploration EVA System Concept of Operations). */
export const EVA = {
  /** "Supports EVAs of up to 8 hours in duration (6±2 hours)". */
  maxDuration_h: 8,
  /** Walking EVAs stay within a 2 km radius of the lander/habitat. */
  walkRadius_km: 2,
}

export const RADIATION = {
  /**
   * Average galactic-cosmic-ray dose equivalent on the surface at Gale crater,
   * measured by Curiosity's RAD, Aug 2012 – Jun 2013 (Hassler et al., 2014).
   */
  doseEquivalent_mSv_per_day: 0.67,
  /** NASA-STD-3001 Vol 1 Rev B [V1 4030]: career effective dose limit. */
  careerLimit_mSv: 600,
  note:
    'Background galactic cosmic rays only, at the average rate Curiosity RAD measured in Gale crater. ' +
    'Solar particle events add to this: on 20 May 2024 RAD recorded 8,100 µGy from a single storm. ' +
    'Do not start an EVA during a solar storm warning.',
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
// and the NASA traversable-slope limit (20°).
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
    label: 'NASA EVA-EXP-0075: Exploration EVA System Concept of Operations (slope and duration limits, walking range)',
    url: 'https://www.nasa.gov/wp-content/uploads/2020/01/topic_1-_eva_lunar_surface_concept_of_operations.pdf',
  },
  {
    label: 'SEXTANT traverse planner (Marquez 2008 walking speed; Santee et al. 2001 metabolic cost)',
    url: 'https://github.com/norheim/pextant/blob/master/pextant/explorers.py',
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
