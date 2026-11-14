import { useId, useState, type ReactNode } from 'react'

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
  children: ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  const id = useId()
  const shown = props.fixed || open
  return (
    <section className="sec">
      {props.fixed ? (
        <header className="sec-head">
          <h2>{props.title}</h2>
          {props.aside && <span className="sec-aside">{props.aside}</span>}
        </header>
      ) : (
        <button type="button" className="sec-head sec-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <h2>{props.title}</h2>
          {props.aside && <span className="sec-aside">{props.aside}</span>}
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
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
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
        >
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
