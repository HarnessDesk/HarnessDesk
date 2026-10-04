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
let newDraft: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  newDraft = vi.fn()
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

const mount = (overrides: Partial<AppSnapshot> = {}, activeDestination: 'teams' | 'agents' | 'dashboard' | 'plugins' | null = null) => {
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
      worktrees: [{ path: '/workspace/repo/.worktrees/topic', branch: 'topic', head: 'abc', isMain: false, managed: true }],
      ...overrides,
  }

  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    searchHistory: vi.fn(async () => {}),
    newDraft,
    loadWorktrees: vi.fn(async () => {}),
    loadAgents: vi.fn(async () => {}),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenTeams={() => {}} onOpenAgents={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
          activeDestination={activeDestination}
        />
      </StoreProvider>,
    )
  })

  return container
}

describe('Sidebar readiness with active runtime (#382)', () => {
  it('enables New session button when active runtime is ready even if default runtime health is not ready', () => {
    mount()
    const newSessionBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.includes('New session'))
    expect(newSessionBtn).not.toBeNull()
    expect(newSessionBtn?.disabled).toBe(false)
  })

  it('one click on New session starts a draft without opening the chooser', () => {
    mount()
    const newSessionBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.includes('New session'))!
    act(() => newSessionBtn.click())
    expect(newDraft).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-slot="dialog"]')).toBeNull()
  })

  it('the more-ways menu keeps worktree choices first and opens Goal preselected', () => {
    mount()
    const trigger = container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!
    act(() => trigger.click())
    const menu = document.querySelector('[role="menu"]')!
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((one) => one.textContent?.trim())
    expect(items).toEqual(['New worktree…', 'topic', 'Goal…', 'Flow…', 'Team…'])
    expect(menu.querySelector('[role="separator"]')).not.toBeNull()
    const goal = [...menu.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === 'Goal…')!
    act(() => goal.click())
    const goalChoice = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((one) => one.textContent?.startsWith('Goal'))
    expect(goalChoice?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows no sessions empty state rather than connect runtime when active runtime is ready', () => {
    mount()
    const empty = container.querySelector('[data-slot="empty-state"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).not.toContain('Connect a runtime to see your sessions.')
    expect(empty?.textContent).toContain('No sessions yet.')
  })

  it('disables direct session start when the active runtime is not ready but keeps the menu reachable', () => {
    mount({
      healthByRuntime: {
        [CLAUDE]: unavailableHealth,
        [CODEX]: unavailableHealth,
      },
    })
    const newSessionBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.includes('New session'))
    expect(newSessionBtn).not.toBeNull()
    expect(newSessionBtn?.disabled).toBe(true)

    const moreWays = container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')
    expect(moreWays).not.toBeNull()
    expect(moreWays?.disabled).toBe(false)

    const empty = container.querySelector('[data-slot="empty-state"]')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('Connect a runtime to see your sessions.')
  })
})

it('keeps the workbench-owned header, one content scroller, and footer as plain layout', () => {
  mount()
  const header = container.querySelector('[data-region="sidebar-header"]')!
  const content = container.querySelector('[data-region="sidebar-content"]')!
  const footer = container.querySelector('[data-region="sidebar-footer"]')!
  expect(header.querySelector('button[aria-label="Search everything"]')).not.toBeNull()
  expect(content.querySelector('[data-slot="navigation-group-label"]')?.textContent).toContain('Projects')
  expect(footer.childElementCount).toBeGreaterThan(0)
})

