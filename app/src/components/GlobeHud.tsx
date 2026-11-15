import { useEffect, useState } from 'react'
import { fetchMolaElevation } from '../lib/elevation'
import { fetchGeologicUnit, type GeologicUnit } from '../lib/geology'
import { inBBox, type BBox } from '../lib/globe'
import type { GlobeViewState } from '../lib/globeEngine'
import type { MissionSummary } from '../lib/missionStatus'
import type { LatLon } from '../lib/terrain'
import { canOpenWorkspaceAt } from '../lib/viewTransition'
import { fmtLat } from '../hooks/usePlan'
import { Icon } from './ui'

interface Props {
  view: GlobeViewState | null
  hover: LatLon | null
  inspect: LatLon | null
  site: BBox
  /** The same mission as in the 2D workspace: verdict, route priority, reason and key. */
  mission: MissionSummary
  compact: boolean
  /** Imagery is still arriving. */
  busy: boolean
  onOverview: () => void
  onFocus: () => void
  onOpenWorkspace: (at?: LatLon) => void
  onClearInspect: () => void
}

/** East-positive longitude in 0-360, the usual convention for Mars. */
const fmtLon = (lon: number) => `${(((lon % 360) + 360) % 360).toFixed(4)}°E`

const fmtAlt = (km: number) => (km >= 1000 ? `${Math.round(km).toLocaleString('en-US')} km` : km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`)

/** What the global datasets say about a picked point. No routing happens here. */
function Selection({ point, site, onOpen, onClear }: { point: LatLon; site: BBox; onOpen: (at: LatLon) => void; onClear: () => void }) {
  const [unit, setUnit] = useState<GeologicUnit | null | 'loading' | 'error'>('loading')
  const [elev, setElev] = useState<number | null | 'loading' | 'error'>('loading')

  useEffect(() => {
    let live = true
    setUnit('loading')
    setElev('loading')
    fetchGeologicUnit(point).then(
      (u) => live && setUnit(u),
      () => live && setUnit('error'),
    )
    fetchMolaElevation(point).then(
      (v) => live && setElev(v),
      () => live && setElev('error'),
    )
    return () => {
      live = false
    }
  }, [point])

  const inStudy = inBBox(point, site)
  const inGale = canOpenWorkspaceAt(point)

  return (
    <div className="hud-card hud-selection" role="dialog" aria-label="Selected location">
      <header>
        <h3>Selected location</h3>
        <button type="button" className="icon-btn" onClick={onClear} aria-label="Clear selection">
          <Icon name="close" size={14} />
        </button>
      </header>
      <dl>
        <div>
          <dt>Latitude</dt>
          <dd>{fmtLat(point.lat)}</dd>
        </div>
        <div>
          <dt>Longitude</dt>
          <dd>{fmtLon(point.lon)}</dd>
        </div>
        <div>
          <dt>Elevation · MOLA</dt>
          <dd>{elev === 'loading' ? '…' : elev === 'error' || elev == null ? 'unavailable' : `${Math.round(elev).toLocaleString('en-US')} m`}</dd>
        </div>
        <div>
          <dt>Geologic unit</dt>
          <dd title={unit && typeof unit === 'object' ? unit.description : undefined}>
            {unit === 'loading' ? '…' : unit === 'error' ? 'unavailable' : unit ? unit.code : 'unmapped'}
          </dd>
        </div>
      </dl>
      {unit && typeof unit === 'object' && <p className="hud-note">{unit.description} · USGS SIM 3292</p>}
      {inStudy ? (
        <>
          <p className="hud-status is-ok">Inside the EVA study area. Routing and terrain analysis are available.</p>
          <button type="button" className="btn btn-primary btn-block" onClick={() => onOpen(point)}>
            Open in mission workspace
          </button>
        </>
      ) : (
        <>
          <p className="hud-status">
            EVA routing is not available here. The 1 m terrain model covers only the study area in Gale crater, so no
            route or GO / NO-GO can be computed for this point.
          </p>
          {inGale && (
            <button type="button" className="btn btn-block" onClick={() => onOpen(point)}>
              View in 2D map
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Controls and readouts over the globe. */
export default function GlobeHud(p: Props) {
  const at = p.hover ?? (p.view ? { lat: p.view.lat, lon: p.view.lon } : null)
  return (
    <div className="hud">
      <div className="hud-tools">
        <button type="button" className="hud-btn" onClick={p.onOverview} aria-label="Show the whole planet" data-tip="Whole planet">
          <Icon name="globe" />
        </button>
        <button type="button" className="hud-btn" onClick={p.onFocus} aria-label={p.mission.hasPlan ? 'Focus on the mission' : 'Go to Gale crater'} data-tip={p.mission.hasPlan ? 'Focus mission' : 'Gale crater'}>
          <Icon name="target" />
        </button>
      </div>

      {!p.compact && (
        <div className={`hud-card hud-mission tone-${p.mission.tone}`} role="status" aria-live="polite" aria-busy={p.mission.busy}>
          <span className="label">{p.mission.hasPlan ? 'EVA mission' : 'Mission workspace'}</span>
          <strong>{p.mission.title}</strong>
          {p.mission.mode && (
            <p className="hud-mode">
              <i>Route priority</i> {p.mission.mode}
            </p>
          )}
          {p.mission.reason && (
            <p className="hud-reason">
              {p.mission.reason}
              {p.mission.moreReasons > 0 && ` (and ${p.mission.moreReasons} more)`}
            </p>
          )}
          <p>{p.mission.detail}</p>
          {p.mission.legend.length > 0 && (
            <ul className="route-legend hud-legend" aria-label="Route key">
              {p.mission.legend.map((item) => (
                <li key={item.id}>
                  <i className={`key-${item.id}`} />
                  {item.label}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-primary btn-block" onClick={() => p.onOpenWorkspace()}>
            {p.mission.hasPlan ? 'Open mission workspace' : 'Enter Gale crater workspace'}
            <Icon name="enter" size={14} />
          </button>
        </div>
      )}

      {p.inspect && !p.compact && <Selection point={p.inspect} site={p.site} onOpen={p.onOpenWorkspace} onClear={p.onClearInspect} />}

      <footer className="hud-read">
        {at && (
          <>
            <span>
              <b>{p.hover ? 'LAT' : 'CENTER'}</b>
              {fmtLat(at.lat)}
            </span>
            <span>
              <b>LON</b>
              {fmtLon(at.lon)}
            </span>
          </>
        )}
        {p.view && (
          <span>
            <b>ALT</b>
            {fmtAlt(p.view.altitudeKm)}
          </span>
        )}
        {p.busy && <span className="hud-busy">Loading imagery</span>}
        <span className="hud-credit">Viking MDIM 2.1 · MRO CTX · NASA/JPL/USGS · imagery on a sphere, no terrain relief</span>
      </footer>
    </div>
  )
}
