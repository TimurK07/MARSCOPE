import type { ReactNode } from 'react'
import { GEOLOGY, HIRISE, THEMIS_DAY, THEMIS_NIGHT, type TileLayerDef } from '../lib/layers'
import { RADIATION, SLOPE_CLASSES, SOURCES } from '../lib/model'
import { CONTOUR_INDEX_M, CONTOUR_INTERVAL_M, ELEVATION_RAMP, HIDDEN_RGB, type HazardMode } from '../lib/overlays'
import type { RoverStop, WeatherSol } from '../lib/nasa'
import type { Terrain } from '../lib/terrain'
import { fmtCoord } from '../hooks/usePlan'
import type { LayerState } from './MapView'
import type { RailPane } from './ToolRail'
import { Datum, Segmented, Switch } from './ui'

interface Props {
  pane: RailPane
  terrain: Terrain
  zoom: number
  tiles: Record<string, LayerState>
  setTile: (id: string, s: LayerState) => void
  hazard: LayerState & { mode: HazardMode }
  setHazard: (s: LayerState & { mode: HazardMode }) => void
  elevation: LayerState
  setElevation: (s: LayerState) => void
  contours: LayerState
  setContours: (s: LayerState) => void
  hiddenSteep: LayerState
  setHiddenSteep: (s: LayerState) => void
  showTrack: boolean
  setShowTrack: (v: boolean) => void
  weather: WeatherSol | null | 'loading'
  rover: RoverStop | null
  onFitCrater: () => void
  onFitSite: () => void
}

function Layer(props: {
  title: string
  source: string
  description: string
  state: LayerState
  onChange: (s: LayerState) => void
  opacity?: boolean
  notice?: ReactNode
  children?: ReactNode
}) {
  const { state, onChange } = props
  return (
    <div className={`layer ${state.on ? 'is-on' : ''}`}>
      <div className="layer-head">
        <div>
          <h3>{props.title}</h3>
          <p className="layer-src">{props.source}</p>
        </div>
        <Switch checked={state.on} onChange={(on) => onChange({ ...state, on })} label={props.title} />
      </div>
      {state.on && (
        <div className="layer-body">
          <p className="layer-desc">{props.description}</p>
          {props.notice}
          {props.children}
          {props.opacity !== false && (
            <label className="opacity">
              <span>Opacity</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={state.opacity}
                onChange={(e) => onChange({ ...state, opacity: Number(e.target.value) })}
              />
              <output>{Math.round(state.opacity * 100)}%</output>
            </label>
          )}
        </div>
      )}
    </div>
  )
}

/** Tile layer row with scale gating for coarse regional products. */
function TileLayer(props: {
  def: TileLayerDef
  zoom: number
  state: LayerState
  onChange: (s: LayerState) => void
  onFitCrater: () => void
  children?: ReactNode
}) {
  const { def } = props
  const gated = def.maxUsefulZoom != null && props.zoom > def.maxUsefulZoom
  return (
    <Layer
      title={def.title}
      source={`${def.source} · ${def.resolution}`}
      description={def.description}
      state={props.state}
      onChange={props.onChange}
      notice={
        gated ? (
          <div className="gate">
            <p>
              Hidden at site scale: one {def.resolution.includes('m/px') ? 'pixel' : 'map unit'} of this product covers
              much of the study area. It reads correctly at crater scale.
            </p>
            <button type="button" className="btn btn-sm" onClick={props.onFitCrater}>
              View Gale crater
            </button>
          </div>
        ) : undefined
      }
    >
      {props.children}
    </Layer>
  )
}

const rampCss = `linear-gradient(90deg, ${ELEVATION_RAMP.map((c) => `rgb(${c.join(',')})`).join(', ')})`

/** Group heading inside a data pane. */
function Group(props: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="group">
      <div className="group-head">
        <h3>{props.title}</h3>
        {props.note && <code>{props.note}</code>}
      </div>
      {props.children}
    </div>
  )
}