it('puts the unread Inbox before search in the title bar and keeps the footer for the person', () => {
  mount({ inbox: [{ id: 'kept', tone: 'info', title: 'Review ready', at: 0, read: false }] })
  const header = container.querySelector('[data-region="sidebar-header"]')!
  const footer = container.querySelector('[data-region="sidebar-footer"]')!
  const search = header.querySelector<HTMLButtonElement>('button[aria-label="Search everything"]')!
  const titleBar = search.closest('[data-slot="bar"]')!
  const bell = titleBar.querySelector('[data-slot="inbox-button"]')!
  expect(bell).not.toBeNull()
  expect(bell.hasAttribute('data-unread')).toBe(true)
  expect(bell.textContent).toBe('1')
  expect(bell.closest('button')?.title).toBe('Inbox, 1 unread')
  expect(bell.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(titleBar.classList.contains('hd-drag')).toBe(true)
  expect(bell.closest('.hd-no-drag')).not.toBeNull()
  expect(search.classList.contains('hd-no-drag')).toBe(true)
  expect(footer.querySelector('[data-slot="inbox-button"]')).toBeNull()
  expect(footer.querySelector('button[data-slot="popover-trigger"]')).not.toBeNull()
})

/**
 * Main's three full navigation rows: counts follow each destination and labels
 * remain present at the minimum sidebar width.
 */
describe('sidebar destinations', () => {
  it('renders four separate, labelled design-system rows with main counts at 200px', () => {
    container.style.width = '200px'
    mount({
      agents: [{ id: 'a', origin: 'builtin', path: '/a/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'a', name: 'A', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], prefer: [], brief: '' } }],
      plugins: [
        { instanceId: 'one', identity: { id: 'one', name: 'One', source: { kind: 'builtin' } } },
        { instanceId: 'two', identity: { id: 'two', name: 'Two', source: { kind: 'builtin' } } },
      ],
      usage: [{ runtime: CLAUDE, account: null, plan: null, lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10080, resetsAt: null }], credits: null, spend: null, reached: null, source: { kind: 'runtime', label: 'API' }, fetchedAt: 1, staleAfterMs: 1, error: null }],
    } as unknown as Partial<AppSnapshot>)
    const group = container.querySelector('[aria-label="Main sections"]')!
    const rows = [...group.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')]
    expect(rows).toHaveLength(4)
    expect(rows.map((one) => one.getAttribute('aria-label'))).toEqual(['Teams', 'Agents', 'Dashboard', 'Plugins'])
    expect(rows.map((one) => one.querySelector('[data-slot="sidebar-menu-label-content"]')?.textContent)).toEqual(['Teams', 'Agents', 'Dashboard', 'Plugins'])
    expect(rows.map((one) => one.querySelector('[data-slot="sidebar-menu-icon"]'))).toHaveLength(4)
    expect(rows.map((one) => one.parentElement?.querySelector('[data-slot="sidebar-menu-badge"]')?.textContent?.trim())).toEqual([undefined, '1', '1', '2'])
    const type = rows.map((one) => {
      const label = one.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"] [data-slot="text"]')!
      return label.getAttribute('data-role')
    })
    expect(type).toEqual(['navigation', 'navigation', 'navigation', 'navigation'])
  })

  it('fills the active row when its destination window is open', () => {
    mount({}, 'plugins')
    const plugins = container.querySelector<HTMLButtonElement>('button[aria-label="Plugins"]')!
    expect(plugins.dataset.active).toBe('true')
    expect(plugins.getAttribute('aria-current')).toBe('page')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Agents"]')?.dataset.active).toBeUndefined()
  })

  it('shows a Dashboard badge only when an agent needs attention', () => {
    mount()
    const dashboard = container.querySelector<HTMLButtonElement>('button[aria-label="Dashboard"]')!
    expect(dashboard.parentElement?.querySelector('[data-slot="sidebar-menu-badge"]')).toBeNull()

    mount({
      usage: [{ runtime: CLAUDE, account: null, plan: null, lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10080, resetsAt: null }], credits: null, spend: null, reached: null, source: { kind: 'runtime', label: 'API' }, fetchedAt: 1, staleAfterMs: 1, error: null }],
    } as unknown as Partial<AppSnapshot>)
    const needsAttention = container.querySelector<HTMLButtonElement>('button[aria-label="Dashboard"]')!
    expect(needsAttention.parentElement?.querySelector('[data-slot="sidebar-menu-badge"]')?.textContent?.trim()).toBe('1')
  })

  it('keeps everything-search and list-filter names distinct and calls the group Projects', () => {
    mount()
    const search = container.querySelector<HTMLButtonElement>('button[aria-label="Search everything"]')!
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Meta+K')
    expect(search.title).toBe('Search everything (⌘K)')
    expect(container.querySelector('input[aria-label="Filter this list"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="navigation-group-label"]')?.textContent).toContain('Projects')
  })

  it('renders the HarnessDesk wordmark at the documented 20px semibold role', () => {
    mount()
    const brand = [...container.querySelectorAll<HTMLElement>('[data-slot="text"]')].find((one) => one.textContent === 'HarnessDesk')!
    expect(brand.dataset.role).toBe('wordmark')
  })

  it('keeps Goal, Flow and Team unavailable without a project folder', () => {
    mount({ workspace: null, workspaces: [] })
    act(() => container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!.click())
    const menu = document.querySelector('[role="menu"]')!
    for (const kind of ['Goal…', 'Flow…', 'Team…']) {
      const row = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((one) => one.textContent?.trim().startsWith(kind))!
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.getAttribute('title')).toBe('Open a folder to start one.')
    }
  })
})

it('Teams is a top-level destination and marks its selected page', () => {
  mount({}, 'teams')
  const entry = container.querySelector<HTMLButtonElement>('button[aria-label="Teams"]')
  expect(entry).not.toBeNull()
  expect(entry?.getAttribute('aria-current')).toBe('page')
})
