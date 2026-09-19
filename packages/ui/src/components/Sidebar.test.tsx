import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runtimeId, type RuntimeHealth, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Sidebar } from './Sidebar'

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
  ({
    id,
    name,
    capabilities: {},
    presentation: { name, brand: id, historySource: 'Claude' },
  }) as unknown as RuntimeInfo

const codex = runtime(CODEX, 'OpenAI Codex')
const claude = runtime(CLAUDE, 'Claude Code')

const unavailableHealth: RuntimeHealth = {
  state: 'unavailable',
  reason: 'notInstalled',
  message: 'Codex is not installed',
}

const readyHealth: RuntimeHealth = {
  state: 'ready',
}

const mount = (overrides: Partial<AppSnapshot> = {}) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [codex, claude],
    activeRuntime: CLAUDE,
    // Default runtime is down / unavailable
    health: unavailableHealth,
    // Active runtime is ready
    healthByRuntime: {
      [CLAUDE]: readyHealth,
      [CODEX]: unavailableHealth,
    },
    workspace: {
      path: '/workspace/repo',
      git: { branch: 'main' },
    } as AppSnapshot['workspace'],
    ...overrides,
  }

  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    searchHistory: vi.fn(async () => {}),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenAgents={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
        />
      </StoreProvider>,
    )
  })

  return container
}

describe('Sidebar readiness with active runtime (#382)', () => {
  it('enables New session button when active runtime is ready even if default runtime health is not ready', () => {
    mount()
    const newSessionBtn = container.querySelector<HTMLButtonElement>('button[title*="Start one agent"]')
    expect(newSessionBtn).not.toBeNull()
    expect(newSessionBtn?.disabled).toBe(false)
  })

  it('enables Worktrees button when active runtime is ready even if default runtime health is not ready', () => {
    mount()
    const worktreeBtn = container.querySelector<HTMLButtonElement>('button[title*="Worktrees of this project"]')
    expect(worktreeBtn).not.toBeNull()
    expect(worktreeBtn?.disabled).toBe(false)
  })

  it('shows no sessions empty state rather than connect runtime when active runtime is ready', () => {
    mount()
    const empty = container.querySelector('p[class*="empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).not.toContain('Connect a runtime to see your sessions.')
    expect(empty?.textContent).toContain('No sessions yet.')
  })

  it('disables New session and Worktrees when active runtime is not ready', () => {
    mount({
      healthByRuntime: {
        [CLAUDE]: unavailableHealth,
        [CODEX]: unavailableHealth,
      },
    })
    const newSessionBtn = container.querySelector<HTMLButtonElement>('button[title*="Start one agent"]')
    expect(newSessionBtn).not.toBeNull()
    expect(newSessionBtn?.disabled).toBe(true)

    const worktreeHelp = container.querySelector<HTMLElement>('[aria-label*="Connect an agent"]')
    expect(worktreeHelp).not.toBeNull()
    expect(worktreeHelp?.tabIndex).toBe(0)
    const worktreeBtn = worktreeHelp?.querySelector<HTMLButtonElement>('button')
    expect(worktreeBtn?.disabled).toBe(true)

    const empty = container.querySelector('p[class*="empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('Connect a runtime to see your sessions.')
  })
})

/**
 * The plain path's one new row (the owner's rule, 2026-09-18): always there,
 * reading nothing of its own — it counts whatever roster another surface has
 * already asked for, and wears the Dashboard badge's own warn tone rather
 * than a rule drawn just for this row.
 */
describe('the Agents row', () => {
  const agentsRow = (): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith('Agents'))
    if (!found) throw new Error('no Agents row')
    return found
  }

  it('shows with no count before any surface has read the roster', () => {
    mount()
    const row = agentsRow()
    expect(row.querySelector('span[class*="navCount"]')).toBeNull()
  })

  it('counts the roster once something has read it, in force only', () => {
    mount({
      agents: [
        { id: 'a', origin: 'builtin', path: '/a/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'a', name: 'A', permission: 'read', answers: [], produces: [], skills: [], prefer: [], brief: '' } },
        { id: 'b', origin: 'builtin', path: '/b/AGENT.md', digest: 'd', shadows: [], problems: [{ level: 'error', at: 'x', text: 'bad' }], definition: null },
      ],
    } as unknown as Partial<AppSnapshot>)
    const row = agentsRow()
    // Only "a" parses; "b" is broken and not counted as in force.
    expect(row.textContent).toContain('1')
    expect(row.querySelector('[data-tone="warn"]')?.textContent).toBe('1')
  })

  it('wears no warn tone when nothing is broken', () => {
    mount({
      agents: [
        { id: 'a', origin: 'builtin', path: '/a/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'a', name: 'A', permission: 'read', answers: [], produces: [], skills: [], prefer: [], brief: '' } },
      ],
    } as unknown as Partial<AppSnapshot>)
    const row = agentsRow()
    expect(row.querySelector('[data-tone="warn"]')).toBeNull()
  })
})
