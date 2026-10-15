import { expect, test } from 'vitest'
import { destinationForSettings } from './settings-destination'

test('aliases and detail focus resolve without reopening a full-window surface', () => {
  expect(destinationForSettings('agents')).toEqual({ kind: 'settings', route: { kind: 'section', section: 'runtimes', focus: null } })
  expect(destinationForSettings('workspaces', '/synthetic/project')).toEqual({ kind: 'settings', route: { kind: 'project', root: '/synthetic/project' } })
  expect(destinationForSettings('workspaces', 'triggers')).toEqual({ kind: 'settings', route: { kind: 'section', section: 'workspaces', focus: 'triggers' } })
  expect(destinationForSettings('library')).toEqual({ kind: 'library', section: 'skill' })
  expect(destinationForSettings('plugins')).toEqual({ kind: 'plugins', section: 'installed', id: null })
  expect(destinationForSettings('runtimes', 'add')).toEqual({ kind: 'settings', route: { kind: 'add-runtime' } })
})
