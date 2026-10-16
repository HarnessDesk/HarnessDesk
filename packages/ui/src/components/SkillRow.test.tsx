import { expect, it } from 'vitest'
import { entryHasProblem, runtimeId, type LibraryEntry, type LibrarySkillUpdate } from '@harnessdesk/protocol'
import { findingFor } from './SkillRow'

const origin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: '1234567', path: 'review' }
const update = (status: LibrarySkillUpdate['status']): LibrarySkillUpdate => ({ name: 'review', runtime: runtimeId('alpha'), origin, latest: status === 'behind' ? 'abcdef1' : null, status, reason: 'The source did not answer.' })
const entry = (statuses: readonly LibrarySkillUpdate['status'][]): LibraryEntry => ({ kind: 'skill', name: 'review', title: null, description: null,
  copies: [{ path: '/home/jane/.alpha/skills/review', scope: 'user', readBy: [runtimeId('alpha')], digest: 'one', hollow: false, readOnly: false }],
  reach: [{ runtime: runtimeId('alpha'), state: 'reaches', basis: 'reported' }], update: statuses.map(update),
})
it.each([
  ['behind', { text: 'Update available', tone: 'quiet' }],
  ['gone', { text: 'Source branch is gone', tone: 'warn' }],
  ['unreachable', { text: 'Could not check', tone: 'quiet', title: 'The source did not answer.' }],
  ['current', null],
] as const)('finds %s without changing problem counts', (status, expected) => {
  expect(findingFor(entry([status]), [])).toEqual(expected)
  expect(entryHasProblem(entry([status]))).toBe(false)
})
it('chooses behind, then gone, then unreachable independent of runtime order', () => {
  expect(findingFor(entry(['unreachable', 'gone', 'behind']), [])?.text).toBe('Update available')
  expect(findingFor(entry(['current', 'unreachable', 'gone']), [])?.text).toBe('Source branch is gone')
})
it('keeps every existing warning before update news and news before quiet findings', () => {
  const value = entry(['behind'])
  expect(findingFor({ ...value, copies: value.copies.map(c => ({ ...c, hollow: true })) }, [])?.text).toBe('Empty on disk')
  expect(findingFor({ ...value, reach: [{ runtime: runtimeId('alpha'), state: 'rejected', basis: 'reported' }] }, [{ id: runtimeId('alpha'), label: 'Alpha' }])?.text).toBe('Refused by Alpha')
  expect(findingFor({ ...value, copies: [...value.copies, { ...value.copies[0]!, path: '/home/jane/.beta/skills/review', digest: 'two' }] }, [])?.text).toBe('2 copies differ')
  expect(findingFor({ ...value, copies: value.copies.map(c => ({ ...c, readBy: [] })), reach: [{ runtime: runtimeId('alpha'), state: 'absent', basis: 'scanned' }] }, [])?.text).toBe('Where no runtime looks')
  for (const state of ['off', 'stale'] as const) expect(findingFor({ ...value, reach: [{ runtime: runtimeId('alpha'), state, basis: 'scanned' }] }, [])?.text).toBe('Update available')
})
