import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type ConfigOption } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AddMember } from './AddMember'

/**
 * Adding a member, from the roster that lists them.
 *
 * There was no way to do this: a conversation joined because it happened to be
 * open in the folder and happened to take a turn, so adding one meant leaving
 * the room, starting a session elsewhere, sending it something, and coming back
 * to see whether it had appeared.
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

const MODELS: ConfigOption = {
  id: 'model',
  label: 'Model',
  type: 'select',
  currentValue: 'haiku',
  choices: [
    { value: 'haiku', label: 'Haiku' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus', disabled: 'not on this plan' },
  ],
}

const rig = (
  options: readonly ConfigOption[] = [MODELS],
  /** Conversations already running in the project, and the rooms they are in. */
  world: {
    history?: readonly unknown[]
    teams?: ReadonlyMap<string, unknown>
    listPrefs?: Record<string, unknown>
  } = {},
) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'claude-code',
    workspace: { path: '/repo', name: 'repo', lastOpenedAt: 1 },
    workspaces: [{ path: '/repo', name: 'repo', lastOpenedAt: 1 }],
    history: world.history ?? [],
    teams: world.teams ?? new Map(),
    listPrefs: { ...emptySnapshot().listPrefs, ...(world.listPrefs ?? {}) },
    runtimes: [
      { id: 'claude-code', presentation: { name: 'Claude Code' }, capabilities: {} },
      { id: 'codex', presentation: { name: 'Codex' }, capabilities: {} },
    ],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newSessionDefaultsFor: vi.fn().mockResolvedValue(options),
    setNewSessionDefault: vi.fn().mockResolvedValue(options),
    newSession: vi.fn().mockResolvedValue(sessionKey('claude-code', 's1')),
    joinRoom: vi.fn().mockResolvedValue(undefined),
    toggleCollapsed: vi.fn(),
  } as unknown as AppStore
  return { store }
}

const render = async (store: AppStore, onClose = vi.fn()): Promise<typeof onClose> => {
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <AddMember room="room-1" root="/repo" onClose={onClose} />
      </StoreProvider>,
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  return onClose
}

const select = (label: string): HTMLSelectElement => {
  const found = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!found) throw new Error(`no select labelled ${label}`)
  return found
}

const press = (name: string): void => {
  const found = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes(name),
  )
  if (!found) throw new Error(`no button ${name}`)
  act(() => found.click())
}

it('offers the agents, and the options that agent declares', async () => {
  const { store } = rig()
  await render(store)

  expect([...select('Agent').options].map((one) => one.textContent)).toEqual([
    'Claude Code',
    'Codex',
  ])
  expect([...select('Model').options].map((one) => one.value)).toEqual(['haiku', 'sonnet', 'opus'])
})

it('a choice the plan forbids is offered greyed with the reason, not removed', async () => {
  // An absent control is a support ticket; a disabled one is an explanation.
  const { store } = rig()
  await render(store)

  const opus = [...select('Model').options].find((one) => one.value === 'opus')
  expect(opus?.disabled).toBe(true)
  expect(opus?.textContent).toContain('not on this plan')
})

it('a pick is stored against the agent, and re-asks it', async () => {
  // The answer changes the question: a model with one context window greys its
  // own Max-mode switch, so the list is re-declared rather than patched.
  const { store } = rig()
  await render(store)

  act(() => {
    const model = select('Model')
    model.value = 'sonnet'
    model.dispatchEvent(new Event('change', { bubbles: true }))
  })

  expect(store.setNewSessionDefault).toHaveBeenCalledWith('claude-code', 'model', 'sonnet')
})

it('starts it in the room’s folder and puts it in the room, then closes', async () => {
  const { store } = rig()
  const onClose = await render(store)

  press('Add to room')
  await act(async () => {
    await Promise.resolve()
  })

  // `reveal: false`: main is a slot, so showing the new conversation would
  // replace the room being staffed and leave the person on an empty draft.
  expect(store.newSession).toHaveBeenCalledWith({
    cwd: '/repo',
    runtime: 'claude-code',
    reveal: false,
  })
  // Starting it is half the job. Membership is explicit — a project holds
  // several rooms, so being open in the folder cannot mean being in one — and
  // a conversation that started without joining is an agent the rail never
  // lists and the board never reaches.
  expect(store.joinRoom).toHaveBeenCalledWith('room-1', 'claude-code', 's1')
  expect(onClose).toHaveBeenCalled()
})

it('says so, and stays open, when the room will not take it', async () => {
  // The host refuses a conversation from another project. Closing on that
  // refusal would leave a started agent nobody asked for and no word about it.
  const { store } = rig()
  ;(store.joinRoom as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('That conversation is working in /elsewhere, which is outside /repo.'),
  )
  const onClose = await render(store)

  press('Add to room')
  await act(async () => {
    await Promise.resolve()
  })

  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain('outside /repo')
})

