// 3D Mars globe renderer (three.js). Loaded lazily, only by GlobeView.
//
// What is drawn is imagery, not terrain: a sphere textured with the Viking
// MDIM 2.1 mosaic, sharpened near the camera with patches built from the same
// NASA Mars Trek tile pyramids the 2D workspace uses. There is no elevation
// data on the globe.

import * as THREE from 'three'
import { Line2 } from 'three/examples/jsm/lines/Line2.js'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import {
  altitudeForZoom,
  angularDistance,
  densifyPath,
  inBBox,
  latLonToUnit,
  slerp,
  tileGridFor,
  unitToLatLon,
  wrapLon,
  wrapTileX,
  zoomForAltitude,
  type BBox,
  type TileGrid,
} from './globe'
import { HIRISE } from './layers'
import { MARS_FEATURES } from './marsFeatures'
import { ROUTE_COLOR_HEX, type LegRole, type MissionTone, type RouteNote } from './routeDisplay'
import type { LatLon } from './terrain'
import { GALE_IMAGERY, floorZoomAt } from './viewTransition'

export const GLOBE_FOV = 35

export interface GlobeViewState extends LatLon {
  /** Zoom of the 2D map that shows the same ground extent. */
  zoom: number
  altitudeKm: number
}

/** Dash lengths on the unit sphere. The frame's are about 70 m and 100 m; the return route's about 30 m and 15 m. */
const FRAME_DASH = { size: 0.00002, gap: 0.00003 }
const RETURN_DASH = { size: 0.000009, gap: 0.0000045 }

export interface GlobeData {
  /** Study area with terrain data: [south, west, north, east]. */
  site: BBox
  points: LatLon[]
  /** Route legs as sampled geographic paths. */
  legs: LatLon[][]
  /** Outbound or return, for each leg: the same colours as on the 2D map. */
  legRoles: LegRole[]
  /** Places the planner established and the 2D map marks too. */
  notes: RouteNote[]
  rover: LatLon | null
  inspect: LatLon | null
  /** Whether the 2D map currently shows its HiRISE layer; the globe matches it up close. */
  hirise: boolean
  mission: { title: string; detail: string; tone: MissionTone }
}

export interface GlobeCallbacks {
  onView: (v: GlobeViewState) => void
  onPick: (p: LatLon) => void
  onHover: (p: LatLon | null) => void
  /** The user tried to zoom in past the deepest level available at this location. */
  onFloor: (center: LatLon, zoom: number) => void
  onMissionClick: () => void
  /** Imagery is being fetched. */
  onLoading: (busy: boolean) => void
}

const MARS_RADIUS_KM = 3396.19
const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ'
const VIKING = (z: number, y: number, x: number) =>
  `${TREK}/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`
const CTX = (z: number, y: number, x: number) => `${TREK}/Gale_CTX_BlockAdj_dd/1.0.0/default/default028mm/${z}/${y}/${x}.png`
const HIRISE_TILE = (z: number, y: number, x: number) => `${TREK}/curiosity_hirise_mosaic/1.0.0/default/default028mm/${z}/${y}/${x}.png`
const HIRISE_BOUNDS = HIRISE.bounds as BBox

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** Whether a view of the given size around a centre overlaps a box. */
const viewTouches = (c: LatLon, spanLat: number, spanLon: number, b: BBox) =>
  c.lat + spanLat / 2 > b[0] && c.lat - spanLat / 2 < b[2] && c.lon + spanLon / 2 > b[1] && c.lon - spanLon / 2 < b[3]

const LIGHT = new THREE.Vector3(-0.5, 0.42, 0.76).normalize()

const SHADE = /* glsl */ `
  uniform vec3 uLight;
  uniform float uFlat;
  // Presentation lighting only. The mosaic already carries the real illumination
  // of its source images, so this stays gentle and fades out on approach.
  float shade(vec3 n) {
    float ndl = clamp(dot(n, uLight), 0.0, 1.0);
    float lit = mix(0.36, 1.04, smoothstep(0.0, 0.8, ndl));
    float limb = mix(0.7, 1.0, pow(clamp(n.z, 0.0, 1.0), 0.4));
    return mix(lit * limb, 1.0, uFlat);
  }
`
const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const FRAG_SPHERE = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vN;
  ${SHADE}
  void main() {
    vec3 n = normalize(vN);
    vec3 c = texture2D(uMap, vUv).rgb * shade(n);
    // Faint dusty limb, the only atmospheric cue.
    float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.5);
    c += vec3(0.78, 0.46, 0.3) * rim * 0.22 * (1.0 - uFlat);
    gl_FragColor = vec4(c, 1.0);
  }
`
const FRAG_PATCH = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vN;
  ${SHADE}
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float f = 0.035;
    float edge = smoothstep(0.0, f, vUv.x) * smoothstep(0.0, f, 1.0 - vUv.x) * smoothstep(0.0, f, vUv.y) * smoothstep(0.0, f, 1.0 - vUv.y);
    gl_FragColor = vec4(t.rgb * shade(normalize(vN)), t.a * uOpacity * edge);
  }
`

// ---------- tiles ----------

const tileCache = new Map<string, Promise<ImageBitmap | null>>()

