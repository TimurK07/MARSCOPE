import { useEffect, useState } from 'react'
import { fetchGeologicUnit, type GeologicUnit } from '../lib/geology'
import { MAX_SLOPE_DEG, slopeClass, surfaceDistanceM } from '../lib/model'
import { cellAt, elevationAt, hiddenSteepShare, slopeAt, type LatLon, type Terrain } from '../lib/terrain'
import { fmtKm, fmtLat, fmtLon } from '../hooks/usePlan'

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
  const hidden = inside ? hiddenSteepShare(terrain, idx) : null

  return (
    <div className="insp">
      <dl className="insp-data">
        <div>
          <dt>Latitude</dt>
          <dd>{fmtLat(point.lat)}</dd>
        </div>
        <div>
          <dt>Longitude</dt>
          <dd>{fmtLon(point.lon)}</dd>
        </div>
        <div>
          <dt>Elevation</dt>
          <dd>{inside ? `${elevationAt(terrain, idx).toFixed(1)} m` : '—'}</dd>
        </div>
        <div>
          <dt>Slope</dt>
          <dd>
            {cls ? (
              <>
                <i className="dot" style={{ background: `rgb(${cls.rgb.join(',')})` }} />
                {slope.toFixed(1)}° <span>{cls.label.toLowerCase()}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div title="Share of this cell's 1 m source pixels that are steeper than 20°. A roughness indicator from the HiRISE DEM, not a hazard probability.">
          <dt>Hidden steep ground</dt>
          <dd>{hidden == null ? '—' : hidden === 0 ? 'none detected at 1 m' : `${Math.round(hidden * 100)}% of 1 m pixels`}</dd>
        </div>
        <div>
          <dt>From habitat</dt>
          <dd>{habitat ? fmtKm(surfaceDistanceM(habitat, point)) : '—'}</dd>
        </div>
        <div className="insp-wide">
          <dt>Geologic unit · USGS SIM 3292</dt>
          <dd>
            {unit === 'loading' ? (
              '…'
            ) : unit === 'error' ? (
              'unavailable'
            ) : unit ? (
              <>
                {unit.code} <span>{unit.description}</span>
              </>
            ) : (
              'unmapped'
            )}
          </dd>
        </div>
      </dl>

      <div className="insp-side">
        {!inside ? (
          <p className="gate-note">Outside the study area. Routing needs the 4 m terrain grid inside the dashed frame.</p>
        ) : blocked ? (
          <p className="gate-note">Steeper than the {MAX_SLOPE_DEG}° limit. A checkpoint cannot be placed here.</p>
        ) : (
          <>
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
          </>
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Clear selection
        </button>
      </div>
    </div>
  )
}
