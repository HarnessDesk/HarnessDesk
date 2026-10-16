import { expect, it, vi } from 'vitest'
import { sessionKey, sessionId } from '@harnessdesk/protocol'
import { frameDestinationStore } from '../preview/frame-destination-store'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { admitFixedTool, readToolIntents } from './frame-tools'
import { dockViews } from './workbench'
import { AppStore } from './store'
import '../panels/builtins'

const fixture = () => {
  const store = frameDestinationStore(previewStore())
  store.showViewIn('main', { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  return store
}
const intent = (store: AppStore) => store.getSnapshot().workbench.frameTools[store.workSubject()!]
it.each([true, false])('selects Conversation on entry and restores the prior tool with open=%s', open => {
  const store = fixture()
  store.chooseWorkTool('activity')
  if (!open) store.toggleWorkPanel()
  const prior = intent(store)
  store.setWindowMode('editor')
  expect(intent(store)).toMatchObject({ tool: 'conversation', mode: 'conversation', open: true })
  store.chooseWorkTool('details')
  store.setWindowMode('conversation')
  expect(intent(store)).toEqual(prior)
  expect(dockViews(store.getSnapshot().workbench.right).some(one => one.view.kind === 'conversation')).toBe(false)
})
it('admits only the current conversation in Editor and leaves ordinary main navigation intact', () => {
  const store = fixture(), view = { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY }
  const before = store.getSnapshot().workbench
  expect(admitFixedTool(before, view)).toBeNull()
  store.chooseWorkTool('conversation')
  expect(store.getSnapshot().workbench).toBe(before)
  store.setWindowMode('editor')
  store.showViewIn('right', { ...view, session: null })
  expect(store.workSubject()).toBe(`session:${PREVIEW_SESSION_KEY}`)
  store.showViewIn('main', { ...view, session: null })
  expect(store.workSubject()).toMatch(/^draft:/)
  expect(intent(store)?.tool).not.toBe('conversation')
  store.chooseWorkTool('conversation')
  expect(intent(store)?.tool).not.toBe('conversation')
  store.openTeamRoom('fixture-team')
  store.chooseWorkTool('conversation')
  expect(intent(store)?.tool).not.toBe('conversation')
})
it('restores prior intent when navigating away and selects Conversation when returning', async () => {
  const store = fixture()
  store.chooseWorkTool('activity'); store.toggleWorkPanel()
  const prior = intent(store), subject = store.workSubject()!
  store.setWindowMode('editor')
  store.openTeamRoom('fixture-team')
  expect(store.getSnapshot().workbench.frameTools[subject]).toEqual(prior)
  await store.navigateBack()
  expect(store.workSubject()).toBe(subject)
  expect(intent(store)).toMatchObject({ tool: 'conversation', open: true })
  store.setWindowMode('conversation')
  expect(intent(store)).toEqual(prior)
})
it('hydrates Editor mode and reads its stored prior tool without making Conversation a normal tool', async () => {
  const store = fixture()
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => method === 'app/state/get' ? { windowMode: 'editor', layouts: { [store.getSnapshot().workspace!.path]: store.getSnapshot().workbench } } : null) as never)
  await store.loadPreferences()
  expect(intent(store)).toMatchObject({ tool: 'conversation', open: true })
  expect(readToolIntents({ current: { tool: 'conversation', mode: 'conversation', open: true,
    beforeEditor: { tool: 'activity', mode: 'activity', open: false } } })).toEqual({ current: {
    tool: 'conversation', mode: 'conversation', open: true, beforeEditor: { tool: 'activity', mode: 'activity', open: false },
  } })
})
it('restores the exact cached document selected before Editor, after a different document is shown there', () => {
  const store = fixture()
  store.openFile('/repo/first.ts'); store.openFile('/repo/second.ts')
  const prior = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'file' && one.view.path === '/repo/second.ts')!
  store.setWindowMode('editor')
  store.openFile('/repo/first.ts')
  store.setWindowMode('conversation')
  expect(store.getSnapshot().workbench.right.root).toMatchObject({ active: prior.id })
})
it('returns from Settings with the requested Editor mode and Conversation selected', async () => {
  const store = fixture(), subject = store.workSubject()!
  store.chooseWorkTool('activity'); store.toggleWorkPanel()
  const prior = intent(store)
  store.setWindowMode('editor'); store.chooseWorkTool('details')
  store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'general', focus: null } })
  expect(store.getSnapshot().windowMode).toBe('editor')
  expect(store.getSnapshot().workbench.frameTools[subject]).toEqual(prior)
  await store.leaveSettings()
  expect(intent(store)).toMatchObject({ tool: 'conversation', open: true })
})

