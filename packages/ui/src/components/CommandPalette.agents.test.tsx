import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type RuntimeInfo, type SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { CommandPalette } from './CommandPalette'

/**
 * "Start with <agent>" promises a conversation.
 *
 * Choosing the agent is a preference that leaves the screen alone, so the
 * palette has to open the draft itself — for the agent it just chose, and
 * for the one that was already chosen. Pinned because the old switch opened
 * the draft as a side effect, and a row that only set a preference would
 * read as a dead row.
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

const CODEX = runtimeId('codex')
const CLAUDE = runtimeId('claude-code')

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id, name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

const reviewer = (id: string, name: string): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name}.`,
    ceiling: 'edit',
    ceilingFrom: 'permission',
    answers: [],
    produces: [],
    skills: [],
    mcp: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Review.',
  },
})

const PLANS = new Map<string, SeatPlan>([
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'prefer',
      winner: 0,
      blocked: null,
      ceiling: { level: 'edit', hold: 'asked' },
      candidates: [{ seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
    },
  ],
])

const mount = async (): Promise<{
  selectRuntime: ReturnType<typeof vi.fn>
  newDraft: ReturnType<typeof vi.fn>
  store: AppStore
  openAgents: ReturnType<typeof vi.fn>
}> => {
  const selectRuntime = vi.fn(async () => {})
  const newDraft = vi.fn()
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [runtime(CODEX, 'OpenAI Codex'), runtime(CLAUDE, 'Claude Code')],
    activeRuntime: CODEX,
    agents: [reviewer('code-reviewer', 'Code reviewer')],
    agentPlans: PLANS,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request: vi.fn(async () => ({ data: [], nextCursor: null })) },
    selectRuntime,
    newDraft,
    loadAgents: vi.fn(async () => {}),
    startAsAgent: vi.fn(async () => null),
  } as unknown as AppStore
  const openAgents = vi.fn()
  const host = { close: () => {}, chooseFolder: () => {}, openSettings: () => {}, openUsage: () => {}, openAgents }
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <CommandPalette host={host} />
      </StoreProvider>,
    )
  })
  return { selectRuntime, newDraft, store, openAgents }
}

const type = (value: string): void => {
  const field = container.querySelector('input')
  if (!field) throw new Error('no palette input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const row = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) =>
    node.textContent?.includes(label),
  )
  if (!found) throw new Error(`no row reading “${label}”`)
  return found
}

it('starting with another agent chooses it and opens a draft', async () => {
  const { selectRuntime, newDraft } = await mount()
  type('start with claude')
  act(() => row('Start with Claude Code').click())
  expect(selectRuntime).toHaveBeenCalledWith(CLAUDE)
  expect(newDraft).toHaveBeenCalledOnce()
})

it('starting with the agent already chosen opens the draft, and still puts the pick through the store', async () => {
  // The store makes a same-agent pick a no-op — unless that agent has
  // crashed, in which case the pick is the restart its health asks for. The
  // palette therefore never decides for itself that the pick is redundant.
  const { selectRuntime, newDraft } = await mount()
  type('start with codex')
  const current = row('Start with OpenAI Codex')
  expect(current.textContent).toContain('current')
  act(() => current.click())
  expect(selectRuntime).toHaveBeenCalledWith(CODEX)
  expect(newDraft).toHaveBeenCalledOnce()
  // The draft is opened after the pick, in the same tick: `selectRuntime`
  // patches the default before its first await, so the draft reads it.
  expect(selectRuntime.mock.invocationCallOrder[0]).toBeLessThan(newDraft.mock.invocationCallOrder[0]!)
})

it('Start as <Agent> starts a conversation as it, and says where it would sit', async () => {
  const { store } = await mount()
  type('start as code')
  const start = row('Start as Code reviewer')
  expect(start.textContent).toContain('Claude')
  act(() => start.click())
  expect(store.startAsAgent).toHaveBeenCalledWith('code-reviewer')
})

it('Open <Agent> opens the Agents window on it, never Settings', async () => {
  const { openAgents } = await mount()
  type('open code reviewer')
  act(() => row('Open Code reviewer').click())
  expect(openAgents).toHaveBeenCalledWith('code-reviewer')
})
