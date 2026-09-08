import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionKey, type RuntimeInfo, type Session, type UserContent } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * A task the person reworded, on its way to the agent.
 *
 * No runtime lets the desk set its plan, so this message is the whole of how
 * an edit reaches the agent at all. What is pinned here: it travels in the
 * same `<context source=…>` envelope every other injection uses rather than
 * as characters in the person's own sentence, it is only sent while it still
 * stands against the plan, and sending it retires the edits the agent has
 * already taken up.
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
const queue = vi.fn(async (_content: unknown, _key?: unknown) => true)
const retirePlanEdits = vi.fn()

const planned = (labels: readonly string[]): Session =>
  ({
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    itemsLoaded: true,
    turns: [
      {
        id: 't1',
        status: 'completed',
        items: [
          {
            id: 'c1',
            type: 'toolCall',
            tool: 'TodoWrite',
            source: { kind: 'builtin' },
            status: 'completed',
            args: { todos: labels.map((content) => ({ content, status: 'pending' })) },
          },
        ],
      },
    ],
  }) as unknown as Session

const mount = (labels: readonly string[], edits: { from: string; to: string }[]): void => {
  const runtime = {
    id: 'alpha',
    name: 'Alpha Agent',
    capabilities: { steer: false, imageInput: true } as RuntimeInfo['capabilities'],
    presentation: { name: 'Alpha Agent' },
  } as RuntimeInfo
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    runtimes: [runtime],
    activeRuntime: runtime.id,
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: new Map([[KEY, planned(labels)]]),
    activeSessionKey: KEY,
    planEdits: edits.length > 0 ? { [KEY]: edits } : {},
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn() },
    queue,
    steer: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
    notice: vi.fn(),
    runCommand: vi.fn(async () => true),
    retirePlanEdits,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Composer onChooseProject={() => {}} />
      </StoreProvider>,
    )
  })
}

const type = (words: string): void => {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no textarea')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, words)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const send = async (): Promise<void> => {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no textarea')
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
  })
}

const sent = (): UserContent[] => (queue.mock.calls[0]?.[0] ?? []) as UserContent[]
const texts = (): string[] =>
  sent().filter((part): part is Extract<UserContent, { type: 'text' }> => part.type === 'text').map((part) => part.text)

beforeEach(() => {
  queue.mockClear()
  retirePlanEdits.mockClear()
})

describe('a reworded task', () => {
  it('rides with the next message, in its own envelope', () => {
    mount(['Buffer the request body'], [{ from: 'Buffer the request body', to: 'Buffer the body, re-arm per attempt' }])
    type('carry on')
    void send()
    const all = texts()
    const note = all.find((part) => part.includes('Task list edited by the user'))
    expect(note).toBeDefined()
    expect(note).toContain('<context source="Task list edited by the user">')
    expect(note).toContain('“Buffer the request body” → “Buffer the body, re-arm per attempt”')
    // The text box stays the person's: the note is beside their sentence,
    // never inside it.
    expect(all).toContain('carry on')
    expect(all.find((part) => part === 'carry on')).not.toContain('reworded')
  })

  it('goes before what the person typed, so the instruction reads against it', () => {
    mount(['Buffer the request body'], [{ from: 'Buffer the request body', to: 'Buffer the body' }])
    type('now do it')
    void send()
    const all = texts()
    expect(all.findIndex((part) => part.includes('Task list edited'))).toBeLessThan(
      all.findIndex((part) => part === 'now do it'),
    )
  })

  it('sends nothing when the agent has already adopted the wording', () => {
    // The plan says what the person asked for, so there is nothing to correct
    // and no envelope to carry.
    mount(['Buffer the body'], [{ from: 'Buffer the request body', to: 'Buffer the body' }])
    type('carry on')
    void send()
    expect(texts().some((part) => part.includes('Task list edited'))).toBe(false)
  })

  it('sends nothing when nothing was edited', () => {
    mount(['Buffer the request body'], [])
    type('carry on')
    void send()
    expect(texts().some((part) => part.includes('Task list edited'))).toBe(false)
  })

  it('retires the edits the agent took up, as the message goes', () => {
    mount(['Buffer the request body'], [{ from: 'Buffer the request body', to: 'Buffer the body' }])
    type('carry on')
    void send()
    expect(retirePlanEdits).toHaveBeenCalledWith(
      [{ label: 'Buffer the request body', done: false, active: false }],
      KEY,
    )
  })

  it('can be sent on its own, with nothing typed beside it', () => {
    // A correction is a thing to send in its own right. Without this the only
    // way to deliver one was to type filler text next to it.
    mount(['Buffer the request body'], [{ from: 'Buffer the request body', to: 'Buffer the body' }])
    const send = [...container.querySelectorAll('button')].find((b) =>
      /send/i.test(b.getAttribute('aria-label') ?? b.title ?? ''),
    ) as HTMLButtonElement | undefined
    expect(send?.disabled).toBe(false)
  })

  it('leaves the composer closed when there is nothing to say', () => {
    mount(['Buffer the request body'], [])
    const send = [...container.querySelectorAll('button')].find((b) =>
      /send/i.test(b.getAttribute('aria-label') ?? b.title ?? ''),
    ) as HTMLButtonElement | undefined
    expect(send?.disabled).toBe(true)
  })
})
