import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type TeamState } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { DeleteRoom, RenameRoom } from './RoomActions'

/**
 * Correcting a room's name, and putting one away.
 *
 * Both were wire verbs with no door, so a name typed in a hurry was permanent
 * and an abandoned room stayed in the tree for good. The delete carries the
 * weight: it has to say what goes *and* what does not, because the fear it
 * raises — "are my agents about to be deleted too" — is answered no, and a
 * dialog that only lists losses does not answer it at all.
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

const room = (over: Partial<TeamState> = {}): TeamState =>
  ({
    id: 'room-1',
    name: 'Checkout rewrite',
    root: '/repo',
    members: [],
    messaging: true,
    intents: [],
    channel: [],
    ...over,
  }) as unknown as TeamState

const rig = () => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({ ...emptySnapshot(), status: 'open' }) as unknown as AppSnapshot,
    renameRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi
      .fn()
      .mockResolvedValue({ name: 'Checkout rewrite', intents: 2, members: 1, messages: 3 }),
    notice: vi.fn(),
  } as unknown as AppStore
  return { store }
}

const press = (name: string): void => {
  const found = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes(name),
  )
  if (!found) throw new Error(`no button ${name}`)
  act(() => found.click())
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

it('renames a room, and says the rename is only the label', async () => {
  const { store } = rig()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RenameRoom room={room()} onClose={onClose} />
      </StoreProvider>,
    )
  })

  // Prefilled, because renaming is usually correcting.
  const field = document.querySelector<HTMLInputElement>('[aria-label="Room name"]')!
  expect(field.value).toBe('Checkout rewrite')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      field,
      'Tax rounding',
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  press('Rename')
  await settle()

  expect(store.renameRoom).toHaveBeenCalledWith('room-1', 'Tax rounding')
  expect(onClose).toHaveBeenCalled()
  expect(container.textContent).toContain('board, its members and everything said in it are untouched')
})

it('a rename that changes nothing asks the host for nothing', async () => {
  const { store } = rig()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RenameRoom room={room()} onClose={onClose} />
      </StoreProvider>,
    )
  })
  press('Rename')
  await settle()

  expect(store.renameRoom).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('the delete names what goes, counted', () => {
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <DeleteRoom
          room={room({
            intents: [{ id: 1 }, { id: 2 }] as never,
            channel: [{ kind: 'message' }, { kind: 'signal' }] as never,
          })}
          onClose={vi.fn()}
        />
      </StoreProvider>,
    )
  })

  // Jobs and messages, not entries: a signal is not something somebody wrote.
  expect(container.textContent).toContain('2 jobs and 1 message')
  expect(container.textContent).toContain('cannot be undone')
})

it('the delete says the conversations survive, which is the fear it answers', () => {
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <DeleteRoom
          room={room({ members: [sessionKey('codex', 'c1'), sessionKey('claude', 'k1')] })}
          onClose={vi.fn()}
        />
      </StoreProvider>,
    )
  })

  expect(container.textContent).toContain('All 2 conversations in it leave the room and carry on')
  expect(container.textContent).toContain('no transcript is touched')
})

it('one conversation is said in the singular', () => {
  // A recording read "1 conversation leave the room and carry on". The tests
  // only ever built rooms with two members, so nothing had said it aloud.
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <DeleteRoom room={room({ members: [sessionKey('codex', 'c1')] })} onClose={vi.fn()} />
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('The one conversation in it leaves the room and carries on')
})

it('an empty room does not pretend to be losing something', () => {
  const { store } = rig()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <DeleteRoom room={room()} onClose={vi.fn()} />
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('nothing on its board')
  expect(container.textContent).toContain('No conversations are in it.')
})

it('deletes, and reports what the host said went', async () => {
  const { store } = rig()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <DeleteRoom room={room()} onClose={onClose} />
      </StoreProvider>,
    )
  })
  press('Delete room')
  await settle()

  expect(store.deleteRoom).toHaveBeenCalledWith('room-1')
  // The host's counts, not the dialog's — they are what actually went.
  expect(store.notice).toHaveBeenCalledWith(
    'info',
    expect.stringContaining('2 jobs and 3 messages'),
  )
  expect(onClose).toHaveBeenCalled()
})

it('stays open and says why when the host will not delete it', async () => {
  const { store } = rig()
  ;(store.deleteRoom as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('There is no room room-1.'),
  )
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <DeleteRoom room={room()} onClose={onClose} />
      </StoreProvider>,
    )
  })
  press('Delete room')
  await settle()

  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain('no room room-1')
})
