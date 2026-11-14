import { useId, useState, type ReactNode } from 'react'

const ICONS = {
  layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 12.5l9 5 9-5M3 17l9 5 9-5',
  environment: 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  context: 'M4 18c3-9 6 3 9-6s4-4 7-7M4 18h.01M20 5h.01M9 13.5h.01',
  sources: 'M5 4h10l4 4v12H5V4ZM14 4v5h5M8 13h8M8 17h6',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.9M12 17h.01',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  close: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  expand: 'M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18',
  target: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM12 1.5V4M12 20v2.5M1.5 12H4M20 12h2.5',
  enter: 'M5 12h14M13 6l6 6-6 6',
  profile: 'M3 18 8 9l4 5 3-7 6 11H3Z',
  point: 'M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10ZM12 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
} as const

export type IconName = keyof typeof ICONS

/** 24 px stroke icon. */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  )
}

/** Accessible on/off switch. */
export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className="switch"
      onClick={() => props.onChange(!props.checked)}
    >
      <i />
    </button>
  )
}

/** Collapsible panel section. */
export function Section(props: {
  title: string
  aside?: ReactNode
  defaultOpen?: boolean
  /** When set, the section is always open and has no toggle. */
  fixed?: boolean
  /** Controlled open state (optional). */
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  const [inner, setInner] = useState(props.defaultOpen ?? true)
  const id = useId()
  const open = props.open ?? inner
  const toggle = () => {
    setInner(!open)
    props.onToggle?.(!open)
  }
  const shown = props.fixed || open
  return (
    <section className="sec">
      {props.fixed ? (
        <header className="sec-head">
          <h2>{props.title}</h2>
          {props.aside && <span className="sec-aside">{props.aside}</span>}
        </header>
      ) : (
        <button type="button" className="sec-head sec-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
          <h2>{props.title}</h2>
          {props.aside && <span className="sec-aside">{props.aside}</span>}
          <span className="chev">
            <Icon name="chevronDown" size={14} />
          </span>
        </button>
      )}
      {shown && (
        <div className="sec-body" id={id}>
          {props.children}
        </div>
      )}
    </section>
  )
}

/** Two- or three-way segmented control. */
export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={props.value === o.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Label and value pair in monospace, for telemetry-style readouts. */
export function Datum(props: { label: string; children: ReactNode }) {
  return (
    <div className="datum">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  )
}
