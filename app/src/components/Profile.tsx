import { useMemo, useRef } from 'react'
import type { RouteSample } from '../lib/router'
import { slopeClass } from '../lib/model'

interface Props {
  samples: RouteSample[]
  /** Distances (m) where a new leg starts, for stop markers. */
  stops: number[]
  onCursor: (s: RouteSample | null) => void
}

const W = 320
const H = 120
const PAD = { l: 38, r: 8, t: 8, b: 18 }

/** Elevation profile of the planned route, coloured by terrain slope class. */
export default function Profile({ samples, stops, onCursor }: Props) {
  const svg = useRef<SVGSVGElement>(null)

  const geo = useMemo(() => {
    const total = samples[samples.length - 1].dist || 1
    let lo = Infinity
    let hi = -Infinity
    for (const s of samples) {
      if (s.elevation < lo) lo = s.elevation
      if (s.elevation > hi) hi = s.elevation
    }
    const span = Math.max(hi - lo, 10)
    const x = (d: number) => PAD.l + (d / total) * (W - PAD.l - PAD.r)
    const y = (z: number) => PAD.t + (1 - (z - lo) / span) * (H - PAD.t - PAD.b)
    // One segment per run of equal slope class.
    const segs: { d: string; color: string }[] = []
    let cur = ''
    let curColor = ''
    samples.forEach((s, i) => {
      const cls = slopeClass(s.slope)
      const color = `rgb(${cls.rgb.join(',')})`
      const pt = `${x(s.dist).toFixed(1)},${y(s.elevation).toFixed(1)}`
      if (color !== curColor) {
        if (cur) segs.push({ d: `${cur} L${pt}`, color: curColor })
        cur = `M${pt}`
        curColor = color
      } else cur += ` L${pt}`
      if (i === samples.length - 1 && cur) segs.push({ d: cur, color: curColor })
    })
    const area =
      `M${x(0)},${H - PAD.b} ` +
      samples.map((s) => `L${x(s.dist).toFixed(1)},${y(s.elevation).toFixed(1)}`).join(' ') +
      ` L${x(total)},${H - PAD.b} Z`
    return { total, lo, hi, x, y, segs, area }
  }, [samples])

  const move = (e: React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const d = ((px - PAD.l) / (W - PAD.l - PAD.r)) * geo.total
    if (d < 0 || d > geo.total) return onCursor(null)
    // Binary search for the nearest sample by distance.
    let a = 0
    let b = samples.length - 1
    while (b - a > 1) {
      const m = (a + b) >> 1
      if (samples[m].dist < d) a = m
      else b = m
    }
    onCursor(samples[b])
  }

  return (
    <svg
      ref={svg}
      className="profile"
      viewBox={`0 0 ${W} ${H}`}
      onMouseMove={move}
      onMouseLeave={() => onCursor(null)}
      role="img"
      aria-label="Elevation profile of the planned route"
    >
      <path d={geo.area} className="profile-area" />
      {stops.map((d, i) => (
        <line key={i} x1={geo.x(d)} x2={geo.x(d)} y1={PAD.t} y2={H - PAD.b} className="profile-stop" />
      ))}
      {geo.segs.map((s, i) => (
        <path key={i} d={s.d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
      ))}
      <text x={PAD.l - 4} y={PAD.t + 8} className="profile-label" textAnchor="end">
        {Math.round(geo.hi)} m
      </text>
      <text x={PAD.l - 4} y={H - PAD.b} className="profile-label" textAnchor="end">
        {Math.round(geo.lo)} m
      </text>
      <text x={PAD.l} y={H - 4} className="profile-label">
        0
      </text>
      <text x={W - PAD.r} y={H - 4} className="profile-label" textAnchor="end">
        {(geo.total / 1000).toFixed(2)} km
      </text>
    </svg>
  )
}
