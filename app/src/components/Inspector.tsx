import { useEffect, useState } from 'react'
import { fetchGeologicUnit, type GeologicUnit } from '../lib/geology'
import { MAX_SLOPE_DEG, slopeClass, surfaceDistanceM } from '../lib/model'
import { cellAt, elevationAt, slopeAt, type LatLon, type Terrain } from '../lib/terrain'
import { fmtKm, fmtLat, fmtLon } from '../hooks/usePlan'
import { Datum } from './ui'

interface Props {
  terrain: Terrain
  point: LatLon
  habitat: LatLon | null
  targetCount: number
  onSetHabitat: () => void
  onAddTarget: () => void
  onClose: () => void
}

/** Point inspector: what the data says about one location, and what you can do with it. */
export default function Inspector({ terrain, point, habitat, targetCount, onSetHabitat, onAddTarget, onClose }: Props) {
  const [unit, setUnit] = useState<GeologicUnit | null | 'loading' | 'error'>('loading')

  useEffect(() => {
    let live = true
    setUnit('loading')
    fetchGeologicUnit(point).then(
      (u) => live && setUnit(u),
      () => live && setUnit('error'),
    )
    return () => {
      live = false
    }
  }, [point])

  const idx = cellAt(terrain, point)
  const inside = idx >= 0
  const slope = inside ? slopeAt(terrain, idx) : NaN
  const cls = Number.isNaN(slope) ? null : slopeClass(slope)
  const blocked = !inside || Number.isNaN(slope) || slope > MAX_SLOPE_DEG

  return (
    <div className="inspector" role="dialog" aria-label="Point inspector">
      <header>
        <h3>Point inspector</h3>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close inspector">
          ✕
        </button>
      </header>
      <dl className="data">
        <Datum label="Latitude">{fmtLat(point.lat)}</Datum>
        <Datum label="Longitude">{fmtLon(point.lon)}</Datum>
        {inside && (
          <>
            <Datum label="Elevation">{elevationAt(terrain, idx).toFixed(1)} m</Datum>
            <Datum label="Slope">
              {cls ? (
                <>
                  <i className="dot" style={{ background: `rgb(${cls.rgb.join(',')})` }} />
                  {slope.toFixed(1)}° · {cls.label.toLowerCase()}
                </>
              ) : (
                'no data'
              )}
            </Datum>
          </>
        )}
        {habitat && <Datum label="From habitat">{fmtKm(surfaceDistanceM(habitat, point))}</Datum>}
        <Datum label="Geologic unit">
          {unit === 'loading' ? '…' : unit === 'error' ? 'unavailable' : unit ? unit.code : 'unmapped'}
        </Datum>
      </dl>
      {unit && typeof unit === 'object' && <p className="footnote">{unit.description} (USGS SIM 3292).</p>}

      {!inside ? (
        <p className="gate-note">Outside the study area. Routing needs the 4 m terrain grid inside the dashed frame.</p>
      ) : blocked ? (
        <p className="gate-note">Steeper than the {MAX_SLOPE_DEG}° limit. A checkpoint cannot be placed here.</p>
      ) : (
        <div className="inspector-actions">
          {habitat ? (
            <button type="button" className="btn btn-primary" onClick={onAddTarget}>
              Add as target {targetCount + 1}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onSetHabitat}>
              Set as habitat
            </button>
          )}
          {habitat && (
            <button type="button" className="btn" onClick={onSetHabitat}>
              Move habitat here
            </button>
          )}
        </div>
      )}
    </div>
  )
}
