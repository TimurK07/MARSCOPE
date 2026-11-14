import { useEffect, useState } from 'react'
import { adviceFor } from '../lib/advice'
import { compareModes, comparisonTable, modeCards, OBJECTIVE, type ModeState, type TableRow } from '../lib/comparison'
import { buildChecks, type Verdict } from '../lib/mission'
import { CAUTION_WEIGHT, ROUTE_MODES, type RouteMode } from '../lib/objectives'
import type { ModeSummary } from '../lib/planner'
import { EVA, MAX_SLOPE_DEG, PLANNING_PACE, RADIATION, RETURN_DISTANCE_AT_PACE_M, RETURN_DISTANCE_RANGE, RETURN_LIMITS } from '../lib/model'
import { fmtCoord, fmtDur, fmtKm, type PlanState } from '../hooks/usePlan'
import { Datum, Icon, Section } from './ui'
import { fmtDose, fmtSlope } from '../lib/format'

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

const VERDICT_SHORT: Record<Verdict, string> = { standby: '—', go: 'GO', nogo: 'NO-GO', unverified: 'UNVERIFIED', noroute: 'NO ROUTE' }

/** What a mode shows in place of a verdict while it has none. */
const verdictText = (verdict: Verdict, state: ModeState) => (state === 'pending' ? '…' : VERDICT_SHORT[verdict])

/**
 * The route priority, chosen on three cards. Each card carries its own mode's
 * verdict and figures, so the three can be told apart before one is picked.
 */
