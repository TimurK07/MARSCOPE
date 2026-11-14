// Global elevation lookup against the MGS MOLA digital elevation model,
// served by NASA JPL Mars Trek. Used on the globe, outside the 1 m study-area DEM.

import type { LatLon } from './terrain'

const SERVICE =
  'https://trek.nasa.gov/mars/trekarcgis/rest/services/mola128_mola64_merge_90Nto90S_SimpleC_clon0/ImageServer/identify'

const cache = new Map<string, number | null>()

/** Elevation in metres above the Mars areoid, or null where the service has no value. */
export async function fetchMolaElevation(p: LatLon): Promise<number | null> {
  const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`
  if (cache.has(key)) return cache.get(key)!
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: p.lon, y: p.lat }),
    geometryType: 'esriGeometryPoint',
    returnGeometry: 'false',
    returnCatalogItems: 'false',
    f: 'json',
  })
  let value: number | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetch(`${SERVICE}?${params}`).then((r) => r.json())
      const n = Number(data.value)
      value = Number.isFinite(n) ? n : null
      break
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise((res) => setTimeout(res, 500 * attempt))
    }
  }
  cache.set(key, value)
  return value
}
