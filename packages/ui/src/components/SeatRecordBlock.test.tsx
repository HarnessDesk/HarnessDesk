import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionKey, type Session, type SessionId, type TeamState } from '@harnessdesk/protocol'

import { EVIDENCE_ROOM, PREVIEW_SEAT } from '../preview/evidence-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SeatRecordBlock } from './SeatRecordBlock'

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

const KEY = sessionKey(runtimeId('codex'), 's1' as SessionId)

const mount = async (seatRecord: (runtime: string, sessionId: string) => Promise<unknown>) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/home/dev',
    activeSessionKey: KEY,
    sessions: new Map([
      [
        KEY,
        {
          id: 's1',
          runtime: 'codex',
          cwd: '/home/dev/code/HarnessDesk',
          turns: [],
          itemsLoaded: true,
        } as unknown as Session,
      ],
    ]),
    teams: new Map([
      [EVIDENCE_ROOM, { id: EVIDENCE_ROOM, name: 'Checkout hardening' } as unknown as TeamState],
    ]),
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    seatRecord: vi.fn(seatRecord),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <SeatRecordBlock />
      </StoreProvider>,
    )
  })
  await act(async () => {})
  return store
}

it('shows who was seated, on what, told what, where, on which board, and since when', async () => {
  const store = await mount(async () => PREVIEW_SEAT)
  expect(store.seatRecord).toHaveBeenCalledWith('codex', 's1')
  const text = container.textContent ?? ''
  expect(text).toContain('Seat record')
  expect(text).toContain('Scout · In HarnessDesk')
  expect(text).toContain('Alpha · alpha-max')
  expect(text).toContain('Beta · beta-pro — passed over')
  expect(text).toContain('Read · asked')
  expect(text).toContain('retry-on-502 at a1b2c3d')
  expect(text).toContain('~/code/HarnessDesk')
  expect(text).toContain('Checkout hardening')
  expect(text).toContain('Open')
  expect(container.querySelector('button, input, textarea')).toBeNull()
})

it('a closed seat says how the desk let it go', async () => {
  await mount(async () => ({
    ...PREVIEW_SEAT,
    closed: { at: Date.UTC(2026, 8, 18, 15, 0), why: 'deleted' },
  }))
  expect(container.textContent).toContain('Its conversation was deleted')
})

it("a seat phase 3 kept for an Agent that said only `ceiling:` is drawn in that order's words", async () => {
  await mount(async () => ({ ...PREVIEW_SEAT, standing: { kind: 'ceiling', level: 'edit' } }))
  expect(container.textContent).toContain('Edit · its ceiling')
  expect(container.textContent).not.toContain('Read · asked')
})

it('a Seat a backup brought says so, and that it says nothing about this conversation here', async () => {
  await mount(async () => ({ ...PREVIEW_SEAT, restored: { at: Date.UTC(2026, 8, 18, 16, 0) } }))
  expect(container.textContent).toContain('From a backup')
  expect(container.textContent).toContain('This desk did not keep this seat')
})

it('a conversation the desk never seated shows nothing', async () => {
  await mount(async () => null)
  expect(container.innerHTML).toBe('')
})

it('a record that cannot be read says so, in the host’s words', async () => {
  await mount(async () => {
    throw new Error('the connection to HarnessDesk was lost')
  })
  expect(container.textContent).toBe('Its Seat record could not be read: the connection to HarnessDesk was lost')
})
