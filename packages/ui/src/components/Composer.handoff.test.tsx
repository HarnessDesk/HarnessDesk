import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { deskContextContent, runtimeId, sessionId, splitContextContent, type RuntimeInfo, wrapContext } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { Drafts, NEW_SESSION_DRAFT_KEY } from '../state/drafts'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Composer } from './Composer'

/**
 * Sending a draft that carries a hand-off.
 *
 * The bug this replaced: when the packet could not be built — the source
 * agent restarted, its store never had the session — the chip was dropped
 * silently and the instruction went out on its own, so the new agent was
 * asked to "carry on" with work it had never heard of.
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

const runtime: RuntimeInfo = {
  id: runtimeId('claude-code'),
  name: 'Claude Code',
  capabilities: { imageInput: true } as RuntimeInfo['capabilities'],
  presentation: { name: 'Claude Code' },
} as RuntimeInfo

const calls = {
  queue: vi.fn(async (_input: readonly unknown[], _key?: unknown) => true),
  steer: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
  notice: vi.fn(),
  handoffPacket: vi.fn(async () => null as string | null),
  clearDraftHandoff: vi.fn(),
  openSession: vi.fn(async () => {}),
  runCommand: vi.fn(async () => true),
}

const mount = (paneId?: string): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    runtimes: [runtime],
    activeRuntime: runtime.id,
    health: { state: 'ready' } as AppSnapshot['health'],
    workspace: { path: '/w', name: 'w' } as AppSnapshot['workspace'],
    activeSessionKey: null,
    draftHandoff: {
      runtime: runtimeId('codex'),
      sessionId: sessionId('s-1'),
      carry: 'summary',
      agentName: 'OpenAI Codex',
      title: 'Build pong',
      cwd: '/w',
    },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn() },
    // Each fixture is a separate window; it must not restore another test's mirror.
    drafts: new Drafts(null),
    ...calls,
  } as unknown as AppStore
  if (paneId) {
    const rootId = paneId.split(':')[0]!
    Object.assign(snapshot, { workbench: { ...snapshot.workbench, main: { root: { kind: 'pane', id: rootId, view: { kind: 'conversation', session: null } }, focused: rootId, expanded: null } } })
  }
  const composer = <Composer onChooseProject={() => {}} />
  act(() => {
    root.render(
      <StoreProvider store={store}>
        {paneId ? <PaneProvider scope={{ paneId, view: { kind: 'conversation', session: null }, sessionKey: null }}>{composer}</PaneProvider> : composer}
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

const enter = (): void => {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockClear()
})

describe('the window’s chord over a composer', () => {
  it('leaves ⌥⌘↵ to the window — it neither sends nor stops the event', async () => {
    mount()
    type('Not yet.')
    const event = new KeyboardEvent('keydown', { key: 'Enter', altKey: true, metaKey: true, bubbles: true, cancelable: true })
    act(() => { textarea().dispatchEvent(event) })
    await act(async () => {})
    expect(calls.queue).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves ⌥⌘↵ to the window with a completion menu open, picking nothing', async () => {
    mount()
    type('/')
    await act(async () => {})
    expect(document.querySelector('[role="listbox"], [role="option"]')).not.toBeNull()
    const event = new KeyboardEvent('keydown', { key: 'Enter', altKey: true, metaKey: true, bubbles: true, cancelable: true })
    act(() => { textarea().dispatchEvent(event) })
    await act(async () => {})
    expect(event.defaultPrevented).toBe(false)
    expect(textarea().value).toBe('/')
  })
})

it('a focused composer refuses another pane target without acknowledging or changing its draft', () => {
  mount('owning-pane')
  type('Keep this draft')
  const received = vi.fn()
  act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { paneId: 'other-pane', text: 'Wrong target', onReceived: received } })))
  expect(received).not.toHaveBeenCalled()
  expect(textarea().value).toBe('Keep this draft')
  act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { paneId: 'owning-pane', text: 'Own target', onReceived: received } })))
  expect(received).toHaveBeenCalledTimes(1)
  expect(textarea().value).toBe('Keep this draft\nOwn target')
  // Existing untargeted callers still reach the focused composer.
  act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { text: 'Continue here', onReceived: received } })))
  expect(received).toHaveBeenCalledTimes(2)
  expect(textarea().value).toBe('Keep this draft\nOwn target\nContinue here')
})

it('a synthetic member composer accepts its exact owner target while the Team root has focus', () => {
  mount('team-main:member-session')
  const received = vi.fn()
  act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { paneId: 'team-main:member-session', text: 'Commit this member', onReceived: received } })))
  expect(received).toHaveBeenCalledTimes(1)
  expect(textarea().value).toBe('Commit this member')
})

it('keeps the synthetic member fixture independent of a different window draft', () => {
  const otherWindow = new Drafts(sessionStorage)
  otherWindow.setLive(NEW_SESSION_DRAFT_KEY, { text: 'Not yet.', attachments: [] })
  window.dispatchEvent(new Event('pagehide'))
  try {
    mount('team-main:member-session')
    const received = vi.fn()
    act(() => window.dispatchEvent(new CustomEvent('harnessdesk:compose', { detail: { paneId: 'team-main:member-session', text: 'Commit this member', onReceived: received } })))
    expect(received).toHaveBeenCalledTimes(1)
    expect(textarea().value).toBe('Commit this member')
  } finally {
    otherWindow.setLive(NEW_SESSION_DRAFT_KEY, { text: '', attachments: [] })
  }
})

describe('a draft carrying a hand-off', () => {
  it('shows what it is carrying, and from whom', () => {
    mount()
    expect(container.textContent).toContain('From Codex — Build pong')
    expect(container.textContent).toContain('summary')
  })

  it('sends the packet first, then the instruction', async () => {
    const packet = wrapContext('Handed off from OpenAI Codex — “Build pong”', '## Goal\nfinish the scoring')
    const pasted = wrapContext('Pasted elsewhere', 'keep this wrapper as typed text')
    const typed = `Carry on with the scoring.\n\n${pasted}`
    calls.handoffPacket.mockImplementationOnce(async () => packet)
    mount()
    type(typed)
    enter()
    await act(async () => {})
    expect(calls.queue).toHaveBeenCalledTimes(1)
    expect(calls.queue.mock.calls[0]?.[0]).toEqual([deskContextContent(packet), { type: 'text', text: typed }])
    expect(splitContextContent(calls.queue.mock.calls[0]?.[0] as never)).toEqual({
      injections: [{ label: 'Handed off from OpenAI Codex — “Build pong”', text: '## Goal\nfinish the scoring' }],
      text: typed,
    })
  })

  it('sends nothing at all when the packet could not be built', async () => {
    mount()
    type('Carry on with the scoring.')
    enter()
    await act(async () => {})
    expect(calls.queue).not.toHaveBeenCalled()
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.notice).toHaveBeenCalledWith('warning', expect.stringContaining('Build pong'))
    // And the instruction is still there to send, or to reword.
    expect(textarea().value).toBe('Carry on with the scoring.')
  })
})

it('sends once when Enter comes again while the packet is still being built', async () => {
  // With a new worktree armed, a second send is a second worktree and branch.
  const pending: Array<(packet: string | null) => void> = []
  calls.handoffPacket.mockImplementation(() => new Promise<string | null>((resolve) => pending.push(resolve)))
  try {
    mount()
    type('Carry on with the scoring.')
    enter()
    enter()
    await act(async () => {
      for (const finish of pending) finish('<context source="Handed off from OpenAI Codex — “Build pong”">…</context>')
    })
    await act(async () => {})

    expect(calls.queue).toHaveBeenCalledTimes(1)
  } finally {
    calls.handoffPacket.mockImplementation(async () => null)
  }
})

it("waits for a draft's first send to make its conversation before it takes another", async () => {
  // A second send from the draft would cut a second worktree and start a second agent.
  const queued: Array<(ok: boolean) => void> = []
  calls.handoffPacket.mockImplementation(async () => '<context source="Handed off from OpenAI Codex — “Build pong”">…</context>')
  calls.queue.mockImplementation(() => new Promise<boolean>((resolve) => queued.push(resolve)))
  try {
    mount()
    type('Start the scoring.')
    enter()
    await act(async () => {})
    type('And the sound.')
    enter()
    await act(async () => {})

    expect(calls.queue).toHaveBeenCalledTimes(1)
    expect(textarea().value).toBe('And the sound.')
  } finally {
    for (const finish of queued) finish(true)
    calls.handoffPacket.mockImplementation(async () => null)
    calls.queue.mockImplementation(async () => true)
  }
})