it('opening another conversation keeps it in main and returning selects that subject’s own Conversation tool', async () => {
  const store = fixture(), first = store.workSubject()!
  const source = store.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!
  const id = sessionId('fixture-second'), key = sessionKey(source.runtime, id)
  Object.assign(store.getSnapshot(), { sessions: new Map(store.getSnapshot().sessions).set(key, { ...source, id }) })
  store.chooseWorkTool('activity'); store.toggleWorkPanel()
  const prior = intent(store)
  store.setWindowMode('editor')
  store.showViewIn('main', { kind: 'conversation', session: key })
  expect(store.workSubject()).toBe(`session:${key}`)
  expect(intent(store)).toMatchObject({ tool: 'conversation', open: true })
  expect(store.getSnapshot().workbench.frameTools[first]).toEqual(prior)
  expect(dockViews(store.getSnapshot().workbench.right).some(one => one.view.kind === 'conversation')).toBe(false)
  await store.navigateBack()
  expect(store.workSubject()).toBe(first)
  expect(intent(store)).toMatchObject({ tool: 'conversation', open: true })
  store.setWindowMode('conversation')
  expect(intent(store)).toEqual(prior)
})
it('reload preserves the exact prior panel even after an Editor tool selection', async () => {
  const original = fixture()
  original.openFile('/repo/first.ts'); original.openFile('/repo/second.ts')
  const prior = intent(original), subject = original.workSubject()!
  original.setWindowMode('editor'); original.chooseWorkTool('details')
  const layout = JSON.parse(JSON.stringify(original.getSnapshot().workbench))
  const fresh = fixture()
  vi.spyOn(fresh.transport, 'request').mockImplementation((async (method: string) => method === 'app/state/get' ? {
    windowMode: 'editor', layouts: { [fresh.getSnapshot().workspace!.path]: layout },
  } : null) as never)
  await fresh.loadPreferences()
  expect(intent(fresh)).toMatchObject({ tool: 'conversation', open: true })
  fresh.setWindowMode('conversation')
  // The legacy Details selection made during Editor migrates to an open rail;
  // the independent rail preference survives restoring the prior file pane.
  expect(fresh.getSnapshot().workbench.frameTools[subject]).toEqual({ ...prior, railOpen: true })
  expect(fresh.getSnapshot().workbench.right.root).toMatchObject({ active: layout.right.root.active })
})
it('reload restores an expanded prior file pane while keeping the rail changed during Editor', async () => {
  const original = fixture()
  original.openFile('/repo/first.ts'); original.openFile('/repo/second.ts')
  original.toggleWorkRail(); original.swapWorkPane()
  const prior = intent(original), subject = original.workSubject()!
  const selected = dockViews(original.getSnapshot().workbench.right).find(one => one.view.kind === 'file' && one.view.path === '/repo/second.ts')!
  expect(prior).toEqual({ tool: 'files', mode: 'file', open: true, railOpen: false, expanded: true })
  original.setWindowMode('editor')
  original.toggleWorkRail()
  original.openFile('/repo/first.ts')
  const layout = JSON.parse(JSON.stringify(original.getSnapshot().workbench))
  const fresh = fixture()
  vi.spyOn(fresh.transport, 'request').mockImplementation((async (method: string) => method === 'app/state/get' ? {
    windowMode: 'editor', layouts: { [fresh.getSnapshot().workspace!.path]: layout },
  } : null) as never)
  await fresh.loadPreferences()
  expect(intent(fresh)?.beforeEditor).toEqual({ ...prior, mount: selected.id })
  fresh.setWindowMode('conversation')
  expect(fresh.getSnapshot().workbench.frameTools[subject]).toEqual({ ...prior, railOpen: true })
  expect(fresh.getSnapshot().workbench.right.root).toMatchObject({ active: selected.id })
})
it.each(['closed', 'details', 'file', 'browser'] as const)('leaving Editor clears hidden Browser focus while preserving a restored visible Browser (%s prior)', async prior => {
  const store = fixture()
  if (prior === 'file') store.openFile('/repo/prior.ts')
  else if (prior === 'browser') await store.openBrowser()
  else { store.chooseWorkTool('details'); if (prior === 'closed') store.toggleWorkPanel() }
  store.setWindowMode('editor')
  await store.openBrowser()
  const browser = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  store.focusView(browser.id)
  expect(store.getSnapshot().workbench.focus).toBe(browser.id)
  store.setWindowMode('conversation')
  expect(store.getSnapshot().workbench.focus).toBe(prior === 'browser' ? browser.id : null)
})
it.each(['openTeamRoom', 'selectWork'] as const)('departing Editor through %s clears focus from its old Browser', async route => {
  const store = fixture()
  store.openTeamRoom('fixture-team'); store.chooseWorkTool('details')
  store.showViewIn('main', { kind: 'conversation', session: PREVIEW_SESSION_KEY })
  store.chooseWorkTool('details'); store.setWindowMode('editor')
  await store.openBrowser()
  const browser = dockViews(store.getSnapshot().workbench.right).find(one => one.view.kind === 'browser')!
  store.focusView(browser.id)
  if (route === 'openTeamRoom') store.openTeamRoom('fixture-team')
  else store.selectWork({ kind: 'room', room: 'fixture-team' })
  expect(store.workSubject()).toBe('team:fixture-team')
  expect(store.getSnapshot().workbench.frameTools['team:fixture-team']).toEqual({ tool: 'details', mode: 'details', open: true })
  expect(store.getSnapshot().workbench.focus).toBeNull()
})
