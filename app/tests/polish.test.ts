// Stability and accessibility of the interface (Phase 5.4A): the document never
// scrolls, a calculation is called a calculation, secondary text meets WCAG AA,
// warnings are not cut short, and touch targets are large enough. These read the
// sources and the style sheets, so a change that undoes one of them fails here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8')
const tokens = read('index.css')
const mission = read('styles/mission.css')
const mobile = read('styles/mobile.css')
const panel = read('components/MissionPanel.tsx')
const sheet = read('components/MobileSheet.tsx')
const dock = read('components/BottomDock.tsx')
const app = read('App.tsx')
const hook = read('hooks/usePlan.ts')
const status = read('lib/missionStatus.ts')

const token = (name: string) => tokens.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1]
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
/** `fg` at opacity `a` over `bg`. */
const over = (fg: string, bg: string, a: number) => {
  const f = rgb(fg)
  const b = rgb(bg)
  return `#${f.map((v, i) => Math.round(v * a + b[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`
}
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 2 contrast ratio. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const rule = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`)
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('the document does not scroll', () => {
  it('keeps screen-reader text inside the box it labels', () => {
    // Absolutely positioned text is placed against its nearest positioned ancestor. Without one
    // inside the scrolling panel it lands on the document and makes the page scrollable.
    expect(rule(mission, '.sr-only')).toContain('position: absolute')
    expect(rule(mission, '.cmp th')).toContain('position: relative')
    // Every use of it in the panel sits in a table header cell of the comparison.
    const uses = [...panel.matchAll(/<(\w+)[^<>]*>\s*(?:\{[^{}]*\}\s*)*\{?[^<>{}]*<span className="sr-only">/g)]
    expect(panel.match(/className="sr-only"/g)).toHaveLength(2)
    expect(uses.length).toBeGreaterThan(0)
    const cmp = panel.slice(panel.indexOf('function ModeComparison'), panel.indexOf('/** Signed saving'))
    expect(cmp.match(/className="sr-only"/g)).toHaveLength(2)
    for (const m of cmp.matchAll(/className="sr-only"/g)) {
      const before = cmp.slice(0, m.index)
      expect(before.lastIndexOf('<th')).toBeGreaterThan(before.lastIndexOf('</th>'))
    }
  })

  it('is still read by screen readers: clipped, not removed', () => {
    const sr = rule(mission, '.sr-only')
    expect(sr).toContain('clip-path: inset(50%)')
    expect(sr).not.toMatch(/display: none|visibility: hidden/)
  })

  it('also refuses to scroll at the root, as a second line of defence', () => {
    expect(tokens).toMatch(/html \{\s*overflow: hidden;/)
    expect(tokens).toMatch(/body \{[^}]*overflow: hidden;/)
  })

  it('leaves scrolling to the mission panel and the sheet', () => {
    expect(read('styles/mobile.css')).toMatch(/\.sheet-body \{[^}]*overflow-y: auto;/)
  })
})

describe('a calculation in progress', () => {
  it('is called CALCULATING, in the panel, the sheet and on the globe', () => {
    expect(status).toMatch(/statusTitle = \(s: PlanState\) => \(isCalculating\(s\) \? 'CALCULATING' : VERDICT_TITLE\[verdictOf\(s\)\]\)/)
    expect(panel).toContain('<strong>{statusTitle(s)}</strong>')
    expect(sheet).toContain('{statusTitle(plan)}')
    // The globe's title is built with the same word, in the mission status module the app calls.
    expect(status).toContain('`EVA plan · ${statusTitle(plan)}`')
    expect(app).toContain('missionSummary(plan, display)')
    // The old wording is not used for the headline anywhere.
    for (const src of [sheet, app]) expect(src).not.toContain('VERDICT_TITLE[verdict]')
  })

  it('only changes the word: the verdict itself is computed as before', () => {
    expect(status).toContain("if (!s.plan) return 'standby'")
    expect(status).toContain("return s.verdict === 'go' && s.go ? 'go' : s.verdict === 'unverified' ? 'unverified' : 'nogo'")
    expect(status).toMatch(/isCalculating = \(s: PlanState\) => s\.pending && verdictOf\(s\) === 'standby'/)
  })

  it('is announced as busy', () => {
    expect(panel).toMatch(/role="status" aria-live="polite" aria-busy=\{s\.pending\}/)
    expect(sheet).toContain('aria-busy={plan.pending}')
    expect(dock).toMatch(/p\.plan\.pending \? \(\s*<p className="dock-empty" role="status" aria-busy="true">/)
    expect(dock).toContain('Calculating the route.')
  })

  it('never shows a result computed for other inputs as the current one', () => {
    const fresh = hook.slice(hook.indexOf('const fresh ='), hook.indexOf('const plan: Plan | null'))
    for (const field of ['points === points', 'returnDistanceM === returnDistanceM', 'roundTrip === roundTrip', 'massKg === massKg']) {
      expect(fresh).toContain(`result.input.${field}`)
    }
  })
})

describe('text contrast', () => {
  const surfaces: Record<string, string> = {
    bg: token('bg'),
    surface: token('surface'),
    'surface-2': token('surface-2'),
    'surface-3': token('surface-3'),
  }
  // Tinted surfaces that carry text: the selected card and table column, and the status washes.
  const tinted: Record<string, string> = {
    'selected card': over(token('accent'), surfaces['surface-2'], 0.13),
    'selected column': over(token('accent'), surfaces.surface, 0.13),
    'NO-GO status': over(token('nogo'), surfaces.surface, 0.06),
    'UNVERIFIED status': over(token('warn'), surfaces.surface, 0.07),
    'NO ROUTE status': over(token('noroute'), surfaces.surface, 0.05),
  }
  const all = { ...surfaces, ...tinted }

  it('the washes assumed here are the ones in the style sheets', () => {
    expect(tokens).toContain('--accent-wash: rgb(212 104 60 / 0.13);')
    expect(token('accent')).toBe('#d4683c')
    expect(mission).toContain('background: rgb(229 80 79 / 0.06);')
    expect(mission).toContain('background: rgb(224 178 70 / 0.07);')
    expect(mission).toContain('background: rgb(159 176 195 / 0.05);')
  })

  it.each(['text', 'text-2', 'text-3', 'go', 'warn', 'noroute', 'accent-hi', 'nogo-text'])('--%s is at least 4.5:1 on every surface', (name) => {
    for (const [where, bg] of Object.entries(all)) expect(contrast(token(name), bg), `${name} on ${where}`).toBeGreaterThanOrEqual(4.5)
  })

  it('uses the lighter red for small red text, and keeps the brand red for large text and marks', () => {
    // --nogo itself is below 4.5:1 on the tinted surfaces, which is why small text does not use it.
    expect(contrast(token('nogo'), tinted['selected card'])).toBeLessThan(4.5)
    expect(contrast(token('nogo'), surfaces.surface)).toBeGreaterThanOrEqual(3)
    for (const css of [mission, read('styles/base.css'), read('styles/map.css'), read('styles/globe.css')]) {
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2].replace(/(border|background|outline)[^;]*;/g, '')
        if (/(^|[\s;])color: var\(--nogo\);/.test(body)) expect(m[1].trim()).toMatch(/\.m-status-nogo strong$/)
      }
    }
    expect(token('nogo')).toBe('#e5504f')
  })
})

describe('warnings are not cut short', () => {
  it('lets a NO-GO reason wrap and keeps its figures on one line', () => {
    const span = rule(mission, '.m-fail span')
    expect(span).not.toMatch(/ellipsis|nowrap|overflow: hidden/)
    expect(rule(mission, '.m-fail code')).toContain('white-space: nowrap')
  })

  it('keeps a measurement, its unit and its limit together in the constraints', () => {
    const code = rule(mission, '.limit-row code')
    expect(code).toContain('white-space: nowrap')
    expect(code).toContain('flex: none')
    expect(rule(mission, '.limit-row span')).toContain('min-width: 0')
  })
})

describe('the constraints section', () => {
  const section = panel.slice(panel.indexOf('title="Mission constraints"'), panel.indexOf('<Section title="Route telemetry"'))
  const fold = section.slice(section.indexOf('<details'))

  it('keeps measurements, limits, results and the essential warning in view', () => {
    const visible = section.slice(0, section.indexOf('<details'))
    for (const part of ['Route feasibility', 'return-limit', 'className="limits"', 'limit-margin', 'limit-advice', 'No value is validated or certified as safe for Mars']) {
      expect(visible).toContain(part)
    }
    expect(visible).toContain('not an official safety standard for EVAs on Mars')
    expect(visible).toContain('not a guarantee of a safe return')
  })

  it('moves the long explanation into a labelled fold, with every caveat intact', () => {
    expect(section.match(/<details/g)).toHaveLength(1)
    expect(fold).toContain('<summary>About these limits</summary>')
    for (const caveat of [
      'MARSCOPE planning assumptions that can be changed in the model',
      'None is an official',
      'NASA EVA-EXP-0075',
      'Artemis lunar EVA',
      'one hour of secondary oxygen',
      'one and the same way back meets both limits',
      'not a guarantee of a safe return on Mars',
      'they are not straightened, which errs on the careful side',
    ]) {
      expect(fold.replace(/\s+/g, ' ')).toContain(caveat)
    }
  })
})

describe('touch targets', () => {
  const px = (decl: string, prop: string) => Number(decl.match(new RegExp(`${prop}: (\\d+)px`))![1])

  it('are at least 40 px on the mobile layout', () => {
    expect(px(rule(mobile, '.is-mobile .seg button'), 'min-height')).toBeGreaterThanOrEqual(40)
    expect(px(rule(mobile, '.is-mobile .btn-sm'), 'min-height')).toBeGreaterThanOrEqual(40)
    const icon = rule(mobile, '.is-mobile .icon-btn')
    expect(px(icon, 'width')).toBeGreaterThanOrEqual(40)
    expect(px(icon, 'height')).toBeGreaterThanOrEqual(40)
    expect(px(rule(mobile, '.is-mobile .topbar-tools .icon-btn'), 'width')).toBeGreaterThanOrEqual(40)
    expect(px(rule(mobile, '.sheet-tabs button'), 'min-height')).toBeGreaterThanOrEqual(40)
    expect(px(rule(mobile, '.is-mobile .sec-head'), 'min-height')).toBeGreaterThanOrEqual(40)
    expect(px(rule(mission, '.is-mobile .mode-card'), 'min-height')).toBeGreaterThanOrEqual(40)
    expect(px(rule(mission, '.is-mobile .return-limit .btn'), 'min-height')).toBeGreaterThanOrEqual(40)
    // The top bar is tall enough to hold them.
    expect(px(rule(mobile, '.is-mobile .topbar'), 'height')).toBeGreaterThanOrEqual(42)
  })

  it('are at least 40 px on any touch screen that keeps the desktop layout', () => {
    const coarse = mobile.slice(mobile.lastIndexOf('@media (pointer: coarse)'))
    for (const sel of ['.seg button', '.btn-sm', '.zoom button', '.rail-btn', '.icon-btn']) expect(coarse).toContain(sel)
    expect(coarse).toMatch(/min-height: 40px/)
    expect(coarse).toMatch(/width: 40px;\s*height: 40px;/)
    expect(coarse).toContain('--topbar-h: 48px')
  })

  it('give a checkpoint pin a 42 px touch area without changing how it looks', () => {
    for (const css of [mobile.slice(0, mobile.lastIndexOf('@media (pointer: coarse)')), mobile.slice(mobile.lastIndexOf('@media (pointer: coarse)'))]) {
      expect(css).toMatch(/\.mk-base::after,\s*(\.is-mobile )?\.mk-target::after \{\s*content: '';\s*position: absolute;\s*inset: -6px;/)
    }
    // 30 px pin plus 6 px on every side.
    expect(read('components/MapView.tsx')).toContain('icon: icon(html, 30)')
  })
})
