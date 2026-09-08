import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Intent, Plan, TeamPeerInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AddWork } from './AddWork'

/**
 * Putting work up with the fields the board actually enforces.
 *
 * The header's input took a title and nothing else, so every job a person wrote
 * owned no files and waited on nothing — and those two are exactly what the
 * host refereeres at claim time. The board could promise one-claim-per-job and
 * not one-agent-per-file, because there was nowhere to say which files.
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

const intent = (over: Partial<Intent>): Intent =>
  ({
    id: 1,
    title: 'Fix the refill',
    state: 'open',
    files: [],
    dependsOn: [],
    ...over,
  }) as Intent

/** One member of the room, for the field that can ask somebody to take a job. */
const PEER: TeamPeerInfo = {
  runtime: 'codex' as never,
  sessionId: 'c1',
  title: 'API migration',
  agent: 'Codex',
  nickname: 'Alpha',
  busy: false,
  here: true,
}

const rig = (intents: readonly Intent[] = []) => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({ ...emptySnapshot(), status: 'open' }) as unknown as AppSnapshot,
    teamAdd: vi.fn().mockResolvedValue(undefined),
    teamPost: vi.fn().mockResolvedValue(undefined),
  } as unknown as AppStore
  return { store, intents }
}

const render = (
  store: AppStore,
  intents: readonly Intent[],
  onClose = vi.fn(),
  /* The two fields a board with goals and members grows. Defaulted away, so
     every test that does not care about them reads as it did. */
  extra: {
    plans?: readonly Plan[]
    plan?: number | null
    peers?: readonly TeamPeerInfo[]
    onTrouble?: (message: string) => void
  } = {},
): typeof onClose => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AddWork room="room-1" intents={intents} onClose={onClose} {...extra} />
      </StoreProvider>,
    )
  })
  return onClose
}

