interface Props {
  onStart: () => void
  onExample: () => void
  canExample: boolean
}

/** First-run briefing shown over the map. */
export default function Onboarding({ onStart, onExample, canExample }: Props) {
  return (
    <div className="briefing" role="dialog" aria-labelledby="briefing-title">
      <p className="eyebrow">Mount Sharp · Gale crater · Mars</p>
      <h2 id="briefing-title">Plan a Marswalk before anyone steps outside.</h2>
      <p className="lede">
        MARSCOPE layers NASA orbital and rover data over the ground Curiosity is exploring, then finds the safest walking
        route between a habitat and your science targets.
      </p>
      <ol>
        <li>
          <span>
            <b>Pick a habitat site.</b> Click the map to inspect any location.
          </span>
        </li>
        <li>
          <span>
            <b>Add science targets.</b> The route avoids slopes steeper than 20°.
          </span>
        </li>
        <li>
          <span>
            <b>Read the verdict.</b> GO or NO-GO against NASA EVA limits.
          </span>
        </li>
      </ol>
      <div className="briefing-actions">
        <button type="button" className="btn btn-primary" onClick={onStart}>
          Start planning
        </button>
        <button type="button" className="btn" onClick={onExample} disabled={!canExample}>
          Load example EVA
        </button>
      </div>
    </div>
  )
}
