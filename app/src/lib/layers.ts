// Tile layers. Every source is NASA data served by JPL Mars Trek (WMTS).
// Tiling: equirectangular, Mars 2000, 256 px, URL order z / row / col.

export interface TileLayerDef {
  id: string
  title: string
  source: string
  description: string
  url: string
  maxNativeZoom: number
  /** [south, west, north, east]; omitted for global layers. */
  bounds?: [number, number, number, number]
  defaultOn: boolean
  defaultOpacity: number
  /**
   * Coarse regional products are hidden above this zoom: at site scale a
   * single pixel of the source covers a large part of the study area.
   */
  maxUsefulZoom?: number
  resolution: string
}

const trek = (layer: string, ext: 'png' | 'jpg') =>
  `https://trek.nasa.gov/tiles/Mars/EQ/${layer}/1.0.0/default/default028mm/{z}/{y}/{x}.${ext}`

/** Always-on context imagery, coarse to fine. */
export const BASE_LAYERS: TileLayerDef[] = [
  {
    id: 'viking',
    title: 'Viking color mosaic',
    source: 'Viking Orbiter · MDIM 2.1',
    description: 'Global color context.',
    url: trek('Mars_Viking_MDIM21_ClrMosaic_global_232m', 'jpg'),
    maxNativeZoom: 7,
    defaultOn: true,
    defaultOpacity: 1,
    resolution: '232 m/px',
  },
  {
    id: 'ctx',
    title: 'CTX mosaic, Gale crater',
    source: 'MRO · Context Camera',
    description: 'Regional context of Gale crater.',
    url: trek('Gale_CTX_BlockAdj_dd', 'png'),
    maxNativeZoom: 12,
    bounds: [-6.5732988, 135.1842593, -2.8077809, 139.2413012],
    defaultOn: true,
    defaultOpacity: 1,
    resolution: '6 m/px',
  },
]

export const HIRISE: TileLayerDef = {
  id: 'hirise',
  title: 'HiRISE orbital imagery',
  source: 'MRO · HiRISE',
  description: 'Sub-metre mosaic of the Curiosity roving site. CTX and Viking fill in around it.',
  url: trek('curiosity_hirise_mosaic', 'png'),
  maxNativeZoom: 16,
  bounds: [-4.9254743, 137.1224669, -4.2489588, 137.7298129],
  defaultOn: true,
  defaultOpacity: 1,
  resolution: '< 1 m/px',
}

export const THEMIS_DAY: TileLayerDef = {
  id: 'themis-day',
  title: 'Thermal infrared, day',
  source: 'Mars Odyssey · THEMIS',
  description: 'Daytime surface brightness temperature. Sun-facing and dark surfaces read warm.',
  url: trek('THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018', 'png'),
  maxNativeZoom: 9,
  defaultOn: false,
  defaultOpacity: 0.85,
  maxUsefulZoom: 11.5,
  resolution: '100 m/px',
}

export const THEMIS_NIGHT: TileLayerDef = {
  id: 'themis-night',
  title: 'Thermal infrared, night',
  source: 'Mars Odyssey · THEMIS',
  description: 'Night-time temperature. Rock and cemented ground hold heat and read bright; dust and sand read dark.',
  url: trek('THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018', 'png'),
  maxNativeZoom: 9,
  defaultOn: false,
  defaultOpacity: 0.85,
  maxUsefulZoom: 11.5,
  resolution: '100 m/px',
}

export const GEOLOGY: TileLayerDef = {
  id: 'geology',
  title: 'Geologic map',
  source: 'USGS SIM 3292 · Tanaka et al. 2014',
  description: 'Global geologic units at 1:20M. Inspect any point on the map to read its unit.',
  url: 'https://trek.nasa.gov/mars/trekarcgis/rest/services/SIM3292_Global_Geology/MapServer/WMTS/tile/1.0.0/SIM3292_Global_Geology/default/default028mm/{z}/{y}/{x}.png',
  maxNativeZoom: 11,
  defaultOn: false,
  defaultOpacity: 0.55,
  maxUsefulZoom: 11.5,
  resolution: '1:20,000,000',
}

export const TILE_LAYERS: TileLayerDef[] = [HIRISE, THEMIS_DAY, THEMIS_NIGHT, GEOLOGY]

/** Bounds of Gale crater for the regional view: [south, west, north, east]. */
export const CRATER_VIEW: [number, number, number, number] = [-6.45, 136.2, -3.95, 139.1]
