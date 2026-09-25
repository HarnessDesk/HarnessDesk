import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { SeatAttachmentsRecord, SeatId } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SeatAttachments } from './SeatAttachments'

/**
 * Decision 19 of the phase-12 plan: a Seat name card and historical details
 * show `loaded`, `not-loaded` and `not recorded` as three separate facts, and
 * an old Seat (or one that declared nothing) is never dressed up as having
 * "loaded nothing" — that would be a success tone this desk never measured.
 * Decision "An epoch remains historical... A restored observation gets an
 * explicit Restored chip and never says currently loaded" is the other half:
 * `restored` always wins the status line, whatever `historical` says.
 */

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

const settle = () => act(async () => {})
const SNAPSHOT = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
const SEAT = 'seat-1' as SeatId

const storeFor = (record: SeatAttachmentsRecord | null): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => SNAPSHOT,
    readSeatAttachments: vi.fn(async () => record),
  }) as unknown as AppStore

const RECORD: SeatAttachmentsRecord = {
  version: 1,
  seat: SEAT,
  agentDigest: 'd'.repeat(64),
  runtime: 'one',
  build: '1.0.0',
  epoch: 0,
  observedAt: 1,
  skillsMode: 'allowlist',
  mcpMode: 'allowlist',
  declarations: [
    { kind: 'skill', name: 'review', identity: { kind: 'skill', name: 'review', digest: 'a'.repeat(64), source: 'library', pathLabel: '~/.skills/review' }, problem: null },
    { kind: 'mcp', name: 'search', identity: { kind: 'mcp', name: 'search', digest: 'b'.repeat(64), source: 'library', pathLabel: '~/.mcp/search' }, problem: 'This runtime cannot load this attachment for one Seat.' },
  ],
  results: [
    { identity: { kind: 'skill', name: 'review', digest: 'a'.repeat(64), source: 'library', pathLabel: '~/.skills/review' }, status: 'loaded', reason: null },
    { identity: { kind: 'mcp', name: 'search', digest: 'b'.repeat(64), source: 'library', pathLabel: '~/.mcp/search' }, status: 'not-loaded', reason: 'This runtime cannot load this attachment for one Seat.' },
  ],
  restored: false,
}

it('no sidecar reads "Not recorded", never invented as a loaded-nothing success', async () => {
  const store = storeFor(null)
  act(() => root.render(<StoreProvider store={store}><SeatAttachments seat={SEAT} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('Not recorded')
  expect(text).not.toContain('Loaded')
})

it('a loaded skill and an unsupported server are shown distinctly, each with its own reason', async () => {
  const store = storeFor(RECORD)
  act(() => root.render(<StoreProvider store={store}><SeatAttachments seat={SEAT} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('review')
  expect(text).toContain('search')
  expect(text).toContain('This runtime cannot load this attachment for one Seat.')
  const tones = [...container.querySelectorAll('[data-tone]')].map((node) => node.textContent)
  expect(tones).toContain('Loaded')
  expect(tones).toContain('Not loaded')
})

it('a restored epoch never says currently loaded, whatever historical says', async () => {
  const store = storeFor({ ...RECORD, restored: true })
  act(() => root.render(<StoreProvider store={store}><SeatAttachments seat={SEAT} historical={false} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('Restored')
  expect(text).not.toMatch(/currently loaded/i)
})

it('a live epoch on the current Seat reads differently from the same epoch shown as history', async () => {
  const live = storeFor(RECORD)
  act(() => root.render(<StoreProvider store={live}><SeatAttachments seat={SEAT} /></StoreProvider>))
  await settle()
  const liveText = container.textContent ?? ''

  act(() => root.unmount())
  root = createRoot(container)
  const historical = storeFor(RECORD)
  act(() => root.render(<StoreProvider store={historical}><SeatAttachments seat={SEAT} historical /></StoreProvider>))
  await settle()
  const historicalText = container.textContent ?? ''

  expect(liveText).not.toEqual(historicalText)
})

it('names the runtime by its presentation, never its id (rule 8)', async () => {
  const snapshot = { ...SNAPSHOT, runtimes: [{ id: 'one', presentation: { name: 'Pretty Agent' } }] } as unknown as AppSnapshot
  const store = { ...storeFor(RECORD), getSnapshot: () => snapshot } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SeatAttachments seat={SEAT} /></StoreProvider>))
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('Currently on Pretty Agent')
  expect(text).not.toMatch(/on one\b/)
})
