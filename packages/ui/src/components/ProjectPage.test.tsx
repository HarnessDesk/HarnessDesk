import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowEntry, ProjectChecks, WorkspaceEntry } from '@harnessdesk/protocol'

import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { WorkspacesSection } from './Settings'
import { WorkspaceMenu } from './WorkspaceMenu'

/**
 * Workspaces › a project: the project's own Agents, reached from its folder
 * row and from the sidebar's project menu.
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

const STOREFRONT: WorkspaceEntry = {
  path: '/home/dev/work/storefront',
  name: 'storefront',
  lastOpenedAt: 3,
  repo: { root: '/home/dev/work/storefront', worktree: false },
}
const DOCS: WorkspaceEntry = { path: '/home/dev/work/docs', name: 'docs', lastOpenedAt: 2 }
const SCRATCH: WorkspaceEntry = { path: '/home/dev/work/scratch', name: 'scratch', lastOpenedAt: 1 }

const agent = (id: string, name: string, origin: AgentEntry['origin'], folder: string): AgentEntry => ({
  id,
  origin,
  path: `${folder}/${id}/AGENT.md`,
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
})

const JUDGE = agent('judge', 'Judge', 'builtin', '/app/agents')
const AGENTS: Readonly<Record<string, readonly AgentEntry[]>> = {
  [STOREFRONT.path]: [agent('code-reviewer', 'Code reviewer', 'project', `${STOREFRONT.path}/.harnessdesk/agents`), JUDGE],
  [DOCS.path]: [agent('editor', 'Docs editor', 'project', `${DOCS.path}/.harnessdesk/agents`), JUDGE],
  [SCRATCH.path]: [JUDGE],
}

const CHECKS = (path: string): ProjectChecks => ({
  project: path,
  file: `${path}/.harnessdesk/checks.yml`,
  exists: path === STOREFRONT.path,
  at: null,
  uncommitted: false,
  checks: path === STOREFRONT.path ? [{ name: 'verify', run: 'pnpm verify', timeout: 600, seen: 'no' }] : [],
  problems: [],
})

const FLOWS: Readonly<Record<string, readonly FlowEntry[]>> = {
  [STOREFRONT.path]: [{ id: 'fix', origin: 'project', path: '.harnessdesk/flows/fix.yml', name: 'Fix', description: null, format: 'agents', problem: null, shadows: [] }],
}

const mount = (node: React.ReactNode) => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/home/dev',
    workspace: STOREFRONT,
    workspaces: [STOREFRONT, DOCS, SCRATCH],
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadWorktrees: vi.fn(async () => {}),
    loadLanePreferences: vi.fn(async () => {}),
    agentsIn: vi.fn(async (path: string) => AGENTS[path] ?? []),
    projectChecks: vi.fn(async (path: string) => CHECKS(path)),
    flowCatalog: vi.fn(async (path: string) => FLOWS[path] ?? []),
    loadCaptureHealth: vi.fn(async () => {}),
    setCapture: vi.fn(async () => ({ project: STOREFRONT.path, enabled: true, state: 'healthy', reason: 'Current.', nextStep: 'None.', checkedAt: 1, lastCapturedAt: 1, pending: 0, gaps: 0, revision: 1 })),
    retryCapture: vi.fn(async () => ({ project: STOREFRONT.path, enabled: true, state: 'healthy', reason: 'Current.', nextStep: 'None.', checkedAt: 1, lastCapturedAt: 1, pending: 0, gaps: 0, revision: 1 })),
    openWorkspace: vi.fn(async () => {}),
    forgetWorkspace: vi.fn(async () => {}),
    askSettings: vi.fn(),
    startSessionIn: vi.fn(async () => {}),
  } as unknown as AppStore
  const openAgents = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShellProvider
          actions={{
            chooseProject: () => {},
            signIn: () => {},
            openUsage: () => {},
            openRuntimes: () => {},
            openAgents,
          }}
        >
          {node}
        </ShellProvider>
      </StoreProvider>,
    )
  })
  return { store, openAgents }
}

const settle = () => act(async () => {})
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}
const rowFor = (name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith(name))
  if (!found) throw new Error(`no row for ${name}`)
  return found
}
const agentsText = (): string => container.querySelector('section[aria-label="Agents"]')?.textContent ?? ''

it('each folder opens its project’s page, which lists the project’s own Agents and the folder they are read from', async () => {
  const { store } = mount(<WorkspacesSection />)
  expect(container.textContent).toContain('~/work/docs')
  act(() => rowFor('storefront').click())
  await settle()
  expect(store.agentsIn).toHaveBeenCalledWith(STOREFRONT.path)
  expect(button('Workspaces')).toBeDefined()
  const text = agentsText()
  expect(text).toContain('Code reviewer')
  expect(text).toContain('Edit')
  expect(text).toContain('~/work/storefront/.harnessdesk/agents')
  // Only its own: what ships and what is yours are not the project's.
  expect(text).not.toContain('Judge')
})

it('the open project’s Agents open their pages in the Agents window', async () => {
  const { openAgents } = mount(<WorkspacesSection focus={STOREFRONT.path} />)
  await settle()
  act(() => rowFor('Code reviewer').click())
  expect(openAgents).toHaveBeenCalledWith('code-reviewer')
})

it('a project not open says how to reach its Agents, and is opened or forgotten from its page', async () => {
  const { store } = mount(<WorkspacesSection focus={DOCS.path} />)
  await settle()
  expect(agentsText()).toContain('Docs editor')
  expect(container.querySelectorAll('section[aria-label="Agents"] button')).toHaveLength(0)
  expect(container.textContent).toContain('Open this project to start its Agents')
  act(() => button('Open').click())
  expect(store.openWorkspace).toHaveBeenCalledWith(DOCS.path)
  act(() => button('Forget').click())
  expect(store.forgetWorkspace).toHaveBeenCalledWith(DOCS.path)
})

it('a project with no Agents of its own says how to give it one', async () => {
  mount(<WorkspacesSection focus={SCRATCH.path} />)
  await settle()
  expect(agentsText()).toContain('No Agents of its own')
})

it('the sidebar’s project menu opens the project’s page', () => {
  const { store } = mount(
    <WorkspaceMenu
      group={{ root: STOREFRONT.path, name: 'storefront', sessions: [], updatedAt: 0 }}
      at={{ x: 10, y: 10 }}
      onClose={() => {}}
      onNewWorktree={() => {}}
    />,
  )
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (one) => one.textContent?.startsWith('Project settings'),
  )
  if (!item) throw new Error('no Project settings item')
  act(() => item.click())
  expect(store.askSettings).toHaveBeenCalledWith('workspaces', STOREFRONT.path)
})

it('a project’s checks follow its Agents, and a project with no checks file shows none', async () => {
  mount(<WorkspacesSection focus={STOREFRONT.path} />)
  await settle()
  const sections = [...container.querySelectorAll('section[aria-label]')].map((one) => one.getAttribute('aria-label'))
  expect(sections).toEqual(['Agents', 'Flows', 'Checks', 'Provenance'])
  expect(container.querySelector('section[aria-label="Checks"]')?.textContent).toContain('pnpm verify')

  act(() => root.unmount())
  root = createRoot(container)
  mount(<WorkspacesSection focus={DOCS.path} />)
  await settle()
  expect(container.querySelector('section[aria-label="Checks"]')).toBeNull()
})

it('the project’s flows are read lazily, only once its page is open, and never on the plain Workspaces list', async () => {
  const { store } = mount(<WorkspacesSection />)
  expect(store.flowCatalog).not.toHaveBeenCalled()
  act(() => rowFor('storefront').click())
  await settle()
  expect(store.flowCatalog).toHaveBeenCalledWith(STOREFRONT.path)
  const text = container.querySelector('section[aria-label="Flows"]')?.textContent ?? ''
  expect(text).toContain('Fix')
})
