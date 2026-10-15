import { expect, it } from 'vitest'
import { destinationOf, type Destination } from '../state/destinations'
import { emptySnapshot, type AppSnapshot } from '../state/store'
import { terminalCwdForSnapshot } from './terminal-scope'

const snapshotAt = (current: Destination): AppSnapshot => {
  const base = emptySnapshot()
  return {
    ...base,
    workspace: { path: '/synthetic/project' } as NonNullable<AppSnapshot['workspace']>,
    workbench: {
      ...base.workbench,
      navigation: { ...base.workbench.navigation, current },
    },
  }
}

it('uses the conversation workspace or the folder-backed changes review', () => {
  expect(terminalCwdForSnapshot(snapshotAt(destinationOf({ kind: 'conversation', session: null })))).toBe('/synthetic/project')
  expect(terminalCwdForSnapshot(snapshotAt({
    kind: 'changes-review', root: '/synthetic/review', returnTo: { kind: 'conversation', session: null },
  }))).toBe('/synthetic/review')
})

it('uses the chosen project on page destinations', () => {
  expect(terminalCwdForSnapshot(snapshotAt({
    kind: 'settings', route: { kind: 'section', section: 'general', focus: null },
  }))).toBe('/synthetic/project')
  expect(terminalCwdForSnapshot(snapshotAt({ kind: 'dashboard', view: 'overview', scope: null }))).toBe('/synthetic/project')
})

it('uses the visibly opened project settings instead of a retained workspace', () => {
  expect(terminalCwdForSnapshot(snapshotAt({ kind: 'settings', route: { kind: 'project', root: '/synthetic/selected' } }))).toBe('/synthetic/selected')
})

it('refuses when no project is chosen on a page, even with a retained conversation', () => {
  const snapshot = snapshotAt({ kind: 'teams', filter: 'active' })
  const sessions = new Map(snapshot.sessions).set('old' as never, { cwd: '/synthetic/old-conversation' } as never)
  expect(terminalCwdForSnapshot({ ...snapshot, sessions, activeSessionKey: 'old' as never, workspace: null })).toBeNull()
})
