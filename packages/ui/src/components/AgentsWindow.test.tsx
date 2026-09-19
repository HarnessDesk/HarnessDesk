import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type RuntimeInfo, type SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentsWindow } from './AgentsWindow'

/**
 * The Agents window: the left-menu screen (never Settings) that reads the
 * roster once, on opening, and shows either the overview (every Agent, in
 * precedence order) or one Agent's own page, selected from the rail.
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

const entry = (id: string, name: string, over: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name} does the work.`,
    ceiling: 'edit',
    ceilingFrom: 'permission',
    answers: [],
    produces: [],
    skills: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Work.',
  },
  ...over,
})

const ROSTER: readonly AgentEntry[] = [
  entry('code-reviewer', 'Code reviewer'),
  entry('judge', 'Judge'),
  entry('draft', 'Draft', { definition: null, problems: [{ level: 'error', at: 'permission', text: 'bad' }] }),
]

const PLANS = new Map<string, SeatPlan>([
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'prefer',
      winner: 0,
      blocked: null,
      candidates: [{ seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
    },
  ],
  [
    'judge',
    {
      id: 'judge',
      from: 'prefer',
      winner: null,
      blocked: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Cursor', runtimeName: 'Cursor', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
      ],
    },
  ],
])

const mount = (focus: string | null = null) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
    runtimes: [{ id: runtimeId('claude-code'), capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
    agents: ROSTER,
    agentPlans: PLANS,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: vi.fn(async () => {}),
    loadSeating: vi.fn(async () => {}),
  } as unknown as AppStore
  const onClose = vi.fn()
  const onFocus = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentsWindow focus={focus} onClose={onClose} onFocus={onFocus} />
      </StoreProvider>,
    )
  })
  return { store, onClose, onFocus }
}

const navItem = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('nav button')].find((one) => one.textContent?.includes(label))
  if (!found) throw new Error(`no nav row reading “${label}”`)
  return found as HTMLButtonElement
}

it('reads the roster once, on opening', () => {
  const { store } = mount()
  expect(store.loadAgents).toHaveBeenCalled()
})

it('the rail leads with All Agents, then the roster grouped by origin', () => {
  mount()
  expect(navItem('All Agents')).toBeDefined()
  expect(navItem('Code reviewer')).toBeDefined()
  expect(navItem('Judge')).toBeDefined()
  expect(navItem('draft')).toBeDefined()
})

it('shows the overview when nothing is selected, and a placeholder once an Agent is', () => {
  mount(null)
  expect(container.textContent).toContain('Who does the work')

  const { onFocus } = mount(null)
  act(() => navItem('Code reviewer').click())
  expect(onFocus).toHaveBeenCalledWith('code-reviewer')
})

it('a selected Agent gets its own page, not the overview', () => {
  mount('code-reviewer')
  expect(container.textContent).not.toContain('Who does the work')
  // The Agent's own page (Task 15) — a drill, not a settings section: no page title, its name in the head instead.
  expect(container.querySelector('[data-slot="page-title"]')).toBeNull()
  expect(container.textContent).toContain('Code reviewer does the work.')
})

it('wears a state mark for an Agent that will not parse', () => {
  mount()
  const row = navItem('draft')
  expect(row.querySelector('[data-state="broken"]')).not.toBeNull()
})

it('wears a state mark for an Agent that cannot be seated here', () => {
  mount()
  const row = navItem('Judge')
  expect(row.querySelector('[data-state]')).not.toBeNull()
  // Never the reason inline in the rail — the overview page says why; the rail only marks it.
  expect(row.textContent).not.toContain('signed out')
})

it('an Agent that can be seated wears no state mark', () => {
  mount()
  const row = navItem('Code reviewer')
  expect(row.querySelector('[data-state]')).toBeNull()
})
