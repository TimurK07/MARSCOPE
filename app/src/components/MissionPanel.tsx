import { useEffect, useState } from 'react'
import { adviceFor } from '../lib/advice'
import { buildChecks } from '../lib/mission'
import { EVA, MAX_SLOPE_DEG, RADIATION } from '../lib/model'
import { fmtCoord, fmtDur, fmtKm, type PlanState } from '../hooks/usePlan'
import { Datum, Icon, Section } from './ui'

interface Props {
  plan: PlanState
  onLoadExample: () => void
  canLoadExample: boolean
  onRemove: (index: number) => void
  onMove: (index: number, dir: -1 | 1) => void
  onClear: () => void
  /** Compact header for the mobile sheet. */
  compact?: boolean
}

/** Signed saving: positive means the straightened path is shorter or quicker. */
const fmtSaved = (v: number) => `${v >= 0 ? '−' : '+'}${Math.abs(v).toFixed(v >= 100 ? 0 : 1)}`

export type Verdict = 'standby' | 'go' | 'nogo' | 'noroute'

export function verdictOf(s: PlanState): Verdict {
  return !s.plan ? 'standby' : s.plan.error ? 'noroute' : s.go ? 'go' : 'nogo'
}

export const VERDICT_TITLE: Record<Verdict, string> = {
  standby: 'STANDBY',
  go: 'GO',
  nogo: 'NO-GO',
  noroute: 'NO ROUTE',
}

