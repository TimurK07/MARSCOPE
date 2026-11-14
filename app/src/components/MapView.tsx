import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { BASE_LAYERS, CRATER_VIEW, TILE_LAYERS, type TileLayerDef } from '../lib/layers'
import { contourImage, elevationImage, hazardImage, hiddenSteepImage, type HazardMode } from '../lib/overlays'
import { cellAt, elevationAt, slopeAt, type LatLon, type Terrain } from '../lib/terrain'
import type { RoverStop, RoverTrack } from '../lib/nasa'
import type { RouteLeg } from '../lib/router'
import { LOCAL_EXIT_ZOOM } from '../lib/viewTransition'

export interface LayerState {
  on: boolean
  opacity: number
}

export interface HoverInfo extends LatLon {
  elevation: number | null
  slope: number | null
}

export interface MapHandle {
  zoomIn: () => void
  zoomOut: () => void
  fitSite: () => void
  fitCrater: () => void
  /** Current centre and zoom. */
  getView: () => { lat: number; lon: number; zoom: number }
  /** Moves to a view at once, without animation, and stops following the study area. */
  jumpTo: (center: LatLon, zoom: number) => void
  reveal: (p: LatLon, bottomInset?: number) => void
}

interface Props {
  terrain: Terrain
  tiles: Record<string, LayerState>
  hazard: LayerState & { mode: HazardMode }
  elevation: LayerState
  contours: LayerState
  /** Hidden steep ground, from the 1 m source DEM. */
  hidden: LayerState
  showTrack: boolean
  track: RoverTrack | null
  points: LatLon[]
  legs: RouteLeg[]
  selectedSol: number | null
  cursor: LatLon | null
  inspect: LatLon | null
  onInspect: (p: LatLon) => void
  onStopClick: (s: RoverStop) => void
  onHover: (h: HoverInfo | null) => void
  onZoom: (zoom: number) => void
  onMovePoint: (index: number, p: LatLon) => void
  /** The user zoomed out to the map's minimum zoom. */
  onMinZoom?: () => void
}

/** Retries tiles that fail on a flaky connection (Leaflet gives up after one try). */
function retryFailedTiles(layer: L.TileLayer): L.TileLayer {
  layer.on('tileerror', (e) => {
    const img = e.tile as HTMLImageElement & { _retries?: number }
    const tries = (img._retries = (img._retries ?? 0) + 1)
    if (tries > 4) return
    const src = img.src.split('?')[0]
    setTimeout(() => {
      img.src = `${src}?retry=${tries}`
    }, 800 * tries)
  })
  return layer
}

function makeTileLayer(def: TileLayerDef, pane: string): L.TileLayer {
  return retryFailedTiles(
    L.tileLayer(def.url, {
      pane,
      maxNativeZoom: def.maxNativeZoom,
      maxZoom: 19,
      tileSize: 256,
      noWrap: true,
      bounds: def.bounds
        ? L.latLngBounds([def.bounds[0], def.bounds[1]], [def.bounds[2], def.bounds[3]])
        : undefined,
      opacity: def.defaultOpacity,
      attribution: 'Imagery: NASA/JPL-Caltech · Mars Trek',
    }),
  )
}

const MIN_ZOOM = LOCAL_EXIT_ZOOM

const icon = (html: string, size: number) =>
  L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })

