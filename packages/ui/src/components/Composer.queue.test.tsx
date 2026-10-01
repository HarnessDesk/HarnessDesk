import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type RuntimeInfo, type Session, type SessionQueue } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { draftsOf, UNSCOPED_RECOVERY_KEY } from '../state/drafts'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

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
let mountedSnapshot: AppSnapshot
let mountedStore: AppStore
let mountedListeners = new Set<() => void>()
let mockRecoveries: AppSnapshot['recoverableDrafts'] = new Map()

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
  container = document.createElement('div')
  mockRecoveries = new Map()
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  sessionStorage.clear()
})

const KEY = sessionKey('alpha', 's1')

const runtime = (steer: boolean): RuntimeInfo =>
  ({
    id: 'alpha',
    name: 'Alpha Agent',
    capabilities: { steer, imageInput: true } as RuntimeInfo['capabilities'],
    presentation: { name: 'Alpha Agent' },
  }) as RuntimeInfo

const session = (busy: boolean, items: readonly unknown[] = [], id = 's1'): Session =>
  ({
    id,
    runtime: 'alpha',
    cwd: '/w',
    status: { type: busy ? 'active' : 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [
      {
        id: 't1',
        items,
        status: busy ? 'inProgress' : 'completed',
      },
    ],
    itemsLoaded: true,
  }) as unknown as Session

const calls = {
  queue: vi.fn(async (_input: unknown, _key?: unknown) => true),
  steer: vi.fn(async () => true),
  send: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  notice: vi.fn(),
  runCommand: vi.fn(async () => true),
  addRecoverableDraft: vi.fn((key: ReturnType<typeof sessionKey>, draft: Parameters<AppStore['addRecoverableDraft']>[1]) => {
    const drafts = new Map(mountedSnapshot.recoverableDrafts)
    const items = drafts.get(key) ?? []
    draftsOf(mountedStore).addRecoverable(key, draft)
    drafts.set(key, draftsOf(mountedStore).recoverable(key))
    mockRecoveries = drafts
    mountedSnapshot = { ...mountedSnapshot, recoverableDrafts: drafts }
    mountedListeners.forEach((listener) => listener())
  }),
  removeRecoverableDraft: vi.fn((key: ReturnType<typeof sessionKey>, id: number) => {
    const drafts = new Map(mountedSnapshot.recoverableDrafts)
    drafts.set(key, (drafts.get(key) ?? []).filter((entry) => entry.id !== id))
    mockRecoveries = drafts
    mountedSnapshot = { ...mountedSnapshot, recoverableDrafts: drafts }
    mountedListeners.forEach((listener) => listener())
  }),
  restoreRecoverableDraft: vi.fn((key: ReturnType<typeof sessionKey>, id: number) => {
    const current = [...(mountedSnapshot.recoverableDrafts.get(key) ?? [])]
    const selected = current.find((entry) => entry.id === id)
    if (!selected) return null
    const live = draftsOf(mountedStore).live(key)
    draftsOf(mountedStore).setLive(key, {
      text: selected.text,
      attachments: selected.attachments.map((attachment, index) => ({
        ...attachment,
        id: attachment.id ?? `restored-${id}-${index}`,
      })),
    })
    if (live && (live.text.trim() || live.attachments.length)) {
      current.push({
        ...live,
        id: Date.now() + current.length,
        createdAt: Date.now(),
        reason: 'saved',
        detail: 'Restore it to swap with the current draft.',
      })
    }
    mountedSnapshot = {
      ...mountedSnapshot,
      recoverableDrafts: new Map(mountedSnapshot.recoverableDrafts).set(key, current.filter((entry) => entry.id !== id)),
    }
    mountedListeners.forEach((listener) => listener())
    return {
      text: selected.text,
      attachments: selected.attachments.map((attachment, index) => ({
        ...attachment,
        id: attachment.id ?? `restored-${id}-${index}`,
      })),
    }
  }),
}

const mount = ({
  busy,
  steer = false,
  queue = null,
  key = KEY,
  items = [],
}: {
  busy: boolean
  steer?: boolean
  queue?: SessionQueue | null
  key?: ReturnType<typeof sessionKey> | null
  /** What the running turn holds so far. */
  items?: readonly unknown[]
}): void => {
  mountedSnapshot = {
    ...emptySnapshot(),
    runtimes: [runtime(steer)],
    activeRuntime: runtime(steer).id,
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: key ? new Map([[key, session(busy, items, key.split(':').slice(1).join(':'))]]) : new Map(),
    activeSessionKey: key,
    queues: queue && key ? new Map([[key, queue]]) : new Map(),
    recoverableDrafts: mockRecoveries,
  }
  mountedStore = {
    subscribe: (listener: () => void) => { mountedListeners.add(listener); return () => mountedListeners.delete(listener) },
    getSnapshot: () => mountedSnapshot,
    transport: { request: vi.fn() },
    ...calls,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={mountedStore}>
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
  mountedListeners = new Set()
  for (const call of Object.values(calls)) call.mockClear()
})

describe('the composer while a turn is running', () => {
  const runtimeShapes = [
    { name: 'Codex fake', steer: true },
    { name: 'ACP fake', steer: false },
  ] as const

  for (const shape of runtimeShapes) {
    it(`uses only declared steer capability and recovers a refused ⌘↵ on ${shape.name}`, async () => {
      if (shape.steer) calls.steer.mockImplementationOnce(async () => false)
      else calls.queue.mockImplementationOnce(async () => false)
      mount({ busy: true, steer: shape.steer })
      expect(textarea().placeholder).toBe(shape.steer
        ? 'Type the next message — ↵ queues it, ⌘↵ adds it to this turn'
        : 'Type the next message — it is sent when this turn ends')
      act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
        detail: { text: `typed for ${shape.name}`, attachments: [{ name: 'spec.md', path: '/w/spec.md', kind: 'file' }] },
      })))
      await act(async () => {
        enter({ meta: true })
        type('newer draft')
        await Promise.resolve()
      })

      expect(shape.steer ? calls.steer : calls.queue).toHaveBeenCalledTimes(1)
      expect(textarea().value).toBe('newer draft')
      expect(container.textContent).toContain('Message not sent')
      const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
      expect(restore).toBeDefined()
      act(() => restore?.click())
      expect(textarea().value).toBe(`typed for ${shape.name}`)
      expect(container.textContent).toContain('spec.md')
      const restoreNewer = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
      expect(restoreNewer).toBeDefined()
      act(() => restoreNewer?.click())
      expect(textarea().value).toBe('newer draft')
    })

    it(`keeps the 25-cap refusal recoverable alongside a newer draft on ${shape.name}`, async () => {
      calls.queue.mockImplementationOnce(async () => false)
      mount({ busy: true, steer: shape.steer })
      type(`the 25th queued refusal for ${shape.name}`)
      await act(async () => {
        enter()
        type('typed after the queue refusal')
        await Promise.resolve()
      })

      expect(calls.queue).toHaveBeenCalledTimes(1)
      expect(textarea().value).toBe('typed after the queue refusal')
      expect(container.textContent).toContain('Message not sent')
      const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
      expect(restore).toBeDefined()
      act(() => restore?.click())
      expect(textarea().value).toBe(`the 25th queued refusal for ${shape.name}`)
      const restoreNewer = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
      expect(restoreNewer).toBeDefined()
      act(() => restoreNewer?.click())
      expect(textarea().value).toBe('typed after the queue refusal')
    })
  }

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

  it('queues on ⌘Enter too while the turn is a review, which Codex will not let anything join', () => {
    mount({ busy: true, steer: true, items: [{ id: 'r', type: 'review', phase: 'entered', review: 'current changes' }] })
    expect(textarea().placeholder).toBe('Type the next message — it is sent when this turn ends')
    type('then fix what it finds')
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
    expect(textarea().value).toBe('')
    expect(calls.addRecoverableDraft).toHaveBeenCalledWith(KEY, expect.objectContaining({ text: 'do not lose me' }))
    expect(container.textContent).toContain('Message not sent')
  })

  it('keeps an empty-composer refusal recoverable after the Composer remounts', async () => {
    calls.queue.mockImplementationOnce(async () => false)
    mount({ busy: true })
    type('recover me after reload')
    enter()
    await act(async () => {})
    expect(textarea().value).toBe('')
    expect(mockRecoveries.get(KEY)?.map((draft) => draft.text)).toContain('recover me after reload')

    act(() => root.unmount())
    root = createRoot(container)
    mount({ busy: false })
    expect(textarea().value).toBe('')
    expect(mockRecoveries.get(KEY)?.map((draft) => draft.text)).toContain('recover me after reload')
    expect(container.textContent).toContain('Restore')
  })

  it('keeps a refused steer recoverable without replacing a newer draft', async () => {
    calls.steer.mockImplementationOnce(async () => false)
    mount({ busy: true, steer: true })
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
      detail: { text: 'steer me', attachments: [{ name: 'spec.md', path: '/w/spec.md', kind: 'file' }] },
    })))
    await act(async () => {
      enter({ meta: true })
      type('newer draft')
      await Promise.resolve()
    })

    expect(textarea().value).toBe('newer draft')
    expect(container.textContent).toContain('Message not sent')
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restore).toBeDefined()
    act(() => restore?.click())
    expect(textarea().value).toBe('steer me')
    expect(container.textContent).toContain('spec.md')
    const restoreNewer = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restoreNewer).toBeDefined()
    act(() => restoreNewer?.click())
    expect(textarea().value).toBe('newer draft')
  })

  it('shows a refused draft only in the conversation that sent it', () => {
    mount({ busy: false, key: KEY })
    calls.addRecoverableDraft(KEY, {
      text: 'A private draft',
      attachments: [],
      detail: 'Message not sent. Restore it to the composer.',
    })
    mount({ busy: false, key: sessionKey('alpha', 's2') })
    expect(container.textContent).not.toContain('Message not sent')
    mount({ busy: false, key: KEY })
    expect(container.textContent).toContain('Message not sent')
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restore).toBeDefined()
    act(() => restore?.click())
    expect(textarea().value).toBe('A private draft')
  })

  it('shows when a refused draft could not be saved for a reload', () => {
    mockRecoveries = new Map([[KEY, [{
      id: 99,
      createdAt: 99,
      reason: 'refused',
      text: 'memory-only recovery',
      attachments: [],
      detail: "Restore it. Kept until you close this window's view — it could not be saved for a reload.",
    }]]])
    mount({ busy: false })
    expect(container.textContent).toContain('it could not be saved for a reload')
  })

  it('uses plain words for an unsaved queued edit instead of its internal row id', () => {
    const queueRowId = 'queue-internal-77'
    mockRecoveries = new Map([[KEY, [{
      id: 100,
      createdAt: 100,
      reason: 'edit',
      sourceId: queueRowId,
      text: 'recovered edit',
      attachments: [],
      detail: "Your edit wasn't saved — the original was already sent. Restore it to the composer.",
    }]]])
    mount({ busy: false })

    expect(container.textContent).toContain('Edit not saved.')
    expect(container.textContent).toContain("Your edit wasn't saved — the original was already sent.")
    expect(container.textContent).not.toContain(queueRowId)
  })

  it('keeps a refused steer and its chips in recovery when the composer is empty', async () => {
    calls.steer.mockImplementationOnce(async () => false)
    mount({ busy: true, steer: true })
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
      detail: { text: 'steer me', attachments: [{ name: 'spec.md', path: '/w/spec.md', kind: 'file' }] },
    })))
    await act(async () => {
      enter({ meta: true })
      await Promise.resolve()
    })
    expect(textarea().value).toBe('')
    expect(mockRecoveries.get(KEY)?.[0]).toMatchObject({
      text: 'steer me',
      attachments: [{ name: 'spec.md', kind: 'file' }],
    })
    expect(container.textContent).toContain('Restore')
  })

  it('keeps a refused queue recoverable without replacing a newer draft', async () => {
    calls.queue.mockImplementationOnce(async () => false)
    mount({ busy: true })
    type('first message')
    await act(async () => {
      enter()
      type('second message')
      await Promise.resolve()
    })

    expect(textarea().value).toBe('second message')
    expect(container.textContent).toContain('Message not sent')
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restore).toBeDefined()
    act(() => restore?.click())
    expect(textarea().value).toBe('first message')
    const restoreNewer = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restoreNewer).toBeDefined()
    act(() => restoreNewer?.click())
    expect(textarea().value).toBe('second message')
  })

  it('restores path attachments when the first send is refused before a session exists', async () => {
    calls.queue.mockImplementationOnce(async () => false)
    mount({ busy: false, key: null })
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
      detail: {
        text: 'first message with a file',
        attachments: [{ name: 'spec.md', path: '/w/spec.md', kind: 'file' }],
      },
    })))

    await act(async () => {
      enter()
      await Promise.resolve()
    })

    expect(textarea().value).toBe('')
    const recovery = mountedSnapshot.recoverableDrafts.get(UNSCOPED_RECOVERY_KEY)?.[0]
    expect(recovery).toMatchObject({
      text: 'first message with a file',
      attachments: [{ name: 'spec.md', kind: 'file' }],
    })
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restore).toBeDefined()
    act(() => restore?.click())
    expect(textarea().value).toBe('first message with a file')
    expect(container.textContent).toContain('spec.md')
  })

  it('keeps a refused first send out of a conversation selected while session creation is pending', async () => {
    let refuse!: (delivered: boolean) => void
    calls.queue.mockImplementationOnce(() => new Promise<boolean>((resolve) => { refuse = resolve }))
    mount({ busy: false, key: null })
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', {
      detail: { text: 'belongs to a new conversation', attachments: [] },
    })))

    await act(async () => {
      enter()
      await Promise.resolve()
    })
    mountedSnapshot = {
      ...mountedSnapshot,
      activeSessionKey: KEY,
      sessions: new Map([[KEY, session(false)]]),
    }
    mountedListeners.forEach((listener) => listener())
    expect(textarea().value).toBe('')

    await act(async () => { refuse(false) })

    expect(textarea().value).toBe('')
    expect(mountedSnapshot.recoverableDrafts.get(UNSCOPED_RECOVERY_KEY)?.[0]?.text)
      .toBe('belongs to a new conversation')
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restore).toBeDefined()
    act(() => restore?.click())
    expect(textarea().value).toBe('belongs to a new conversation')
  })

  it('shows an inline queue refusal as a recoverable draft without replacing the composer', () => {
    mount({ busy: false })
    type('my current composer draft')
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:recoverable-draft', {
      detail: {
        text: 'edited queued words',
        attachments: [{
          name: 'Issue 12', path: 'note:Issue 12', kind: 'note',
          text: '<context source="Issue 12">\nbody\n</context>',
        }],
        reason: 'It was delivered before the edit arrived.',
      },
    })))
    expect(textarea().value).toBe('my current composer draft')
    expect(container.textContent).toContain('Could not save the queued message: It was delivered before the edit arrived.')
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Restore'))
    expect(restore).toBeDefined()
    act(() => restore?.click())
    expect(textarea().value).toBe('edited queued words')
    expect(container.textContent).toContain('Issue 12')
  })

  it('keeps earlier refused messages when a later retry is refused too', async () => {
    calls.queue.mockImplementationOnce(async () => false).mockImplementationOnce(async () => false)
    mount({ busy: true })
    type('first refused')
    await act(async () => {
      enter()
      type('second refused')
      await Promise.resolve()
    })
    await act(async () => {
      enter()
      type('newest draft')
      await Promise.resolve()
    })

    expect(textarea().value).toBe('newest draft')
    expect(container.querySelectorAll('[data-slot="composer-notice"]')).toHaveLength(2)
    const restore = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="composer-notice"] button')]
    act(() => restore[1]?.click())
    expect(textarea().value).toBe('second refused')
    expect(container.querySelectorAll('[data-slot="composer-notice"]')).toHaveLength(2)
  })

  it('clears recovery after an accepted steer', async () => {
    calls.steer.mockImplementationOnce(async () => true)
    mount({ busy: true, steer: true })
    type('accepted steer')
    await act(async () => {
      enter({ meta: true })
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('Message not sent')
  })

  it('does not hold an accepted queue as recoverable', async () => {
    calls.queue.mockImplementationOnce(async () => true)
    mount({ busy: true })
    type('accepted queue')
    await act(async () => {
      enter()
      await Promise.resolve()
    })
    expect(textarea().value).toBe('')
    expect(container.textContent).not.toContain('Message not sent')
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
  const corner = (): Element | null =>
    container.querySelector('[data-slot="composer-tools"]')?.lastElementChild ?? null

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
