import { EDIT_TEAM_START_POLICY } from '../preview/front-door-edit-fixture'
import { expect, it } from 'vitest'
import type { FlowEntry, FlowPolicy } from '@harnessdesk/protocol'
import { TEAM_START_POLICIES } from '../preview/team-start-fixture'
import { CONTEST_START_POLICY } from './contest-start-fixture'
import { withReviewHandoff, pickerSections, quickFlowChoices, shapeSummary, supportsComparisonJudge, withAttemptCheck, withComparisonJudge } from './team-start'

const entry = (id: string, over: Partial<FlowEntry> = {}): FlowEntry => ({
  id, name: id, origin: 'builtin', path: `${id}.yml`, description: 'First sentence. More details.',
  format: 'agents', problem: null, shadows: [], ...over,
})
const shapes = ['review', 'investigation', 'comparison', 'alignment', 'independent-review', 'fix-and-review'].map(id => entry(id))

it('bounds quick Flow choices to three project, recent and common options without losing the full catalogue', () => {
  const project = entry('local', { origin: 'project' })
  expect(quickFlowChoices(shapes, {}).map(one => one.id)).toEqual(['fix-and-review', 'comparison', 'independent-review'])
  const entries = [...shapes, project]
  expect(quickFlowChoices(entries, { alignment: 8 }).map(one => one.id)).toEqual(['local', 'alignment', 'fix-and-review'])
  expect(new Set(quickFlowChoices(entries, { 'fix-and-review': 2 }).map(one => one.id)).size).toBe(3)
  expect(pickerSections(entries, {}, '').project).toContain(project)
  expect(pickerSections(entries, {}, '').more).toHaveLength(shapes.length)
})

it('reserves quick choices for current readable Flows while keeping broken and legacy entries in the catalogue', () => {
  const broken = entry('broken', { origin: 'project', problem: 'Unknown Agent', format: null })
  const legacy = entry('old-fix', { origin: 'project', format: 'legacy' })
  const recentBroken = entry('recent-broken', { problem: 'Invalid policy' })
  const local = entry('local', { origin: 'project' })
  const entries = [broken, legacy, recentBroken, ...shapes, local]
  expect(quickFlowChoices(entries, { 'recent-broken': 20 }).map(one => one.id)).toEqual(['local', 'fix-and-review', 'comparison'])
  expect(quickFlowChoices([broken, legacy], {})).toEqual([])
  expect(pickerSections(entries, {}, '').project).toEqual(expect.arrayContaining([broken, legacy, local]))
  expect(pickerSections(entries, {}, 'broken').more).toContain(recentBroken)
})

it('leaves a project comparison with a renamed person destination intact', () => {
  const base = TEAM_START_POLICIES.comparison
  const project: FlowPolicy = { ...base,
    roles: base.roles.map(role => role.id === 'referee' ? { ...role, id: 'merge' } : role),
    rules: base.rules.map(rule => ({ ...rule, on: rule.on === 'referee' ? 'merge' : rule.on,
      then: { ...rule.then, role: rule.then.role === 'referee' ? 'merge' : rule.then.role } })),
    complete: { merge: ['merged'] },
  }
  expect(supportsComparisonJudge(base)).toBe(true)
  expect(supportsComparisonJudge(project)).toBe(false)
  expect(withComparisonJudge(project, project, null)).toBe(project)
  expect(withComparisonJudge(project, project, { runtime: 'runtime-1' })).toBe(project)
})

it.each(['comparison', 'mechanical-contest'] as const)('preserves separating spaces as %s’s project check is typed', id => {
  const template = id === 'mechanical-contest' ? CONTEST_START_POLICY : TEAM_START_POLICIES.comparison
  let flow: FlowPolicy = template
  let value = ''
  for (const character of 'node check.mjs') {
    flow = withAttemptCheck(flow, template, value + character)
    const check = flow.roles.find(role => role.kind === 'check')
    value = check?.kind === 'check' ? check.check.run : ''
  }
  expect(value).toBe('node check.mjs')
})

it('adds, skips and restores per-attempt checks before a contest’s person choice', () => {
  const template = CONTEST_START_POLICY
  const checked = withAttemptCheck(template, template, 'npm test')
  expect(checked.roles.find(role => role.id === 'verify')).toMatchObject({ kind: 'check', check: { run: 'npm test', onRequest: true, exits: { '0': 'pass' }, otherwise: 'fail' } })
  expect(checked.rules).toEqual([
    { id: 'to-verify', on: 'competitor', then: { role: 'verify', title: 'Check the attempt' } },
    { id: 'to-person', on: 'verify', when: { any: ['pass'] }, then: { role: 'referee', title: 'Choose and merge an attempt' } },
  ])
  expect(withAttemptCheck(checked, template, '   ')).toEqual(template)
  expect(withAttemptCheck(withAttemptCheck(checked, template, ''), template, 'npm test')).toEqual(checked)
})

const customComparison = (): FlowPolicy => {
  const base: FlowPolicy = TEAM_START_POLICIES.comparison
  return { ...base, roles: [base.roles[0]!, {
    id: 'verify', kind: 'check', check: { run: 'node original.mjs', onRequest: false, cwd: 'app', timeout: 37, exits: { '0': 'clean', '2': 'bad' }, otherwise: 'bad' },
  }, ...base.roles.slice(1)], rules: [
    { id: 'project-check', on: 'competitor', when: { every: ['published'] }, then: { role: 'verify', title: 'Run the project check' } },
    { id: 'retry-attempts', on: 'verify', when: { any: ['bad'] }, then: { role: 'competitor', title: 'Repair the attempts' } },
    { id: 'judge-clean-attempts', on: 'verify', when: { any: ['clean'] }, then: { role: 'judge', title: 'Choose from the checked attempts' } },
    ...base.rules.filter(rule => rule.on === 'judge'),
  ] }
}

