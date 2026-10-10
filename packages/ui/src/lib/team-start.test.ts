import { expect, it } from 'vitest'
import type { FlowEntry, FlowPolicy } from '@harnessdesk/protocol'
import { TEAM_START_POLICIES } from '../preview/team-start-fixture'
import { CONTEST_START_POLICY } from './contest-start-fixture'
import { pickerSections, shapeSummary, withAttemptCheck } from './team-start'

const entry = (id: string, over: Partial<FlowEntry> = {}): FlowEntry => ({
  id, name: id, origin: 'builtin', path: `${id}.yml`, description: 'First sentence. More details.',
  format: 'agents', problem: null, shadows: [], ...over,
})
const shapes = ['review', 'investigation', 'comparison', 'alignment', 'independent-review', 'fix-and-review'].map(id => entry(id))

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

it('uses the approved fresh-desk order and puts project flows in their own section', () => {
  expect(pickerSections(shapes, {}, '').most.map(one => one.id)).toEqual(['fix-and-review', 'comparison', 'independent-review', 'investigation'])
  const sections = pickerSections([...shapes, entry('local', { origin: 'project' })], {}, '')
  expect(sections.project.map(one => one.id)).toEqual(['local'])
  expect(sections.more.map(one => one.id)).toEqual(['alignment', 'review'])
  expect(pickerSections(shapes, {}, '').project).toEqual([])
})

it('ranks actual starts, breaks ties by the fresh order, and searches names and summaries', () => {
  expect(pickerSections(shapes, { alignment: 8, review: 4, comparison: 4 }, '').most.map(one => one.id)).toEqual(['alignment', 'comparison', 'review', 'fix-and-review'])
  expect(pickerSections([entry('one', { name: 'Read code', summary: 'Security specialists.' }), entry('two')], {}, 'SECURITY').most.map(one => one.id)).toEqual(['one'])
})
