import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProvenanceDialog } from './ProvenanceDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let store: AppStore
let snapshot: AppSnapshot

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  snapshot = { ...emptySnapshot(), status: 'open' }
  store = { subscribe: () => () => {}, getSnapshot: () => snapshot, readProvenanceSeat: vi.fn(async () => ({ seat: null, session: null, unavailable: 'Gone.' })) } as unknown as AppStore
})
afterEach(() => { act(() => root.unmount()); host.remove() })

it('reads the exact immutable Seat id rather than a current session', async () => {
  await act(async () => root.render(<StoreProvider store={store}><ProvenanceDialog root="/work/project" seat="seat-17" onClose={() => {}} /></StoreProvider>))
  expect(store.readProvenanceSeat).toHaveBeenCalledWith('/work/project', 'seat-17')
})

/** The host's own reason is said once — never followed by the generic sentence it already answers. */
it('says why a record is unavailable once, not the specific reason and then the generic one', async () => {
  await act(async () => root.render(<StoreProvider store={store}><ProvenanceDialog root="/work/project" seat="seat-17" onClose={() => {}} /></StoreProvider>))
  await act(async () => {})
  expect(document.body.textContent).toContain('Gone.')
  expect(document.body.textContent).not.toContain('The historical Seat record is unavailable.')
})
