import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { LeadChatNotice } from './LeadChatNotice'

/** The notice switches control only through its explicit buttons. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const renderNotice = (holder: 'lead' | 'person' | null, problem: string | null = null) => {
  const snapshot = emptySnapshot()
  const lead = {
    state: { chatControlProblem: problem, chats: holder ? [{ id: 'codex:s1', holder, sent: [] }] : [], settings: { name: 'dex' }, revision: 1 },
    resetChatControl: vi.fn(async () => {}), subscribe: () => () => {}, takeOverChat: vi.fn(async () => {}), handBackChat: vi.fn(async () => {}),
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, lead } as unknown as AppStore
  act(() => { root.render(<StoreProvider store={store}><LeadChatNotice runtime={'codex' as never} sessionId={'s1' as never} /></StoreProvider>) })
  return lead
}

it('says the Lead manages the chat and offers Take over', () => {
  const lead = renderNotice('lead')
  expect(container.textContent).toContain('Dex is managing this chat.')
  act(() => { (container.querySelector('button') as HTMLButtonElement).click() })
  expect(lead.takeOverChat).toHaveBeenCalledWith('codex:s1')
})

it('after take over says the person has it and offers Hand back', () => {
  const lead = renderNotice('person')
  expect(container.textContent).toContain('You have this chat.')
  expect(container.textContent).toContain('Hand back to Dex')
  act(() => { (container.querySelector('button') as HTMLButtonElement).click() })
  expect(lead.handBackChat).toHaveBeenCalledWith('codex:s1')
})

it('shows nothing for a chat the Lead never wrote to', () => {
  renderNotice(null)
  expect(container.textContent).toBe('')
})

for (const holder of ['lead', 'person'] as const) it(`shows a refused ${holder === 'lead' ? 'take over' : 'hand back'} inline`, async () => {
  const lead = renderNotice(holder)
  const action = holder === 'lead' ? lead.takeOverChat : lead.handBackChat
  action.mockRejectedValueOnce(new Error('The desk is offline. Try again when it reconnects.'))
  await act(async () => { (container.querySelector('button') as HTMLButtonElement).click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The desk is offline. Try again when it reconnects.')
  await act(async () => { (container.querySelector('button') as HTMLButtonElement).click() })
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('offers explicit confirmed recovery of an unreadable record and displays a reset refusal', async () => {
  const lead = renderNotice(null, 'The control record cannot be read. Use Reset chat control.')
  expect(container.textContent).toContain('Reset chat control')
  await act(async () => { (container.querySelector('button') as HTMLButtonElement).click() })
  expect(lead.resetChatControl).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('all projects')
  lead.resetChatControl.mockRejectedValueOnce(new Error('The control record could not be saved.'))
  await act(async () => { (Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Reset chat control') as HTMLButtonElement).click() })
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('The control record could not be saved.')
})
