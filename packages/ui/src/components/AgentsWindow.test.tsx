import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type RuntimeInfo, type SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { installTopBarTestLayout } from '../test/top-bar-layout'
installTopBarTestLayout()
import { agentsDestinationStore } from '../preview/agents-destination-fixture'
import { PREVIEW_SESSION_KEY } from '../preview/harness'
import { AgentsWindow } from './AgentsWindow'

/** The controlled Agents destination reads only while active and uses the shell bar. */

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
    mcp: [],
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
      ceiling: { level: 'edit', hold: 'asked' },
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
      ceiling: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Cursor', runtimeName: 'Cursor', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
      ],
    },
  ],
])

const mount = (focus: string | null = null, active = true) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/home/dev',
    stateDir: '/home/dev/.harnessdesk',
    runtimes: [{ id: runtimeId('claude-code'), capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
    agents: ROSTER,
    agentPlans: PLANS,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: vi.fn(async () => {}),
    loadSeating: vi.fn(async () => {}),
    readAgentAttachments: vi.fn(async () => ({
      agent: 'x',
      origin: 'user',
      agentDigest: 'd',
      skillsMode: 'runtime-defaults',
      mcpMode: 'runtime-defaults',
      declarations: [],
      support: [],
    })),
    readAgentNotes: vi.fn(async () => ({ path: '/NOTES.md', text: null, digest: null, writable: true, problem: null })),
    // The overview's unfinished-saves banner and the Agent page's editable
    // fields: neutral defaults, so a test with no opinion about either still
    // settles rather than throwing "not a function".
    authoringPending: vi.fn(async () => []),
    readAuthoring: vi.fn(async (target: { readonly id?: string }) => ({
      target,
      source: '---\nname: x\n---\nBrief.\n',
      digest: `digest-${target.id ?? 'x'}`,
      exists: true,
      displayPath: 'AGENT.md',
      writable: true,
      issues: [],
    })),
  } as unknown as AppStore
  const onClose = vi.fn()
  const onFocus = vi.fn()
  const render = (shown: boolean) => act(() => {
    root.render(
      <StoreProvider store={store}>
        <TopBarProvider><DestinationPageScope owner="destination:agents" active={shown}><AgentsWindow focus={focus} onFocus={onFocus} /></DestinationPageScope><TopBarOutlet owner="destination:agents" fallback={{ place: 'Agents', more: () => null }} /></TopBarProvider>
      </StoreProvider>,
    )
  })
  render(active)
  return { store, onClose, onFocus, render }
}

it('dismisses New Agent when the retained page deactivates and does not reopen it on return', async () => {
  const { render } = mount()
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'New Agent…')!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  render(false)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  render(true)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('reads the roster once, on opening', () => {
  const { store } = mount()
  expect(store.loadAgents).toHaveBeenCalledTimes(1)
})
it('Agents in main has one page and no private rail or a redundant return action', () => {
  mount()
  expect(container.querySelector('[data-slot="app-window"]')).toBeNull()
  expect(container.querySelector('nav')).toBeNull()
  expect(container.textContent).not.toContain(['Back', 'to', 'app'].join(' '))
  expect(container.querySelector('[data-slot="page"]')?.getAttribute('data-width')).toBe('wide')
})
it('the roster records a named route through its caller', () => {
  const { onFocus } = mount()
  const row = [...container.querySelectorAll('button')].find(button => button.textContent?.startsWith('Code reviewer'))!
  act(() => row.click())
  expect(onFocus).toHaveBeenCalledWith('code-reviewer')
})
it('a named Agent uses the reading page and the parent crumb in the shared bar', () => {
  const { onFocus } = mount('code-reviewer')
  expect(container.querySelector('[data-slot="page"]')?.getAttribute('data-width')).toBe('reading')
  const parent = [...container.querySelectorAll('button')].find(button => button.textContent === 'Agents ›')!
  expect(parent).toBeTruthy()
  act(() => parent.click())
  expect(onFocus).toHaveBeenCalledWith(null)
  expect(container.querySelector('[data-slot="page-title"]')).toBeNull()
})
it('a missing focused Agent falls back to the roster and wide measure', () => {
  mount('missing-agent')
  expect(container.textContent).toContain('Who does the work')
  expect(container.querySelector('[data-slot="page"]')?.getAttribute('data-width')).toBe('wide')
})

for (const refused of [false, true]) it(`a ${refused ? 'refused' : 'successful'} start keeps the real destination contract`, async () => {
  const store = agentsDestinationStore(new URLSearchParams('frame-wall=agents&frame-detail=agent'))
  const original = store.transport.request.bind(store.transport)
  const returnToWork = vi.spyOn(store, 'returnToWork')
  const seed = store.getSnapshot()
  const plan = seed.agentPlans.get('code-reviewer')!
  const session = seed.sessions.get(PREVIEW_SESSION_KEY)!
  store.transport.request = (async (method, params) => {
    if (method === 'agent/seat/dry') return [{ ...plan, winner: refused ? null : plan.winner }]
    if (method === 'agent/seat') return session
    return original(method, params as never)
  }) as typeof store.transport.request
  await act(async () => root.render(<StoreProvider store={store}><TopBarProvider>
    <DestinationPageScope owner="destination:agents" active><AgentsWindow focus="code-reviewer" onFocus={() => {}} /></DestinationPageScope>
    <TopBarOutlet owner="destination:agents" fallback={{ place: 'Agents', more: () => null }} />
  </TopBarProvider></StoreProvider>))
  const start = container.querySelector<HTMLButtonElement>('[data-topbar="verb"] button')!
  expect(start).toBeTruthy()
  await act(async () => { start.click() })
  expect(returnToWork).not.toHaveBeenCalled()
  if (refused) {
    expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'agents', id: 'code-reviewer' })
    expect(store.getSnapshot().seatRefusal?.agent).toBe('code-reviewer')
  } else {
    expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
    expect(store.getSnapshot().activeSessionKey).toBe(PREVIEW_SESSION_KEY)
  }
})

it('a retained inactive Agents page does not load its roster or claim the bar', () => {
  const { store } = mount(null, false)
  expect(store.loadAgents).not.toHaveBeenCalled()
  expect(container.querySelector('[data-topbar="verb"] button')).toBeNull()
})
