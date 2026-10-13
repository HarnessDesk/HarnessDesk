import type { AppStore } from '../state/store'
import { findPane } from '../state/layout'
import { fixedSubject } from '../state/workbench'
import { handOverToComposer } from '../lib/compose'

/** One route for the window shortcut and the floating action. */
export const requestAskInChat = (): boolean => {
  const detail = { handled: false }
  window.dispatchEvent(new CustomEvent('harnessdesk:ask-in-chat', { detail }))
  return detail.handled
}

const target = (store: AppStore, paneId: string, subject: string): string | null => {
  const current = store.getSnapshot()
  const pane = findPane(current.workbench.main, paneId)
  if (fixedSubject(current.workbench.main) !== subject || current.workbench.main.focused !== paneId || pane?.view.kind !== 'conversation' || !pane.view.session) return null
  return pane.view.session
}

export const canAskInChat = (store: AppStore, paneId: string, subject: string): boolean => target(store, paneId, subject) !== null

export const askInChat = async (store: AppStore, paneId: string, subject: string, text: string): Promise<boolean> => {
  const sessionKey = target(store, paneId, subject)
  if (!sessionKey) return false
  store.chooseWorkTool('conversation')
  store.focusPane(paneId)
  const received = await handOverToComposer({ paneId, sessionKey, text })
  if (!received && fixedSubject(store.getSnapshot().workbench.main) === subject) store.notice('warning', 'The quote could not reach the conversation draft. Select the text and try again.')
  return received
}
