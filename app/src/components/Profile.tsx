import { useEffect, useMemo, useRef, useState } from 'react'
import type { RouteSample } from '../lib/router'
import { slopeClass } from '../lib/model'

interface Props {
  samples: RouteSample[]
  /** Distances (m) where each leg after the first starts, i.e. arrival at targets 1, 2, … */
  stops: number[]
  /** Whether the route ends back at the habitat. */
  roundTrip: boolean
  onCursor: (s: RouteSample | null) => void
}

const PAD = { l: 52, r: 14, t: 20, b: 22 }

/** Elevation profile of the planned route, coloured by terrain slope class. Fills its container. */
export default function Profile({ samples, stops, roundTrip, onCursor }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 600, h: 120 })
  const [hoverX, setHoverX] = useState<number | null>(null)

  useEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w: W, h: H } = size

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
    // One path per run of equal slope class.
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
    // Distance ticks: a round step that gives 4 to 8 labels.
    const step = [50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => total / s <= 8) ?? 10000
    const ticks: number[] = []
    for (let d = step; d < total; d += step) if (x(total) - x(d) > 72) ticks.push(d)
    return { total, lo, hi, x, y, segs, area, ticks }
  }, [samples, W, H])

  const move = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect()
    const px = e.clientX - r.left
    const d = ((px - PAD.l) / (W - PAD.l - PAD.r)) * geo.total
    if (d < 0 || d > geo.total) {
      setHoverX(null)
      return onCursor(null)
    }
    // Binary search for the nearest sample by distance.
    let a = 0
    let b = samples.length - 1
    while (b - a > 1) {
      const m = (a + b) >> 1
      if (samples[m].dist < d) a = m
      else b = m
    }
    setHoverX(geo.x(samples[b].dist))
    onCursor(samples[b])
  }
  const leave = () => {
    setHoverX(null)
    onCursor(null)
  }

  const fmtTick = (d: number) => (geo.total >= 2000 ? `${(d / 1000).toFixed(d % 1000 === 0 ? 0 : 1)} km` : `${d} m`)
  const marks = [
    { d: 0, label: 'H' },
    ...stops.map((d, i) => ({ d, label: String(i + 1) })),
    ...(roundTrip ? [{ d: geo.total, label: 'H' }] : [{ d: geo.total, label: String(stops.length + 1) }]),
  ]

  return (
    <div ref={wrap} className="profile-wrap" onPointerMove={move} onPointerLeave={leave}>
      <svg className="profile" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Elevation profile of the planned route">
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="profile-axis" />
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t} y2={PAD.t} className="profile-grid" />
        <path d={geo.area} className="profile-area" />
        {marks.map((m, i) => (
          <g key={i}>
            <line x1={geo.x(m.d)} x2={geo.x(m.d)} y1={PAD.t} y2={H - PAD.b} className="profile-stop" />
            <text x={geo.x(m.d)} y={PAD.t - 7} textAnchor={i === 0 ? 'start' : i === marks.length - 1 ? 'end' : 'middle'} className={`profile-mark ${m.label === 'H' ? 'is-base' : ''}`}>
              {m.label}
            </text>
          </g>
        ))}
        {geo.segs.map((s, i) => (
          <path key={i} d={s.d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {hoverX != null && <line x1={hoverX} x2={hoverX} y1={PAD.t} y2={H - PAD.b} className="profile-hover" />}
        <text x={PAD.l - 8} y={PAD.t + 4} className="profile-label" textAnchor="end">
          {Math.round(geo.hi)} m
        </text>
        <text x={PAD.l - 8} y={H - PAD.b} className="profile-label" textAnchor="end">
          {Math.round(geo.lo)} m
        </text>
        {geo.ticks.map((d) => (
          <text key={d} x={geo.x(d)} y={H - 6} className="profile-label" textAnchor="middle">
            {fmtTick(d)}
          </text>
        ))}
        <text x={W - PAD.r} y={H - 6} className="profile-label" textAnchor="end">
          {(geo.total / 1000).toFixed(2)} km
        </text>
      </svg>
    </div>
  )
}
