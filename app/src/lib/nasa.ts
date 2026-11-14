// Live NASA feeds (all public, CORS-enabled, no API key).

import type { LatLon } from './terrain'

const MSL_WAYPOINTS = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json'
const MSL_TRAVERSE = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json'
const MSL_RAW_IMAGES = 'https://mars.nasa.gov/api/v1/raw_image_items/'
const MSL_WEATHER = 'https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json'

/** GET JSON with a few retries: the NASA services occasionally drop a first request. */
async function getJson(url: string, tries = 3): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json()
    } catch (err) {
      if (attempt >= tries) throw err
      await new Promise((res) => setTimeout(res, 600 * attempt))
    }
  }
}

export interface RoverStop extends LatLon {
  sol: number
  elevation: number
  totalKm: number
}

export interface RoverTrack {
  stops: RoverStop[]
  path: LatLon[]
}

export async function fetchRoverTrack(): Promise<RoverTrack> {
  const [wp, tr] = await Promise.all([
    getJson(MSL_WAYPOINTS),
    getJson(MSL_TRAVERSE),
  ])
  const stops: RoverStop[] = wp.features.map((f: any) => ({
    lat: f.properties.lat,
    lon: f.properties.lon,
    sol: f.properties.sol,
    elevation: f.properties.elev_geoid,
    totalKm: f.properties.dist_km,
  }))
  const path: LatLon[] = []
  for (const f of tr.features) {
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
    for (const line of lines) for (const c of line) path.push({ lon: c[0], lat: c[1] })
  }
  return { stops, path }
}

export interface RoverImage {
  id: number
  sol: number
  instrument: string
  takenUtc: string
  url: string
  link: string
  /** Mast azimuth in degrees (rover frame), when reported. */
  azimuth: number | null
  /** Local mean solar time, e.g. "16:57". */
  lmst: string | null
}

/** Full-frame Navcam images Curiosity took on a given sol. */
export async function fetchSolImages(sol: number, limit = 12): Promise<RoverImage[]> {
  const params = new URLSearchParams({
    order: 'date_taken desc',
    per_page: String(limit * 3),
    page: '0',
    condition_1: 'msl:mission',
    condition_2: `${sol}:sol:gte`,
    condition_3: `${sol}:sol:lte`,
    search: 'NAV_LEFT_B',
  })
  const data = await getJson(`${MSL_RAW_IMAGES}?${params}`)
  return (data.items as any[])
    .filter((i) => i.extended?.sample_type === 'full')
    .slice(0, limit)
    .map((i) => ({
      id: i.id,
      sol: i.sol,
      instrument: i.instrument,
      takenUtc: i.date_taken,
      url: i.https_url,
      link: `https://mars.nasa.gov/raw_images/${i.id}/`,
      azimuth: i.extended?.mast_az != null && i.extended.mast_az !== 'UNK' && !Number.isNaN(Number(i.extended.mast_az)) ? Number(i.extended.mast_az) : null,
      lmst: typeof i.extended?.lmst === 'string' ? (i.extended.lmst.match(/M(\d\d:\d\d)/)?.[1] ?? null) : null,
    }))
}

export interface WeatherSol {
  sol: number
  earthDate: string
  minTempC: number | null
  maxTempC: number | null
  pressurePa: number | null
  opacity: string
  sunrise: string
  sunset: string
  uvIndex: string
}

const num = (v: string): number | null => (v === '--' || v === '' || v == null ? null : Number(v))

/** Latest REMS weather report from Curiosity (outreach feed by Centro de Astrobiología). */
export async function fetchLatestWeather(): Promise<WeatherSol | null> {
  const data = await getJson(MSL_WEATHER)
  const s = data.soles?.[0]
  if (!s) return null
  return {
    sol: Number(s.sol),
    earthDate: s.terrestrial_date,
    minTempC: num(s.min_temp),
    maxTempC: num(s.max_temp),
    pressurePa: num(s.pressure),
    opacity: s.atmo_opacity,
    sunrise: s.sunrise,
    sunset: s.sunset,
    uvIndex: s.local_uv_irradiance_index,
  }
}
