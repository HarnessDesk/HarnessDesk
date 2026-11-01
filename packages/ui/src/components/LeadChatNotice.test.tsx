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

const renderNotice = (holder: 'lead' | 'person' | null, problem: { kind: 'invalid' | 'transient' | 'unavailable'; message: string; retryable?: boolean } | null = null) => {
  const snapshot = emptySnapshot()
  const listeners = new Set<() => void>()
  const lead = {
    state: { chatControlProblem: problem, chats: holder ? [{ id: 'codex:s1', holder, sent: [] }] : [], settings: { name: 'dex' }, revision: 1 },
    readChatControl: vi.fn(async () => {}), resetChatControl: vi.fn(async () => {}), subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, notify: () => { for (const listener of listeners) listener() }, takeOverChat: vi.fn(async () => {}), handBackChat: vi.fn(async () => {}),
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
  const lead = renderNotice(null, { kind: 'invalid', message: 'The control record cannot be read. Use Reset chat control.' })
  expect(container.textContent).toContain('Reset chat control')
  await act(async () => { (container.querySelector('button') as HTMLButtonElement).click() })
  expect(lead.resetChatControl).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('all projects')
  lead.resetChatControl.mockRejectedValueOnce(new Error('The control record could not be saved.'))
  await act(async () => { (Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === 'Reset chat control') as HTMLButtonElement).click() })
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('The control record could not be saved.')
})

for (const holder of ['lead', 'person'] as const) it(`keeps ${holder} controls and retries a transient read without offering Reset`, async () => {
  const lead = renderNotice(holder, { kind: 'transient', message: 'The desk connection was lost.' })
  expect(container.textContent).toContain(holder === 'lead' ? 'Take over' : 'Hand back to Dex')
  expect(container.textContent).not.toContain('Reset chat control')
  const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Try again')!
  expect(retry).toBeDefined()
  await act(async () => { retry.click() })
  expect(lead.readChatControl).toHaveBeenCalledOnce()
})

it('does not show a global transient failure on a chat without a Lead record', () => {
  renderNotice(null, { kind: 'transient', message: 'Temporary control read failure' })
  expect(container.textContent).toBe('')
})

for (const next of [null, 'transient', 'unavailable'] as const) it(`closes Reset confirmation when invalid changes to ${next}`, async () => {
  const lead = renderNotice('person', { kind: 'invalid', message: 'Reset required' })
  await act(async () => { container.querySelector('button')!.click() })
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  await act(async () => {
    lead.state = { ...lead.state, chatControlProblem: next ? { kind: next, message: 'Recovery changed' } : null }
    lead.notify()
  })
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(lead.resetChatControl).not.toHaveBeenCalled()
})

it('shows project repair guidance for an unavailable folder without offering Reset', () => {
  renderNotice('person', { kind: 'unavailable', message: 'Restore the selected project folder and its access permissions, then try again.' })
  expect(container.textContent).toContain('Restore the selected project folder')
  expect(container.textContent).not.toContain('Reset chat control')
})

it('does not show an unavailable warning on a chat without a Lead record', () => {
  renderNotice(null, { kind: 'unavailable', message: 'Restore the selected project folder.' })
  expect(container.textContent).toBe('')
})

for (const holder of ['lead', 'person'] as const) it(`re-reads an escalated I/O notice and restores ${holder} controls without resetting`, async () => {
  const lead = renderNotice(holder, { kind: 'invalid', retryable: true, message: 'Try again to read chat control. Reset clears the record.' })
  const buttons = Array.from(container.querySelectorAll('button'))
  expect(buttons.slice(0, 2).map(button => button.textContent)).toEqual(['Try again', 'Reset chat control'])
  expect(container.textContent).toContain(holder === 'person' ? 'Hand back to Dex' : 'Take over')
  lead.readChatControl.mockImplementationOnce(async () => { lead.state = { ...lead.state, chatControlProblem: null }; lead.notify() })
  await act(async () => { buttons[0]!.click() })
  expect(lead.readChatControl).toHaveBeenCalledOnce()
  expect(lead.resetChatControl).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('Try again')
  expect(container.textContent).not.toContain('Reset chat control')
  expect(container.textContent).toContain(holder === 'person' ? 'Hand back to Dex' : 'Take over')
})