export function ModeCards({ plan: s }: { plan: PlanState }) {
  const cards = modeCards(s.comparison, s.mode, s.pending)
  return (
    <div className="m-modes">
      <div className="mode-cards" role="group" aria-label="Route priority">
        {cards.map((c) => (
          <button
            key={c.mode}
            type="button"
            className={`mode-card ${c.selected ? 'is-on' : ''}`}
            aria-pressed={c.selected}
            aria-label={`${c.description} Mission status: ${c.state === 'pending' ? 'calculating' : c.state === 'idle' ? 'none yet' : VERDICT_SHORT[c.verdict]}.`}
            onClick={() => s.setMode(c.mode)}
          >
            <span className="mc-top">
              <span className="mc-name">{c.label}</span>
              <span className="mc-obj">{c.objective}</span>
              <span className={`mc-verdict v-${c.verdict}`}>{verdictText(c.verdict, c.state)}</span>
            </span>
            <span className="mc-figs">
              <i>{c.timeLabel}</i>
              <b>{c.time}</b>
              {c.timeDelta && <span>{c.timeDelta}</span>}
              <span className="mc-detail">
                {/* kcal already says energy */}
                {c.detail.label && !c.detail.text.endsWith('kcal') && <i>{c.detail.label}</i>}
                {c.detail.text}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="mode-note">The Cautious weighting is a heuristic, not a safety rating.</p>
    </div>
  )
}

/** The three routes for the same checkpoints, measured the same way, side by side. */
function ModeComparison(props: { comparison: Record<RouteMode, ModeSummary | null>; selected: RouteMode; onSelect: (m: RouteMode) => void; pending: boolean }) {
  const table = comparisonTable(props.comparison, props.pending)
  const any = ROUTE_MODES.some((m) => props.comparison[m.id])
  const on = (id: RouteMode) => (id === props.selected ? 'is-on' : '')
  const head = (
    <colgroup>
      <col className="cmp-c0" />
      <col />
      <col />
      <col />
    </colgroup>
  )
  const body = (rows: TableRow[]) =>
    rows.map((r) => (
      <tr key={r.id}>
        <th scope="row">
          {r.label}
          {r.hint && <span className="sr-only">. {r.hint}</span>}
        </th>
        {ROUTE_MODES.map((m) => (
          <td key={m.id} className={on(m.id)}>
            {r.cells[m.id].value}
            {r.cells[m.id].delta && <small>{r.cells[m.id].delta}</small>}
          </td>
        ))}
      </tr>
    ))
  return (
    <div className="cmp">
      <table>
        {head}
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Metric</span>
            </th>
            {ROUTE_MODES.map((m) => (
              <th key={m.id} scope="col" className={on(m.id)}>
                <button type="button" aria-pressed={m.id === props.selected} onClick={() => props.onSelect(m.id)}>
                  {m.id === 'energy' ? 'Energy' : m.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="cmp-status">
            <th scope="row">Mission status</th>
            {ROUTE_MODES.map((m) => (
              <td key={m.id} className={`${on(m.id)} v-${table.verdicts[m.id]}`}>
                {verdictText(table.verdicts[m.id], table.states[m.id])}
                {table.reasons[m.id] && <small>{table.reasons[m.id]}</small>}
              </td>
            ))}
          </tr>
          {body(table.primary)}
        </tbody>
      </table>
      {!any && <p className="muted">{props.pending ? 'Calculating the three routes…' : 'Plan a route to compare the three priorities.'}</p>}
      {any && <p className="cmp-key">Smaller figures: difference from Fastest. A difference in one figure, not a ranking.</p>}
      {any && <p className="cmp-note">{compareModes(props.comparison, props.pending)[props.selected].tradeoff}</p>}

      <details className="cmp-fold">
        <summary>More</summary>
        <table>
          {head}
          <tbody>{body(table.more)}</tbody>
        </table>
      </details>

      <details className="cmp-fold">
        <summary>About these figures</summary>
        <dl className="cmp-about">
          {ROUTE_MODES.map((m) => (
            <div key={m.id}>
              <dt>{m.label}</dt>
              <dd>{OBJECTIVE[m.id].full}</dd>
            </div>
          ))}
          {[...table.primary, ...table.more]
            .filter((r) => r.hint)
            .map((r) => (
              <div key={r.id}>
                <dt>{r.label}</dt>
                <dd>{r.hint}</dd>
              </div>
            ))}
        </dl>
        <p className="footnote">
          All three routes obey the same hard limits: {MAX_SLOPE_DEG}° maximum slope for every cell and every step walked, no
          clipping of no-go cells, and the same EVA and return checks. They are measured the same way. Walking energy is an
          approximation adapted from treadmill research on Earth (Santee et al. 2001), at the model's walking speed; Mars
          gravity enters only its climb and descent terms, not the level-walking term that makes up most of it. Cautious
          weights time on hidden steep ground by 1 + {CAUTION_WEIGHT} × the cell's steep share: a heuristic coefficient of
          ours, not a NASA-certified safety model and not a measured risk. Each route is the least-cost path on the 4 m grid
          for its own objective; it is then straightened, and the straightened route is not proven optimal, so a figure can
          come out slightly lower on another priority. No priority guarantees a safe route.
        </p>
      </details>
    </div>
  )
}

/** Signed saving: positive means the straightened path is shorter or quicker. */
const fmtSaved = (v: number) => `${v >= 0 ? '−' : '+'}${Math.abs(v).toFixed(v >= 100 ? 0 : 1)}`

export type { Verdict } from '../lib/mission'

export function verdictOf(s: PlanState): Verdict {
  // GO only when the planner itself says so; anything unsettled is never shown as GO.
  if (!s.plan) return 'standby'
  if (s.plan.error) return 'noroute'
  return s.verdict === 'go' && s.go ? 'go' : s.verdict === 'unverified' ? 'unverified' : 'nogo'
}

export const VERDICT_TITLE: Record<Verdict, string> = {
  standby: 'STANDBY',
  go: 'GO',
  nogo: 'NO-GO',
  unverified: 'UNVERIFIED',
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
          <p>
            {s.pending
              ? 'Calculating routes…'
              : points.length === 0
                ? 'Select a habitat site on the map.'
                : 'Habitat set. Add a science target.'}
          </p>
        )}
        {verdict === 'go' && <p>Route is within all MARSCOPE planning limits. Not a safety clearance.</p>}
        {verdict === 'noroute' && (
          <>
            <p>{plan?.error}</p>
            <p className="m-why">Legs that were found are drawn. Nothing else is assessed until every checkpoint can be reached.</p>
          </>
        )}
        {verdict === 'unverified' && (
          <p>
            The return to the habitat could not be verified: the calculation limit was reached. This is not a confirmed
            violation, and it is not a GO.
          </p>
        )}
        {verdict === 'nogo' && <p className="m-why">Outside MARSCOPE planning limits. The route itself stays within the slope limit:</p>}
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
          <dt title={`EVA duration with walking no faster than ${PLANNING_PACE.max_kmh} km/h, plus time at the targets. The 8-hour limit is judged on this figure. The duration by the speed model alone is under Route telemetry.`}>
            EVA duration · ≤ {PLANNING_PACE.max_kmh} km/h
          </dt>
          <dd>{ready ? fmtDur(s.planEvaSeconds) : '—'}</dd>
        </div>
        <div>
          <dt>Climb / descent</dt>
          <dd>{ready ? `+${Math.round(plan.ascent)} / −${Math.round(plan.descent)} m` : '—'}</dd>
        </div>
        <div>
          <dt title="Metabolic energy of walking by the adopted model (Santee et al. 2001), at the model's walking speed. An approximation.">Walking energy · model</dt>
          <dd>{ready ? `${Math.round(s.energyKcal)} kcal` : '—'}</dd>
        </div>
      </dl>

      <ModeCards plan={s} />
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
    if (verdict === 'nogo' || verdict === 'unverified') setConstraintsOpen(true)
  }, [verdict])

  const adviceInput = ready
    ? { points, walkTime: plan.planWalkTime, stopMinutes: s.stopMinutes, walkBack: plan.walkBack }
    : null
  // With no route yet, show the limits the plan will be held to.
  const returnKm = +(s.returnDistanceM / 1000).toFixed(2)
  // What is being typed into the return limit field, until it is a usable value.
  const [returnDraft, setReturnDraft] = useState<string | null>(null)
  const idleChecks = buildChecks({ evaSeconds: 0, walkBack: null, returnDistanceM: s.returnDistanceM }).map((c) => ({ ...c, value: '—', ok: true, ratio: 0, margin: '' }))
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

      <Section title="Compare route priorities" aside={ROUTE_MODES.find((m) => m.id === s.mode)!.label}>
        <ModeComparison comparison={s.comparison} selected={s.mode} onSelect={s.setMode} pending={s.pending} />
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
        aside={
          checks
            ? `${checks.length - failed.length} of ${checks.length} met${verdict === 'unverified' ? ', not verified' : ''}${s.returnDistanceIsDefault ? '' : ` · return ≤ ${returnKm} km`}`
            : s.returnDistanceIsDefault
              ? undefined
              : `return ≤ ${returnKm} km`
        }
      >
        <p className={`feasible ${verdict === 'noroute' ? 'is-bad' : ready ? 'is-ok' : ''}`}>
          <b>Route feasibility</b>
          <span>
            {verdict === 'noroute'
              ? 'No route within the slope limit. Mission constraints are not assessed.'
              : ready
                ? `Every leg stays on ground of ${MAX_SLOPE_DEG}° or less.`
                : `Legs must stay on ground of ${MAX_SLOPE_DEG}° or less.`}
          </span>
        </p>
        <div className={`return-limit ${s.returnDistanceIsDefault ? '' : 'is-custom'}`}>
          <label title="Longest acceptable way back to the habitat. A MARSCOPE planning assumption, not a NASA-certified limit for Mars EVAs.">
            <span>Return distance limit</span>
            <span className="num">
              <input
                type="number"
                inputMode="decimal"
                min={RETURN_DISTANCE_RANGE.min_m / 1000}
                max={RETURN_DISTANCE_RANGE.max_m / 1000}
                step={RETURN_DISTANCE_RANGE.step_m / 1000}
                value={returnDraft ?? returnKm}
                aria-describedby="return-limit-note"
                onChange={(e) => {
                  // While typing, a value is applied only once it is inside the range; anything else
                  // ("0", "0.", an empty field) waits, so the field never fights the keyboard.
                  setReturnDraft(e.target.value)
                  const m = Number(e.target.value) * 1000
                  if (e.target.value !== '' && m >= RETURN_DISTANCE_RANGE.min_m && m <= RETURN_DISTANCE_RANGE.max_m) s.setReturnDistanceM(m)
                }}
                onBlur={(e) => {
                  // On leaving the field the value is brought into the range, or put back if it is not a number.
                  if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) s.setReturnDistanceM(Number(e.target.value) * 1000)
                  setReturnDraft(null)
                }}
              />
              km
            </span>
          </label>
          <div className="return-limit-meta">
            <span className="return-limit-tag">{s.returnDistanceIsDefault ? 'Default' : `Custom · default ${RETURN_DISTANCE_RANGE.default_m / 1000} km`}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setReturnDraft(null)
                s.setReturnDistanceM(RETURN_DISTANCE_RANGE.default_m)
              }}
              disabled={s.returnDistanceIsDefault}
            >
              Reset to {RETURN_DISTANCE_RANGE.default_m / 1000} km
            </button>
          </div>
          <p id="return-limit-note" className="footnote">
            A MARSCOPE planning assumption you can set from {RETURN_DISTANCE_RANGE.min_m / 1000} to {RETURN_DISTANCE_RANGE.max_m / 1000} km.
            No value is validated or certified as safe for Mars. The way back must also take no more than{' '}
            {RETURN_LIMITS.time_s / 60} min at no more than {PLANNING_PACE.max_kmh} km/h.
            {s.returnDistanceM > RETURN_DISTANCE_AT_PACE_M &&
              ` At that pace ${RETURN_LIMITS.time_s / 60} min covers at most ${RETURN_DISTANCE_AT_PACE_M / 1000} km, so a limit above ${RETURN_DISTANCE_AT_PACE_M / 1000} km cannot make a plan pass: the time limit decides.`}
          </p>
        </div>
        <ul className="limits">
          {(checks ?? idleChecks).map((c) => {
            const advice = checks && !c.ok && adviceInput ? adviceFor(c.id, adviceInput) : null
            return (
              <li key={c.id} className={!checks ? 'idle' : c.ok ? 'ok' : c.state === 'unverified' ? 'unv' : 'bad'}>
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
          All three limits are MARSCOPE planning assumptions that can be changed in the model. None is an official
          safety standard for EVAs on Mars. They are informed by NASA EVA-EXP-0075, a summary of the Artemis lunar EVA
          concept: a suit that supports EVAs of up to 8 hours, walking excursions within a 2 km radius at about 2 km/h,
          and one hour of secondary oxygen. The {EVA.maxDuration_h}-hour limit is applied to the EVA duration at the
          planning pace (walking no faster than {PLANNING_PACE.max_kmh} km/h, plus the time at the targets); the duration by
          the speed model alone is shown above and under Route telemetry. The return limits are{' '}
          {returnKm} km (set above; {RETURN_DISTANCE_RANGE.default_m / 1000} km by default) and {RETURN_LIMITS.time_s / 60} min. A plan passes only if, from
          every point of the route, one and the same way back meets both limits, with its time counted at no more than{' '}
          {PLANNING_PACE.max_kmh} km/h; the two figures above describe that path from the worst point. Passing this check
          is a planning result under these assumptions, not a guarantee of a safe return on Mars. Ways back follow the terrain grid towards the habitat, so a climb home counts as
          slower than the walk out, and they are not straightened, which errs on the careful side.
        </p>
      </Section>

      <Section title="Route telemetry" defaultOpen={false}>
        {ready ? (
          <dl className="data">
            <Datum label="Walking time, model">{fmtDur(plan.walkTime)}</Datum>
            <Datum label={`Walking time at ≤ ${PLANNING_PACE.max_kmh} km/h`}>{fmtDur(plan.planWalkTime)}</Datum>
            <Datum label="Time at targets">{fmtDur(targets * s.stopMinutes * 60)}</Datum>
            <Datum label="EVA duration, model">{fmtDur(s.evaSeconds)}</Datum>
            <Datum label={`EVA duration at ≤ ${PLANNING_PACE.max_kmh} km/h`}>{fmtDur(plan.planWalkTime + targets * s.stopMinutes * 60)}</Datum>
            <Datum label="Mean walking speed, model">{(plan.distance / plan.walkTime).toFixed(2)} m/s</Datum>
            <Datum label="Steepest terrain on route">
              {fmtSlope(plan.maxSlope, MAX_SLOPE_DEG)} of {MAX_SLOPE_DEG}°
            </Datum>
            <Datum label="Farthest point, straight line">{fmtKm(plan.farthest)}</Datum>
            <Datum label="Walking energy, model">{Math.round(s.energyKcal)} kcal</Datum>
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
          Two walking times are given for the same route. The model time uses the walking-speed model (Marquez 2007, as in
          SEXTANT), which rests on twelve Apollo 14 speeds on slopes between about −8° and +6.5° and walks 1.6 m/s on the
          level. The second time caps that speed at {PLANNING_PACE.max_kmh} km/h, the pace NASA EVA-EXP-0075 assumes for lunar
          walking excursions, adopted here as a planning assumption. Both inherit the model's limits and neither is a
          validated walking time for Mars; they are two scenarios, not a range with a known confidence. EVA duration adds
          the time at the targets to the walking time.
        </p>
        <p className="footnote">
          The route is straightened only where the straight line stays on walkable ground, is no slower, and crosses no
          more hidden steep ground. Hidden steep ground counts 1 m DEM pixels over {MAX_SLOPE_DEG}° inside a 4 m cell; it
          is an indicator of roughness, not a probability, and rocks or ledges smaller than the DEM resolves are not
          detected.
        </p>
        <p className="footnote">
          Energy is metabolic energy of walking only, by the adopted model (Santee et al. 2001) at the model's walking
          speed. That model comes from treadmill walking on Earth at one speed with loads up to 18 kg; only its climb and
          descent terms use Mars gravity. Work at the targets is not modelled, so this is not the energy of the whole EVA.
        </p>
      </Section>

      <Section
        title="Background radiation"
        defaultOpen={false}
        aside={ready ? `${fmtDose(s.doseMsv)} · ${fmtDose(s.planDoseMsv)}` : undefined}
      >
        <dl className="data">
          <Datum label="EVA duration, model">{ready ? fmtDur(s.evaSeconds) : '—'}</Datum>
          <Datum label="Background over that time">{ready ? fmtDose(s.doseMsv) : '—'}</Datum>
          <Datum label={`EVA duration at ≤ ${PLANNING_PACE.max_kmh} km/h`}>{ready ? fmtDur(s.planEvaSeconds) : '—'}</Datum>
          <Datum label="Background over that time">{ready ? fmtDose(s.planDoseMsv) : '—'}</Datum>
          <Datum label="Surface rate used">{RADIATION.doseEquivalent_mSv_per_day} mSv/day</Datum>
        </dl>
        <p className="footnote">
          Each figure is the surface rate multiplied by one of the two EVA durations. They are simplified estimates of
          background exposure during those hours, not validated astronaut doses and not exposure caused by the EVA
          itself. The second is another scenario, not an upper bound. Radiation has no limit in MARSCOPE and does not
          enter GO / NO-GO.
        </p>
        <p className="footnote">{RADIATION.note}</p>
      </Section>
    </>
  )
}
