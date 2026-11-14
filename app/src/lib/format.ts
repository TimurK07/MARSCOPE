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
