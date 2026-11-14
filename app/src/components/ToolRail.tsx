import { Icon, type IconName } from './ui'

export type RailPane = 'layers' | 'environment' | 'context' | 'sources'

export const RAIL_PANES: { id: RailPane; label: string; icon: IconName }[] = [
  { id: 'layers', label: 'Map layers', icon: 'layers' },
  { id: 'environment', label: 'Environment', icon: 'environment' },
  { id: 'context', label: 'Scientific context', icon: 'context' },
  { id: 'sources', label: 'Data sources', icon: 'sources' },
]

interface Props {
  active: RailPane | null
  onSelect: (pane: RailPane | null) => void
  /** Number of data layers currently drawn on the map, shown on the Layers button. */
  layerCount: number
  canUndo: boolean
  onUndo: () => void
  onHelp: () => void
}

/** Vertical tool rail: opens the data panes over the map. */
export default function ToolRail({ active, onSelect, layerCount, canUndo, onUndo, onHelp }: Props) {
  return (
    <nav className="rail" aria-label="Tools">
      <div className="rail-mark" title="MARSCOPE" aria-hidden="true" />
      <div className="rail-group">
        {RAIL_PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            className="rail-btn"
            aria-pressed={active === p.id}
            aria-label={p.label}
            data-tip={p.label}
            onClick={() => onSelect(active === p.id ? null : p.id)}
          >
            <Icon name={p.icon} />
            {p.id === 'layers' && layerCount > 0 && <span className="rail-count">{layerCount}</span>}
          </button>
        ))}
      </div>
      <div className="rail-group rail-end">
        <button type="button" className="rail-btn" aria-label="Undo last plan edit" data-tip="Undo  Ctrl/⌘ Z" disabled={!canUndo} onClick={onUndo}>
          <Icon name="undo" />
        </button>
        <button type="button" className="rail-btn" aria-label="Show mission briefing" data-tip="Briefing" onClick={onHelp}>
          <Icon name="help" />
        </button>
      </div>
    </nav>
  )
}