/** Loads an image with CORS. A 404 (outside a mosaic) is final; network errors are retried. */
function loadTile(url: string): Promise<ImageBitmap | null> {
  let p = tileCache.get(url)
  if (!p) {
    p = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`, { mode: 'cors' })
          if (!r.ok) return null
          return await createImageBitmap(await r.blob())
        } catch {
          // NASA's tile server sometimes drops a first request.
          await new Promise((res) => setTimeout(res, 400 * (attempt + 1)))
        }
      }
      return null
    })()
    tileCache.set(url, p)
  }
  return p
}

/**
 * Draws a grid of tiles into one canvas, centre tiles first.
 * onTile fires after each tile lands, so the patch can sharpen progressively.
 */
function stitch(
  grid: TileGrid,
  url: (z: number, y: number, x: number) => string,
  only: BBox | undefined,
  onTile: (canvas: HTMLCanvasElement, loaded: number) => void,
): Promise<void> {
  const cols = grid.x1 - grid.x0 + 1
  const rows = grid.y1 - grid.y0 + 1
  const canvas = document.createElement('canvas')
  canvas.width = cols * 256
  canvas.height = rows * 256
  const ctx = canvas.getContext('2d')!
  const size = 180 / 2 ** grid.z
  const cx = (grid.x0 + grid.x1) / 2
  const cy = (grid.y0 + grid.y1) / 2
  const tiles: { x: number; y: number; d: number }[] = []
  for (let y = grid.y0; y <= grid.y1; y++) {
    for (let x = grid.x0; x <= grid.x1; x++) {
      if (only) {
        const west = x * size - 180
        const north = 90 - y * size
        if (west + size < only[1] || west > only[3] || north < only[0] || north - size > only[2]) continue
      }
      tiles.push({ x, y, d: Math.hypot(x - cx, y - cy) })
    }
  }
  tiles.sort((a, b) => a.d - b.d)
  let loaded = 0
  return Promise.all(
    tiles.map((t) =>
      loadTile(url(grid.z, t.y, wrapTileX(t.x, grid.z))).then((img) => {
        if (!img) return
        ctx.drawImage(img, (t.x - grid.x0) * 256, (t.y - grid.y0) * 256, 256, 256)
        onTile(canvas, ++loaded)
      }),
    ),
  ).then(() => undefined)
}

function patchGeometry(b: BBox, segs = 40): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let j = 0; j <= segs; j++) {
    for (let i = 0; i <= segs; i++) {
      const u = i / segs
      const v = j / segs
      const p = latLonToUnit({ lat: b[0] + (b[2] - b[0]) * v, lon: b[1] + (b[3] - b[1]) * u })
      pos.push(p[0], p[1], p[2])
      uv.push(u, v)
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i
      idx.push(a, a + 1, a + segs + 1, a + 1, a + segs + 2, a + segs + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

interface PatchSlot {
  key: string
  z: number
  bounds: BBox | null
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null
  /** Meshes fading out, to be disposed. */
  old: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]
  target: number
  building: number
}

interface OverlayItem {
  el: HTMLElement
  at: LatLon
  /** Returns whether the item should show at the current view. */
  show: (zoom: number) => boolean
}

const rawTexture = (canvas: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(canvas)
  // Pass pixels through untouched so the globe matches the 2D map's tiles exactly.
  t.colorSpace = THREE.NoColorSpace
  t.anisotropy = anisotropy
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.needsUpdate = true
  return t
}

const toCanvas = (img: ImageBitmap): HTMLCanvasElement => {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.drawImage(img, 0, 0)
  return c
}

// Sharper global mosaic: the same Viking MDIM 2.1 product from the USGS map service, one request.
const GLOBAL_4K =
  'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap' +
  '&LAYERS=MDIM21_color&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=4096&HEIGHT=2048&FORMAT=image/jpeg'

export class GlobeEngine {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(GLOBE_FOV, 1, 0.001, 20)
  private sphereMat: THREE.ShaderMaterial
  private flat = { value: 0 }
  private overlayRoot: HTMLDivElement
  private overlays: OverlayItem[] = []
  private dataOverlays: OverlayItem[] = []
  private lines: Line2[] = []
  private lineMats: LineMaterial[] = []
  private routeGroup = new THREE.Group()
  private frameLine: Line2 | null = null

  private cur = { lat: 6, lon: 122, alt: 3 }
  private tgt = { lat: 6, lon: 122, alt: 3 }
  private fly: { from: LatLon; to: LatLon; a0: number; a1: number; bump: number; t0: number; ms: number; done: (ok: boolean) => void } | null = null
  private fling = { lat: 0, lon: 0 }
  private w = 1
  private h = 1
  private raf = 0
  private last = 0
  private dirty = true
  private active = true
  private disposed = false
  private idleTimer = 0
  private floorNotified = 0
  private lastPatchUpdate = 0
  /** Length of the whole route as an angle on the sphere, radians. */
  private routeRad = 0
  private siteSpanRad = 0
  private readonly lowPower: boolean
  private readonly anisotropy: number
  private viking: PatchSlot = { key: '', z: 0, bounds: null, mesh: null, old: [], target: 0, building: 0 }
  private ctx: PatchSlot = { key: '', z: 0, bounds: null, mesh: null, old: [], target: 0, building: 0 }
  private hirise: PatchSlot = { key: '', z: 0, bounds: null, mesh: null, old: [], target: 0, building: 0 }
  private showHirise = true
  private ctxWanted = false
  private baseLoading = true
  private busy = false
  // Where the 2D map's centre sits relative to the globe's centre, in pixels, and how far
  // the view is shifted towards it: 0 = planet centred, 1 = aligned with the 2D map.
  private localFocus = { x: 0, y: 0 }
  private focusMix = 0
  private focusLock: number | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private press: { x: number; y: number; moved: boolean; pinch: number; slop: number } | null = null
  private cleanup: (() => void)[] = []

  private container: HTMLElement
  private cb: GlobeCallbacks

  constructor(container: HTMLElement, cb: GlobeCallbacks, opts: { lowPower: boolean; baseTextureUrl: string }) {
    this.container = container
    this.cb = cb
    this.lowPower = opts.lowPower
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.lowPower ? 1.5 : 2))
    this.renderer.setClearColor(0x060607, 1)
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
    const canvas = this.renderer.domElement
    canvas.className = 'globe-canvas'
    canvas.tabIndex = 0
    canvas.setAttribute('role', 'application')
    canvas.setAttribute('aria-label', 'Interactive globe of Mars. Drag to rotate, scroll to zoom, arrow keys to move.')
    container.appendChild(canvas)

    this.overlayRoot = document.createElement('div')
    this.overlayRoot.className = 'globe-overlays'
    container.appendChild(this.overlayRoot)

    // A 1x1 placeholder in the mean colour of Mars until the mosaic arrives.
    const px = document.createElement('canvas')
    px.width = px.height = 1
    px.getContext('2d')!.fillStyle = '#8a5a3c'
    px.getContext('2d')!.fillRect(0, 0, 1, 1)
    this.sphereMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: rawTexture(px, 1) }, uLight: { value: LIGHT }, uFlat: this.flat },
      vertexShader: VERT,
      fragmentShader: FRAG_SPHERE,
    })
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), this.sphereMat))
    this.routeGroup.renderOrder = 5
    this.scene.add(this.routeGroup)

    this.buildLabels()
    this.loadBase(opts.baseTextureUrl)
    this.bindInput(canvas)

    const ro = new ResizeObserver(() => this.resize())
    ro.observe(container)
    this.cleanup.push(() => ro.disconnect())
    this.resize()
    this.tgt.alt = this.cur.alt = this.overviewAltitude()
    this.invalidate()
  }

  // ---------- public API ----------

  getView(): GlobeViewState {
    return this.viewOf(this.cur)
  }

  /** Tells the globe where the 2D map's centre is on screen, relative to its own centre. */
  setLocalFocus(dx: number, dy: number) {
    if (dx === this.localFocus.x && dy === this.localFocus.y) return
    this.localFocus = { x: dx, y: dy }
    this.dirty = true
    this.invalidate()
  }

  /** Holds the view aligned with the 2D map (true) or lets it follow the zoom again (false). */
  lockFocus(on: boolean) {
    this.focusLock = on ? 1 : null
    this.invalidate()
  }

  /** Aligns the view with the 2D map and resolves once it is there. */
  alignFocus(): Promise<void> {
    this.focusLock = 1
    if (document.hidden || !this.active) this.focusMix = 1
    this.dirty = true
    this.invalidate()
    const t0 = performance.now()
    return new Promise((resolve) => {
      const check = () => {
        if (this.focusMix > 0.999 || performance.now() - t0 > 900 || this.disposed) {
          this.focusMix = 1
          this.dirty = true
          this.invalidate()
          return resolve()
        }
        setTimeout(check, 30)
      }
      check()
    })
  }

  /** Jumps to a view without animation. With aligned, the view starts lined up with the 2D map. */
  setView(v: { lat: number; lon: number; zoom: number }, aligned = false) {
    this.cancelFly(false)
    if (aligned) {
      this.focusLock = 1
      this.focusMix = 1
    }
    const alt = altitudeForZoom(v.zoom, this.h, GLOBE_FOV)
    this.cur = { lat: v.lat, lon: wrapLon(v.lon), alt }
    this.tgt = { ...this.cur }
    this.fling = { lat: 0, lon: 0 }
    this.dirty = true
    this.updatePatches()
    this.invalidate()
  }

  /** Animates to a view. Resolves false when the user interrupts it. */
  flyTo(v: { lat: number; lon: number; zoom?: number; altitude?: number }, ms = 1600): Promise<boolean> {
    this.cancelFly(false)
    const a1 = v.altitude ?? altitudeForZoom(v.zoom ?? 5, this.h, GLOBE_FOV)
    const from = { lat: this.cur.lat, lon: this.cur.lon }
    const to = { lat: v.lat, lon: wrapLon(v.lon) }
    const ang = angularDistance(from, to)
    // Long hops rise first, so the planet stays readable on the way.
    const bump = Math.max(0, ang * 0.75 - Math.max(this.cur.alt, a1))
    const duration = ms * Math.min(1.6, 0.55 + ang / 2 + Math.abs(Math.log(a1 / this.cur.alt)) / 9)
    this.fling = { lat: 0, lon: 0 }
    // Start loading the imagery of the destination now, so it is there on arrival.
    this.updatePatches({ lat: to.lat, lon: to.lon, alt: a1 })
    // A hidden tab gets no animation frames: arrive at once instead of never.
    if (document.hidden || !this.active) {
      this.cur = { lat: to.lat, lon: to.lon, alt: a1 }
      this.tgt = { ...this.cur }
      this.dirty = true
      this.invalidate()
      return Promise.resolve(true)
    }
    return new Promise((done) => {
      this.fly = { from, to, a0: this.cur.alt, a1, bump, t0: performance.now(), ms: duration, done }
      this.invalidate()
    })
  }

  flyToOverview(center?: LatLon) {
    const c = center ?? { lat: this.cur.lat, lon: this.cur.lon }
    return this.flyTo({ lat: Math.max(-35, Math.min(35, c.lat)), lon: c.lon, altitude: this.overviewAltitude() })
  }

  setActive(active: boolean) {
    this.active = active
    this.container.classList.toggle('is-paused', !active)
    if (active) {
      this.dirty = true
      this.invalidate()
    } else {
      this.cancelFly(false)
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }

  /** Resolves when the detail patches for the current view are in place, or after a timeout. */
  whenSettled(timeoutMs: number): Promise<void> {
    const t0 = performance.now()
    this.updatePatches()
    return new Promise((resolve) => {
      const check = () => {
        const busy = this.viking.building > 0 || this.ctx.building > 0
        if (!busy || performance.now() - t0 > timeoutMs || this.disposed) return resolve()
        setTimeout(check, 60)
      }
      setTimeout(check, 30)
    })
  }

  setData(data: GlobeData) {
    if (this.showHirise !== data.hirise) {
      this.showHirise = data.hirise
      this.updatePatches()
    }
    for (const o of this.dataOverlays) o.el.remove()
    this.dataOverlays = []
    this.clearLines()

    const site = data.site
    const centre = { lat: (site[0] + site[2]) / 2, lon: (site[1] + site[3]) / 2 }
    this.siteSpanRad = ((site[2] - site[0]) * Math.PI) / 180

    // Study area frame, shown once it is more than a few pixels across.
    const corners = [
      { lat: site[0], lon: site[1] },
      { lat: site[0], lon: site[3] },
      { lat: site[2], lon: site[3] },
      { lat: site[2], lon: site[1] },
      { lat: site[0], lon: site[1] },
    ]
    this.frameLine = this.addLine(corners, 0xee8c60, 1.5, true)

    // Route: every leg follows the surface. Samples are metres apart, so the
    // densify step only matters if a leg ever has a long gap.
    let routeRad = 0
    data.legs.forEach((leg, n) => {
      const role = data.legRoles[n] ?? 'outbound'
      const path = densifyPath(leg, 0.002)
      for (let i = 1; i < leg.length; i++) routeRad += angularDistance(leg[i - 1], leg[i])
      this.routeGroup.add(this.makeLine(path, 0x05181c, 7, false, 0.7))
      // The return is dashed, as on the 2D map, so it reads where it shares ground with the way out.
      const top = this.makeLine(path, ROUTE_COLOR_HEX[role], 3, role === 'return', 1, RETURN_DASH)
      top.renderOrder = role === 'return' ? 7 : 6
      this.routeGroup.add(top)
    })
    this.routeRad = routeRad

    const close = (zoom: number) => this.spanPx(this.siteSpanRad, zoom) >= 70
    const mission = document.createElement('button')
    mission.type = 'button'
    mission.className = `gl-mission tone-${data.mission.tone}`
    mission.innerHTML = `<i></i><span><b></b><small></small></span>`
    mission.querySelector('b')!.textContent = data.mission.title
    mission.querySelector('small')!.textContent = data.mission.detail
    mission.addEventListener('click', () => this.cb.onMissionClick())
    const anchor = data.points[0] ?? centre
    this.addOverlay(this.dataOverlays, mission, anchor, (z) => !close(z))

    for (const note of data.notes) {
      const el = document.createElement('div')
      el.className = 'gl-pin gl-note'
      el.title = note.label
      el.innerHTML = `<div class="mk mk-note mk-note-${note.kind}"><i></i></div>`
      this.addOverlay(this.dataOverlays, el, note.at, close)
    }
    data.points.forEach((p, i) => {
      const el = document.createElement('div')
      el.className = 'gl-pin'
      el.innerHTML = i === 0 ? '<div class="mk mk-base"><span>H</span></div>' : `<div class="mk mk-target"><span>${i}</span></div>`
      this.addOverlay(this.dataOverlays, el, p, close)
    })
    if (data.rover) {
      const el = document.createElement('div')
      el.className = 'gl-pin gl-rover'
      el.innerHTML = '<div class="mk mk-rover"><i></i></div><span>Curiosity</span>'
      this.addOverlay(this.dataOverlays, el, data.rover, close)
    }
    if (data.inspect) {
      const el = document.createElement('div')
      el.className = 'gl-pin'
      el.innerHTML = '<div class="mk mk-inspect"></div>'
      this.addOverlay(this.dataOverlays, el, data.inspect, () => true)
    }
    this.dirty = true
    this.invalidate()
  }

  dispose() {
    this.disposed = true
    this.cancelFly(false)
    cancelAnimationFrame(this.raf)
    clearTimeout(this.idleTimer)
    for (const fn of this.cleanup) fn()
    this.clearLines()
    for (const slot of [this.viking, this.ctx, this.hirise]) {
      for (const m of [slot.mesh, ...slot.old]) if (m) this.dropMesh(m)
    }
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose()
    })
    ;(this.sphereMat.uniforms.uMap.value as THREE.Texture).dispose()
    this.sphereMat.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
    this.overlayRoot.remove()
  }

  // ---------- view maths ----------

  private viewOf(c: { lat: number; lon: number; alt: number }): GlobeViewState {
    return { lat: c.lat, lon: c.lon, zoom: zoomForAltitude(c.alt, this.h, GLOBE_FOV), altitudeKm: c.alt * MARS_RADIUS_KM }
  }

  /** Altitude at which the whole planet sits comfortably in the viewport. */
  private overviewAltitude(): number {
    const beta = Math.atan(0.74 * Math.tan((GLOBE_FOV / 2) * (Math.PI / 180)) * Math.min(1, this.w / this.h))
    return 1 / Math.sin(beta) - 1
  }

  /** On-screen size in pixels of an arc at the centre of the view. */
  private spanPx(rad: number, zoom: number): number {
    return rad / (Math.PI / (256 * 2 ** zoom))
  }

  private floorAltitude(center: LatLon): number {
    return altitudeForZoom(floorZoomAt(center), this.h, GLOBE_FOV)
  }

  private resize() {
    const r = this.container.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    // Keep the same ground extent when the viewport height changes.
    const zoom = this.h > 1 ? zoomForAltitude(this.cur.alt, this.h, GLOBE_FOV) : null
    const far = this.cur.alt > 0.9
    this.w = r.width
    this.h = r.height
    this.renderer.setSize(this.w, this.h, false)
    this.camera.aspect = this.w / this.h
    this.camera.updateProjectionMatrix()
    for (const m of this.lineMats) m.resolution.set(this.w, this.h)
    if (zoom != null && !far && !this.fly) {
      this.cur.alt = this.tgt.alt = altitudeForZoom(zoom, this.h, GLOBE_FOV)
    }
    this.dirty = true
    this.invalidate()
  }

  // ---------- render loop (on demand) ----------

  private invalidate() {
    if (!this.raf && this.active && !this.disposed) this.raf = requestAnimationFrame((t) => this.tick(t))
  }

  private tick(now: number) {
    this.raf = 0
    const dt = Math.min(64, now - (this.last || now))
    this.last = now
    let moving = false

    if (this.fly) {
      const f = this.fly
      const t = Math.min(1, (now - f.t0) / f.ms)
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      const p = slerp(f.from, f.to, e)
      const alt = Math.exp(Math.log(f.a0) + (Math.log(f.a1) - Math.log(f.a0)) * e) + f.bump * Math.sin(Math.PI * e)
      this.cur = { lat: p.lat, lon: p.lon, alt }
      this.tgt = { ...this.cur }
      moving = true
      if (t >= 1) {
        this.fly = null
        f.done(true)
      }
    } else {
      if (Math.abs(this.fling.lat) + Math.abs(this.fling.lon) > 1e-5 && this.pointers.size === 0) {
        this.tgt.lat += this.fling.lat * dt
        this.tgt.lon = wrapLon(this.tgt.lon + this.fling.lon * dt)
        const decay = Math.exp(-dt / 220)
        this.fling.lat *= decay
        this.fling.lon *= decay
        moving = true
      }
      this.tgt.lat = Math.max(-88, Math.min(88, this.tgt.lat))
      this.tgt.alt = Math.max(this.floorAltitude(this.tgt), Math.min(this.overviewAltitude() * 1.25, this.tgt.alt))
      const k = 1 - Math.exp(-dt / 70)
      const dLon = wrapLon(this.tgt.lon - this.cur.lon)
      const dLat = this.tgt.lat - this.cur.lat
      const dAlt = Math.log(this.tgt.alt / this.cur.alt)
      if (Math.abs(dLon) + Math.abs(dLat) > 1e-9 || Math.abs(dAlt) > 1e-6) {
        this.cur.lon = wrapLon(this.cur.lon + dLon * k)
        this.cur.lat += dLat * k
        this.cur.alt *= Math.exp(dAlt * k)
        moving = Math.abs(dLon) + Math.abs(dLat) > 1e-7 || Math.abs(dAlt) > 1e-4
        if (!moving) this.cur = { ...this.tgt }
        this.dirty = true
      }
    }

    // Slide the view towards the 2D map's centre on the final approach to Gale.
    {
      const z = zoomForAltitude(this.cur.alt, this.h, GLOBE_FOV)
      const natural = inBBox(this.cur, GALE_IMAGERY) ? smooth(9.4, 12.2, z) : 0
      const want = this.focusLock ?? natural
      if (Math.abs(want - this.focusMix) > 0.0015) {
        this.focusMix += (want - this.focusMix) * (1 - Math.exp(-dt / 110))
        moving = true
        this.dirty = true
      } else if (this.focusMix !== want) {
        this.focusMix = want
        this.dirty = true
      }
      // CTX fades in between zoom 5.4 and 5.9, matching what the 2D map shows from there on.
      if (this.ctxWanted) this.ctx.target = clamp01((z - 5.4) / 0.5)
    }

    const busy = this.baseLoading || this.viking.building + this.ctx.building + this.hirise.building > 0
    if (busy !== this.busy) {
      this.busy = busy
      this.cb.onLoading(busy)
    }

    // Patch cross-fades.
    for (const slot of [this.viking, this.ctx, this.hirise]) {
      if (slot.mesh) {
        const u = slot.mesh.material.uniforms.uOpacity
        if (u.value !== slot.target) {
          u.value = Math.abs(slot.target - u.value) < 0.02 ? slot.target : u.value + (slot.target - u.value) * (1 - Math.exp(-dt / 110))
          moving = true
        }
      }
      for (const m of slot.old) {
        const u = m.material.uniforms.uOpacity
        // An old patch leaves once the new one has faded in over it.
        const covered = !slot.mesh || slot.target === 0 || (slot.building === 0 && slot.mesh.material.uniforms.uOpacity.value > 0.97)
        if (covered) u.value -= dt / 220
        moving = true
      }
      const gone = slot.old.filter((m) => m.material.uniforms.uOpacity.value <= 0)
      for (const m of gone) this.dropMesh(m)
      slot.old = slot.old.filter((m) => !gone.includes(m))
    }

    if (moving || this.dirty) {
      this.dirty = false
      this.draw()
    }
    if (moving) {
      this.invalidate()
      // Keep refining imagery during long manual moves; a flight loads its destination up front.
      if (!this.fly && now - this.lastPatchUpdate > 450) this.updatePatches()
    } else {
      clearTimeout(this.idleTimer)
      this.idleTimer = window.setTimeout(() => this.updatePatches(), 180)
    }
  }

  private draw() {
    const c = this.cur
    const d = 1 + c.alt
    const u = latLonToUnit(c)
    this.camera.position.set(u[0] * d, u[1] * d, u[2] * d)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(0, 0, 0)
    this.camera.near = Math.max(c.alt * 0.2, 1e-5)
    this.camera.far = d + 1.2
    const ox = this.localFocus.x * this.focusMix
    const oy = this.localFocus.y * this.focusMix
    // An off-centre view of the same camera: the point below the camera lands at (ox, oy)
    // from the middle of the canvas, with the scale unchanged.
    if (Math.abs(ox) + Math.abs(oy) > 0.05) this.camera.setViewOffset(this.w, this.h, -ox, -oy, this.w, this.h)
    else this.camera.clearViewOffset()
    this.camera.updateProjectionMatrix()
    this.camera.updateMatrixWorld()

    const view = this.viewOf(c)
    // Shading fades out on approach so the handover to the flat 2D map is exact.
    this.flat.value = Math.max(0, Math.min(1, (view.zoom - 3.2) / 3))

    if (this.frameLine) this.frameLine.visible = this.spanPx(this.siteSpanRad, view.zoom) >= 10
    this.routeGroup.visible = this.spanPx(this.routeRad, view.zoom) >= 24

    this.renderer.render(this.scene, this.camera)
    this.placeOverlays(view.zoom, u, d)
    this.cb.onView(view)
  }

  // ---------- imagery ----------

  private async loadBase(url: string) {
    const img = await loadTile(url)
    if (this.disposed) return
    if (img) this.swapBase(rawTexture(toCanvas(img), this.anisotropy))
    const sharp = this.lowPower ? null : await loadTile(GLOBAL_4K)
    this.baseLoading = false
    if (this.disposed) return
    if (sharp) this.swapBase(rawTexture(toCanvas(sharp), this.anisotropy))
    this.invalidate()
  }

  private swapBase(t: THREE.Texture) {
    t.wrapS = THREE.RepeatWrapping
    const old = this.sphereMat.uniforms.uMap.value as THREE.Texture
    this.sphereMat.uniforms.uMap.value = t
    old.dispose()
    this.dirty = true
    this.invalidate()
  }

  /** Builds higher-resolution imagery around the centre of the view once the camera rests. */
  private updatePatches(at: { lat: number; lon: number; alt: number } = this.cur) {
    if (this.disposed || !this.active) return
    this.lastPatchUpdate = performance.now()
    const { zoom } = this.viewOf(at)
    const center = { lat: at.lat, lon: at.lon }
    const spanLat = (this.h * 180) / (256 * 2 ** zoom)
    const spanLon = (spanLat * (this.w / this.h)) / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180))

    // Viking mosaic: the global texture is zoom 3; add detail from zoom 4 to its native zoom 7.
    if (zoom > 3.3) {
      const z = Math.max(4, Math.min(7, Math.round(zoom)))
      this.requestPatch(this.viking, z, center, spanLat * 1.2, spanLon * 1.2, VIKING, 1)
    } else this.viking.target = 0

    // CTX mosaic of Gale crater, wherever the view reaches it. The 2D map shows it from
    // its minimum zoom, so the globe does too, with the same tiles.
    this.ctxWanted = zoom > 5.4 && viewTouches(center, spanLat, spanLon, GALE_IMAGERY)
    if (this.ctxWanted) {
      const z = Math.max(6, Math.min(12, Math.round(zoom)))
      this.requestPatch(this.ctx, z, center, spanLat * 1.2, spanLon * 1.2, CTX, 2, GALE_IMAGERY)
    } else this.ctx.target = 0

    // HiRISE mosaic of the roving site, up close, when the 2D map has that layer on.
    if (this.showHirise && zoom > 11.4 && viewTouches(center, spanLat, spanLon, HIRISE_BOUNDS)) {
      const z = Math.max(12, Math.min(14, Math.round(zoom)))
      this.requestPatch(this.hirise, z, center, spanLat * 1.15, spanLon * 1.15, HIRISE_TILE, 3, HIRISE_BOUNDS)
    } else this.hirise.target = 0
    this.invalidate()
  }

  private requestPatch(slot: PatchSlot, z: number, center: LatLon, spanLat: number, spanLon: number, url: typeof VIKING, order: number, only?: BBox) {
    slot.target = 1
    if (slot.bounds && slot.z === z) {
      // Still well inside the current patch: keep it.
      const b = slot.bounds
      const mLat = (b[2] - b[0]) * 0.22
      const mLon = (b[3] - b[1]) * 0.22
      if (center.lat > b[0] + mLat && center.lat < b[2] - mLat && center.lon > b[1] + mLon && center.lon < b[3] - mLon) return
    }
    const grid = tileGridFor(center, spanLat, spanLon, z, this.lowPower ? 5 : 7, this.lowPower ? 4 : 5)
    const key = `${z}/${grid.x0}/${grid.y0}/${grid.x1}/${grid.y1}`
    if (key === slot.key) return
    slot.key = key
    slot.building++
    let tex: THREE.CanvasTexture | null = null
    let lastUpload = 0
    stitch(grid, url, only, (canvas) => {
      if (this.disposed || slot.key !== key) return
      if (!tex) {
        // First tile: put the patch on the globe; the rest sharpen it as they arrive.
        tex = rawTexture(canvas, this.anisotropy)
        const mat = new THREE.ShaderMaterial({
          uniforms: { uMap: { value: tex }, uOpacity: { value: 0 }, uLight: { value: LIGHT }, uFlat: this.flat },
          vertexShader: VERT,
          fragmentShader: FRAG_PATCH,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        })
        const mesh = new THREE.Mesh(patchGeometry(grid.bounds), mat)
        mesh.renderOrder = order
        if (slot.mesh) slot.old.push(slot.mesh)
        slot.mesh = mesh
        slot.z = z
        slot.bounds = grid.bounds
        this.scene.add(mesh)
      } else if (performance.now() - lastUpload > 120) {
        tex.needsUpdate = true
      } else return
      lastUpload = performance.now()
      this.dirty = true
      this.invalidate()
    }).then(() => {
      slot.building--
      if (tex && !this.disposed) {
        tex.needsUpdate = true
        this.dirty = true
        this.invalidate()
      }
    })
  }

  private dropMesh(m: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>) {
    this.scene.remove(m)
    m.geometry.dispose()
    ;(m.material.uniforms.uMap.value as THREE.Texture).dispose()
    m.material.dispose()
  }

  // ---------- lines and overlays ----------

  private makeLine(path: LatLon[], color: number, width: number, dashed: boolean, opacity = 1, dash = FRAME_DASH): Line2 {
    const pos: number[] = []
    for (const p of path) pos.push(...latLonToUnit(p))
    const geo = new LineGeometry()
    geo.setPositions(pos)
    const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, dashed, dashSize: dash.size, gapSize: dash.gap })
    mat.resolution.set(this.w, this.h)
    const line = new Line2(geo, mat)
    if (dashed) line.computeLineDistances()
    line.renderOrder = 4
    this.lineMats.push(mat)
    this.lines.push(line)
    return line
  }

  private addLine(path: LatLon[], color: number, width: number, dashed: boolean): Line2 {
    const line = this.makeLine(densifyPath(path, 0.0005), color, width, dashed, 0.9)
    this.scene.add(line)
    return line
  }

  private clearLines() {
    for (const l of this.lines) {
      l.removeFromParent()
      l.geometry.dispose()
    }
    for (const m of this.lineMats) m.dispose()
    this.lines = []
    this.lineMats = []
    this.frameLine = null
  }

  private addOverlay(list: OverlayItem[], el: HTMLElement, at: LatLon, show: (zoom: number) => boolean) {
    this.overlayRoot.appendChild(el)
    list.push({ el, at, show })
  }

  private buildLabels() {
    for (const f of MARS_FEATURES) {
      const el = document.createElement('div')
      el.className = `gl-label band-${f.band}`
      el.textContent = f.name
      const show =
        f.band === 'global' ? (z: number) => z < 5.2 : f.band === 'regional' ? (z: number) => z > 2.6 && z < 9.5 : (z: number) => z >= 6.5 && z < 12
      this.addOverlay(this.overlays, el, f, show)
    }
  }

  private placeOverlays(zoom: number, camUnit: number[], d: number) {
    const v = new THREE.Vector3()
    for (const o of [...this.overlays, ...this.dataOverlays]) {
      const p = latLonToUnit(o.at)
      // In front of the horizon as seen from the camera.
      // The horizon is where the dot product equals 1 / d; keep a little clear of the limb.
      const facing = p[0] * camUnit[0] + p[1] * camUnit[1] + p[2] * camUnit[2] > 1 / d + 0.04 * (1 - 1 / d)
      if (!facing || !o.show(zoom)) {
        o.el.style.display = 'none'
        continue
      }
      v.set(p[0], p[1], p[2]).project(this.camera)
      const x = (v.x * 0.5 + 0.5) * this.w
      const y = (-v.y * 0.5 + 0.5) * this.h
      if (x < -80 || y < -40 || x > this.w + 80 || y > this.h + 40) {
        o.el.style.display = 'none'
        continue
      }
      o.el.style.display = ''
      o.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
    }
  }

  // ---------- input ----------

  private pick(clientX: number, clientY: number): LatLon | null {
    const r = this.container.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hit = new THREE.Vector3()
    return ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), hit) ? unitToLatLon([hit.x, hit.y, hit.z]) : null
  }

  private cancelFly(notifyUser: boolean) {
    if (!this.fly) return
    const f = this.fly
    this.fly = null
    this.tgt = { ...this.cur }
    f.done(!notifyUser)
  }

  /** Ground angle in degrees that one pixel of drag should move the view. */
  private degPerPx(): number {
    const rad = (2 * this.cur.alt * Math.tan((GLOBE_FOV / 2) * (Math.PI / 180))) / this.h
    return (Math.min(rad, 0.0042) * 180) / Math.PI
  }

  private zoomBy(factor: number, about?: LatLon | null) {
    const floor = this.floorAltitude(this.tgt)
    const next = this.tgt.alt * factor
    if (factor < 1 && this.tgt.alt <= floor * 1.002) {
      const now = performance.now()
      if (now - this.floorNotified > 900) {
        this.floorNotified = now
        this.cb.onFloor({ lat: this.tgt.lat, lon: this.tgt.lon }, floorZoomAt(this.tgt))
      }
      return
    }
    if (about && factor < 1) {
      // Zoom towards the point under the cursor, as map users expect.
      const k = Math.min(1, (1 - Math.max(next, floor) / this.tgt.alt) * 0.9)
      const c = slerp(this.tgt, about, k)
      this.tgt.lat = c.lat
      this.tgt.lon = c.lon
    }
    this.tgt.alt = next
    this.invalidate()
  }

  private bindInput(canvas: HTMLCanvasElement) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      canvas.addEventListener(type, fn as EventListener, opts)
      this.cleanup.push(() => canvas.removeEventListener(type, fn as EventListener, opts))
    }
    let lastMove = 0
    let hoverRaf = 0

    on('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      this.cancelFly(true)
      this.fling = { lat: 0, lon: 0 }
      if (this.pointers.size === 1) this.press = { x: e.clientX, y: e.clientY, moved: false, pinch: 0, slop: e.pointerType === 'touch' ? 10 : 5 }
      else if (this.pointers.size === 2 && this.press) {
        const [a, b] = [...this.pointers.values()]
        this.press.pinch = Math.hypot(a.x - b.x, a.y - b.y)
        this.press.moved = true
      }
    })

    on('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId)
      if (!prev) {
        // Hover readout, at most once per frame.
        if (!hoverRaf) {
          const { clientX, clientY } = e
          hoverRaf = requestAnimationFrame(() => {
            hoverRaf = 0
            this.cb.onHover(this.pick(clientX, clientY))
          })
        }
        return
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (!this.press) return
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (this.press.pinch > 0 && dist > 0) this.zoomBy(this.press.pinch / dist)
        this.press.pinch = dist
        return
      }
      const dx = e.clientX - prev.x
      const dy = e.clientY - prev.y
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > this.press.slop) this.press.moved = true
      if (!this.press.moved) return
      const deg = this.degPerPx()
      const dLat = dy * deg
      const dLon = (-dx * deg) / Math.max(0.25, Math.cos((this.tgt.lat * Math.PI) / 180))
      this.tgt.lat += dLat
      this.tgt.lon = wrapLon(this.tgt.lon + dLon)
      const now = performance.now()
      const dt = Math.max(8, now - lastMove)
      lastMove = now
      this.fling = { lat: (dLat / dt) * 0.22, lon: (dLon / dt) * 0.22 }
      this.invalidate()
    })

    const release = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId)
      if (!had || this.pointers.size > 0) return
      const press = this.press
      this.press = null
      if (press && !press.moved) {
        this.fling = { lat: 0, lon: 0 }
        const p = this.pick(e.clientX, e.clientY)
        if (p) this.cb.onPick(p)
      } else if (performance.now() - lastMove > 90) this.fling = { lat: 0, lon: 0 }
      this.invalidate()
    }
    on('pointerup', release)
    on('pointercancel', release)
    on('pointerleave', () => this.cb.onHover(null))

    on(
      'wheel',
      (e) => {
        e.preventDefault()
        this.cancelFly(true)
        const delta = Math.max(-120, Math.min(120, e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY))
        this.zoomBy(Math.exp(delta * 0.0022), this.pick(e.clientX, e.clientY))
      },
      { passive: false },
    )

    on('dblclick', (e) => {
      const p = this.pick(e.clientX, e.clientY)
      if (p) this.flyTo({ ...p, altitude: Math.max(this.floorAltitude(p), this.cur.alt * 0.35) }, 700)
    })

    on('keydown', (e) => {
      const step = this.degPerPx() * 60
      if (e.key === 'ArrowLeft') this.tgt.lon = wrapLon(this.tgt.lon - step)
      else if (e.key === 'ArrowRight') this.tgt.lon = wrapLon(this.tgt.lon + step)
      else if (e.key === 'ArrowUp') this.tgt.lat += step
      else if (e.key === 'ArrowDown') this.tgt.lat -= step
      else if (e.key === '+' || e.key === '=') this.zoomBy(0.7)
      else if (e.key === '-' || e.key === '_') this.zoomBy(1 / 0.7)
      else return
      e.preventDefault()
      this.cancelFly(true)
      this.invalidate()
    })
  }

  /** Position of a geographic point in the browser window, in CSS pixels. */
  screenOf(p: LatLon): { x: number; y: number } {
    const u = latLonToUnit(p)
    const v = new THREE.Vector3(u[0], u[1], u[2]).project(this.camera)
    const r = this.container.getBoundingClientRect()
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height }
  }

  /** Zoom controls from outside the canvas. */
  zoomStep(direction: 1 | -1) {
    this.cancelFly(true)
    this.zoomBy(direction > 0 ? 0.6 : 1 / 0.6)
  }
}
