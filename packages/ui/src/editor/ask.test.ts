import { expect, it, vi } from 'vitest'
import { askInChat, requestAskInChat } from './ask'
import { emptySnapshot, type AppStore } from '../state/store'
import { fixedSubject } from '../state/workbench'
vi.mock('../lib/compose', () => ({ handOverToComposer: vi.fn(async () => true) }))
import { handOverToComposer } from '../lib/compose'

it('opens and focuses only the owning current main conversation and hands over draft text', async () => {
  const snapshot = emptySnapshot()
  const pane = snapshot.workbench.main.root
  if (pane.kind !== 'pane') throw new Error('expected main pane')
  Object.assign(pane, { view: { kind: 'conversation', session: 'fake:s1' } })
  const store = { getSnapshot: () => snapshot, chooseWorkTool: vi.fn(), focusPane: vi.fn(), notice: vi.fn() } as unknown as AppStore
  const subject = fixedSubject(snapshot.workbench.main)!
  expect(await askInChat(store, pane.id, subject, 'quote')).toBe(true)
  expect(store.chooseWorkTool).toHaveBeenCalledWith('conversation')
  expect(store.focusPane).toHaveBeenCalledWith(pane.id)
  expect(handOverToComposer).toHaveBeenCalledWith({ paneId: pane.id, sessionKey: 'fake:s1', text: 'quote' })
  vi.mocked(handOverToComposer).mockClear()
  expect(await askInChat(store, pane.id, 'departed-conversation', 'quote')).toBe(false)
  expect(handOverToComposer).not.toHaveBeenCalled()
})
it('shares a synchronous request path with the app shortcut and reports whether a selection accepted it', () => {
  expect(requestAskInChat()).toBe(false)
  const listener = (event: Event) => { (event as CustomEvent).detail.handled = true }
  window.addEventListener('harnessdesk:ask-in-chat', listener)
  expect(requestAskInChat()).toBe(true)
  window.removeEventListener('harnessdesk:ask-in-chat', listener)
})
