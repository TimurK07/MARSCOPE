import { EVA, MAX_SLOPE_DEG, RADIATION, SOURCES } from '../lib/model'
import type { RouteSample } from '../lib/router'
import { fmtCoord, fmtDur, fmtKm, type PlanState } from '../hooks/usePlan'
import Profile from './Profile'
import { Datum, Section } from './ui'

interface Props {
  plan: PlanState
  cursor: RouteSample | null
  onCursor: (s: RouteSample | null) => void
  onLoadExample: () => void
  canLoadExample: boolean
  onRemove: (index: number) => void
  onMove: (index: number, dir: -1 | 1) => void
  onClear: () => void
}

type Verdict = 'standby' | 'go' | 'nogo' | 'noroute'

export default function MissionPanel({ plan: s, ...p }: Props) {
  const { plan, checks, points } = s
  const verdict: Verdict = !plan ? 'standby' : plan.error ? 'noroute' : s.go ? 'go' : 'nogo'
  const failed = checks?.filter((c) => !c.ok) ?? []

  const verdictText: Record<Verdict, { title: string; line: string }> = {
    standby: {
      title: 'STANDBY',
      line:
        points.length === 0
          ? 'No plan yet. Select a habitat site on the map.'
          : 'Habitat set. Add at least one science target.',
    },
    go: { title: 'GO', line: 'Route is within all mission constraints.' },
    nogo: { title: 'NO-GO', line: `Limit exceeded: ${failed.map((c) => c.label).join('; ')}.` },
    noroute: { title: 'NO ROUTE', line: plan?.error ?? '' },
  }

  return (
    <>
      <div className={`verdict verdict-${verdict}`} role="status" aria-live="polite">
        <span className="verdict-label">Mission verdict</span>
        <strong>{verdictText[verdict].title}</strong>
        <p>{verdictText[verdict].line}</p>
      </div>

      <dl className="metrics">
        <div>
          <dt>Distance</dt>
          <dd>{plan && !plan.error ? fmtKm(plan.distance) : '—'}</dd>
        </div>
        <div>
          <dt>EVA duration</dt>
          <dd>{plan && !plan.error ? fmtDur(s.evaSeconds) : '—'}</dd>
          {plan && !plan.error && <small>{fmtDur(plan.walkTime)} walking</small>}
        </div>
        <div>
          <dt>Elevation</dt>
          <dd>{plan && !plan.error ? `+${Math.round(plan.ascent)} / −${Math.round(plan.descent)} m` : '—'}</dd>
        </div>
        <div>
          <dt>Energy</dt>
          <dd>{plan && !plan.error ? `${Math.round(s.energyKcal)} kcal` : '—'}</dd>
        </div>
      </dl>

      <Section
        title="Route checkpoints"
        fixed
        aside={
          <span className="row-actions">
            <button type="button" className="btn btn-sm btn-ghost" onClick={s.undo} disabled={!s.canUndo} title="Undo (Ctrl/⌘ Z)">
              Undo
            </button>
            {points.length > 0 && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={p.onClear}>
                Clear
              </button>
            )}
          </span>
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
                <b>Review the verdict</b>
                <span>The route, constraints and exposure update as you edit.</span>
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
                          ↑
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Move target ${i} later`}
                          disabled={i === points.length - 1}
                          onClick={() => p.onMove(i, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    <button type="button" className="icon-btn" aria-label={i === 0 ? 'Remove habitat' : `Remove target ${i}`} onClick={() => p.onRemove(i)}>
                      ✕
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

      <Section title="Mission parameters" defaultOpen={points.length > 0}>
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
        aside={checks ? `${checks.length - failed.length}/${checks.length} met` : undefined}
      >
        {checks ? (
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
                <i aria-hidden="true">{c.ok ? '✓' : '!'}</i>
                <span>{c.label}</span>
                <code className="limit">{c.limit}</code>
                <code className="val">{c.value}</code>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="checks checks-idle">
            <li>
              <i aria-hidden="true">·</i>
              <span>EVA duration</span>
              <code className="limit">≤ {EVA.maxDuration_h} h</code>
            </li>
            <li>
              <i aria-hidden="true">·</i>
              <span>Farthest point from habitat</span>
              <code className="limit">≤ {EVA.walkRadius_km} km</code>
            </li>
            <li>
              <i aria-hidden="true">·</i>
              <span>Steepest terrain on route</span>
              <code className="limit">≤ {MAX_SLOPE_DEG}°</code>
            </li>
          </ul>
        )}
        <p className="footnote">Limits from NASA EVA-EXP-0075, Exploration EVA System Concept of Operations.</p>
      </Section>

      <Section title="Radiation exposure" defaultOpen={false} aside={plan && !plan.error ? `${s.doseMsv.toFixed(3)} mSv` : undefined}>
        <dl className="data">
          <Datum label="Dose for this EVA">{plan && !plan.error ? `${s.doseMsv.toFixed(3)} mSv` : '—'}</Datum>
          <Datum label="Surface rate (RAD)">{RADIATION.doseEquivalent_mSv_per_day} mSv/day</Datum>
          <Datum label="Share of career limit">
            {plan && !plan.error ? `${((s.doseMsv / RADIATION.careerLimit_mSv) * 100).toFixed(3)} %` : '—'}
          </Datum>
          <Datum label="Career limit">{RADIATION.careerLimit_mSv} mSv</Datum>
        </dl>
        <p className="footnote">{RADIATION.note}</p>
      </Section>

      <Section title="Terrain profile">
        {plan && !plan.error && plan.samples.length > 1 ? (
          <>
            <Profile samples={plan.samples} stops={plan.legStarts} onCursor={p.onCursor} />
            <p className="profile-read">
              {p.cursor ? (
                <>
                  <code>{fmtKm(p.cursor.dist)}</code>
                  <code>{fmtDur(p.cursor.time)}</code>
                  <code>{p.cursor.elevation.toFixed(0)} m</code>
                  <code>{p.cursor.slope.toFixed(1)}°</code>
                </>
              ) : (
                <span>Move over the profile to trace the route on the map.</span>
              )}
            </p>
          </>
        ) : (
          <p className="muted">The elevation profile appears once a route is planned.</p>
        )}
      </Section>

      <Section title="Data sources" defaultOpen={false}>
        <ul className="sources">
          {SOURCES.map((src) => (
            <li key={src.url}>
              <a href={src.url} target="_blank" rel="noreferrer">
                {src.label}
              </a>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}
