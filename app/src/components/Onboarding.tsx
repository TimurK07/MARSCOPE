interface Props {
  onStart: () => void
  onExample: () => void
  canExample: boolean
  /** True when reopened over an existing plan. */
  hasPlan?: boolean
}

const DATA = [
  { mission: 'Mars Reconnaissance Orbiter', use: 'HiRISE and CTX imagery, 1 m terrain model' },
  { mission: 'Curiosity rover (MSL)', use: 'Traverse, Navcam frames, weather, radiation' },
  { mission: 'Mars Odyssey', use: 'THEMIS thermal infrared' },
  { mission: 'USGS · Viking', use: 'Geologic map, global color context' },
]

/** First-run mission briefing. Reopened from the tool rail. */
export default function Onboarding({ onStart, onExample, canExample, hasPlan }: Props) {
  return (
    <div className="brief-scrim">
      <div className="brief" role="dialog" aria-modal="true" aria-labelledby="brief-title">
        <div className="brief-main">
          <p className="brief-eyebrow">Mount Sharp · Gale crater · Mars</p>
          <h2 id="brief-title">Plan a Marswalk before anyone steps outside.</h2>
          <p className="brief-lede">
            MARSCOPE is a mission-planning workspace for a surface EVA. It layers data from NASA missions over the
            ground Curiosity is exploring and plans walking routes between a habitat and your science targets that stay
            within NASA's 20° slope limit. It is a planning aid, not a safety certification.
          </p>
          <ol className="brief-steps">
            <li>
              <b>Pick a habitat site</b>
              <span>Click the map to inspect any location.</span>
            </li>
            <li>
              <b>Add science targets</b>
              <span>The route avoids slopes steeper than 20°.</span>
            </li>
            <li>
              <b>Read the mission status</b>
              <span>GO or NO-GO against NASA EVA limits.</span>
            </li>
          </ol>
          <div className="brief-actions">
            <button type="button" className="btn btn-primary" onClick={onExample} disabled={!canExample}>
              Load example EVA
            </button>
            <button type="button" className="btn" onClick={onStart}>
              {hasPlan ? 'Continue planning' : 'Start with an empty plan'}
            </button>
          </div>
        </div>
        <div className="brief-data">
          <p className="label">NASA data in this workspace</p>
          <ul>
            {DATA.map((d) => (
              <li key={d.mission}>
                <b>{d.mission}</b>
                <span>{d.use}</span>
              </li>
            ))}
          </ul>
          <p className="brief-note">Every model constant links to its NASA or peer-reviewed source.</p>
        </div>
      </div>
    </div>
  )
}
