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

it('uses the design sidebar header, one content scroller, and a footer for docked panels', () => {
  mount()
  const header = container.querySelector('[data-sidebar="header"]')!
  const content = container.querySelector('[data-sidebar="content"]')!
  const footer = container.querySelector('[data-sidebar="footer"]')!
  expect(header.querySelector('button[aria-label="Search everything (⌘K)"]')).not.toBeNull()
  expect(content.querySelector('[data-slot="navigation-group-label"]')?.textContent).toContain('Projects')
  expect(footer.childElementCount).toBeGreaterThan(0)
})

/**
 * The plain path's one new row (the owner's rule, 2026-09-18): always there,
 * reading nothing of its own — it counts whatever roster another surface has
 * already asked for, and wears the Dashboard badge's own warn tone rather
 * than a rule drawn just for this row.
 */
describe('compact sidebar destinations', () => {
  it('renders three named navigation buttons without roster or plugin counts', () => {
    mount({
      agents: [{ id: 'a', origin: 'builtin', path: '/a/AGENT.md', digest: 'd', shadows: [], problems: [], definition: { id: 'a', name: 'A', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], prefer: [], brief: '' } }],
      plugins: [{ id: 'one' }, { id: 'two' }],
    } as unknown as Partial<AppSnapshot>)
    const group = container.querySelector('[aria-label="Main sections"]')!
    expect([...group.querySelectorAll<HTMLButtonElement>('button')].map((one) => one.getAttribute('aria-label'))).toEqual(['Agents', 'Dashboard', 'Plugins'])
    expect([...group.querySelectorAll('button')].map((one) => one.textContent?.trim())).toEqual(['Agents', 'Dashboard', 'Plugins'])
    expect(group.querySelector('[class*="navCount"]')).toBeNull()
  })

  it('shows a Dashboard badge only when an agent needs attention', () => {
    mount()
    const dashboard = container.querySelector<HTMLButtonElement>('button[aria-label="Dashboard"]')!
    expect(dashboard.querySelector('[class*="navCount"]')).toBeNull()

    mount({
      usage: [{ runtime: CLAUDE, account: null, plan: null, lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10080, resetsAt: null }], credits: null, spend: null, reached: null, source: { kind: 'runtime', label: 'API' }, fetchedAt: 1, staleAfterMs: 1, error: null }],
    } as unknown as Partial<AppSnapshot>)
    const needsAttention = container.querySelector<HTMLButtonElement>('button[aria-label="Dashboard"]')!
    expect(needsAttention.querySelector('[class*="navCount"]')?.textContent).toBe('1')
  })

  it('keeps everything-search and list-filter names distinct and calls the group Projects', () => {
    mount()
    expect(container.querySelector('button[aria-label="Search everything (⌘K)"]')).not.toBeNull()
    expect(container.querySelector('input[aria-label="Filter this list"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="navigation-group-label"]')?.textContent).toContain('Projects')
  })
})
