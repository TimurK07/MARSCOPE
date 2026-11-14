import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fmtDur, fmtKm, type PlanState } from '../hooks/usePlan'
import { VERDICT_TITLE, verdictOf } from './MissionPanel'

export type SheetSnap = 'peek' | 'half' | 'full'
export type SheetTab = 'mission' | 'layers' | 'point' | 'profile' | 'surface'

export const SHEET_PEEK_H = 78

const TABS: { id: SheetTab; label: string }[] = [
  { id: 'mission', label: 'Mission' },
  { id: 'layers', label: 'Layers' },
  { id: 'point', label: 'Point' },
  { id: 'profile', label: 'Profile' },
  { id: 'surface', label: 'Photos' },
]

/** Height in px of each snap position for the current viewport. */
export function sheetHeights(): Record<SheetSnap, number> {
  const vh = window.innerHeight
  return { peek: SHEET_PEEK_H, half: Math.round(vh * 0.52), full: vh - 52 }
}

interface Props {
  plan: PlanState
  snap: SheetSnap
  onSnap: (s: SheetSnap) => void
  tab: SheetTab
  onTab: (t: SheetTab) => void
  /** Tabs that currently hold something to look at. */
  marked: Partial<Record<SheetTab, boolean>>
  children: ReactNode
}

/**
 * Mobile bottom sheet with three snap positions.
 * Only the header is draggable, so scrolling the content and panning the map
 * never fight with the sheet.
 */
export default function MobileSheet({ plan, snap, onSnap, tab, onTab, marked, children }: Props) {
  const [dragH, setDragH] = useState<number | null>(null)
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null)
  const [, force] = useState(0)

  // Snap heights depend on the viewport.
  useEffect(() => {
    const onResize = () => force((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const heights = sheetHeights()
  const height = dragH ?? heights[snap]

  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, h: heights[snap], moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dy = d.y - e.clientY
    if (Math.abs(dy) > 6) d.moved = true
    if (d.moved) setDragH(Math.min(Math.max(d.h + dy, heights.peek), heights.full))
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      // A tap toggles between the summary and the half-height sheet.
      onSnap(snap === 'peek' ? 'half' : 'peek')
    } else if (dragH != null) {
      const order: SheetSnap[] = ['peek', 'half', 'full']
      onSnap(order.reduce((best, s) => (Math.abs(heights[s] - dragH) < Math.abs(heights[best] - dragH) ? s : best)))
    }
    setDragH(null)
  }

  const verdict = verdictOf(plan)
  const ready = plan.plan && !plan.plan.error

  return (
    <section className={`sheet sheet-${snap} ${dragH != null ? 'is-dragging' : ''}`} style={{ height }} aria-label="Mission and data">
      <div
        className="sheet-head"
        role="button"
        tabIndex={0}
        aria-label={snap === 'peek' ? 'Open mission sheet' : 'Collapse mission sheet'}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSnap(snap === 'peek' ? 'half' : 'peek')
          }
        }}
      >
        <i className="sheet-grip" />
        <div className="sheet-summary">
          <strong className={`sheet-verdict v-${verdict}`}>{VERDICT_TITLE[verdict]}</strong>
          {ready ? (
            <>
              <span>
                <b>Distance</b>
                {fmtKm(plan.plan!.distance)}
              </span>
              <span>
                <b>EVA</b>
                {fmtDur(plan.evaSeconds)}
              </span>
            </>
          ) : (
            <span className="sheet-hint">
              {verdict === 'noroute'
                ? 'A checkpoint cannot be reached.'
                : plan.points.length === 0
                  ? 'Tap the map to choose a habitat site.'
                  : 'Tap the map to add a science target.'}
            </span>
          )}
        </div>
      </div>
      <div className="sheet-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={marked[t.id] ? 'has-data' : ''}
            onClick={() => {
              onTab(t.id)
              if (snap === 'peek') onSnap('half')
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={`sheet-body sheet-body-${tab}`} role="tabpanel">
        {children}
      </div>
    </section>
  )
}
