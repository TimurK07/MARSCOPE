import { useEffect, useState } from 'react'
import { adviceFor } from '../lib/advice'
import { buildChecks, type Verdict } from '../lib/mission'
import { CAUTION_WEIGHT, ROUTE_MODES, type RouteMode } from '../lib/objectives'
import type { ModeSummary } from '../lib/planner'
import { EVA, MAX_SLOPE_DEG, PLANNING_PACE, RADIATION, RETURN_LIMITS } from '../lib/model'
import { fmtCoord, fmtDur, fmtKm, type PlanState } from '../hooks/usePlan'
import { Datum, Icon, Section, Segmented } from './ui'

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

/** The three routes for the same checkpoints, measured the same way, side by side. */
function ModeComparison(props: {
  comparison: Record<RouteMode, ModeSummary | null>
  selected: RouteMode
  onSelect: (m: RouteMode) => void
  pending: boolean
}) {
  const cols = ROUTE_MODES.map((m) => ({ ...m, data: props.comparison[m.id] }))
  const any = cols.some((c) => c.data)
  const rows: { label: string; hint?: string; value: (d: ModeSummary) => string; num?: (d: ModeSummary) => number }[] = [
    { label: 'Distance', value: (d) => fmtKm(d.distance), num: (d) => d.distance },
    {
      label: 'Walking time, model',
      hint: 'By the walking-speed model (Marquez 2007, as in SEXTANT). This is what Fastest minimises.',
      value: (d) => fmtDur(d.walkTime),
      num: (d) => d.walkTime,
    },
    {
      label: `at ≤ ${PLANNING_PACE.max_kmh} km/h`,
      hint: `The same route with the speed capped at the planning pace of ${PLANNING_PACE.max_kmh} km/h. A second scenario, not a bound or a confidence interval.`,
      value: (d) => fmtDur(d.planWalkTime),
      num: (d) => d.planWalkTime,
    },
    { label: 'Walking energy', value: (d) => `${Math.round(d.energyKcal)} kcal`, num: (d) => d.energyKcal },
    { label: 'Climb', value: (d) => `+${Math.round(d.ascent)} m`, num: (d) => d.ascent },
    {
      label: 'Hidden steep ground',
      hint: 'Steep-pixel shares of the cells crossed, added up. 1.0 equals one 4 m cell that is entirely steeper than 20° at the 1 m scale.',
      value: (d) => (d.exposure ? d.exposure.load.toFixed(1) : '—'),
      num: (d) => d.exposure?.load ?? NaN,
    },
    {
      label: 'per km',
      hint: 'The same, per kilometre of route, so routes of different lengths can be compared.',
      value: (d) => (d.exposure ? d.exposure.perKm.toFixed(1) : '—'),
      num: (d) => d.exposure?.perKm ?? NaN,
    },
    {
      label: 'cells affected',
      hint: 'Share of the cells crossed that contain any steep 1 m pixel.',
      value: (d) => (d.exposure ? `${(d.exposure.cellShare * 100).toFixed(1)}%` : '—'),
      num: (d) => d.exposure?.cellShare ?? NaN,
    },
  ]
  const current = ROUTE_MODES.find((m) => m.id === props.selected)!
  return (
    <div className="cmp">
      <table>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Metric</span>
            </th>
            {cols.map((c) => (
              <th key={c.id} scope="col" className={c.id === props.selected ? 'is-on' : ''}>
                <button type="button" aria-pressed={c.id === props.selected} onClick={() => props.onSelect(c.id)} title={c.short}>
                  {c.id === 'energy' ? 'Energy' : c.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Status</th>
            {cols.map((c) => (
              <td key={c.id} className={`${c.id === props.selected ? 'is-on' : ''} v-${c.data?.verdict ?? 'standby'}`}>
                {c.data ? VERDICT_SHORT[c.data.verdict] : props.pending ? '…' : '—'}
              </td>
            ))}
          </tr>
          {rows.map((r) => {
            // The lowest value in a row is marked; ties are all marked.
            const nums = cols.map((c) => (c.data?.feasible && r.num ? r.num(c.data) : NaN))
            const min = Math.min(...nums.filter((n) => !Number.isNaN(n)))
            return (
              <tr key={r.label}>
                <th scope="row" title={r.hint}>
                  {r.label}
                </th>
                {cols.map((c, i) => (
                  <td key={c.id} className={`${c.id === props.selected ? 'is-on' : ''} ${nums[i] === min ? 'is-min' : ''}`}>
                    {c.data?.feasible ? r.value(c.data) : '—'}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      {!any && <p className="muted">{props.pending ? 'Calculating the three routes…' : 'Plan a route to compare the three priorities.'}</p>}
      <p className="cmp-note">
        <b>{current.label}.</b> {current.summary}
      </p>
      <p className="footnote">
        All three routes obey the same hard limits: {MAX_SLOPE_DEG}° maximum slope for every cell and every step walked, no
        clipping of no-go cells, and the same EVA and return checks. They are measured the same way; the lowest value in each row is underlined. Walking
        energy is an approximation adapted from research on Earth (Santee et al. 2001) and scaled to Mars gravity.
        Cautious weights time on hidden steep ground by 1 + {CAUTION_WEIGHT} × the cell's steep share: a heuristic
        coefficient of ours, not a NASA-certified safety model and not a measured risk. Each route is the least-cost
        path on the 4 m grid for its own objective; it is then straightened, and the straightened route is not proven
        optimal. No priority guarantees a safe route.
      </p>
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
        {verdict === 'go' && <p>Route is within all mission constraints.</p>}
        {verdict === 'noroute' && <p>{plan?.error}</p>}
        {verdict === 'unverified' && (
          <p>
            The return to the habitat could not be verified: the calculation limit was reached. This is not a confirmed
            violation, and it is not a GO.
          </p>
        )}
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
          <dt title="Walking time by the speed model plus time at the targets. The time at the planning pace is under Route telemetry.">EVA duration · model</dt>
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

      <div className="m-mode">
        <span className="label">Route priority</span>
        <Segmented
          label="Route priority"
          value={s.mode}
          onChange={s.setMode}
          options={[
            { value: 'fastest', label: 'Fastest' },
            { value: 'energy', label: 'Energy' },
            { value: 'cautious', label: 'Cautious' },
          ]}
        />
      </div>
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

      <Section title="Compare route priorities" defaultOpen={false} aside={ROUTE_MODES.find((m) => m.id === s.mode)!.label}>
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
        aside={checks ? `${checks.length - failed.length} of ${checks.length} met${verdict === 'unverified' ? ', not verified' : ''}` : undefined}
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
          {RETURN_LIMITS.distance_m / 1000} km and {RETURN_LIMITS.time_s / 60} min. A plan passes only if, from
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
          Energy covers walking only (Santee et al. 2001). Work at the targets is not modelled, so this is not the
          energy of the whole EVA.
        </p>
      </Section>

      <Section
        title="Radiation exposure"
        defaultOpen={false}
        aside={ready ? `${s.doseMsv.toFixed(3)} / ${s.planDoseMsv.toFixed(3)} mSv` : undefined}
      >
        <dl className="data">
          <Datum label="EVA duration, model">{ready ? fmtDur(s.evaSeconds) : '—'}</Datum>
          <Datum label="Background dose, model">{ready ? `${s.doseMsv.toFixed(3)} mSv` : '—'}</Datum>
          <Datum label={`EVA duration at ≤ ${PLANNING_PACE.max_kmh} km/h`}>{ready ? fmtDur(s.planEvaSeconds) : '—'}</Datum>
          <Datum label={`Background dose at ≤ ${PLANNING_PACE.max_kmh} km/h`}>{ready ? `${s.planDoseMsv.toFixed(3)} mSv` : '—'}</Datum>
          <Datum label="Surface rate (RAD)">{RADIATION.doseEquivalent_mSv_per_day} mSv/day</Datum>
          <Datum label="Career limit, for scale">{RADIATION.careerLimit_mSv} mSv</Datum>
          <Datum label="Share of career limit, model">
            {ready ? `${((s.doseMsv / RADIATION.careerLimit_mSv) * 100).toFixed(3)} %` : '—'}
          </Datum>
          <Datum label={`Share at ≤ ${PLANNING_PACE.max_kmh} km/h`}>
            {ready ? `${((s.planDoseMsv / RADIATION.careerLimit_mSv) * 100).toFixed(3)} %` : '—'}
          </Datum>
        </dl>
        <p className="footnote">
          Two figures, one for each EVA duration: the same surface rate multiplied by the time outside. They are
          simplified estimates of background exposure, not validated astronaut doses, and the planning figure is a second
          scenario, not an upper bound: a longer EVA or a solar event gives more. Radiation does not enter GO / NO-GO.
        </p>
        <p className="footnote">{RADIATION.note}</p>
      </Section>
    </>
  )
}
