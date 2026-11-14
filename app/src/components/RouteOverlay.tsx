import type { RouteDisplay } from '../lib/routeDisplay'

interface Props {
  display: RouteDisplay
  /** On small screens the map key is drawn here; on wide ones the status bar carries it. */
  compact: boolean
}

/**
 * What sits over the map about the route: a one-line reason when the plan does
 * not pass, and on small screens the key to the route colours. Both are tied to
 * the plan and its limits, not to a place: places are marked on the map itself.
 */
export default function RouteOverlay({ display, compact }: Props) {
  const { alert, legend } = display
  if (!alert && !(compact && legend.length > 0)) return null
  return (
    <div className={`route-overlay ${compact ? 'is-compact' : ''}`}>
      {alert && (
        <p className={`route-alert tone-${alert.tone}`} role="status">
          <b>{alert.title}</b>
          <span>{alert.text}</span>
        </p>
      )}
      {compact && legend.length > 0 && (
        <ul className="route-legend" aria-label="Route key">
          {legend.map((item) => (
            <li key={item.id}>
              <i className={`key-${item.id}`} />
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