const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRefs = useRef<Record<string, L.TileLayer>>({})
  const rasterRefs = useRef<Record<string, L.ImageOverlay>>({})
  const hazardModeRef = useRef<HazardMode | null>(null)
  const trackGroup = useRef<L.LayerGroup | null>(null)
  const planGroup = useRef<L.LayerGroup | null>(null)
  const inspectRef = useRef<L.Marker | null>(null)
  const cursorRef = useRef<L.CircleMarker | null>(null)
  const zoomRef = useRef(13)
  const autoFit = useRef(true)
  const userZoomAt = useRef(0)
  const cb = useRef(props)
  cb.current = props

  const siteBounds = () => {
    const { west, south, east, north } = props.terrain.meta.bbox
    return L.latLngBounds([south, west], [north, east])
  }

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      autoFit.current = false
      mapRef.current?.zoomIn()
    },
    zoomOut: () => {
      autoFit.current = false
      userZoomAt.current = performance.now()
      mapRef.current?.zoomOut()
    },
    getView: () => {
      const m = mapRef.current!
      const c = m.getCenter()
      return { lat: c.lat, lon: c.lng, zoom: m.getZoom() }
    },
    jumpTo: (center, zoom) => {
      autoFit.current = false
      mapRef.current?.setView([center.lat, center.lon], zoom, { animate: false })
    },
    fitSite: () => {
      autoFit.current = true
      mapRef.current?.flyToBounds(siteBounds(), { padding: [24, 24], duration: 0.6 })
    },
    fitCrater: () => {
      autoFit.current = false
      mapRef.current?.flyToBounds(
        L.latLngBounds([CRATER_VIEW[0], CRATER_VIEW[1]], [CRATER_VIEW[2], CRATER_VIEW[3]]),
        { duration: 0.6 },
      )
    },
    /** Pan just enough to bring a point into the visible part of the map. */
    reveal: (p: LatLon, bottomInset = 0) => {
      mapRef.current?.panInside([p.lat, p.lon], { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40 + bottomInset] })
    },
  }))

  // Create the map once.
  useEffect(() => {
    const t = props.terrain
    const area = siteBounds()
    const map = L.map(el.current!, {
      crs: L.CRS.EPSG4326,
      minZoom: MIN_ZOOM,
      maxZoom: 19,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      zoomControl: false,
      attributionControl: true,
      // Wide enough for the regional view at the minimum zoom, where the globe takes over.
      maxBounds: L.latLngBounds([-24, 118], [14, 158]),
      maxBoundsViscosity: 0.8,
    })
    mapRef.current = map
    L.control.scale({ imperial: false, position: 'bottomright', maxWidth: 120 }).addTo(map)
    map.attributionControl.setPrefix(false)

    map.createPane('base').style.zIndex = '200'
    map.createPane('data').style.zIndex = '250'
    map.createPane('raster').style.zIndex = '300'

    for (const def of BASE_LAYERS) makeTileLayer(def, 'base').addTo(map)
    for (const def of TILE_LAYERS) tileRefs.current[def.id] = makeTileLayer(def, 'data')

    L.rectangle(area, { className: 'site-frame', fill: false, interactive: false }).addTo(map)

    trackGroup.current = L.layerGroup().addTo(map)
    planGroup.current = L.layerGroup().addTo(map)

    map.on('click', (e) => cb.current.onInspect({ lat: e.latlng.lat, lon: e.latlng.lng }))
    map.on('mousemove', (e) => {
      const p = { lat: e.latlng.lat, lon: e.latlng.lng }
      const idx = cellAt(t, p)
      cb.current.onHover({
        ...p,
        elevation: idx < 0 ? null : elevationAt(t, idx),
        slope: idx < 0 ? null : slopeAt(t, idx),
      })
    })
    map.on('mouseout', () => cb.current.onHover(null))
    map.on('zoomend', () => {
      zoomRef.current = map.getZoom()
      cb.current.onZoom(map.getZoom())
      // Zooming out as far as the map goes hands the view back to the globe.
      if (map.getZoom() <= MIN_ZOOM + 0.01 && performance.now() - userZoomAt.current < 1500) cb.current.onMinZoom?.()
    })

    map.fitBounds(area, { padding: [24, 24] })
    zoomRef.current = map.getZoom()
    cb.current.onZoom(map.getZoom())

    // Keep the view sensible when the layout changes (panels, mobile tabs).
    // While the view is "following" the study area (initially, and after Fit),
    // refit whenever the stage changes size: dock, panels, window.
    autoFit.current = true
    const stopFollowing = (e: Event) => {
      autoFit.current = false
      if (e.type !== 'mousedown') userZoomAt.current = performance.now()
    }
    const container = map.getContainer()
    for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) {
      container.addEventListener(ev, stopFollowing, { passive: true })
    }
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false })
      if (autoFit.current) map.fitBounds(area, { padding: [24, 24], animate: false })
    })
    ro.observe(el.current!)
    return () => {
      ro.disconnect()
      map.remove()
      mapRef.current = null
      rasterRefs.current = {}
      hazardModeRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tile layers: visibility, opacity, and scale gating of coarse products.
  const applyTiles = () => {
    const map = mapRef.current
    if (!map) return
    TILE_LAYERS.forEach((def, i) => {
      const layer = tileRefs.current[def.id]
      const st = cb.current.tiles[def.id]
      const usable = def.maxUsefulZoom == null || zoomRef.current <= def.maxUsefulZoom
      const show = st.on && usable
      if (show && !map.hasLayer(layer)) layer.addTo(map)
      if (!show && map.hasLayer(layer)) layer.remove()
      layer.setOpacity(st.opacity)
      layer.setZIndex(i + 1)
    })
  }
  useEffect(applyTiles, [props.tiles])
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.on('zoomend', applyTiles)
    return () => {
      map.off('zoomend', applyTiles)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Raster overlays painted from the terrain grids (built on first use).
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const t = props.terrain
    const sync = (id: string, st: LayerState, z: number, build: () => string, rebuild = false) => {
      let layer = rasterRefs.current[id]
      if (st.on && (!layer || rebuild)) {
        layer?.remove()
        layer = rasterRefs.current[id] = L.imageOverlay(build(), siteBounds(), {
          pane: 'raster',
          interactive: false,
          className: `raster raster-${id}`,
          zIndex: z,
        })
      }
      if (!layer) return
      if (st.on && !map.hasLayer(layer)) layer.addTo(map)
      if (!st.on && map.hasLayer(layer)) layer.remove()
      layer.setOpacity(st.opacity)
    }
    sync('elevation', props.elevation, 1, () => elevationImage(t))
    sync('contours', props.contours, 2, () => contourImage(t))
    sync('hidden', props.hidden, 4, () => hiddenSteepImage(t))
    const modeChanged = hazardModeRef.current !== props.hazard.mode
    sync('hazard', props.hazard, 3, () => hazardImage(t, props.hazard.mode), modeChanged && props.hazard.on)
    if (props.hazard.on) hazardModeRef.current = props.hazard.mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.hazard, props.elevation, props.contours, props.hidden])

  // Curiosity traverse: line, thinned stops, current position.
  const drawTrack = () => {
    const group = trackGroup.current
    const map = mapRef.current
    if (!group || !map) return
    group.clearLayers()
    const { track, showTrack, selectedSol, terrain } = cb.current
    if (!track || !showTrack) return
    L.polyline(
      track.path.map((p) => [p.lat, p.lon] as [number, number]),
      { className: 'rover-track', interactive: false },
    ).addTo(group)

    const { west, south, east, north } = terrain.meta.bbox
    const last = track.stops[track.stops.length - 1]
    // Show a stop only when it is far enough on screen from the previous one shown.
    const minGap = 16
    let prev: L.Point | null = null
    for (let i = track.stops.length - 2; i >= 0; i--) {
      const s = track.stops[i]
      if (s.lon < west || s.lon > east || s.lat < south || s.lat > north) continue
      const selected = s.sol === selectedSol
      const pt = map.latLngToLayerPoint([s.lat, s.lon])
      if (!selected && prev && pt.distanceTo(prev) < minGap) continue
      prev = pt
      L.circleMarker([s.lat, s.lon], {
        className: selected ? 'rover-stop is-selected' : 'rover-stop',
        radius: selected ? 5.5 : 3,
        bubblingMouseEvents: false,
      })
        .bindTooltip(`Curiosity stop · sol ${s.sol}`, { direction: 'top', offset: [0, -4] })
        .on('click', () => cb.current.onStopClick(s))
        .addTo(group)
    }
    if (last) {
      L.marker([last.lat, last.lon], {
        icon: icon(`<div class="mk mk-rover${last.sol === selectedSol ? ' is-selected' : ''}"><i></i></div>`, 26),
        bubblingMouseEvents: false,
        zIndexOffset: 100,
      })
        .bindTooltip(`Curiosity · current position · sol ${last.sol}`, { direction: 'top', offset: [0, -10] })
        .on('click', () => cb.current.onStopClick(last))
        .addTo(group)
    }
  }
  useEffect(drawTrack, [props.track, props.showTrack, props.selectedSol])
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.on('zoomend', drawTrack)
    return () => {
      map.off('zoomend', drawTrack)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // EVA plan: route legs and draggable checkpoints.
  useEffect(() => {
    const group = planGroup.current
    if (!group) return
    group.clearLayers()
    for (const leg of props.legs) {
      const pts = leg.samples.map((s) => [s.lat, s.lon] as [number, number])
      L.polyline(pts, { className: 'route-casing', interactive: false }).addTo(group)
      L.polyline(pts, { className: 'route-line', interactive: false }).addTo(group)
    }
    props.points.forEach((p, i) => {
      const html =
        i === 0 ? '<div class="mk mk-base"><span>H</span></div>' : `<div class="mk mk-target"><span>${i}</span></div>`
      L.marker([p.lat, p.lon], {
        icon: icon(html, 30),
        draggable: true,
        autoPan: true,
        bubblingMouseEvents: false,
        zIndexOffset: i === 0 ? 400 : 300,
      })
        .bindTooltip(i === 0 ? 'Habitat · drag to move' : `Target ${i} · drag to move`, {
          direction: 'top',
          offset: [0, -12],
        })
        .on('dragend', (e) => {
          const ll = (e.target as L.Marker).getLatLng()
          cb.current.onMovePoint(i, { lat: ll.lat, lon: ll.lng })
        })
        .addTo(group)
    })
  }, [props.points, props.legs])

  // Inspected point.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    inspectRef.current?.remove()
    inspectRef.current = null
    if (!props.inspect) return
    inspectRef.current = L.marker([props.inspect.lat, props.inspect.lon], {
      icon: icon('<div class="mk mk-inspect"></div>', 34),
      interactive: false,
      zIndexOffset: 200,
    }).addTo(map)
  }, [props.inspect])

  // Cursor that follows the terrain profile.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!props.cursor) {
      cursorRef.current?.remove()
      cursorRef.current = null
      return
    }
    const ll: [number, number] = [props.cursor.lat, props.cursor.lon]
    if (!cursorRef.current) {
      cursorRef.current = L.circleMarker(ll, { className: 'profile-cursor', radius: 6, interactive: false }).addTo(map)
    } else cursorRef.current.setLatLng(ll)
  }, [props.cursor])

  return <div ref={el} className="map" />
})

export default MapView
