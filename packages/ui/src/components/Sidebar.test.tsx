import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionId,
  sessionKey,
  type RuntimeHealth,
  type RuntimeInfo,
  type Session,
  type SessionSummary,
} from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Sidebar } from './Sidebar'
import type { Destination } from '../state/destinations'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let newDraft: ReturnType<typeof vi.fn>
let setWindowMode: ReturnType<typeof vi.fn>
let loadHistory: ReturnType<typeof vi.fn>
let askCommit: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  newDraft = vi.fn()
  askCommit = vi.fn()
  loadHistory = vi.fn()
  setWindowMode = vi.fn()
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

const mount = (overrides: Partial<AppSnapshot> = {}, activeDestination: 'teams' | 'flows' | 'agents' | 'library' | 'dashboard' | 'plugins' | null = null, doors: Partial<Pick<Parameters<typeof Sidebar>[0], 'onOpenSettings' | 'onOpenLibrary' | 'onBrowseFolders'>> = {}, settings?: Parameters<typeof Sidebar>[0]['settings']) => {
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
      path: '/workspace/repo', name: 'repo', lastOpenedAt: 1,
      git: { branch: 'main', sha: 'abc1234' },
      } as AppSnapshot['workspace'],
      worktrees: [{ path: '/workspace/repo/.worktrees/topic', branch: 'topic', head: 'abc', isMain: false, managed: true }],
      ...overrides,
  }

  const store = {
    lead: { state: { revision: 0, settings: { name: 'dex' } }, subscribe: () => () => {} },
    subscribe: () => () => {},
    refreshWorkspaceGit: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    loadHistory,
    searchHistory: vi.fn(async () => {}),
    newDraft,
    askCommit,
    setWindowMode,
    loadWorktrees: vi.fn(async () => {}),
    loadAgents: vi.fn(async () => {}),
    returnToWork: vi.fn(),
    flowCatalog: vi.fn(async () => []), agentsIn: vi.fn(async () => []), openFrontDoor: vi.fn(), closeFrontDoor: vi.fn(),
  } as unknown as AppStore

  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenTeams={() => {}} onOpenAgents={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
          activeDestination={activeDestination}
          settings={settings}
          {...doors}
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

  it('the menu opens New Team directly and retains worktree choices', async () => {
    mount()
    const trigger = container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!
    act(() => trigger.click())
    const menu = document.querySelector('[role="menu"]')!
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((one) => one.textContent?.trim())
    expect(items).toEqual(['New session⌘N', 'Open folder…', 'New Team…⌘⇧N', 'New worktree…', 'topic'])
    expect(menu.lastElementChild?.getAttribute('role')).not.toBe('separator')
    const team = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(one => one.textContent?.startsWith('New Team…'))!
    await act(async () => team.click())
    expect(document.querySelector('[aria-label="Search Flows"]')).not.toBeNull()
  })

  it('says why New worktree… is unavailable, not what a worktree is', () => {
    mount({ workspace: { path: '/workspace/plain' } as AppSnapshot['workspace'] })
    act(() => container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!.click())
    const row = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((one) => one.textContent?.startsWith('New worktree…'))!
    expect(row.hasAttribute('disabled') || row.getAttribute('aria-disabled') === 'true' || row.hasAttribute('data-disabled')).toBe(true)
    expect(row.textContent).toContain('Worktrees need a git repository.')
    expect(row.textContent).not.toContain('Its own checkout')
  })

  it('offers the existing commit flow before the first worktree', () => {
    mount({ workspace: { path: '/workspace/repo', name: 'repo', lastOpenedAt: 1, git: { branch: 'main', sha: null } } as AppSnapshot['workspace'] })
    act(() => container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!.click())
    expect(document.body.textContent).toContain('Make a first commit to work in a worktree')
    expect([...document.querySelectorAll('[role="menuitem"]')].some(row => row.textContent?.startsWith('New worktree…'))).toBe(false)
    const commit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Commit')!
    act(() => commit.click())
    expect(askCommit).toHaveBeenCalledWith('/workspace/repo')
  })

  it.each([false, true])('has no global empty text with a project: %s (#1720)', project => {
    mount({ workspace: project ? { path: '/workspace/repo', name: 'repo', lastOpenedAt: 1 } : null,
      workspaces: project ? [{ path: '/workspace/repo', name: 'repo', lastOpenedAt: 1 }] : [] })
    expect(container.textContent).not.toContain('No sessions yet')
    expect(container.textContent).not.toContain('show up too')
    expect(container.querySelector('[data-left-projects-head]')).not.toBeNull()
    expect(container.textContent).toContain('Projects')
    if (project) expect(container.textContent).toContain('No conversations yet — ⌘N starts one here.')
  })

  it.each(['no matches', 'Agent-filtered matches'])('shows one clearable empty state with %s', async (scenario) => {
    const conversation: SessionSummary = {
      id: sessionId('retry'),
      runtime: CLAUDE,
      title: 'Retry the checkout call',
      preview: null,
      cwd: '/workspace/repo',
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 2,
    }
    let snapshot: AppSnapshot = {
      ...emptySnapshot(),
      status: 'open',
      runtimes: [codex, claude],
      activeRuntime: CLAUDE,
      health: readyHealth,
      healthByRuntime: { [CLAUDE]: readyHealth, [CODEX]: unavailableHealth },
      workspace: { path: '/workspace/repo', git: { branch: 'main' } } as AppSnapshot['workspace'],
      history: [conversation],
      historyIdentity: [conversation],
      listPrefs: { ...emptySnapshot().listPrefs, agent: CLAUDE },
    }
    const listeners = new Set<() => void>()
    const searchHistory = vi.fn(async (query: string) => {
      const matches: SessionSummary[] = scenario === 'no matches'
        ? []
        : [{ ...conversation, id: sessionId('excluded-match'), runtime: CODEX, title: 'Needle in another agent' }]
      snapshot = { ...snapshot, history: query.trim() ? matches : [conversation], historyLoading: false }
      for (const listener of listeners) listener()
    })
    const store = {
    lead: { state: { revision: 0, settings: { name: 'dex' } }, subscribe: () => () => {} },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      refreshWorkspaceGit: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
      loadHistory: vi.fn(),
      searchHistory,
      setListPrefs: vi.fn(),
      newDraft,
    setWindowMode,
      loadWorktrees: vi.fn(async () => {}),
      loadAgents: vi.fn(async () => {}),
    } as unknown as AppStore

    act(() => {
      root.render(
        <StoreProvider store={store}>
          <Sidebar
            onOpenSettings={() => {}}
            onOpenTeams={() => {}} onOpenAgents={() => {}}
            onOpenUsage={() => {}}
            onBrowseFolders={() => {}}
            onSignIn={() => {}}
            onSearch={() => {}}
          />
        </StoreProvider>,
      )
    })

    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter this list"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(filter, 'needle')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 240)))

    const empty = container.querySelector('[data-slot="empty-state"]')
    expect(empty?.textContent).toContain('No conversations match “needle”.')
    expect(container.textContent?.match(/No conversations match “needle”\./g)).toHaveLength(1)
    expect(container.textContent).not.toContain('No conversations yet')
    const clear = empty?.querySelector<HTMLButtonElement>('button')!
    expect(clear.textContent).toBe('Clear search')
    expect(clear.tabIndex).toBe(0)
    const tree = container.querySelector('[data-region="session-tree"]')!
    expect(tree.contains(clear)).toBe(false)
    expect(container.textContent).not.toContain('Needle in another agent')

    act(() => clear.click())
    expect(filter.value).toBe('')
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 240)))
    expect(searchHistory).toHaveBeenCalledWith('')
    expect(container.textContent).toContain('Retry the checkout call')
  })

  it('does not show the no-match state above an open conversation omitted from history', async () => {
    const openSession: Session = {
      id: sessionId('open-session'),
      runtime: CLAUDE,
      title: 'Visible open conversation',
      preview: null,
      cwd: '/workspace/repo',
      status: { type: 'idle' },
      createdAt: 1,
      updatedAt: 2,
      turns: [],
      itemsLoaded: true,
    }
    mount({ sessions: new Map([[sessionKey(CLAUDE, openSession.id), openSession]]) })

    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter this list"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(filter, 'needle')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 240)))

    expect(container.textContent).toContain('Visible open conversation')
    expect(container.textContent).not.toContain('No conversations match “needle”.')
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
    expect(empty).toBeNull()
    expect(container.textContent).not.toContain('Connect a runtime to see your sessions.')
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

it('keeps the brand row between the top row and navigation in both column modes', () => {
  mount()
  const header = container.querySelector('[data-region="sidebar-header"]')!
  const top = header.querySelector('[data-left-top]')!
  const brand = header.querySelector('[data-left-brand]')!
  const newSession = container.querySelector('button[aria-label="New session"]')!
  expect(brand.textContent).toContain('HarnessDesk')
  expect(top.nextElementSibling).toBe(brand)
  expect(brand.querySelector('svg')?.getAttribute('height')).toBe('14')
  expect(brand.classList.contains('hd-drag')).toBe(true)
  expect(brand.compareDocumentPosition(newSession) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  mount({}, null, {}, { section: 'general', onSection: () => {}, onBack: () => {} })
  const settingsBrand = container.querySelector('[data-left-brand]')!
  const back = container.querySelector('[data-left-settings] button[aria-label="Back"]')!
  expect(settingsBrand.textContent).toContain('HarnessDesk')
  expect(settingsBrand.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('leaves sidebar notice cards out of Settings navigation so the last group stays reachable', () => {
  mount({ goalMigrationPending: true }, null, {}, { section: 'general', onSection: () => {}, onBack: () => {} })
  expect(container.querySelector('[data-slot="notice-card"]')).toBeNull()
  expect(container.querySelector('[data-left-settings] button[aria-label="Browser"]')).not.toBeNull()
})

it('puts the unread Inbox beside the Settings gear in the seat row', () => {
  mount({ inbox: [{ id: 'kept', tone: 'info', title: 'Review ready', at: 0, read: false }] })
  const header = container.querySelector('[data-region="sidebar-header"]')!
  const footer = container.querySelector('[data-region="sidebar-footer"]')!
  const search = header.querySelector<HTMLButtonElement>('button[aria-label="Search everything"]')!
  const titleBar = search.closest('[data-slot="bar"]')!
  const bell = container.querySelector('[data-left-seat] [data-slot="inbox-button"]')!
  expect(bell).not.toBeNull()
  expect(bell.hasAttribute('data-unread')).toBe(true)
  expect(bell.textContent).toBe('Inbox, 1 unread')
  expect(bell.querySelector('[data-slot="inbox-dot"]')).not.toBeNull()
  expect(bell.closest('button')?.title).toBe('Inbox, 1 unread')
  expect(bell.compareDocumentPosition(footer.querySelector('button[aria-label="Settings"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(titleBar.classList.contains('hd-drag')).toBe(true)
  expect(bell.closest('.hd-no-drag')).not.toBeNull()
  expect(search.closest('.hd-no-drag')).not.toBeNull()
  expect(footer.contains(bell)).toBe(true)
  expect(footer.querySelector('button[data-slot="popover-trigger"]')).not.toBeNull()
})

/**
 * Main navigation rows keep catalogue totals on their pages; labels
 * remain present at the minimum sidebar width.
 */
describe('sidebar destinations', () => {
  it('renders six separate, labelled design-system rows without catalogue counts at 200px', () => {
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
    expect(rows).toHaveLength(5)
    expect(rows.map((one) => one.getAttribute('aria-label'))).toEqual(['Teams', 'Flows', 'Agents', 'Customize', 'Dashboard'])
    expect(rows.map((one) => one.querySelector('[data-slot="sidebar-menu-label-content"]')?.textContent)).toEqual(['Teams', 'Flows', 'Agents', 'Customize', 'Dashboard'])
    expect(rows.map((one) => one.querySelector('[data-slot="sidebar-menu-icon"]'))).toHaveLength(5)
    expect(rows.map((one) => one.parentElement?.querySelector('[data-left-mark]')?.textContent?.trim())).toEqual([undefined, undefined, undefined, undefined, '1'])
    expect(group.querySelectorAll('[data-left-trailing]')).toHaveLength(5)
    expect(rows[4]?.parentElement?.querySelector('[data-left-mark]')?.getAttribute('aria-label')).toBe('1 Runtimes need attention')
  })

  it('fills the active row when its destination window is open', () => {
    mount({}, 'plugins')
    const plugins = container.querySelector<HTMLButtonElement>('button[aria-label="Customize"]')!
    expect(plugins.dataset.active).toBe('true')
    expect(plugins.getAttribute('aria-current')).toBe('page')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Agents"]')?.dataset.active).toBeUndefined()
  })

  it('shows a Dashboard badge only when an agent needs attention', () => {
    mount()
    const dashboard = container.querySelector<HTMLButtonElement>('button[aria-label="Dashboard"]')!
    expect(dashboard.parentElement?.querySelector('[data-left-mark]')).toBeNull()

    mount({
      usage: [{ runtime: CLAUDE, account: null, plan: null, lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10080, resetsAt: null }], credits: null, spend: null, reached: null, source: { kind: 'runtime', label: 'API' }, fetchedAt: 1, staleAfterMs: 1, error: null }],
    } as unknown as Partial<AppSnapshot>)
    const needsAttention = container.querySelector<HTMLButtonElement>('button[aria-label="Dashboard"]')!
    expect(needsAttention.parentElement?.querySelector('[data-left-mark]')?.textContent?.trim()).toBe('1')
  })

  it('keeps everything-search and list-filter names distinct and calls the group Projects', () => {
    mount()
    const search = container.querySelector<HTMLButtonElement>('button[aria-label="Search everything"]')!
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Meta+K')
    expect(search.title).toBe('Search everything (⌘K)')
    expect(container.querySelector('input[aria-label="Filter this list"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="navigation-group-label"]')?.textContent).toContain('Projects')
  })

  it('keeps the brand wordmark in the header', () => {
    mount()
    expect(container.querySelector('[data-region="sidebar-header"] [data-role="wordmark"]')?.textContent).toBe('HarnessDesk')
  })

  it('keeps New Team unavailable without a project folder', () => {
    mount({ workspace: null, workspaces: [] })
    act(() => container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!.click())
    const menu = document.querySelector('[role="menu"]')!
    for (const kind of ['New Team…']) {
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

it('keeps a conversation row unselected while another destination is current', () => {
  const conversation: SessionSummary = {
    id: sessionId('flaky-inventory'),
    runtime: CLAUDE,
    title: 'Pin the flaky inventory test',
    preview: null,
    cwd: '/workspace/repo',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 2,
  }
  mount({
    history: [conversation],
    historyIdentity: [conversation],
    activeSessionKey: sessionKey(CLAUDE, conversation.id),
  }, 'agents')
  expect(container.querySelector('button[aria-label="Agents"]')?.getAttribute('aria-current')).toBe('page')
  expect(container.querySelector('button[aria-label="Pin the flaky inventory test"]')?.getAttribute('aria-current')).toBeNull()
})


it('offers paging when a short filtered list cannot produce a scroll event', () => {
  mount({ historyCursor: 'older-filtered', listPrefs: { ...emptySnapshot().listPrefs, agent: CLAUDE } })
  const more = [...container.querySelectorAll('button')].find(button => button.textContent === 'Load more conversations')
  expect(more).toBeDefined()
  act(() => more?.click())
  expect(loadHistory).toHaveBeenCalledOnce()
})

it('has one top row and five page doors in the approved order', () => {
  mount()
  const header = container.querySelector('[data-region="sidebar-header"]')!
  expect(header.querySelectorAll('[data-slot="bar"]')).toHaveLength(2)
  const group = container.querySelector('[aria-label="Main sections"]')!
  expect([...group.querySelectorAll('[data-slot="sidebar-menu-button"]')]
    .map(node => node.getAttribute('aria-label')))
    .toEqual(['Teams', 'Flows', 'Agents', 'Customize', 'Dashboard'])
  expect(header.querySelector('[data-role="wordmark"]')?.textContent).toBe('HarnessDesk')
  expect(container.querySelector('button[aria-label="Settings"]')?.getAttribute('aria-pressed')).toBe('false')
})

it('Library keeps the existing section route and supports an explicit door', () => {
  const settings = vi.fn(), library = vi.fn()
  mount({}, 'library', { onOpenSettings: settings })
  const row = () => container.querySelector<HTMLButtonElement>('button[aria-label="Customize"]')!
  expect(row().getAttribute('aria-current')).toBe('page')
  act(() => row().click())
  expect(settings).toHaveBeenCalledWith('library')
  mount({}, 'library', { onOpenSettings: settings, onOpenLibrary: library })
  act(() => row().click())
  expect(library).toHaveBeenCalledOnce()
  expect(settings).toHaveBeenCalledOnce()
})


const atDestination = (current: Destination, windowMode: AppSnapshot['windowMode'] = 'editor') => {
  const workbench = emptySnapshot().workbench
  return { windowMode, workbench: { ...workbench, navigation: { ...workbench.navigation, current } } }
}
it('a current conversation gets the effective mode and changes it through the store', () => {
  mount(atDestination({ kind: 'work', view: { kind: 'conversation', session: sessionKey(CLAUDE, sessionId('mode-session')) } }))
  const conversation = container.querySelector<HTMLButtonElement>('button[aria-label="Conversation mode"]')
  const editor = container.querySelector<HTMLButtonElement>('button[aria-label="Editor mode"]')
  expect(editor).not.toBeNull()
  expect(editor!.disabled).toBe(false)
  expect(editor!.getAttribute('aria-pressed')).toBe('true')
  act(() => conversation!.click())
  expect(setWindowMode).toHaveBeenCalledWith('conversation')
})
for (const current of [
  { kind: 'work', view: { kind: 'conversation', session: null } },
  { kind: 'work', view: { kind: 'room', room: 'demo-team' } },
  { kind: 'teams', filter: 'active' }, { kind: 'agents', id: null }, { kind: 'agents', id: 'demo-agent' },
  { kind: 'library', section: 'skill' }, { kind: 'plugins', section: 'installed', id: null },
  { kind: 'dashboard', view: 'overview', scope: null },
  { kind: 'changes-review', root: null, returnTo: { kind: 'conversation', session: null } },
] satisfies Destination[]) it(`keeps a greyed Conversation selection on ${JSON.stringify(current)}`, () => {
  mount(atDestination(current))
  const editor = container.querySelector<HTMLButtonElement>('button[aria-label="Editor mode"]')
  expect(editor).not.toBeNull()
  expect(editor!.disabled).toBe(true)
  expect(editor!.title).toBe("Editor mode opens a conversation's files")
  expect(container.querySelector('button[aria-label="Conversation mode"]')?.getAttribute('aria-pressed')).toBe('true')
  act(() => editor!.click())
  expect(setWindowMode).not.toHaveBeenCalled()
})
it('Settings omits both mode controls even with an Editor preference', () => {
  mount(atDestination({ kind: 'settings', route: { kind: 'section', section: 'general', focus: null } }), null, {},
    { section: 'general', onSection: () => {}, onBack: () => {} })
  expect(container.querySelector('[data-mode-switch]')).toBeNull()
})

it('opens the same folder picker from Projects and the New session menu without a workspace', () => {
  const choose = vi.fn()
  mount({ workspace: null, worktrees: [] }, null, { onBrowseFolders: choose })
  const projects = container.querySelector<HTMLButtonElement>('button[aria-label="Open a project folder"]')!
  expect(projects).not.toBeNull()
  act(() => projects.click())
  act(() => container.querySelector<HTMLButtonElement>('button[title="More ways to start"]')!.click())
  const open = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(one => one.textContent === 'Open folder…')!
  expect(open).toBeDefined()
  expect(open.disabled).toBe(false)
  act(() => open.click())
  expect(choose).toHaveBeenCalledTimes(2)
})

it('keeps exactly six ordered doors and no Lead trace in the whole disabled sidebar', () => {
  mount()
  const group = container.querySelector('[aria-label="Main sections"]')!
  expect(group.children).toHaveLength(6)
  expect([...group.querySelectorAll('[data-slot="sidebar-menu-button"]')].map(node => node.getAttribute('aria-label')))
    .toEqual(['Teams', 'Flows', 'Agents', 'Library', 'Plugins', 'Dashboard'])
  // The header and other existing regions use unrelated lead/leading style names.
  for (const node of [group, ...group.querySelectorAll('*')]) {
    expect(node.textContent).not.toMatch(/lead/i)
    for (const attr of node.attributes) {
      if (/^(aria-|data-)|^(title|class)$/.test(attr.name)) expect(`${attr.name}=${attr.value}`).not.toMatch(/lead/i)
    }
  }
  const normalizeIds = (html: string) => html.replace(/(?:_r_|:r)[a-z0-9]+(?:_|:)/gi, 'react-id')
  const disabled = normalizeIds(container.innerHTML)
  mount({ leadAvailable: true })
  const enabled = container.querySelector('[aria-label="Main sections"]')!
  expect(enabled.children).toHaveLength(7)
  const lead = enabled.querySelector('[aria-label="Dex"]')!
  const row = [...enabled.children].find(child => child.contains(lead))!
  row.remove()
  expect(normalizeIds(container.innerHTML)).toBe(disabled)
})

it.each([false, true])('shows the Lead navigation row only for capability=%s', enabled => {
  mount({ leadAvailable: enabled })
  const rows = [...container.querySelectorAll('button')]
  expect(rows.some(row => row.getAttribute('aria-label') === 'Dex')).toBe(enabled)
})
