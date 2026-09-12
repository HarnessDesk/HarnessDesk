import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionKey, turnId, type FileChange, type SessionId, type Turn } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore, type TurnUndo } from '../state/store'
import { TurnFiles } from './TurnFiles'

/**
 * The card under a turn, and the one refusal it can offer a way out of.
 *
 * A turn holding a deletion the agent recorded no content for cannot be undone
 * whole — writing an empty file back over the real one is the loss an undo
 * exists to prevent — and that refusal used to be the end of it, even though
 * the updates and recorded deletions beside it could still go back (#237).
 *
 * What must not happen is the offer appearing on its own: it is drawn off the
 * code the host put on that one refusal, never up front and never off any
 * other failure.
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

const KEY = sessionKey(runtimeId('codex'), 's1' as SessionId)
const TURN: Turn = { id: turnId('t1'), items: [], status: 'completed', diff: null }
const CHANGES: readonly FileChange[] = [
  { path: '/work/storefront/src/retry.ts', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n-one\n+1\n two\n' },
]

const rig = async (answers: TurnUndo[]) => {
  const snapshot = { ...emptySnapshot(), status: 'open', activeSessionKey: KEY } as unknown as AppSnapshot
  const revertTurn = vi.fn(async () => answers.shift() ?? { done: true, unrecoverable: false })
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    revertTurn,
    redoTurn: vi.fn(async () => ({ done: true, unrecoverable: false })),
    setDetailsTab: vi.fn(),
    openFile: vi.fn(),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <TurnFiles turn={TURN} changes={CHANGES} root="/work/storefront" />
      </StoreProvider>,
    )
  })
  return { revertTurn }
}

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)

it('offers the recoverable half of a turn only after the host refuses for that reason (#237)', async () => {
  const { revertTurn } = await rig([{ done: false, unrecoverable: true }])

  // The control: nothing extra is offered up front. Most turns have nothing
  // unrecoverable in them, and an undo that can go whole must not read as half.
  expect(button('Undo the rest')).toBeUndefined()

  await act(async () => button('Undo')!.click())
  expect(revertTurn).toHaveBeenLastCalledWith(TURN.id, KEY, {})

  const rest = button('Undo the rest')
  expect(rest).toBeDefined()
  await act(async () => rest!.click())
  expect(revertTurn).toHaveBeenLastCalledWith(TURN.id, KEY, { skipUnrecoverable: true })
})

it('offers nothing extra for a refusal with no way out', async () => {
  // A file edited since is the ordinary refusal: there is no half of it to ask for.
  const { revertTurn } = await rig([{ done: false, unrecoverable: false }])

  await act(async () => button('Undo')!.click())

  expect(button('Undo the rest')).toBeUndefined()
  expect(button('Undo')).toBeDefined()
  expect(revertTurn).toHaveBeenCalledTimes(1)
})

it('an undo that went through offers a redo, and nothing to skip', async () => {
  await rig([{ done: true, unrecoverable: false }])

  await act(async () => button('Undo')!.click())

  expect(button('Redo')).toBeDefined()
  expect(button('Undo the rest')).toBeUndefined()
})
