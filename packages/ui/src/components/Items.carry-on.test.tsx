import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CARRY_ON_PHASES, itemId, runtimeId, sessionId, type CarryOnItem } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView, ReadOnlyTranscript } from './Items'
import { formatReset } from '../lib/limits'

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

const openSession = vi.fn(async () => true)
const render = (item: CarryOnItem, readOnly = false) => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, openSession } as unknown as AppStore
  const view = <ItemView item={item} />
  act(() => root.render(<StoreProvider store={store}>{readOnly ? <ReadOnlyTranscript>{view}</ReadOnlyTranscript> : view}</StoreProvider>))
}

const RESET = new Date(2026, 10, 11, 15, 40).getTime()
const base = {
  id: itemId('carry'), type: 'carryOn', cause: 'credits',
  from: { name: 'Codex', account: 'work', model: 'Sol' },
  to: { name: 'Codex', account: 'personal', model: 'Sol' },
  resetsAt: RESET,
} as const satisfies Omit<CarryOnItem, 'phase'>

const marker = () => container.querySelector('[data-carry-on]')
const headline = () => marker()?.querySelector('[data-role="row"]')?.textContent

it('draws every phase as a marker across the column, never as a folded row', () => {
  for (const phase of CARRY_ON_PHASES) {
    render({ ...base, phase, ...(phase === 'left' || phase === 'arrived' ? { link: { runtime: runtimeId('claude'), sessionId: sessionId('other') } } : {}) })
    expect(marker()?.getAttribute('data-carry-on')).toBe(phase)
    expect(headline()).toBeTruthy()
    expect(container.querySelector('button[aria-expanded]')).toBeNull()
  }
})

it('a same-thread switch names both sides, the account that ran out, and its reset', () => {
  render({ ...base, phase: 'switched', mode: 'sameThread' })
  expect(headline()).toBe('Switched from Codex · work to Codex · personal · Sol')
  expect(marker()?.textContent).toContain('Codex · work reached its usage limit')
  expect(marker()?.textContent).toContain(`resets ${formatReset(RESET)}`)
})

it('a changed model shows on both sides, with the host note under it', () => {
  render({ ...base, phase: 'switched', to: { name: 'Codex', account: 'personal', model: 'Sol Mini' }, note: 'Sol is not on this account; using Sol Mini' })
  expect(headline()).toBe('Switched from Codex · work · Sol to Codex · personal · Sol Mini')
  expect(marker()?.textContent).toContain('Sol is not on this account; using Sol Mini.')
})

it('the old conversation links forward to the new one, and the new one back', () => {
  const forward = { runtime: runtimeId('claude'), sessionId: sessionId('new-chat') }
  render({ ...base, phase: 'left', mode: 'handoff', to: { name: 'Claude Code', model: 'Opus' }, link: forward })
  expect(headline()).toBe('Continued in a new conversation with Claude Code · Opus')
  const open = [...container.querySelectorAll('button')].find(button => button.textContent === 'Open')!
  act(() => open.click())
  expect(openSession).toHaveBeenLastCalledWith('new-chat', { runtime: 'claude' })

  const back = { runtime: runtimeId('codex'), sessionId: sessionId('old-chat') }
  render({ ...base, phase: 'arrived', mode: 'handoff', to: { name: 'Claude Code', model: 'Opus' }, link: back })
  expect(headline()).toBe('Continued from Codex · work · Sol on Claude Code · Opus')
  const earlier = [...container.querySelectorAll('button')].find(button => button.textContent === 'Earlier history')!
  act(() => earlier.click())
  expect(openSession).toHaveBeenLastCalledWith('old-chat', { runtime: 'codex' })
})

it('a read-only transcript names the move but offers no link that would direct the desk', () => {
  render({ ...base, phase: 'left', link: { runtime: runtimeId('claude'), sessionId: sessionId('new-chat') } }, true)
  expect(headline()).toContain('Continued in a new conversation')
  expect(container.querySelector('button')).toBeNull()
})

it('waiting, resumed and stopped say the account and the reset in plain words', () => {
  render({ ...base, phase: 'waiting', to: undefined })
  expect(headline()).toBe(`Waiting for Codex · work · Sol to reset at ${formatReset(RESET)}`)
  render({ ...base, phase: 'resumed', to: undefined, resetsAt: undefined })
  expect(headline()).toBe('Resumed on Codex · work · Sol after its reset')
  render({ ...base, phase: 'exhausted', to: undefined })
  expect(headline()).toBe('Stopped on Codex · work · Sol')
  expect(marker()?.textContent).toContain('No other account or agent has room.')
  render({ ...base, phase: 'stopped', to: undefined, resetsAt: undefined, note: 'No reset time known' })
  expect(marker()?.textContent).toContain('Codex · work reached its usage limit. No reset time known.')
})

it('never shows an email, even when a record carries one by mistake', () => {
  render({ ...base, phase: 'switched', from: { name: 'Codex', account: 'dev@example.com' }, to: { name: 'Codex', account: 'jane@example.com' } })
  expect(container.textContent).not.toContain('@')
  expect(headline()).toBe('Switched from Codex to Codex')
})

it('names come from the record, and markup in them stays literal text', () => {
  render({ ...base, phase: 'switched', to: { name: '<img src=x onerror=alert(1)>', account: 'personal' } })
  expect(container.querySelector('img')).toBeNull()
  expect(headline()).toContain('<img src=x onerror=alert(1)>')
})

it('a stop that left the conversation open elsewhere says where, and opens it', () => {
  const there = { runtime: runtimeId('codex'), sessionId: sessionId('chat') }
  const note = 'You sent a message first. The conversation is also open on Codex · personal, where it was in use.'
  render({ ...base, phase: 'stopped', mode: 'sameThread', note, link: there })
  expect(headline()).toBe('Stopped on Codex · work · Sol')
  expect(marker()?.textContent).toContain(`Codex · work reached its usage limit · resets ${formatReset(RESET)}. ${note}`)
  const open = [...container.querySelectorAll('button')].find(button => button.textContent === 'Open')!
  expect(open.getAttribute('title')).toBe('Open the conversation where it is also open')
  act(() => open.click())
  expect(openSession).toHaveBeenLastCalledWith('chat', { runtime: 'codex' })
  render({ ...base, phase: 'stopped', note, link: there }, true)
  expect(container.querySelector('button')).toBeNull()
})

it('a note the host wrote as a phrase reads as a sentence', () => {
  render({ ...base, phase: 'stopped', to: undefined, note: 'stopped at your answer' })
  expect(marker()?.textContent).toContain('. Stopped at your answer.')
  render({ ...base, phase: 'exhausted', to: undefined, note: 'no other account or agent has room' })
  expect(marker()?.textContent).toContain('. No other account or agent has room.')
})
