import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
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

const mount = (): void => {
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

const enter = (): void => {
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockClear()
})

describe('a draft carrying a hand-off', () => {
  it('shows what it is carrying, and from whom', () => {
    mount()
    expect(container.textContent).toContain('From Codex — Build pong')
    expect(container.textContent).toContain('summary')
  })

  it('sends the packet first, then the instruction', async () => {
    calls.handoffPacket.mockImplementationOnce(async () => '<context source="Handed off from OpenAI Codex — “Build pong”">…</context>')
    mount()
    type('Carry on with the scoring.')
    enter()
    await act(async () => {})
    expect(calls.queue).toHaveBeenCalledTimes(1)
    expect(calls.queue.mock.calls[0]?.[0]).toEqual([
      { type: 'text', text: '<context source="Handed off from OpenAI Codex — “Build pong”">…</context>' },
      { type: 'text', text: 'Carry on with the scoring.' },
    ])
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
