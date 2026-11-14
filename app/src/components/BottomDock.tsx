import { useRef } from 'react'
import type { RoverStop } from '../lib/nasa'
import type { RouteSample } from '../lib/router'
import type { LatLon, Terrain } from '../lib/terrain'
import { fmtDur, fmtKm, type PlanState } from '../hooks/usePlan'
import { fmtSlope } from '../lib/format'
import { MAX_SLOPE_DEG } from '../lib/model'
import Inspector from './Inspector'
import Profile from './Profile'
import SurfaceView from './SurfaceDrawer'
import { Icon, type IconName } from './ui'

export type DockTab = 'profile' | 'point' | 'surface'

export const DOCK_TABS: { id: DockTab; label: string; icon: IconName }[] = [
  { id: 'profile', label: 'Terrain profile', icon: 'profile' },
  { id: 'point', label: 'Point', icon: 'point' },
  { id: 'surface', label: 'Surface view', icon: 'camera' },
]

export const DOCK_DEFAULT_H = 188
export const DOCK_MIN_H = 132
const DOCK_TALL_H = 380

export interface DockContentProps {
  tab: DockTab
  terrain: Terrain
  plan: PlanState
  onCursor: (s: RouteSample | null) => void
  inspect: LatLon | null
  onSetHabitat: () => void
  onAddTarget: () => void
  onClearInspect: () => void
  stop: RoverStop | null
  onClearStop: () => void
}

/** Body of one dock tab. Shared by the desktop dock and the mobile sheet. */
export function DockContent(p: DockContentProps) {
  const route = p.plan.plan && !p.plan.plan.error && p.plan.plan.samples.length > 1 ? p.plan.plan : null

  if (p.tab === 'profile')
    return route ? (
      <Profile samples={route.samples} stops={route.legStarts} roundTrip={p.plan.roundTrip} onCursor={p.onCursor} />
    ) : (
      <p className="dock-empty">Plan a route to see its terrain profile. The profile is coloured by slope class and linked to the map.</p>
    )

  if (p.tab === 'point')
    return p.inspect ? (
      <Inspector
        terrain={p.terrain}
        point={p.inspect}
        habitat={p.plan.points[0] ?? null}
        targetCount={Math.max(p.plan.points.length - 1, 0)}
        onSetHabitat={p.onSetHabitat}
        onAddTarget={p.onAddTarget}
        onClose={p.onClearInspect}
      />
    ) : (
      <p className="dock-empty">Click the map to inspect a location: elevation, slope, geologic unit, and actions to place a checkpoint there.</p>
    )

  return p.stop ? (
    <SurfaceView stop={p.stop} onClose={p.onClearStop} />
  ) : (
    <p className="dock-empty">Select a Curiosity stop (yellow markers on the dashed traverse) to see what the rover saw there.</p>
  )
}

interface Props extends DockContentProps {
  onTab: (t: DockTab) => void
  open: boolean
  onOpen: (open: boolean) => void
  height: number
  onHeight: (h: number) => void
  cursor: RouteSample | null
}

/** Bottom dock under the map: terrain profile, point inspector, surface imagery. */
export default function BottomDock(p: Props) {
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)

  const maxH = () => {
    const work = root.current?.parentElement
    return work ? Math.max(DOCK_MIN_H, Math.round(work.clientHeight * 0.62)) : 480
  }
  const clamp = (h: number) => Math.min(Math.max(h, DOCK_MIN_H), maxH())

  const onDown = (e: React.PointerEvent) => {
    if (!p.open) return
    drag.current = { y: e.clientY, h: p.height }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    p.onHeight(clamp(drag.current.h + drag.current.y - e.clientY))
  }
  const onUp = () => {
    drag.current = null
  }

  const tall = p.height > DOCK_DEFAULT_H + 40
  const route = p.plan.plan && !p.plan.plan.error ? p.plan.plan : null

  return (
    <div ref={root} className={`dock ${p.open ? 'is-open' : ''}`} style={p.open ? { height: p.height } : undefined}>
      <div
        className="dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize dock"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <div className="dock-tabs">
        <div role="tablist" aria-label="Dock">
          {DOCK_TABS.map((t) => {
            const dot = (t.id === 'point' && p.inspect) || (t.id === 'surface' && p.stop) || (t.id === 'profile' && route)
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={p.open && p.tab === t.id}
                className={dot ? 'has-data' : ''}
                onClick={() => {
                  if (p.open && p.tab === t.id) return p.onOpen(false)
                  p.onTab(t.id)
                  p.onOpen(true)
                }}
              >
                <Icon name={t.icon} size={14} />
                {t.label}
              </button>
            )
          })}
        </div>
        <div className="dock-read">
          {p.open && p.tab === 'profile' && route && (
            p.cursor ? (
              <>
                <span>
                  <b>DIST</b>
                  {fmtKm(p.cursor.dist)}
                </span>
                <span>
                  <b>TIME</b>
                  {fmtDur(p.cursor.time)}
                </span>
                <span>
                  <b>ELEV</b>
                  {p.cursor.elevation.toFixed(0)} m
                </span>
                <span>
                  <b>SLOPE</b>
                  {fmtSlope(p.cursor.slope, MAX_SLOPE_DEG)}
                </span>
              </>
            ) : (
              <span className="dock-tip">Move over the profile to trace the route on the map</span>
            )
          )}
        </div>
        <div className="dock-actions">
          {p.open && (
            <button
              type="button"
              className="icon-btn"
              aria-label={tall ? 'Restore dock height' : 'Expand dock'}
              title={tall ? 'Restore height' : 'Expand'}
              onClick={() => p.onHeight(tall ? DOCK_DEFAULT_H : clamp(DOCK_TALL_H))}
            >
              <Icon name="expand" size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label={p.open ? 'Collapse dock' : 'Open dock'}
            title={p.open ? 'Collapse' : 'Open'}
            onClick={() => p.onOpen(!p.open)}
          >
            <Icon name={p.open ? 'chevronDown' : 'chevronUp'} size={16} />
          </button>
        </div>
      </div>
      {p.open && (
        <div className="dock-body" role="tabpanel">
          <DockContent {...p} />
        </div>
      )}
    </div>
  )
}
