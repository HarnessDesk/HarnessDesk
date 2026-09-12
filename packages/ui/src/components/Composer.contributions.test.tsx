import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  contributionId,
  pluginInstanceId,
  sessionId,
  sessionKey,
  type CapabilityContribution,
  type CapabilityScope,
  type RuntimeInfo,
  type Session,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * What a context chip is offered for, and what happens when it cannot answer.
 *
 * Three states look the same from the composer and are not: a provider scoped
 * to another conversation, one whose plugin has gone, and one that is right
 * here and has nothing to say. None of them is a promise broken — only a
 * provider that *fails* is that — so none of them may refuse the send.
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
  document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove())
})

const KEY = sessionKey('alpha', 's1')

const provider = (id: string, label: string, scope: CapabilityScope): CapabilityContribution =>
  ({
    kind: 'context',
    id: contributionId(id),
    owner: pluginInstanceId('p#1'),
    revision: 0,
    scope,
    label,
    form: 'resource',
    chip: { description: `${label}, on demand.` },
  }) satisfies CapabilityContribution

/** Every conversation's. */
const ANYWHERE = provider('ctx-diff', 'Uncommitted changes', { kind: 'global' })
/** Another conversation's, and this composer is not it. */
const ELSEWHERE = provider('ctx-there', 'Elsewhere only', { kind: 'session', sessionId: sessionId('s9') })
/** This conversation's. */
const HERE = provider('ctx-here', 'Here only', { kind: 'session', sessionId: sessionId('s1') })

const queue = vi.fn(async (_content: unknown, _key?: unknown) => true)
const notice = vi.fn()
const request = vi.fn(async () => ({ label: 'Uncommitted changes', text: 'diff --git a/a.ts b/a.ts' }))

let snapshot: AppSnapshot
let store: AppStore
const listeners = new Set<() => void>()

const render = (): void => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Composer onChooseProject={() => {}} />
      </StoreProvider>,
    )
  })
}

const mount = (contributions: readonly CapabilityContribution[]): void => {
  const runtime = {
    id: 'alpha',
    name: 'Alpha Agent',
    capabilities: { steer: false, imageInput: true } as RuntimeInfo['capabilities'],
    presentation: { name: 'Alpha Agent' },
  } as RuntimeInfo
  const session = {
    id: 's1',
    runtime: 'alpha',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
  } as unknown as Session
  snapshot = {
    ...emptySnapshot(),
    runtimes: [runtime],
    activeRuntime: 'alpha' as AppSnapshot['activeRuntime'],
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    sessions: new Map([[KEY, session]]),
    activeSessionKey: KEY,
    contributions: [...contributions],
  }
  store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    transport: { request },
    queue,
    steer: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
    notice,
    runCommand: vi.fn(async () => true),
  } as unknown as AppStore
  render()
}

/** What the host would do when a plugin is switched off: the contribution goes. */
const patch = (contributions: readonly CapabilityContribution[]): void => {
  snapshot = { ...snapshot, contributions: [...contributions] }
  act(() => {
    for (const listener of listeners) listener()
  })
}

const click = (element: Element | null | undefined): void => {
  if (!element) throw new Error('nothing to click')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The + menu's rows, which portal to the body. */
const openPicker = (): string[] => {
  click(container.querySelector('button[title="Add"]'))
  return [...document.querySelectorAll('button')].map((button) => button.textContent ?? '')
}

const attach = (label: string): void => {
  const item = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(label))
  click(item)
}

/** The chips above the textarea, by name. */
const chipRow = (): string => container.textContent ?? ''

const send = async (): Promise<void> => {
  const textarea = container.querySelector('textarea')
  if (!textarea) throw new Error('no textarea')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, 'have a look at this')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  queue.mockClear()
  notice.mockClear()
  request.mockClear()
  request.mockResolvedValue({ label: 'Uncommitted changes', text: 'diff --git a/a.ts b/a.ts' })
  listeners.clear()
})

describe('which providers the composer offers', () => {
  it('offers a global provider and withholds one scoped to another conversation', () => {
    mount([ANYWHERE, ELSEWHERE])
    const rows = openPicker()
    // The control: a provider that should be offered is, in the same reading —
    // so the absence below is an absence and not an unopened menu.
    expect(rows.some((row) => row.includes('Uncommitted changes'))).toBe(true)
    expect(rows.some((row) => row.includes('Elsewhere only'))).toBe(false)
  })

  it('offers one scoped to this conversation', () => {
    mount([HERE])
    expect(openPicker().some((row) => row.includes('Here only'))).toBe(true)
  })
})

describe('a chip that cannot answer', () => {
  it('has nothing to add: the message goes, and says what was left off', async () => {
    // `Last test run` in a fresh draft. The provider is here and working; it
    // simply has no run of this conversation's to report.
    request.mockResolvedValue({ label: 'Uncommitted changes', text: '' })
    mount([ANYWHERE])
    openPicker()
    attach('Uncommitted changes')
    await send()

    expect(request).toHaveBeenCalledWith('context/resolve', expect.objectContaining({ id: 'ctx-diff' }))
    // The control: the send goes, carrying what was typed.
    expect(queue).toHaveBeenCalledTimes(1)
    const content = queue.mock.calls[0]?.[0] as unknown as { type: string; text?: string }[]
    expect(content.map((part) => part.type)).toEqual(['text'])
    expect(content[0]?.text).toBe('have a look at this')
    // And the omission is named rather than silent.
    expect(notice).toHaveBeenCalledWith('info', expect.stringContaining('Uncommitted changes'))
  })

  it('is withdrawn from the draft when its plugin goes, instead of refusing every send', async () => {
    mount([ANYWHERE])
    openPicker()
    attach('Uncommitted changes')
    // The control: the chip is on the message before the plugin goes.
    expect(chipRow()).toContain('Uncommitted changes')

    patch([])

    expect(chipRow()).not.toContain('Uncommitted changes')
    expect(notice).toHaveBeenCalledWith('warning', expect.stringContaining('Uncommitted changes'))

    await send()
    // Nothing is asked of a provider that is gone, and the message still goes.
    expect(request).not.toHaveBeenCalled()
    expect(queue).toHaveBeenCalledTimes(1)
  })
})

describe('a chip that fails', () => {
  it('still stops the send, because that promise was real', async () => {
    // Unchanged, and the reason the rule exists: a message silently missing
    // what its chip promised misleads the agent.
    request.mockRejectedValue(new Error('gh is not installed'))
    mount([ANYWHERE])
    openPicker()
    attach('Uncommitted changes')
    await send()

    expect(queue).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('warning', expect.stringContaining('gh is not installed'))
  })
})
