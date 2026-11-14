// Rules for moving between the 3D globe and the 2D mission workspace.
// Pure logic, so the thresholds can be tested.

import { expandBBox, inBBox, type BBox } from './globe'
import type { LatLon } from './terrain'

/** Deepest zoom the global Viking mosaic supports (232 m/px is native at zoom 7). */
export const GLOBAL_FLOOR_ZOOM = 7

/** Deepest zoom on the globe inside the Gale CTX mosaic; the handover to 2D happens here. */
export const LOCAL_ENTER_ZOOM = 12.5

/** The 2D map hands back to the globe when the user zooms out to this level. */
export const LOCAL_EXIT_ZOOM = 6

/** Gale crater CTX mosaic: the region where the globe has high-resolution imagery. */
export const GALE_IMAGERY: BBox = [-6.5732988, 135.1842593, -2.8077809, 139.2413012]

/** How far the globe can zoom at a location: deep inside Gale, shallow elsewhere. */
export function floorZoomAt(center: LatLon): number {
  // A margin keeps the view from showing the mosaic's edge at full depth.
  return inBBox(center, expandBBox(GALE_IMAGERY, -0.12)) ? LOCAL_ENTER_ZOOM : GLOBAL_FLOOR_ZOOM
}

/**
 * Whether reaching the floor should open the 2D workspace by itself.
 * Only near the study area, where the terrain grid and routing exist.
 */
export function shouldAutoEnter(center: LatLon, zoom: number, studyArea: BBox): boolean {
  return zoom >= LOCAL_ENTER_ZOOM - 0.05 && inBBox(center, expandBBox(studyArea, 0.6))
}

/** Whether the 2D workspace can be opened at this location at all (it has imagery there). */
export function canOpenWorkspaceAt(center: LatLon): boolean {
  return inBBox(center, GALE_IMAGERY)
}

export type ViewPhase = 'global' | 'entering' | 'local' | 'exiting'

/** Guards against re-entrant or repeated switching. */
export function canStartTransition(phase: ViewPhase, target: 'local' | 'global', lastSwitchMs: number, nowMs: number): boolean {
  if (phase === 'entering' || phase === 'exiting') return false
  if (phase === target) return false
  return nowMs - lastSwitchMs > 700
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the 2D map's centre is relative to the globe's centre, in pixels.
 * Both rectangles are measured from the live layout, so this holds for any
 * screen size and for any state of the rail, mission panel, dock or sheet.
 */
export function focusOffset(globe: Rect, map: Rect): { x: number; y: number } {
  return {
    x: map.left + map.width / 2 - (globe.left + globe.width / 2),
    y: map.top + map.height / 2 - (globe.top + globe.height / 2),
  }
}
