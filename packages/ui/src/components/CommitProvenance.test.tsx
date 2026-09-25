import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { CommitProvenance as CommitProvenanceValue } from '@harnessdesk/protocol'

import { CommitProvenance, CommitSeatLabels } from './CommitProvenance'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { cardEvidence, factView } from '../preview/evidence-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const value = (count = 1): CommitProvenanceValue => ({
  sha: 'a'.repeat(40), state: 'attributed', coverage: 'complete', via: 'observed', reason: null,
  explanation: 'Observed locally.', evidenceIds: [], cards: [], observedAt: 1,
  seats: Array.from({ length: count }, (_, index) => ({ id: `seat-${index}`, agentName: `Contributor ${index + 1}`, runtime: 'fixture', seatLabel: 'Alpha · careful', session: { runtime: 'fixture', sessionId: `conversation-${index}` } })),
})
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it('keeps a history label as one noninteractive line while naming additional Seats', async () => {
  await act(async () => root.render(<CommitSeatLabels value={value(3)} />))
  expect(host.textContent).toBe('Contributor 1 +2 Seats')
  expect(host.querySelector('button, a, input')).toBeNull()
  expect(host.querySelector('[data-provenance-label]')?.getAttribute('title')).toBe('Alpha · careful')
})

it('does not manufacture a history label without an attributed Seat', async () => {
  await act(async () => root.render(<CommitSeatLabels value={{ ...value(), seats: [] }} />))
  expect(host.textContent).toBe('')
})

it('keeps a supplied history batch Seat actionable when its redundant detail read fails', async () => {
  // The history pane already owns this batch; detail must not erase its Seat
  // just because its opportunistic refresh is unavailable.
  const supplied = value()
  const snapshot = { ...emptySnapshot(), status: 'open' }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    readProvenance: async () => { throw new Error('unavailable') },
    readProvenanceSeat: async () => ({ seat: null, session: null, unavailable: null }),
  } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><CommitProvenance root="/work/project" sha={supplied.sha} value={supplied} /></StoreProvider>))
  expect(host.textContent).toContain('Contributor 1')
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Seat record')).toBe(true)
})

it('treats an optional preview store response as an empty provenance batch', async () => {
  const snapshot = { ...emptySnapshot(), status: 'open' }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    readProvenance: async () => undefined,
  } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><CommitProvenance root="/work/project" sha={'a'.repeat(40)} /></StoreProvider>))
  expect(host.textContent).toContain('Reading provenance')
})

it('renders a runtime mark and returned card evidence for an attributed Seat', async () => {
  const supplied = { ...value(), cards: [{ board: 'room-1', id: 7 }] }
  const snapshot = {
    ...emptySnapshot(), status: 'open',
    runtimes: [{ id: 'fixture', presentation: { name: 'Fixture', brand: 'codex' } }],
    boardEvidence: new Map(),
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readProvenance: async () => undefined } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><CommitProvenance root="/work/project" sha={supplied.sha} value={supplied} /></StoreProvider>))
  expect(host.querySelector('svg')).not.toBeNull()
  expect(host.textContent).toContain('no longer has evidence')
})

it('keeps the way into a historical card\'s evidence when its only fact is a diff that changed nothing', async () => {
  const supplied = { ...value(), cards: [{ board: 'room-1', id: 7 }] }
  const none = factView({ kind: 'diff', files: 0, added: 0, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) }, { card: 7 })
  const snapshot = {
    ...emptySnapshot(), status: 'open',
    runtimes: [{ id: 'fixture', presentation: { name: 'Fixture', brand: 'codex' } }],
    boardEvidence: new Map([['room-1', { cards: [cardEvidence(7, [none])] }]]),
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readProvenance: async () => undefined } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><CommitProvenance root="/work/project" sha={supplied.sha} value={supplied} /></StoreProvider>))
  const entry = host.querySelector('button[aria-label^="What the desk observed on #7"]')
  expect(entry).not.toBeNull()
  expect(entry?.textContent).toBe('no changes')
  expect(host.textContent).not.toContain('no longer has evidence')
})

it('draws nothing for a zero diff on a card its board still shows being worked', async () => {
  const supplied = { ...value(), cards: [{ board: 'room-1', id: 7 }] }
  const none = factView({ kind: 'diff', files: 0, added: 0, removed: 0, from: 'a'.repeat(40), to: 'b'.repeat(40) }, { card: 7 })
  const snapshot = {
    ...emptySnapshot(), status: 'open',
    runtimes: [{ id: 'fixture', presentation: { name: 'Fixture', brand: 'codex' } }],
    boardEvidence: new Map([['room-1', { cards: [cardEvidence(7, [none])] }]]),
    teams: new Map([['room-1', { intents: [{ id: 7, state: 'claimed' }] }]]),
  }
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readProvenance: async () => undefined } as unknown as AppStore
  await act(async () => root.render(<StoreProvider store={store}><CommitProvenance root="/work/project" sha={supplied.sha} value={supplied} /></StoreProvider>))
  expect(host.querySelector('button[aria-label^="What the desk observed on #7"]')).toBeNull()
})
