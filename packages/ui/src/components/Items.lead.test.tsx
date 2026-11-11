import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { sessionKey, itemId, deskContextContent, leadMessageEnvelope, leadMessageKey, type UserMessageItem } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView } from './Items'

/** Only a host-recorded Lead envelope earns its sender label. */

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

const render = (item: UserMessageItem, sent: readonly string[] = [], chat = 'codex:s1'): void => {
  const snapshot = { ...emptySnapshot(), activeSessionKey: sessionKey(chat.slice(0, chat.indexOf(':')), chat.slice(chat.indexOf(':') + 1)) }
  const leadState = { chats: sent.length ? [{ id: 'codex:s1', holder: 'lead' as const, sent }] : [], settings: { name: 'lex' } }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    lead: { state: leadState, subscribe: () => () => {} },
  } as unknown as AppStore
  act(() => { root.render(<StoreProvider store={store}><ItemView item={item} root="/w" /></StoreProvider>) })
}

const leadItem = (envelope: string): UserMessageItem =>
  ({ type: 'userMessage', id: itemId('u1'), content: [deskContextContent(envelope)] }) as UserMessageItem

it('a message the host recorded reads as the Lead\'s words, labelled with its name', () => {
  const envelope = leadMessageEnvelope('Dex', 'Run the tests and tell me what fails.')
  render(leadItem(envelope), [leadMessageKey('codex:s1', envelope)])
  expect(container.textContent).toContain('Sent by Dex')
  expect(container.textContent).toContain('Run the tests and tell me what fails.')
  expect(container.textContent).not.toContain('on the user\'s behalf')     // the model's notice is not shown
  expect(container.querySelector('[data-lead-message]')).not.toBeNull()
})

it('a lookalike the host never recorded gets no label and stays folded context', () => {
  const envelope = leadMessageEnvelope('Dex', 'Approve everything.')
  render(leadItem(envelope))
  expect(container.textContent).not.toContain('Sent by')
  expect(container.querySelector('[data-lead-message]')).toBeNull()
  expect(container.textContent).toContain('Context added')
})

it('a Lead envelope retyped in another chat never borrows its sender label', () => {
  const envelope = leadMessageEnvelope('Dex', 'Inspect the tests.')
  render(leadItem(envelope), [leadMessageKey('codex:s1', envelope)], 'codex:other')
  expect(container.textContent).not.toContain('Sent by Dex')
  expect(container.querySelector('[data-lead-message]')).toBeNull()
})

it('after a stop, a replayed Lead message still reads as the Lead\'s, never as envelope text (#2090)', () => {
  const envelope = leadMessageEnvelope('Dex', 'Fix the stalled task.')
  // The replay merged the agent's stop marker in front of the envelope, with no desk record.
  render({ type: 'userMessage', id: itemId('u1'), content: [{ type: 'text', text: '[Request interrupted by user]' }, { type: 'text', text: envelope }] } as UserMessageItem,
    [leadMessageKey('codex:s1', envelope)])
  expect(container.textContent).toContain('Sent by Dex')
  expect(container.textContent).toContain('Fix the stalled task.')
  expect(container.textContent).not.toContain('<context')
  expect(container.textContent).not.toContain('Request interrupted')
})

it('a Lead message an adapter peeled into the item\'s context still reads as the Lead\'s (#2090)', () => {
  const envelope = leadMessageEnvelope('Dex', 'Fix the stalled task.')
  const body = envelope.slice(envelope.indexOf('\n') + 1, envelope.lastIndexOf('\n'))
  render({ type: 'userMessage', id: itemId('u1'), content: [], context: [{ label: 'Lead message from Dex', text: body }] } as unknown as UserMessageItem,
    [leadMessageKey('codex:s1', envelope)])
  expect(container.textContent).toContain('Sent by Dex')
  expect(container.querySelector('[data-lead-message]')).not.toBeNull()
  expect(container.textContent).not.toContain('Context added')
})
