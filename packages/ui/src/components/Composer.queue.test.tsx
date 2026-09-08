import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type RuntimeInfo, type Session, type SessionQueue } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'
import styles from './Composer.module.css'

/**
 * What Enter does, and when.
 *
 * The bug this replaced: mid-turn, Enter called `turn/steer`, which only one
 * of the four agents implements. For the rest the composer had already
 * cleared itself and the message was gone — replaced by an error toast. So
 * the tests below are about **where a typed message ends up**, in each of the
 * three states the composer can be in.
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

const KEY = sessionKey('alpha', 's1')

const runtime = (steer: boolean): RuntimeInfo =>
  ({
    id: 'alpha',
    name: 'Alpha Agent',
    capabilities: { steer, imageInput: true } as RuntimeInfo['capabilities'],
    presentation: { name: 'Alpha Agent' },
  }) as RuntimeInfo

const session = (busy: boolean): Session =>
  ({
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: { type: busy ? 'active' : 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [
      {
        id: 't1',
        items: [],
        status: busy ? 'inProgress' : 'completed',
      },
    ],
    itemsLoaded: true,
  }) as unknown as Session

const calls = {
  queue: vi.fn(async (_input: unknown, _key?: unknown) => true),
  steer: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  notice: vi.fn(),
  runCommand: vi.fn(async () => true),
}

const mount = ({
  busy,
  steer = false,
  queue = null,
}: {
  busy: boolean
  steer?: boolean
  queue?: SessionQueue | null
}): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    runtimes: [runtime(steer)],
    activeRuntime: runtime(steer).id,
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: new Map([[KEY, session(busy)]]),
    activeSessionKey: KEY,
    queues: queue ? new Map([[KEY, queue]]) : new Map(),
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn() },
    ...calls,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Composer onChooseProject={() => {}} />
      </StoreProvider>,
    )
  })
}

const textarea = (): HTMLTextAreaElement => {
  const element = container.querySelector('textarea')
  if (!element) throw new Error('no textarea')
  return element
}

const type = (value: string): void => {
  const element = textarea()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const enter = (modifiers: { meta?: boolean } = {}): void => {
  act(() => {
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, metaKey: modifiers.meta ?? false }),
    )
  })
}

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockClear()
})

describe('the composer while a turn is running', () => {
  it('queues rather than steering, for an agent that cannot steer', () => {
    mount({ busy: true, steer: false })
    type('and then run the tests')
    enter()
    expect(calls.queue).toHaveBeenCalledTimes(1)
    expect(calls.queue.mock.calls[0]?.[0]).toEqual([{ type: 'text', text: 'and then run the tests' }])
    expect(calls.steer).not.toHaveBeenCalled()
    expect(textarea().value).toBe('')
  })

  /** Steering did not go away — it stopped being what plain Enter means. */
  it('queues on Enter and steers on ⌘Enter, for an agent that can steer', () => {
    mount({ busy: true, steer: true })
    type('also check the types')
    enter()
    expect(calls.queue).toHaveBeenCalledTimes(1)
    expect(calls.steer).not.toHaveBeenCalled()

    type('while you are there')
    enter({ meta: true })
    expect(calls.steer).toHaveBeenCalledTimes(1)
    expect(calls.queue).toHaveBeenCalledTimes(1)
  })

  it('⌘Enter still queues where the agent cannot take it', () => {
    mount({ busy: true, steer: false })
    type('now please')
    enter({ meta: true })
    expect(calls.steer).not.toHaveBeenCalled()
    expect(calls.queue).toHaveBeenCalledTimes(1)
  })

  it('offers Stop and a queue button, and neither replaces the other', () => {
    mount({ busy: true })
    expect(container.querySelector('[aria-label="Stop"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Queue"]')).toBeNull()
    type('something')
    expect(container.querySelector('[aria-label="Stop"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Queue"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Send"]')).toBeNull()
  })

  it('says what Enter will do, in terms of what this agent can take', () => {
    mount({ busy: true, steer: false })
    expect(textarea().placeholder).toBe('Type the next message — it is sent when this turn ends')
    mount({ busy: true, steer: true })
    expect(textarea().placeholder).toBe('Type the next message — ↵ queues it, ⌘↵ adds it to this turn')
  })

  it('puts the draft back when the message did not get anywhere', async () => {
    calls.queue.mockImplementationOnce(async () => false)
    mount({ busy: true })
    type('do not lose me')
    enter()
    await act(async () => {})
    expect(textarea().value).toBe('do not lose me')
  })
})