it('editing a project comparison’s check command preserves its custom routes, exits and settings', () => {
  const original = customComparison()
  const changed = withAttemptCheck(original, original, 'node replacement.mjs')
  expect(changed.rules).toEqual(original.rules)
  expect(changed.roles).toEqual(original.roles.map(role => role.kind === 'check' ? { ...role, check: { ...role.check, run: 'node replacement.mjs' } } : role))
  expect(original.roles.find(role => role.kind === 'check')).toMatchObject({ check: { run: 'node original.mjs' } })
})

it('clearing a project comparison’s check removes custom entry and retry routes, and bridges attempts to the judge', () => {
  const original = customComparison()
  const changed = withAttemptCheck(original, original, '')
  expect(changed.roles.some(role => role.id === 'verify')).toBe(false)
  expect(changed.rules.some(rule => rule.on === 'verify' || rule.then.role === 'verify')).toBe(false)
  expect(changed.rules.find(rule => rule.then.role === 'judge')).toEqual({
    id: 'judge-clean-attempts', on: 'competitor', when: { every: ['published'] }, then: { role: 'judge', title: 'Choose from the checked attempts' },
  })
  expect(changed.rules.find(rule => rule.on === 'judge')).toEqual(original.rules.find(rule => rule.on === 'judge'))
  const roles = new Set(changed.roles.map(role => role.id))
  expect(changed.rules.every(rule => roles.has(rule.on) && roles.has(rule.then.role))).toBe(true)
})

it('restoring a cleared project check keeps its declared success guard, retry route and check configuration', () => {
  const original = customComparison()
  const cleared = withAttemptCheck(original, original, '')
  const restored = withAttemptCheck(cleared, original, 'node replacement.mjs')
  expect(restored.rules).toEqual(original.rules)
  expect(restored.roles).toEqual(original.roles.map(role => role.kind === 'check' ? { ...role, check: { ...role.check, run: 'node replacement.mjs' } } : role))
})

it('restoring a cleared custom check sends its declared success to the current person destination', () => {
  const original = customComparison()
  const cleared = withAttemptCheck(original, original, '')
  const noJudge: FlowPolicy = { ...cleared, roles: cleared.roles.filter(role => role.id !== 'judge'), rules: [
    { id: 'to-person', on: 'competitor', when: { every: ['published'] }, then: { role: 'referee', title: 'Choose and merge an attempt' } },
  ] }
  const restored = withAttemptCheck(noJudge, original, 'node replacement.mjs')
  expect(restored.rules.find(rule => rule.id === 'to-person')).toEqual({
    id: 'to-person', on: 'verify', when: { any: ['clean'] }, then: { role: 'referee', title: 'Choose and merge an attempt' },
  })
  expect(restored.rules.find(rule => rule.id === 'retry-attempts')).toEqual(original.rules.find(rule => rule.id === 'retry-attempts'))
  expect(restored.rules.some(rule => rule.then.role === 'judge' || rule.on === 'judge')).toBe(false)
})

it('prefers a summary, otherwise the first complete description sentence', () => {
  expect(shapeSummary(entry('one', { summary: 'Short version.' }))).toBe('Short version.')
  expect(shapeSummary(entry('one'))).toBe('First sentence.')
  expect(shapeSummary(entry('one', { description: null }))).toBe('')
})

it('keeps a fresh desk unranked and puts project flows in their own section', () => {
  expect(pickerSections(shapes, {}, '').most).toEqual([])
  const sections = pickerSections([...shapes, entry('local', { origin: 'project' })], {}, '')
  expect(sections.project.map(one => one.id)).toEqual(['local'])
  expect(sections.more.map(one => one.id)).toEqual(['alignment', 'comparison', 'fix-and-review', 'independent-review', 'investigation', 'review'])
  expect(pickerSections(shapes, {}, '').project).toEqual([])
})

it('ranks actual starts, breaks ties by the fresh order, and searches names and summaries', () => {
  expect(pickerSections(shapes, { alignment: 8, review: 4, comparison: 4 }, '').most.map(one => one.id)).toEqual(['alignment', 'comparison', 'review'])
  expect(pickerSections([entry('one', { name: 'Read code', summary: 'Security specialists.' }), entry('two')], {}, 'SECURITY').more.map(one => one.id)).toEqual(['one'])
})


it('restores the separate publication handoff after changing the review outcome option', () => {
  const automatic = withReviewHandoff(EDIT_TEAM_START_POLICY, 'merge')
  const waiting = withReviewHandoff(automatic, 'wait')
  expect(waiting.roles.find(role => role.id === 'fixer')).toMatchObject({ grant: 'edit' })
  expect(waiting.roles.find(role => role.id === 'referee')).toMatchObject({ kind: 'person' })
  expect(waiting.rules.find(rule => rule.then.role === 'referee')?.then).toMatchObject({
    title: 'Approve publishing the reviewed change',
    detail: EDIT_TEAM_START_POLICY.rules.find(rule => rule.then.role === 'referee')!.then.detail,
  })
})

it('does not rank zero starts or usage of shapes absent from this catalogue', () => {
  expect(pickerSections(shapes, { comparison: 0, missing: 3 }, '').most).toEqual([])
  expect(pickerSections(shapes, { comparison: 1 }, '').most.map(one => one.id)).toEqual(['comparison'])
})
