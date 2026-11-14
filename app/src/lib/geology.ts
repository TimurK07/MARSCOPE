// Geologic unit lookup against the USGS global geologic map of Mars
// (SIM 3292, Tanaka et al. 2014), served by NASA JPL Mars Trek.

import type { LatLon } from './terrain'

const SERVICE = 'https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/identify'

export interface GeologicUnit {
  code: string
  description: string
}

const cache = new Map<string, GeologicUnit | null>()

export async function fetchGeologicUnit(p: LatLon): Promise<GeologicUnit | null> {
  // Units are mapped at 1:20M, so nearby points share a cache entry.
  const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`
  if (cache.has(key)) return cache.get(key)!
  const params = new URLSearchParams({
    geometry: `${p.lon},${p.lat}`,
    geometryType: 'esriGeometryPoint',
    sr: '104905',
    layers: 'all',
    tolerance: '1',
    mapExtent: `${p.lon - 0.5},${p.lat - 0.5},${p.lon + 0.5},${p.lat + 0.5}`,
    imageDisplay: '400,400,96',
    returnGeometry: 'false',
    f: 'json',
  })
  let unit: GeologicUnit | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetch(`${SERVICE}?${params}`).then((r) => r.json())
      const a = data.results?.[0]?.attributes
      unit = a ? { code: a.Unit, description: a.UnitDesc } : null
      break
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise((res) => setTimeout(res, 500 * attempt))
    }
  }
  cache.set(key, unit)
  return unit
}
