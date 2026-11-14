import { useEffect, useState } from 'react'
import { adviceFor } from '../lib/advice'
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
          <dt>Energy</dt>
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

  const ratios: Record<string, number> = ready
    ? {
        duration: s.evaSeconds / (EVA.maxDuration_h * 3600),
        range: plan.farthest / (EVA.walkRadius_km * 1000),
        slope: plan.maxSlope / MAX_SLOPE_DEG,
      }
    : {}
  const adviceInput = ready
    ? { points, walkTime: plan.walkTime, stopMinutes: s.stopMinutes, farthest: plan.farthest }
    : null
  const targets = Math.max(points.length - 1, 0)

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
        <ul className="limits">
          {(checks ?? [
            { id: 'duration', label: 'EVA duration', value: '—', limit: `≤ ${EVA.maxDuration_h} h`, ok: true },
            { id: 'range', label: 'Farthest point from habitat', value: '—', limit: `≤ ${EVA.walkRadius_km} km`, ok: true },
            { id: 'slope', label: 'Steepest terrain on route', value: '—', limit: `≤ ${MAX_SLOPE_DEG}°`, ok: true },
          ]).map((c) => {
            const advice = !c.ok && adviceInput ? adviceFor(c.id, adviceInput) : null
            const ratio = ratios[c.id]
            return (
              <li key={c.id} className={!checks ? 'idle' : c.ok ? 'ok' : 'bad'}>
                <div className="limit-row">
                  <span>{c.label}</span>
                  <code>
                    <b>{c.value}</b> <i>{c.limit}</i>
                  </code>
                </div>
                <div className="limit-bar" aria-hidden="true">
                  <i style={{ width: `${Math.min(ratio ?? 0, 1) * 100}%` }} />
                </div>
                {advice && <p className="limit-advice">{advice}</p>}
              </li>
            )
          })}
        </ul>
        <p className="footnote">Limits from NASA EVA-EXP-0075, Exploration EVA System Concept of Operations.</p>
      </Section>

      <Section title="Route telemetry" defaultOpen={false}>
        {ready ? (
          <dl className="data">
            <Datum label="Walking time">{fmtDur(plan.walkTime)}</Datum>
            <Datum label="Time at targets">{fmtDur(targets * s.stopMinutes * 60)}</Datum>
            <Datum label="Mean walking speed">{(plan.distance / plan.walkTime).toFixed(2)} m/s</Datum>
            <Datum label="Steepest terrain">{plan.maxSlope.toFixed(1)}°</Datum>
            <Datum label="Farthest from habitat">{fmtKm(plan.farthest)}</Datum>
            <Datum label="Route legs">{plan.legs.length}</Datum>
          </dl>
        ) : (
          <p className="muted">Available once a route is planned.</p>
        )}
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
