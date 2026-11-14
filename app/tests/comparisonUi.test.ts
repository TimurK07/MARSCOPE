// The route comparison in the interface: the priority cards, the comparison
// table and the mobile sheet. These read the sources and the stylesheets, so a
// change that drops a verdict, hides one behind a fold or shrinks a touch
// target fails here.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8')
const panel = read('components/MissionPanel.tsx')
const sheet = read('components/MobileSheet.tsx')
const app = read('App.tsx')
const mission = read('styles/mission.css')
const mobile = read('styles/mobile.css')

/** The declarations of one rule, by its exact selector. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('the priority cards', () => {
  const cards = panel.slice(panel.indexOf('export function ModeCards'), panel.indexOf('function ModeComparison'))

  it('replace the small selector in the mission head', () => {
    const head = panel.slice(panel.indexOf('export function MissionHead'), panel.indexOf('export default function MissionPanel'))
    expect(head).toContain('<ModeCards plan={s} />')
    expect(panel).not.toContain('Segmented')
    expect(panel).not.toContain('m-mode"')
  })

  it('are buttons that say which one is selected and switch the mode', () => {
    expect(cards).toContain('type="button"')
    expect(cards).toContain('aria-pressed={c.selected}')
    expect(cards).toContain('onClick={() => s.setMode(c.mode)}')
    expect(cards).toContain('role="group"')
  })

  it('show name, verdict, model walking time, differences and objective', () => {
    for (const part of ['mc-name', 'mc-obj', 'mc-verdict', 'mc-figs', 'c.timeLabel', 'c.timeDelta', 'mc-detail']) expect(cards).toContain(part)
    // Built from the comparison module and the pending flag, so a result that has not arrived is shown as such.
    expect(cards).toContain('modeCards(s.comparison, s.mode, s.pending)')
  })

  it('only change the mode: checkpoints and the map view are not touched', () => {
    expect(cards).not.toMatch(/setPoints|reveal|fitBounds|flyTo|setView/)
  })

  it('have a colour for every verdict, and a highlight for the selected one', () => {
    for (const v of ['go', 'nogo', 'unverified', 'noroute']) expect(mission).toContain(`.mc-verdict.v-${v}`)
    expect(rule(mission, '.mode-card.is-on')).toMatch(/border-color: var\(--accent\)/)
  })

  it('are large enough to tap, and do not animate', () => {
    const min = Number(rule(mission, '.mode-card').match(/min-height: (\d+)px/)![1])
    expect(min).toBeGreaterThanOrEqual(40)
    expect(Number(rule(mission, '.is-mobile .mode-card').match(/min-height: (\d+)px/)![1])).toBeGreaterThanOrEqual(40)
    const styles = mission.slice(mission.indexOf('.m-modes {'), mission.indexOf('.sr-only {'))
    expect(styles).not.toMatch(/transition|animation|@keyframes/)
    // Works without hover: nothing is revealed only on hover.
    expect(styles).not.toMatch(/:hover[^{]*\{[^}]*(display|visibility|opacity)/)
  })

  it('never clip a label: full-width rows whose lines may wrap', () => {
    expect(rule(mission, '.mode-cards')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(rule(mission, '.mc-top')).toContain('flex-wrap: wrap')
    expect(rule(mission, '.mc-figs')).toContain('flex-wrap: wrap')
    const styles = mission.slice(mission.indexOf('.m-modes {'), mission.indexOf('/* short desktop windows'))
    expect(styles).not.toMatch(/text-overflow|white-space: nowrap|overflow: hidden/)
  })
})

describe('the mission head on a short desktop window', () => {
  const short = mission.slice(mission.indexOf('@media (max-height: 700px)'), mission.indexOf('.sr-only {'))

  it('gets smaller without dropping the verdict, the figures or the cards', () => {
    expect(short).toContain('.ws:not(.is-mobile) .m-status strong')
    expect(short).not.toMatch(/display: none|visibility: hidden/)
    // Nothing about the cards changes here: their rows stay tap-sized.
    expect(short).not.toContain('.mode-card')
  })

  it('says on the cards that the Cautious weighting is not a safety rating', () => {
    expect(panel).toContain('The Cautious weighting is a heuristic, not a safety rating.')
  })

  it('lists every objective in full under "About these figures"', () => {
    const about = panel.slice(panel.indexOf('<summary>About these figures</summary>'))
    expect(about).toContain('OBJECTIVE[m.id].full')
  })
})

describe('the comparison table', () => {
  const cmp = panel.slice(panel.indexOf('function ModeComparison'), panel.indexOf('/** Signed saving'))

  it('keeps every mission verdict above the folds', () => {
    const status = cmp.indexOf('cmp-status')
    const fold = cmp.indexOf('<details')
    expect(status).toBeGreaterThan(0)
    expect(fold).toBeGreaterThan(status)
    expect(cmp.slice(fold)).not.toMatch(/verdicts|VERDICT/)
    // The section itself is open by default.
    expect(panel).toMatch(/<Section title="Compare route priorities" aside/)
  })

  it('has "More" and "About these figures" as folds that need no hover', () => {
    expect(cmp).toMatch(/<summary>More<\/summary>/)
    expect(cmp).toMatch(/<summary>About these figures<\/summary>/)
    expect(cmp.match(/<details/g)).toHaveLength(2)
    // Explanations are text in the fold, not tooltips.
    expect(cmp).not.toMatch(/title=\{/)
  })

  it('keeps the disclaimers', () => {
    const about = cmp.slice(cmp.lastIndexOf('<details'))
    expect(about).toMatch(/not a NASA-certified safety model and not a measured risk/)
    expect(about).toMatch(/No priority guarantees a safe route/)
    expect(about).toMatch(/not proven optimal/)
    expect(about).toMatch(/Santee et al\. 2001/)
  })

  it('does not mark any figure as the one to prefer', () => {
    expect(cmp).not.toContain('is-min')
    expect(mission).not.toContain('is-min')
  })

  it('has a colour for every verdict and touch-sized controls on mobile', () => {
    for (const v of ['go', 'nogo', 'unverified', 'noroute']) expect(mission).toContain(`.cmp td.v-${v}`)
    expect(mission).toMatch(/\.is-mobile \.cmp thead button,\s*\.is-mobile \.cmp-fold summary \{\s*min-height: 40px;/)
  })

  it('lets long labels and values wrap instead of scrolling sideways', () => {
    expect(rule(mission, '.cmp table')).toContain('table-layout: fixed')
    expect(mission).toMatch(/\.cmp td \{[^}]*overflow-wrap: anywhere/)
    expect(mission.slice(mission.indexOf('.cmp table {'), mission.indexOf('.is-mobile .cmp thead button'))).not.toMatch(/white-space: nowrap|overflow-x/)
  })
})

describe('the mobile sheet', () => {
  const summary = sheet.slice(sheet.indexOf('className="sheet-summary"'), sheet.indexOf('className="sheet-tabs"'))

  it('shows verdict, distance, planning EVA duration and the selected priority when collapsed', () => {
    expect(summary).toContain('VERDICT_TITLE[verdict]')
    expect(summary).toContain('fmtKm(plan.plan!.distance)')
    expect(summary).toContain('fmtDur(plan.planEvaSeconds)')
    expect(summary).toContain('sheet-mode')
    expect(summary).toContain('ROUTE_MODES.find((m) => m.id === plan.mode)!.label')
  })

  it('keeps the summary outside the part that is hidden when collapsed', () => {
    expect(mobile).toMatch(/\.sheet-peek \.sheet-tabs,\s*\.sheet-peek \.sheet-body \{\s*visibility: hidden;/)
    expect(mobile).not.toMatch(/\.sheet-peek \.sheet-(summary|mode|status|verdict)/)
  })

  it('puts the priority cards first in the open sheet', () => {
    // The sheet body renders the mission head, whose cards are moved to the top.
    expect(app).toMatch(/<MobileSheet[\s\S]*<MissionHead plan=\{plan\} \/>\s*<MissionPanel/)
    const first = rule(mobile, '.sheet-body .m-modes')
    expect(first).toContain('order: -1')
    expect(rule(mobile, '.sheet-body .m-head')).toContain('flex-direction: column')
  })

  it('leaves the map visible in the half-open state', () => {
    const half = Number(sheet.match(/half: Math\.round\(vh \* ([\d.]+)\)/)![1])
    expect(half).toBeLessThanOrEqual(0.55)
  })
})
