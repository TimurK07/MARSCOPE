// Wording that must not come back: claims the project cannot support.
// These scan the text people read: the interface sources, README and DATA_SOURCES.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildChecks } from '../src/lib/mission'
import { ROUTE_MODES } from '../src/lib/objectives'
import { RADIATION } from '../src/lib/model'
import { findLeg } from '../src/lib/router'
import { at, makeTerrain } from '../src/lib/__tests__/synthetic'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(p, 'utf8')
const dir = (d: string, ext: RegExp) => readdirSync(join(APP, d)).filter((f) => ext.test(f)).map((f) => join(APP, d, f))

const UI = [...dir('src/components', /\.tsx$/), join(APP, 'src/App.tsx'), ...dir('src/lib', /\.ts$/), ...dir('src/hooks', /\.ts$/)]
const DOCS = [join(APP, '..', 'README.md'), join(APP, '..', 'docs', 'DATA_SOURCES.md')]
const ALL = [...UI, ...DOCS]

/** Phrases that claim NASA's authority, or safety, where there is neither. */
const BANNED: [RegExp, string][] = [
  [/NASA EVA limits/i, 'the limits are MARSCOPE planning limits'],
  [/NASA's 20/i, 'the 20 degree limit is a MARSCOPE assumption informed by a lunar document'],
  [/NASA(?:'s)? (?:slope|traversable-slope) limit/i, 'same'],
  [/safest/i, 'no route is shown to be the safest'],
  [/safe walking route/i, 'routes satisfy terrain constraints; they are not shown to be safe'],
  [/No safe route/i, 'say "No route within the slope limit"'],
  [/no safe way back/i, 'say "no way back within the slope limit"'],
  [/the safe limit/i, 'say "the slope limit"'],
  [/Every constant in the planner comes from a NASA document/i, 'several constants are planning assumptions'],
  [/links to its\s+NASA or peer-reviewed source/i, 'several constants are planning assumptions'],
  [/(?:, |and |is )scaled to Mars gravity/i, 'gravity enters the climb and descent terms only'],
  [/RAD radiation measurements/i, 'the app uses one published rate, not RAD data'],
  [/career limit, model|Share of career limit/i, 'no share of the career limit: different quantities'],
  [/guaranteed (?:safe|safety)/i, 'nothing is guaranteed'],
  [/NASA[- ]certified (?:route|plan)/i, 'nothing here is certified'],
]

describe('claims the project does not make', () => {
  for (const [pattern, why] of BANNED) {
    it(`nowhere says ${pattern} (${why})`, () => {
      const hits = ALL.filter((f) => pattern.test(read(f))).map((f) => f.replace(APP, ''))
      expect(hits).toEqual([])
    })
  }
})

describe('what the interface says instead', () => {
  const panel = read(join(APP, 'src/components/MissionPanel.tsx'))
  const onboarding = read(join(APP, 'src/components/Onboarding.tsx'))
  const data = read(join(APP, 'src/components/DataPanel.tsx'))

  it('calls the limits MARSCOPE planning limits and GO not a safety clearance', () => {
    expect(onboarding).toContain('MARSCOPE planning limits')
    expect(onboarding).toContain('MARSCOPE planning assumption informed by NASA lunar EVA documents')
    expect(panel).toContain('Route is within all MARSCOPE planning limits. Not a safety clearance.')
    expect(panel).toContain('No route within the slope limit')
    expect(data).toContain('MARSCOPE planning assumptions')
  })

  it('labels which EVA duration it shows, everywhere one is shown', () => {
    const sheet = read(join(APP, 'src/components/MobileSheet.tsx'))
    const app = read(join(APP, 'src/App.tsx'))
    expect(sheet).toContain('plan.planEvaSeconds')
    expect(sheet).not.toContain('fmtDur(plan.evaSeconds)')
    expect(sheet).toMatch(/EVA ≤ \{PLANNING_PACE\.max_kmh\} km\/h/)
    expect(app).toContain('plan.planEvaSeconds')
    expect(app).not.toContain('fmtDur(plan.evaSeconds)')
    expect(panel).toContain('The 8-hour limit is judged on this figure')
    expect(panel).toContain('EVA duration, model')
  })

  it('labels energy as the model\'s and says where gravity enters', () => {
    expect(panel).toContain('Walking energy · model')
    // The comparison table's rows are built in the comparison module; the long note stays in the panel.
    const comparison = read(join(APP, 'src/lib/comparison.ts'))
    expect(comparison).toContain("'Model walking energy'")
    expect(comparison).toContain('Mars gravity enters only its climb and descent terms')
    expect(panel).toContain('only its climb and')
    const energy = ROUTE_MODES.find((m) => m.id === 'energy')!.summary
    expect(energy).toContain('climb and descent terms only')
    expect(energy).not.toMatch(/scaled to Mars gravity/)
  })

  it('shows background radiation without a share of the career limit', () => {
    expect(panel).not.toContain('careerLimit_mSv')
    expect(panel).not.toMatch(/career/i)
    expect(panel).toContain('not exposure caused by the EVA')
    expect(panel).toContain('does not\n          enter GO / NO-GO')
    expect(RADIATION.note).toContain('solar maximum')
    expect(RADIATION.note).toContain('Solar particle events are not included')
    expect(RADIATION.note).toMatch(/suit or a habitat/)
    expect(RADIATION.doseEquivalent_mSv_per_day).toBe(0.67)
  })
})

describe('what the planner says', () => {
  it('describes a missing route by the slope limit, not by safety', () => {
    const walled = makeTerrain(20, 9, (x) => (x === 10 ? 40 : 0))
    const cut = findLeg(walled, at(walled, 3, 4), at(walled, 16, 4))
    expect(cut.ok).toBe(false)
    if (!cut.ok) {
      expect(cut.reason).toContain('No route within the slope limit')
      expect(cut.reason).not.toMatch(/\bsafe\b/)
    }
    const onSteep = findLeg(walled, at(walled, 3, 4), at(walled, 10, 4))
    if (!onSteep.ok) expect(onSteep.reason).toBe('Target is on terrain steeper than the slope limit.')
  })

  it('names its checks by what they measure, with no word about safety', () => {
    const lost = { maxDistance: Infinity, maxTime: Infinity, maxDistanceAt: { lat: 0, lon: 0 }, maxTimeAt: { lat: 0, lon: 0 }, reachable: false, feasible: false, verified: true }
    for (const c of [...buildChecks({ evaSeconds: 3600, walkBack: lost }), ...buildChecks({ evaSeconds: 3600, walkBack: null })]) {
      expect(`${c.label} ${c.value} ${c.margin}`).not.toMatch(/\bsafe\b/i)
    }
    const labels = buildChecks({ evaSeconds: 3600, walkBack: lost }).map((c) => c.label)
    expect(labels).toEqual(['EVA duration at ≤ 2 km/h', 'Way back to habitat: distance', 'Way back to habitat: time at ≤ 2 km/h'])
  })
})
