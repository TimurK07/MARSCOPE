// Number formatting shared by the planner and the interface.

import type { LatLon } from './terrain'

export const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`)

export const fmtDur = (s: number) => {
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`
}

export const fmtLat = (lat: number) => `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}`
export const fmtLon = (lon: number) => `${lon.toFixed(4)}°E`
export const fmtCoord = (p: LatLon) => `${fmtLat(p.lat)} ${fmtLon(p.lon)}`

/**
 * A slope in degrees to one decimal, rounded away from the limit: at or under
 * the limit it is rounded down, over it rounded up. A blocked cell at 20.03°
 * therefore reads "20.1°", never "20.0°", and a walkable one never reads above
 * the limit. Display only: nothing is decided from the rounded figure.
 */
export function fmtSlope(deg: number, limitDeg: number): string {
  const tenths = deg > limitDeg ? Math.ceil(deg * 10 - 1e-9) : Math.floor(deg * 10 + 1e-9)
  return `${(tenths / 10).toFixed(1)}°`
}

/**
 * A background-dose estimate in mSv to two significant figures. The estimate
 * is a rate times a duration; more digits would only repeat the arithmetic.
 */
export function fmtDose(mSv: number): string {
  if (!(mSv > 0)) return '0 mSv'
  return `${Number(mSv.toPrecision(2))} mSv`
}