/** Mission status and primary metrics. Stays fixed above the scrolling plan. */
export function MissionHead({ plan: s }: { plan: PlanState }) {
  const { plan, checks, points } = s
  const verdict = verdictOf(s)
  const failed = checks?.filter((c) => !c.ok) ?? []
  const ready = plan && !plan.error

  return (
    <div className="m-head">
      <div className={`m-status m-status-${verdict}`} role="status" aria-live="polite">
        <span className="label">Mission status</span>
        <strong>{VERDICT_TITLE[verdict]}</strong>
        {verdict === 'standby' && (
          <p>{points.length === 0 ? 'Select a habitat site on the map.' : 'Habitat set. Add a science target.'}</p>
        )}
        {verdict === 'go' && <p>Route is within all mission constraints.</p>}
        {verdict === 'noroute' && <p>{plan?.error}</p>}
        {verdict === 'nogo' && (
          <ul className="m-fail">
            {failed.map((c) => (
              <li key={c.id}>
                <span>{c.label}</span>
                <code>
                  {c.value} <i>limit {c.limit.replace('≤ ', '')}</i>
                </code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="m-metrics">
        <div>
          <dt>Distance</dt>
          <dd>{ready ? fmtKm(plan.distance) : '—'}</dd>
        </div>
        <div>
          <dt>EVA duration</dt>
          <dd>{ready ? fmtDur(s.evaSeconds) : '—'}</dd>
        </div>
        <div>
          <dt>Climb / descent</dt>
          <dd>{ready ? `+${Math.round(plan.ascent)} / −${Math.round(plan.descent)} m` : '—'}</dd>
        </div>
        <div>
          <dt>Walking energy</dt>
          <dd>{ready ? `${Math.round(s.energyKcal)} kcal` : '—'}</dd>
        </div>
      </dl>
    </div>
  )
}

/** The scrolling part of the mission panel, in planning order. */
export default function MissionPanel({ plan: s, ...p }: Props) {
  const { plan, checks, points } = s
  const verdict = verdictOf(s)
  const ready = plan && !plan.error
  const failed = checks?.filter((c) => !c.ok) ?? []

  // Constraints open themselves when the plan turns NO-GO.
  const [constraintsOpen, setConstraintsOpen] = useState(true)
  useEffect(() => {
    if (verdict === 'nogo') setConstraintsOpen(true)
  }, [verdict])

  const adviceInput = ready
    ? { points, walkTime: plan.walkTime, stopMinutes: s.stopMinutes, walkBack: plan.walkBack }
    : null
  // With no route yet, show the limits the plan will be held to.
  const idleChecks = buildChecks({ evaSeconds: 0, walkBack: null }).map((c) => ({ ...c, value: '—', ok: true, ratio: 0, margin: '' }))
  const targets = Math.max(points.length - 1, 0)
  // Hidden steep ground along the route, where the terrain data has it.
  const withHidden = ready ? plan.legs.filter((l) => l.hiddenCells != null) : []
  const hidden =
    withHidden.length > 0
      ? {
          cells: withHidden.reduce((a, l) => a + (l.hiddenCells ?? 0), 0) / withHidden.length,
          worst: Math.max(...withHidden.map((l) => l.hiddenMax ?? 0)),
        }
      : null

  return (
    <>
      <Section
        title="Route checkpoints"
        fixed
        aside={
          points.length > 0 ? (
            <span className="row-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={s.undo} disabled={!s.canUndo} title="Undo (Ctrl/⌘ Z)">
                Undo
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={p.onClear}>
                Clear
              </button>
            </span>
          ) : s.canUndo ? (
            <span className="row-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={s.undo}>
                Undo
              </button>
            </span>
          ) : undefined
        }
      >
        {points.length === 0 ? (
          <div className="steps">
            <ol>
              <li className="is-current">
                <b>Select the habitat site</b>
                <span>Click the map to inspect a location, then set it as habitat.</span>
              </li>
              <li>
                <b>Add science targets</b>
                <span>Inspect further points and add them in visiting order.</span>
              </li>
              <li>
                <b>Review the mission status</b>
                <span>Route, constraints and exposure update as you edit.</span>
              </li>
            </ol>
            <button type="button" className="btn btn-primary btn-block" onClick={p.onLoadExample} disabled={!p.canLoadExample}>
              Load example EVA at Curiosity's site
            </button>
          </div>
        ) : (
          <>
            <ol className="checkpoints">
              {points.map((pt, i) => (
                <li key={`${i}-${pt.lat}-${pt.lon}`}>
                  <span className={i === 0 ? 'cp cp-base' : 'cp'}>{i === 0 ? 'H' : i}</span>
                  <span className="cp-text">
                    <b>{i === 0 ? 'Habitat' : `Science target ${i}`}</b>
                    <code>{fmtCoord(pt)}</code>
                  </span>
                  <span className="cp-actions">
                    {i > 0 && (
                      <>
                        <button type="button" className="icon-btn" aria-label={`Move target ${i} earlier`} disabled={i === 1} onClick={() => p.onMove(i, -1)}>
                          <Icon name="up" size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Move target ${i} later`}
                          disabled={i === points.length - 1}
                          onClick={() => p.onMove(i, 1)}
                        >
                          <Icon name="down" size={14} />
                        </button>
                      </>
                    )}
                    <button type="button" className="icon-btn" aria-label={i === 0 ? 'Remove habitat' : `Remove target ${i}`} onClick={() => p.onRemove(i)}>
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                </li>
              ))}
              {s.roundTrip && points.length > 1 && (
                <li className="cp-return">
                  <span className="cp cp-base cp-hollow">H</span>
                  <span className="cp-text">
                    <b>Return to habitat</b>
                  </span>
                </li>
              )}
            </ol>
            {points.length === 1 && <p className="hint">Next: click the map and add a science target.</p>}
          </>
        )}
      </Section>

      <Section title="Mission parameters" defaultOpen={false} aside={`${s.stopMinutes} min · ${s.massKg} kg`}>
        <div className="params">
          <label className="param-check">
            <input type="checkbox" checked={s.roundTrip} onChange={(e) => s.setRoundTrip(e.target.checked)} />
            Return to habitat
          </label>
          <label>
            <span>Time at each target</span>
            <span className="num">
              <input
                type="number"
                min={0}
                max={180}
                step={5}
                value={s.stopMinutes}
                onChange={(e) => s.setStopMinutes(Math.max(0, Number(e.target.value)))}
              />
              min
            </span>
          </label>
          <label title="Astronaut plus suit. Planning assumption, set it for your crew.">
            <span>Suited mass</span>
            <span className="num">
              <input
                type="number"
                min={60}
                max={400}
                step={5}
                value={s.massKg}
                onChange={(e) => s.setMassKg(Math.max(1, Number(e.target.value)))}
              />
              kg
            </span>
          </label>
        </div>
      </Section>

      <Section
        title="Mission constraints"
        open={constraintsOpen}
        onToggle={setConstraintsOpen}
        aside={checks ? `${checks.length - failed.length} of ${checks.length} met` : undefined}
      >
        <p className={`feasible ${verdict === 'noroute' ? 'is-bad' : ready ? 'is-ok' : ''}`}>
          <b>Route feasibility</b>
          <span>
            {verdict === 'noroute'
              ? 'No safe route. Mission constraints are not assessed.'
              : ready
                ? `Every leg stays on ground of ${MAX_SLOPE_DEG}° or less.`
                : `Legs must stay on ground of ${MAX_SLOPE_DEG}° or less.`}
          </span>
        </p>
        <ul className="limits">
          {(checks ?? idleChecks).map((c) => {
            const advice = checks && !c.ok && adviceInput ? adviceFor(c.id, adviceInput) : null
            return (
              <li key={c.id} className={!checks ? 'idle' : c.ok ? 'ok' : 'bad'}>
                <div className="limit-row">
                  <span>{c.label}</span>
                  <code>
                    <b>{c.value}</b> <i>{c.limit}</i>
                  </code>
                </div>
                <div className="limit-bar" aria-hidden="true">
                  <i style={{ width: `${Math.min(c.ratio, 1) * 100}%` }} />
                </div>
                {checks && <p className="limit-margin">{c.margin}</p>}
                {advice && <p className="limit-advice">{advice}</p>}
              </li>
            )
          })}
        </ul>
        <p className="footnote">
          Duration and the 2 km walking range are from NASA EVA-EXP-0075. We apply the range to the actual walk-back
          path. The {EVA.walkBackTime_min} min walk-back time is our reading of the same document (2 km at about 2 km/h,
          one hour of secondary oxygen), not a NASA requirement. Walking back is computed over the terrain towards the
          habitat, so a climb home counts as slower than the walk out. It uses the grid path before straightening, so
          it can read slightly longer than the straightened route on the map; the difference is on the safe side.
        </p>
      </Section>

      <Section title="Route telemetry" defaultOpen={false}>
        {ready ? (
          <dl className="data">
            <Datum label="Walking time">{fmtDur(plan.walkTime)}</Datum>
            <Datum label="Time at targets">{fmtDur(targets * s.stopMinutes * 60)}</Datum>
            <Datum label="Mean walking speed">{(plan.distance / plan.walkTime).toFixed(2)} m/s</Datum>
            <Datum label="Steepest terrain on route">
              {plan.maxSlope.toFixed(1)}° of {MAX_SLOPE_DEG}°
            </Datum>
            <Datum label="Farthest point, straight line">{fmtKm(plan.farthest)}</Datum>
            <Datum label="Walking energy">{Math.round(s.energyKcal)} kcal</Datum>
            <Datum label="Route legs">{plan.legs.length}</Datum>
            <Datum label="Straightening vs grid path">
              {fmtSaved(plan.legs.reduce((a, l) => a + l.grid.distance - l.distance, 0))} m,{' '}
              {fmtSaved(plan.legs.reduce((a, l) => a + l.grid.duration - l.duration, 0))} s
            </Datum>
            {hidden && (
              <Datum label="Cells with hidden steep ground">
                {Math.round(hidden.cells * 100)}%, worst {Math.round(hidden.worst * 100)}%
              </Datum>
            )}
          </dl>
        ) : (
          <p className="muted">Available once a route is planned.</p>
        )}
        <p className="footnote">
          The route is straightened only where the straight line stays on walkable ground, is no slower, and crosses no
          more hidden steep ground. Hidden steep ground counts 1 m DEM pixels over {MAX_SLOPE_DEG}° inside a 4 m cell; it
          is an indicator of roughness, not a probability, and rocks or ledges smaller than the DEM resolves are not
          detected.
        </p>
        <p className="footnote">
          Energy covers walking only (Santee et al. 2001). Work at the targets is not modelled, so this is not the
          energy of the whole EVA.
        </p>
      </Section>

      <Section title="Radiation exposure" defaultOpen={false} aside={ready ? `${s.doseMsv.toFixed(3)} mSv` : undefined}>
        <dl className="data">
          <Datum label="Dose for this EVA">{ready ? `${s.doseMsv.toFixed(3)} mSv` : '—'}</Datum>
          <Datum label="Surface rate (RAD)">{RADIATION.doseEquivalent_mSv_per_day} mSv/day</Datum>
          <Datum label="Share of career limit">{ready ? `${((s.doseMsv / RADIATION.careerLimit_mSv) * 100).toFixed(3)} %` : '—'}</Datum>
          <Datum label="Career limit">{RADIATION.careerLimit_mSv} mSv</Datum>
        </dl>
        <p className="footnote">{RADIATION.note}</p>
      </Section>
    </>
  )
}
