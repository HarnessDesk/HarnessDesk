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

it('offers a terminal only on work or a folder-backed changes review', () => {
  expect(terminalCwdForSnapshot(snapshotAt(destinationOf({ kind: 'conversation', session: null })))).toBe('/synthetic/project')
  expect(terminalCwdForSnapshot(snapshotAt({
    kind: 'changes-review', root: '/synthetic/review', returnTo: { kind: 'conversation', session: null },
  }))).toBe('/synthetic/review')
})

it('does not borrow the retained work folder on a page destination', () => {
  expect(terminalCwdForSnapshot(snapshotAt({
    kind: 'settings', route: { kind: 'section', section: 'general', focus: null },
  }))).toBeNull()
  expect(terminalCwdForSnapshot(snapshotAt({ kind: 'dashboard', view: 'overview', scope: null }))).toBeNull()
})