/** Content of one tool-rail pane. */
export default function DataPane(p: Props) {
  const elev = p.terrain.meta.elevation
  const slopeLegend = p.hazard.mode === 'hazards' ? SLOPE_CLASSES.filter((c) => c.maxDeg > 15) : SLOPE_CLASSES.slice(1)

  if (p.pane === 'layers')
    return (
      <>
        <Group title="Imagery">
        <TileLayer def={HIRISE} zoom={p.zoom} state={p.tiles.hirise} onChange={(s) => p.setTile('hirise', s)} onFitCrater={p.onFitCrater} />
        <p className="footnote">Context basemap (always on): MRO CTX mosaic of Gale crater, Viking MDIM 2.1 color.</p>
      </Group>
        <Group title="Terrain" note="HiRISE DEM · 4 m grid">
        <Layer
          title="Slope hazard"
          source="Derived from MRO HiRISE DEM"
          description="Ground a suited crew member should avoid, from the walking model's slope limits."
          state={p.hazard}
          onChange={(s) => p.setHazard({ ...p.hazard, ...s })}
        >
          <Segmented
            label="Slope display"
            value={p.hazard.mode}
            onChange={(mode) => p.setHazard({ ...p.hazard, mode })}
            options={[
              { value: 'hazards', label: 'Hazards only' },
              { value: 'classes', label: 'All classes' },
            ]}
          />
          <ul className="legend">
            {slopeLegend.map((c) => (
              <li key={c.id}>
                <i className={c.id === 'nogo' ? 'sw sw-hatch' : 'sw'} style={{ ['--c' as string]: `rgb(${c.rgb.join(',')})` }} />
                <span>{c.label}</span>
                <code>{c.range}</code>
              </li>
            ))}
          </ul>
        </Layer>

        <Layer
          title="Elevation tint"
          source="MRO HiRISE DEM"
          description="Height above the Mars areoid across the study area."
          state={p.elevation}
          onChange={p.setElevation}
        >
          <div className="ramp">
            <i style={{ background: rampCss }} />
            <div>
              <code>{Math.round(elev.min_m)} m</code>
              <code>{Math.round(elev.max_m)} m</code>
            </div>
          </div>
        </Layer>

        <Layer
          title="Contours"
          source="Derived from MRO HiRISE DEM"
          description={`Elevation contours every ${CONTOUR_INTERVAL_M} m, index lines every ${CONTOUR_INDEX_M} m.`}
          state={p.contours}
          onChange={p.setContours}
        />
        {p.terrain.subSteep && (
          <Layer
            title="Hidden steep ground"
            source={`Derived from MRO HiRISE DEM · ${p.terrain.meta.subcell?.pixel_m.toFixed(1)} m pixels`}
            description="Walkable cells that hide ground steeper than 20° at the 1 m scale. A roughness indicator, not a hazard probability; it does not change the hard slope limit."
            state={p.hiddenSteep}
            onChange={p.setHiddenSteep}
          >
            <div className="ramp">
              <i style={{ background: `linear-gradient(90deg, rgb(${HIDDEN_RGB.join(',')} / 0.25), rgb(${HIDDEN_RGB.join(',')}))` }} />
              <div>
                <code>few 1 m pixels</code>
                <code>all over 20°</code>
              </div>
            </div>
          </Layer>
        )}
      </Group>
      </>
    )

  if (p.pane === 'environment') return <Group title="Measured at Gale crater">
        <div className="card">
          <header>
            <h3>Conditions at Gale</h3>
            <span className="tag">Curiosity REMS</span>
          </header>
          {p.weather === 'loading' ? (
            <p className="muted">Loading latest report…</p>
          ) : p.weather ? (
            <>
              <dl className="data">
                <Datum label="Air temp">
                  {p.weather.minTempC} / {p.weather.maxTempC} °C
                </Datum>
                <Datum label="Pressure">{p.weather.pressurePa} Pa</Datum>
                <Datum label="Sky">{p.weather.opacity}</Datum>
                <Datum label="UV index">{p.weather.uvIndex}</Datum>
                <Datum label="Daylight">
                  {p.weather.sunrise}–{p.weather.sunset}
                </Datum>
              </dl>
              <p className="footnote">
                Latest published report: sol {p.weather.sol} ({p.weather.earthDate}). Outreach feed by Centro de
                Astrobiología.
              </p>
            </>
          ) : (
            <p className="muted">Weather feed unavailable.</p>
          )}
        </div>

        <div className="card">
          <header>
            <h3>Background radiation</h3>
            <span className="tag">Curiosity RAD</span>
          </header>
          <dl className="data">
            <Datum label="GCR dose equivalent">{RADIATION.doseEquivalent_mSv_per_day} mSv/day</Datum>
          </dl>
          <p className="footnote">Average measured on the surface in Gale crater, Aug 2012 – Jun 2013.</p>
        </div>

        {[THEMIS_DAY, THEMIS_NIGHT].map((def) => (
          <TileLayer key={def.id} def={def} zoom={p.zoom} state={p.tiles[def.id]} onChange={(s) => p.setTile(def.id, s)} onFitCrater={p.onFitCrater}>
            <div className="ramp">
              <i style={{ background: 'linear-gradient(90deg, #111, #eee)' }} />
              <div>
                <code>cooler</code>
                <code>warmer</code>
              </div>
            </div>
          </TileLayer>
        ))}
      </Group>

  if (p.pane === 'context') return <Group title="Rover and geology">
        <div className={`layer ${p.showTrack ? 'is-on' : ''}`}>
          <div className="layer-head">
            <div>
              <h3>Curiosity traverse</h3>
              <p className="layer-src">MSL · live from mars.nasa.gov</p>
            </div>
            <Switch checked={p.showTrack} onChange={p.setShowTrack} label="Curiosity traverse" />
          </div>
          {p.showTrack && (
            <div className="layer-body">
              <p className="layer-desc">
                Rover path and stops. Select a stop to see the Navcam frames taken there.
              </p>
              {p.rover && (
                <dl className="data">
                  <Datum label="Position">{fmtCoord(p.rover)}</Datum>
                  <Datum label="Sol">{p.rover.sol}</Datum>
                  <Datum label="Odometry">{p.rover.totalKm.toFixed(2)} km</Datum>
                </dl>
              )}
            </div>
          )}
        </div>

        <TileLayer def={GEOLOGY} zoom={p.zoom} state={p.tiles.geology} onChange={(s) => p.setTile('geology', s)} onFitCrater={p.onFitCrater} />
        {p.zoom <= (GEOLOGY.maxUsefulZoom ?? 99) && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={p.onFitSite}>
            Back to study area
          </button>
        )}
      </Group>

  return (
    <Group title="Model and data sources">
      <p className="layer-desc">
        Every constant in the planner comes from a NASA document or a peer-reviewed paper. Map imagery and terrain come
        from NASA JPL Mars Trek; rover data comes from mars.nasa.gov.
      </p>
      <ul className="sources">
        {SOURCES.map((src) => (
          <li key={src.url}>
            <a href={src.url} target="_blank" rel="noreferrer">
              {src.label}
            </a>
          </li>
        ))}
      </ul>
    </Group>
  )
}
