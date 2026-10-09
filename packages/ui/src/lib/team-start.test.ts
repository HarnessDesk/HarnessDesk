import { expect, it } from 'vitest'
import type { FlowEntry } from '@harnessdesk/protocol'
import { pickerSections, shapeSummary } from './team-start'

const entry = (id: string, over: Partial<FlowEntry> = {}): FlowEntry => ({
  id, name: id, origin: 'builtin', path: `${id}.yml`, description: 'First sentence. More details.',
  format: 'agents', problem: null, shadows: [], ...over,
})
const shapes = ['review', 'investigation', 'comparison', 'alignment', 'independent-review', 'fix-and-review'].map(id => entry(id))

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
