import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { turnId, type Session, type Turn } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TurnTail } from './TurnTail'

/**
 * What a turn says under itself when it has nothing to show.
 *
 * A failed turn names its reason with the alert every failed action uses, so
 * it reads, and is announced, the way a failed commit or checkout is. A turn
 * that finished silently says so in the same drawing, but politely: it
 * interrupts nothing, because nothing the person did was refused.
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

const render = async (turn: Turn) => {
  const snapshot = { ...emptySnapshot(), status: 'open' } as unknown as AppSnapshot
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, setDetailsTab: vi.fn() } as unknown as AppStore
  const session = { cwd: '/work/storefront', turns: [turn], usage: null } as unknown as Session
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <TurnTail turn={turn} session={session} />
      </StoreProvider>,
    )
  })
  return container.querySelector<HTMLElement>('[data-slot="alert"]')
}

it('names the reason a turn failed with the alert every failed action uses', async () => {
  const alert = await render({
    id: turnId('t1'),
    items: [],
    status: 'failed',
    diff: null,
    error: { message: 'Internal error: the session is owned by another process', retrying: true },
  } as Turn)

  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.querySelector('[data-slot="alert-content"]')?.textContent).toBe(
    'Internal error: the session is owned by another process Retrying…',
  )
})

it('says a silent turn ended with nothing, in the same drawing, without interrupting', async () => {
  const alert = await render({ id: turnId('t1'), items: [], status: 'completed', diff: null } as Turn)

  expect(alert?.getAttribute('role')).toBe('status')
  expect(alert?.textContent).toBe('The agent finished this turn without any output.')
})