const running = (over: { id: string; title?: string; runtime?: string }) => ({
  id: over.id,
  runtime: over.runtime ?? 'codex',
  title: over.title ?? over.id,
  preview: null,
  cwd: '/repo',
  status: { type: 'notLoaded' },
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  turns: [],
})

it('offers the conversations already running here, and joins the one picked', async () => {
  /* The room entry point tells somebody they choose which of the project's
     conversations join. Before this the only path into a room was creating a
     brand-new session, so that sentence was a promise with no door behind it. */
  const { store } = rig([MODELS], { history: [running({ id: 's1', title: 'API migration' })] })
  const onClose = await render(store)

  act(() => {
    const running_ = [...document.querySelectorAll('button')].find((one) =>
      one.textContent?.includes('One already running'),
    )
    ;(running_ as HTMLButtonElement).click()
  })

  const row = document.querySelector<HTMLInputElement>('[aria-label="API migration"]')
  if (!row) throw new Error('the running conversation was not offered')
  act(() => row.click())
  press('Add to room')
  await act(async () => {
    await Promise.resolve()
  })

  expect(store.joinRoom).toHaveBeenCalledWith('room-1', 'codex', 's1')
  // Joining is not starting: nothing new is spawned.
  expect(store.newSession).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('does not offer a conversation that is already in a room', async () => {
  // `joinRoom` would move it, and a picker that quietly empties another room
  // is not one somebody can use safely.
  const { store } = rig([MODELS], {
    history: [running({ id: 's1', title: 'API migration' })],
    teams: new Map([
      [
        'room-2',
        { id: 'room-2', name: 'Elsewhere', root: '/repo', members: [sessionKey('codex', 's1')], intents: [], channel: [], messaging: true },
      ],
    ]),
  })
  await render(store)

  const choice = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('One already running'),
  ) as HTMLButtonElement
  expect(choice.disabled).toBe(true)
  expect(choice.getAttribute('title')).toContain('already in a room')
})

it('offers every loose conversation, even when the sidebar is filtered to one agent', async () => {
  /* `useProjectGroups` narrows by `listPrefs.agent` before grouping, which is
     right for a list somebody deliberately filtered and wrong for a dialog
     promising *every* loose conversation here. Filtered to Claude, a loose
     Codex conversation vanished and the option disabled itself claiming
     everything was already placed. */
  const { store } = rig([MODELS], {
    history: [running({ id: 's1', title: 'API migration', runtime: 'codex' })],
    listPrefs: { agent: 'claude-code' },
  })
  await render(store)

  const choice = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('One already running'),
  ) as HTMLButtonElement
  expect(choice.disabled).toBe(false)

  act(() => choice.click())
  expect(document.querySelector('[aria-label="API migration"]')).not.toBeNull()
})

it('a pick that stops being eligible stops being actionable', async () => {
  /* `picked` outlived the row it named: put that conversation in another room
     from anywhere else and its row disappeared while the button stayed armed.
     Pressing it called `joinRoom`, which moves — the silent move the exclusion
     exists to prevent, reached through a stale selection. */
  const { store } = rig([MODELS], {
    history: [running({ id: 's1', title: 'API migration' })],
  })
  const snapshot = store.getSnapshot()
  await render(store)

  act(() => {
    const choice = [...document.querySelectorAll('button')].find((one) =>
      one.textContent?.includes('One already running'),
    ) as HTMLButtonElement
    choice.click()
  })
  const row = document.querySelector<HTMLInputElement>('[aria-label="API migration"]')!
  act(() => row.click())
  expect(
    ([...document.querySelectorAll('button')].find((one) =>
      one.textContent?.includes('Add to room'),
    ) as HTMLButtonElement).disabled,
  ).toBe(false)

  /* Somebody else puts it in a room while this dialog is open. A *new* map,
     the way `team/changed` patches the store — mutating the one in place is
     something the app never does, and a memo would not see it. */
  ;(snapshot as { teams: unknown }).teams = new Map([
    [
      'room-2',
      {
        id: 'room-2',
        name: 'Elsewhere',
        root: '/repo',
        members: [sessionKey('codex', 's1')],
        intents: [],
        channel: [],
        messaging: true,
      },
    ],
  ])
  await render(store)

  const add = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Add to room'),
  ) as HTMLButtonElement
  expect(add.disabled).toBe(true)
  act(() => add.click())
  await act(async () => {
    await Promise.resolve()
  })
  expect(store.joinRoom).not.toHaveBeenCalled()
})

it('says so when an agent declares nothing to pre-set', async () => {
  const { store } = rig([])
  await render(store)
  expect(container.textContent).toContain('declares its controls once a session exists')
})

it('keeps the dialog open and says why when the agent will not start', async () => {
  const { store } = rig()
  ;(store.newSession as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  const onClose = await render(store)

  press('Add to room')
  await act(async () => {
    await Promise.resolve()
  })

  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain('signed in')
})