const choose = (label: string, value: string): void => {
  const node = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!node) throw new Error(`no select labelled ${label}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(node, value)
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const field = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )
  if (!found) throw new Error(`no field labelled ${label}`)
  return found
}

const type = (label: string, value: string): void => {
  act(() => {
    const node = field(label)
    const proto =
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    // React tracks the last value it wrote; assigning directly leaves that
    // tracker unchanged and the change event is swallowed as a no-op.
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const press = (name: string): void => {
  const found = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes(name),
  )
  if (!found) throw new Error(`no button ${name}`)
  act(() => found.click())
}

it('carries the files a job owns, one per line', async () => {
  const { store, intents } = rig()
  render(store, intents)

  type('What needs doing', 'Fix the token refill')
  type('Files it will own', 'src/limiter.js\nsrc/api/**')
  press('Add to board')
  await act(async () => {
    await Promise.resolve()
  })

  expect(store.teamAdd).toHaveBeenCalledWith('room-1', {
    title: 'Fix the token refill',
    files: ['src/limiter.js', 'src/api/**'],
  })
})

it('says what the files buy, and what their absence costs', () => {
  const { store, intents } = rig()
  render(store, intents)

  expect(container.textContent).toContain('the job is reserved but the code is not')
  type('Files it will own', 'src/limiter.js')
  expect(container.textContent).toContain('overlapping src/limiter.js')
})

it('offers only work that could still hold this up', () => {
  // Depending on something already finished is a note, not a dependency, and
  // offering it invites a job that starts life in Waiting for no reason.
  const { store } = rig()
  render(store, [
    intent({ id: 1, title: 'Still open' }),
    intent({ id: 2, title: 'Already finished', state: 'done' }),
    intent({ id: 3, title: 'Given up on', state: 'abandoned' }),
  ])

  expect(container.textContent).toContain('Still open')
  expect(container.textContent).not.toContain('Already finished')
  expect(container.textContent).not.toContain('Given up on')
})

it('records what a job waits for', async () => {
  const { store } = rig()
  const intents = [intent({ id: 4, title: 'The refill fix' })]
  render(store, intents)

  type('What needs doing', 'Round the money')
  act(() => field('Waits for #4').click())
  press('Add to board')
  await act(async () => {
    await Promise.resolve()
  })

  expect(store.teamAdd).toHaveBeenCalledWith('room-1', {
    title: 'Round the money',
    dependsOn: [4],
  })
})

it('will not add a job with no title', () => {
  const { store, intents } = rig()
  render(store, intents)

  const add = [...document.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Add to board'),
  )
  expect((add as HTMLButtonElement).disabled).toBe(true)
})

it('shows the refusal when the board will not own a path', async () => {
  // The host filters what it cannot own; the dialog used to close anyway, so a
  // card appeared owning one of the three paths that had been typed with no
  // word about the other two.
  const { store, intents } = rig()
  ;(store.teamAdd as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('/tmp/absolute.txt is outside this workspace. Nothing was added.'),
  )
  const onClose = render(store, intents)

  type('What needs doing', 'Validate the query')
  type('Files it will own', 'src/ok.ts\n/tmp/absolute.txt')
  press('Add to board')
  await act(async () => {
    await Promise.resolve()
  })

  expect(onClose).not.toHaveBeenCalled()
  expect(container.textContent).toContain('outside this workspace')
})

/**
 * The goal a job belongs to, chosen where the job is written.
 *
 * A Room is permanent and a goal is not, and a job added to no goal is a job
 * that can never be wrapped up with the rest of its batch. Setting it used to
 * be reachable only by an agent passing `plan`.
 */
it('puts a job on a goal, and starts on the goal it was opened from', async () => {
  const { store } = rig()
  render(store, [], vi.fn(), {
    plans: [
      { id: 7, goal: 'Ship the limiter', state: 'running', createdAt: 1 },
      { id: 8, goal: 'Docs pass', state: 'running', createdAt: 2 },
    ],
    plan: 8,
  })

  // Opened from a goal, so nobody picks it out of a menu they were just in.
  expect((field('Goal') as unknown as HTMLSelectElement).value).toBe('8')
  choose('Goal', '7')
  type('What needs doing', 'Fix the token refill')
  press('Add to board')
  await act(async () => {})

  expect(store.teamAdd).toHaveBeenCalledWith('room-1', {
    title: 'Fix the token refill',
    plan: 7,
  })
})

/**
 * The field every kanban calls "Assign to", which this one cannot be.
 *
 * Nobody assigns work here: an agent *claims* it, and the claim is what makes
 * the file lock mean anything. A picker that silently created a claim would be
 * a lie the board would then have to keep — so it posts a message, and the
 * hint under it says exactly that.
 */
it('asks one member to pick a job up, and that is a message and not a claim', async () => {
  const { store } = rig()
  render(store, [], vi.fn(), { peers: [PEER] })

  type('What needs doing', 'Fix the token refill')
  choose('Ask someone to pick it up', 'codex c1')
  press('Add to board')
  await act(async () => {})

  expect(store.teamAdd).toHaveBeenCalledWith('room-1', { title: 'Fix the token refill' })
  expect(store.teamPost).toHaveBeenCalledWith(
    'room-1',
    expect.stringContaining('Fix the token refill'),
    { runtime: 'codex', sessionId: 'c1' },
  )
  expect(document.body.textContent).toContain('The claim is still theirs to take.')
})

/**
 * Asking is the weaker of the two acts, and must not be able to undo the first
 * — or to be repeated into a second job.
 *
 * The job is on the board whether or not the message lands, so the dialog is
 * done and closes. It used to stay open with its fields intact and "Add to
 * board" still armed: pressing it again to retry the message added *another
 * card* first, so one failed post could leave two jobs on the board. The
 * failure is reported where the person is now looking, which is the board.
 */
it('finishes when the message it was asked to send does not land, and says so on the board', async () => {
  const { store } = rig()
  ;(store.teamPost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no'))
  const onClose = vi.fn()
  const onTrouble = vi.fn()
  render(store, [], onClose, { peers: [PEER], onTrouble })

  type('What needs doing', 'Fix the token refill')
  choose('Ask someone to pick it up', 'codex c1')
  press('Add to board')
  await act(async () => {})

  expect(store.teamAdd).toHaveBeenCalledTimes(1)
  expect(onClose).toHaveBeenCalled()
  const said = String((onTrouble.mock.calls[0] ?? [])[0] ?? '')
  expect(said).toContain('is on the board')
  expect(said).toContain('Alpha')
  expect(said).toContain('did not land')
})

/**
 * And the add itself failing is the opposite case: nothing was created, so the
 * words stay and the dialog stays with them.
 */
it('keeps the words when the board will not take the job at all', async () => {
  const { store } = rig()
  ;(store.teamAdd as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('the host said no'))
  const onClose = vi.fn()
  render(store, [], onClose)

  type('What needs doing', 'Fix the token refill')
  press('Add to board')
  await act(async () => {})

  expect(onClose).not.toHaveBeenCalled()
  expect((field('What needs doing') as HTMLInputElement).value).toBe('Fix the token refill')

  // And a retry is one job, not two.
  press('Add to board')
  await act(async () => {})
  expect(store.teamAdd).toHaveBeenCalledTimes(2)
})

it('says so rather than offering an empty menu when nobody is in the room', () => {
  const { store } = rig()
  render(store, [])
  expect(document.body.textContent).toContain('Nobody is in the room yet.')
  expect((field('Ask someone to pick it up') as unknown as HTMLSelectElement).disabled).toBe(true)
})