describe('the composer when nothing is running', () => {
  it('sends through the same call, and lets the host decide it need not wait', () => {
    mount({ busy: false })
    type('start here')
    enter()
    // One path to the host, so the renderer and the host cannot disagree
    // about whether a turn was running at the moment Enter was pressed.
    expect(calls.queue).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-label="Send"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Stop"]')).toBeNull()
  })

  /**
   * A held queue makes Enter mean "join the line", and the composer has to
   * say so — otherwise the key looks broken while the strip quietly grows.
   */
  it('says a message joins a held queue rather than starting a turn', () => {
    mount({
      busy: false,
      queue: {
        status: 'paused',
        reason: 'The turn was stopped.',
        messages: [
          { id: 'q0', input: [{ type: 'text', text: 'earlier' }], queuedAt: 0, state: 'queued' },
        ],
      },
    })
    expect(textarea().placeholder).toBe('Adds to the 1 message already waiting')
    expect(container.querySelector('[aria-label="Queue"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Send"]')).toBeNull()
  })
})

/**
 * The action button's *weight*, which is the only thing that tells you when a
 * message will go. Enter's behaviour is covered above; this is whether the
 * button agrees with it — the two drifted apart once already, when a running
 * turn drew a second saturated coin that looked exactly as immediate as the
 * one that starts a turn.
 */
describe('what the action button says about when the message goes', () => {
  const action = (label: 'Send' | 'Queue'): HTMLButtonElement => {
    const element = container.querySelector(`[aria-label="${label}"]`)
    if (!element) throw new Error(`no ${label} button`)
    return element as HTMLButtonElement
  }

  const held = { status: 'paused', reason: 'stopped', messages: [
    { id: 'q0', input: [{ type: 'text', text: 'earlier' }], queuedAt: 0, state: 'queued' },
  ] } as unknown as SessionQueue

  it('draws nothing to act on when the box is empty', () => {
    mount({ busy: false })
    expect(action('Send').dataset.when).toBe('nothing')
    expect(action('Send').disabled).toBe(true)
  })

  it('draws the immediate weight only when pressing it starts the turn', () => {
    mount({ busy: false })
    type('go')
    expect(action('Send').dataset.when).toBe('now')
  })

  it('draws the deferred weight while a turn is running', () => {
    mount({ busy: true })
    type('go')
    expect(action('Queue').dataset.when).toBe('later')
  })

  it('draws the deferred weight when a held queue is ahead of it', () => {
    mount({ busy: false, queue: held })
    type('go')
    expect(action('Queue').dataset.when).toBe('later')
  })

  /**
   * The corner is whatever acts on the turn. Stop takes the place the send
   * button just occupied — the pointer that started a turn is already on the
   * control that ends it — and it does not move again once a draft appears
   * beside it. Both are position claims, so both are asserted as position.
   */
  const corner = (): Element | null => container.querySelector(`.${styles.toolbar}`)?.lastElementChild ?? null

  it('gives the corner to whatever acts on the turn right now', () => {
    mount({ busy: false })
    type('go')
    expect(corner()).toBe(action('Send'))
    mount({ busy: true })
    expect(corner()).toBe(container.querySelector('[aria-label="Stop"]'))
  })

  it('keeps Stop in the corner when the next message appears beside it', () => {
    mount({ busy: true })
    type('go')
    expect(corner()).toBe(container.querySelector('[aria-label="Stop"]'))
    expect(action('Queue').nextElementSibling).toBe(corner())
  })
})
