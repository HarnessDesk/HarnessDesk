import { expect, it } from 'vitest'
import { runtimeId, type LibraryEntry, type LibrarySkillUpdate, type ReachState } from '@harnessdesk/protocol'
import { chipFor } from './SkillRow'

const entry = (states: ReachState[], status?: LibrarySkillUpdate['status']): LibraryEntry => ({
  kind: 'skill', name: 'review', title: null, description: null, copies: [],
  reach: states.map((state, i) => ({ runtime: runtimeId(`runtime-${i}`), state, basis: 'scanned' })),
  ...(status ? { update: [{ name: 'review', runtime: runtimeId('runtime-0'), status, reason: null, latest: null,
    origin: { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: 'abc', path: 'review' } }] } : {}),
})
it('puts a warning finding in Needs you before counting reach', () => {
  expect(chipFor(entry(['rejected', 'reaches']), [])).toBe('needs-you')
})
it.each(['behind', 'gone'] as const)('puts update %s in Needs you', status => {
  expect(chipFor(entry(['reaches', 'reaches'], status), [])).toBe('needs-you')
})
it.each(['unreachable', 'current'] as const)('does not put update %s in Needs you', status => {
  expect(chipFor(entry(['reaches', 'reaches'], status), [])).toBe('all')
})
it.each([
  { states: ['off', 'stale'], chip: 'nobody' },
  { states: [], chip: 'nobody' },
  { states: ['reaches', 'absent'], chip: 'one-runtime' },
  { states: ['reaches', 'reaches', 'reaches'], chip: 'all' },
] as const)('classifies $states as $chip', ({ states, chip }) => {
  expect(chipFor(entry([...states]), [])).toBe(chip)
})
