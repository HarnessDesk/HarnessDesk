import { expect, it } from 'vitest'
import { runtimeId, sessionKey } from '@harnessdesk/protocol'
import { emptySnapshot } from './snapshot'
import { sessionVisible } from './session-visible'

const key = sessionKey(runtimeId('agent'), 'one')
const main = () => {
  const snapshot = emptySnapshot()
  return { ...snapshot, layout: { ...snapshot.layout, root: { kind: 'pane' as const, id: 'visible', view: { kind: 'conversation' as const, session: key } } } }
}

it('counts an unfocused pane but not a stale active key', () => {
  expect(sessionVisible(main(), key)).toBe(true)
  const stale = { ...emptySnapshot(), activeSessionKey: key }
  expect(sessionVisible(stale, key)).toBe(false)
})

it('does not count a conversation behind a destination or an expanded tool', () => {
  const snapshot = main()
  expect(sessionVisible({ ...snapshot, workbench: { ...snapshot.workbench, navigation: { ...snapshot.workbench.navigation, current: { kind: 'settings', route: { kind: 'section', section: 'general', focus: null } } } } }, key)).toBe(false)
  expect(sessionVisible({ ...snapshot, layout: { ...snapshot.layout, expanded: 'tool' } }, key)).toBe(false)
})

it('counts docked conversations only in visible tabs and uncollapsed areas', () => {
  const snapshot = emptySnapshot()
  const right = { ...snapshot.workbench.right, root: { kind: 'stack' as const, id: 'right', active: 'reader', views: [{ id: 'reader', view: { kind: 'conversation' as const, session: key } }] } }
  const shown = { ...snapshot, workbench: { ...snapshot.workbench, right } }
  expect(sessionVisible(shown, key)).toBe(true)
  expect(sessionVisible({ ...shown, workbench: { ...shown.workbench, right: { ...right, collapsed: true } } }, key)).toBe(false)
})

it('counts the adjacent reader and respects a zoom that hides it', () => {
  const snapshot = emptySnapshot()
  const shown = { ...snapshot, adjacentSession: { key, subject: 'session:agent:main', loading: false, error: null } }
  expect(sessionVisible(shown, key)).toBe(true)
  expect(sessionVisible({ ...shown, workbench: { ...shown.workbench, zoom: { area: 'main', scope: 'window' } } }, key)).toBe(false)
})
