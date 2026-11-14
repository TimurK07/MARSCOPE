// Loads the prepared terrain grids from disk for tests and benchmarks.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitSubcell, type Terrain, type TerrainMeta } from '../src/lib/terrain'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'gale')

export function loadTerrainFromDisk(): Terrain {
  const meta = JSON.parse(readFileSync(join(DIR, 'meta.json'), 'utf8')) as TerrainMeta
  const bytes = (name: string) => {
    const b = readFileSync(join(DIR, name))
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  return {
    meta,
    width: meta.width,
    height: meta.height,
    elevRaw: new Uint16Array(bytes(meta.elevation.file)),
    slopeRaw: new Uint16Array(bytes(meta.slope.file)),
    ...(meta.subcell ? splitSubcell(bytes(meta.subcell.file)) : {}),
  }
}

/** The example EVA: Curiosity's position on sol 5073 and two earlier stops. */
export const EXAMPLE = [
  { lat: -4.82602331, lon: 137.388886 },
  { lat: -4.821, lon: 137.3856 },
  { lat: -4.8161, lon: 137.3824 },
]
