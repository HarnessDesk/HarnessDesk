import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'
import type { AgentAttachmentsView, AgentEntry, Library, LibraryEntry, LibrarySkillUpdate, LibraryUsage, ReachState, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { LibrarySection } from './Library'
import { SkillList } from './SkillRow'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../design', async importOriginal => ({ ...await importOriginal<typeof import('../design')>(), showToast: toast }))

/** The home every `~/…` path in these fixtures hangs off; the page prints them back with the tilde. */
const HOME = '/home/u'

/**
 * The library page.
 *
 * What is under test is the page's honesty, not its markup. Three properties:
 *
 * 1. **`absent` and `unscanned` must never render the same.** They are the two
 *    states a checkbox would collapse, and collapsing them is how a skill that
 *    is sitting in the wrong directory reads as one the user simply has not
 *    installed. Every state carries its own accessible name for exactly this.
 * 2. **Column headings come from each runtime's own presentation**, so the page
 *    obeys the same rule as the rest of the interface: no agent is named by a
 *    literal in this repository.
 * 3. **A count is a filter.** The number is worth nothing if reading "44 empty"
 *    leaves you scrolling 110 rows to find them.
 * 4. **The matrix survives being demoted.** Cards are the front door now, and
 *    every property above is a property of the *page*, not of the table that
 *    used to be all of it. So the matrix tests below switch to it first — via
 *    `showMatrix()` — and what they assert is unchanged. A redesign that
 *    quietly dropped one of these would be a regression wearing new paint.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  toast.mockClear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id, name, capabilities: {}, presentation: { name } }) as unknown as RuntimeInfo

const entry = (
  name: string,
  states: readonly ReachState[],
  over: Partial<LibraryEntry> = {},
): LibraryEntry => ({
  kind: 'skill',
  name,
  title: null,
  description: null,
  copies: [
    {
      path: `/home/u/.claude/skills/${name}`,
      scope: 'user',
      readBy: [],
      hollow: states.includes('hollow'),
      digest: states.includes('hollow') ? null : 'abc',
      readOnly: false,
    },
  ],
  reach: states.map((state, index) => ({
    runtime: runtimeId(index === 0 ? 'one' : 'two'),
    state,
    basis: 'scanned' as const,
  })),
  ...over,
})

// A damaged copy remains useful to compare when another definition exists.
const partialEntry = (name: string, states: readonly ReachState[], over: Partial<LibraryEntry> = {}): LibraryEntry => {
  const one = entry(name, states, over)
  return { ...one, copies: [...one.copies, { path: `/home/u/.agents/skills/${name}`, scope: 'user',
    readBy: [], hollow: false, digest: 'abc', readOnly: false }] }
}

// Real libraries always carry a location row per agent and kind; an agent
// with no row is one the table cannot write to, and the page treats it so.
const skillLocation = (id: string): Library['locations'][number] => ({
  runtime: runtimeId(id),
  kind: 'skill',
  path: `/home/u/.${id}/skills`,
  scope: 'user',
  scanned: true,
  exists: true,
  readOnly: false,
})

const library = (entries: readonly LibraryEntry[]): Library => ({
  generatedAt: 1,
  home: HOME,
  runtimes: [runtimeId('one'), runtimeId('two')],
  locations: [skillLocation('one'), skillLocation('two')],
  entries: [...entries],
  gaps: [],
})

const LibraryHarness = ({ initialFlow = null }: { readonly initialFlow?: 'import' | null }) => {
  const [section, setSection] = useState<'skill' | 'mcp'>('skill')
  return <TopBarProvider><DestinationPageScope owner="destination:library" active>
    <LibrarySection section={section} onSection={setSection} importIntent={initialFlow === 'import' ? 1 : 0} />
  </DestinationPageScope><TopBarOutlet owner="destination:library" fallback={{place:'Fallback',more:()=>null}} /></TopBarProvider>
}
const chooseKind = async (kind: 'skill' | 'mcp') => {
  await act(async () => document.body.querySelector<HTMLButtonElement>('[title="Library sections"]')?.click())
  const label = kind === 'skill' ? 'Skills' : 'MCP servers'
  const choice = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.startsWith(label))
  expect(choice).toBeTruthy()
  await act(async () => choice!.click())
}

const mount = async (
  value: Library,
  usage?: LibraryUsage | Promise<LibraryUsage>,
  options: {
    read?: Promise<Library>
    audit?: readonly Record<string, unknown>[]
    initialFlow?: 'import' | null
    runtimes?: readonly RuntimeInfo[]
    /** What `library/definition` answers — null is the host's ordinary miss. */
    definition?: unknown
    /** Stands in for the store verb, so a toggle's arguments can be read. */
    setSkillEnabled?: (...args: unknown[]) => Promise<void>
    /** Stands in for the store verb that leaves the page for the conversation. */
    returnToWork?: () => void
  } = {},
): Promise<ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>> => {
  // Method-aware: the page asks for the library, then usage, then its own
  // history; answering everything with the library was one `undefined.skills`
  // from a crash.
  const request = vi.fn(async (method: string, _params?: unknown) =>
    // A refresh that really refreshed, which is the shape the host sends when
    // an agent was idle. The interesting cases override this.
    method === 'runtime/refreshCatalog'
      ? { checkedAt: 1, installation: null, refreshed: true }
      : method === 'library/usage'
      ? (usage ?? { generatedAt: 1, sessionsScanned: 0, skills: {} })
      : method === 'library/plan'
        ? { plannedAt: 1, ops: [] }
        : method === 'audit/query'
          ? (options.audit ?? [])
          : method === 'library/definition'
            ? (options.definition ?? null)
            : (options.read ?? value),
  )
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: options.runtimes ?? [runtime('one', 'First Agent'), runtime('two', 'Second Agent')],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    setSkillEnabled: options.setSkillEnabled ?? (async () => {}),
    returnToWork: options.returnToWork ?? (() => {}),
    notice: vi.fn(),
    // The Agent filter's own roster read — these fixtures never populate
    // `snapshot.agents`, so this stays a no-op and the filter offers nothing.
    loadAgents: vi.fn(async () => {}),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <LibraryHarness initialFlow={options.initialFlow ?? null} />
      </StoreProvider>,
    )
  })
  return request
}

/**
 * Switch to the matrix.
 *
 * The page opens on cards, which is the point of the redesign; everything
 * that reads the table, its footers or its drawer has to say so first. Found
 * by the segment's own name rather than by position, so a third view added
 * later cannot silently re-point these at the wrong one.
 */
const showMatrix = async (): Promise<void> => {
  const radio = container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Matrix"]')
  if (radio) { await act(async () => radio.click()); return }
  const trigger = container.querySelector<HTMLButtonElement>('[title="How to show the library"]')!
  await act(async () => trigger.click())
  await act(async () => filterRow('Matrix')!.click())
}

/**
 * The toolbar's Filter menu: every count is one of its rows, and the Agent
 * picker its submenu. Opened by its trigger's name, read, and chosen from by
 * each row's words.
 */
const filterTrigger = (): HTMLElement => {
  const trigger = document.body.querySelector('[data-slot="popover-trigger"][title^="Filter the library"]') as HTMLElement | null
  expect(trigger, 'the toolbar should have a Filter menu').toBeTruthy()
  return trigger as HTMLElement
}
const openFilter = async (): Promise<void> => {
  if (filterTrigger().hasAttribute('data-open')) return
  await act(async () => filterTrigger().click())
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
}
const closeFilter = async (): Promise<void> => {
  if (!filterTrigger().hasAttribute('data-open')) return
  await act(async () => filterTrigger().click())
}
const filterRows = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
/** The row whose words start with `label`, with the menu open. */
const filterRow = (label: string): HTMLElement | undefined =>
  filterRows().find((node) => node.textContent?.toLowerCase().startsWith(label.toLowerCase()))
const chooseFilter = async (label: string): Promise<void> => {
  await openFilter()
  const row = filterRow(label)
  expect(row, `the Filter menu should offer ${label}`).toBeTruthy()
  await act(async () => row?.click())
}
const chooseAgent = async (name: string): Promise<void> => {
  const trigger = document.body.querySelector<HTMLButtonElement>('[title="Declared by"]')
  if (trigger) await act(async () => trigger.click())
  else await openFilter()
  const row = filterRow(name)
  expect(row, `the Agent picker should offer ${name}`).toBeTruthy()
  await act(async () => row?.click())
}

const cellNames = (): readonly string[] =>
  [...document.body.querySelectorAll('[role="img"]')].map(
    (node) => node.getAttribute('aria-label') ?? '',
  )

it('tells absent apart from present-but-unread', async () => {
  // The distinction the whole page exists for. A checkbox renders both as off.
  await mount(library([entry('alpha', ['reaches', 'absent']), entry('beta', ['reaches', 'unscanned'])]))
  await showMatrix()
  const names = cellNames()
  expect(names).toContain('alpha — Second Agent: Not installed')
  expect(names).toContain('beta — Second Agent: Not read')
})

it('names every agent from its own presentation, never a literal', async () => {
  await mount(library([entry('alpha', ['reaches', 'absent'])]))
  await showMatrix()
  const headers = [...document.body.querySelectorAll('th[scope="col"]')].map((node) => node.textContent)
  expect(headers).toEqual(['Name', 'First Agent', 'Second Agent'])
})

it('draws a hollow copy beside a usable definition as its own state', async () => {
  await mount(library([partialEntry('browse', ['hollow', 'absent'])]))
  await showMatrix()
  expect(cellNames()).toContain('browse — First Agent: Empty')
})

it('a count filters the table down to what it counted', async () => {
  await mount(
    library([
      entry('good', ['reaches', 'reaches']),
      partialEntry('empty', ['hollow', 'absent']),
    ]),
  )
  await showMatrix()
  expect(document.body.textContent).toContain('good')
  expect(document.body.textContent).toContain('empty')

  await chooseFilter('Empty on disk')

  const rows = [...document.body.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
  expect(rows).toEqual(['empty'])
})

it('only-problems means defects and strandings, never mere non-reach', async () => {
  // On a real machine `unscanned` is the most common state there is. A filter
  // that treats it as a problem keeps every row, and a switch that changes
  // nothing teaches people to stop pressing it.
  await mount(
    library([
      entry('quiet', ['reaches', 'unscanned']),
      partialEntry('empty', ['hollow', 'absent']),
      entry('stranded', ['unscanned', 'unscanned']),
    ]),
  )
  await showMatrix()
  await chooseChip('Needs you')
  const rows = [...document.body.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
  expect(rows).toEqual(['empty', 'stranded'])
})

it('skills do not offer a count with nothing to show', async () => {
  await mount(library([entry('good', ['reaches', 'reaches'])]))
  await openFilter()
  expect(filterRow('Empty on disk')).toBeUndefined()
  expect(filterRow('Problems')).toBeUndefined()
  expect(filterRow('Everything')).toBeTruthy()
})


it('skills keep a single controls row beneath the title and show active Filter count', async () => {
  await mount(library([entry('good', ['reaches', 'reaches']), partialEntry('empty', ['hollow', 'absent'])]))
  const controls = container.querySelector('[data-slot="library-skills-controls"]')!
  expect(controls.querySelector('[aria-label="Search library"]')).toBeTruthy()
  expect(controls.querySelector('[role="radio"][aria-label="Matrix"]')).toBeTruthy()
  expect(controls.contains(filterTrigger())).toBe(true)
  await chooseFilter('Empty on disk')
  expect(filterTrigger().textContent).toBe('Filter1')
  expect(cards()).toHaveLength(1)
  await chooseFilter('Everything')
  expect(cards()).toHaveLength(2)
  expect(filterTrigger().textContent).toBe('Filter')
  expect(document.activeElement).toBe(filterTrigger())
})


it('skills use ToggleGroups for chips and view without outlined view or Agent dropdowns', async () => {
  await mount(library([entry('good', ['reaches', 'reaches'])]))
  expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(2)
  expect(container.querySelector('[title="Declared by"]')).toBeNull()
  expect(container.querySelector('[title="How to show the library"][data-slot="popover-trigger"]')).toBeNull()
  expect(container.querySelector('[data-slot="native-select"]')).toBeNull()
})


it('opening a row shows every copy and who reads it', async () => {
  await mount(
    library([
      entry('alpha', ['reaches', 'unscanned'], {
        copies: [
          {
            path: '/home/u/.agents/skills/alpha',
            scope: 'user',
            readBy: [],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
        ],
      }),
    ]),
  )
  await showMatrix()
  const disclosure = document.body.querySelector('table [aria-expanded]') as HTMLButtonElement | null
  expect(disclosure).toBeTruthy()
  await act(async () => disclosure?.click())
  // With the tilde, because that is how the path is written everywhere else
  // it appears — in a shell, in the agent's own config, in its documentation.
  // Spelled out, four copies of one skill are four lines whose differing part
  // begins past the fold.
  expect(document.body.textContent).toContain('~/.agents/skills/alpha')
  expect(document.body.textContent).not.toContain('/home/u/.agents')
  expect(document.body.textContent).toContain('No runtime reads this directory.')
})

it('says why a column is weaker rather than letting it look empty', async () => {
  await mount({
    ...library([entry('alpha', ['reaches', 'absent'])]),
    gaps: [
      {
        runtime: runtimeId('two'),
        kind: 'skill',
        reason: 'does not report what it loaded, so its column is read from disk.',
      },
    ],
  })
  expect(document.body.textContent).toContain('Second Agent')
  expect(document.body.textContent).toContain('read from disk')
})

it('reports a failed scan instead of an empty library', async () => {
  const request = vi.fn(async () => {
    throw new Error('the host said no')
  })
  const snapshot: AppSnapshot = { ...emptySnapshot(), status: 'open', runtimes: [] } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    loadAgents: vi.fn(async () => {}),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <LibraryHarness />
      </StoreProvider>,
    )
  })
  expect(document.body.textContent).toContain('the host said no')
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('the host said no')
})

it('usage joins the matrix: the never-fired tile isolates paid-and-idle', async () => {
  await mount(
    library([
      entry('busy', ['reaches', 'reaches'], { catalogTokens: 100 }),
      entry('idle', ['reaches', 'absent'], { catalogTokens: 90 }),
      entry('invisible', ['unscanned', 'unscanned'], { catalogTokens: 80 }),
    ]),
    {
      generatedAt: 1,
      sessionsScanned: 12,
      skills: { busy: { sessions: 3, activations: 7, lastAt: 1, byRuntime: { one: { sessions: 3, activations: 7 } } } },
    },
  )
  await showMatrix()
  await chooseFilter('Never fired')
  const rows = [...document.body.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
  // `invisible` reaches nobody: it is a reach problem, not an idle expense.
  expect(rows).toEqual(['idle'])
})

it('the footer prices what the table shows, per agent', async () => {
  await mount(
    library([
      entry('alpha', ['reaches', 'absent'], { catalogTokens: 100 }),
      entry('beta', ['reaches', 'reaches'], { catalogTokens: 50 }),
    ]),
  )
  await showMatrix()
  const cells = [...document.body.querySelectorAll('tfoot tr:first-child td')].map(
    (node) => node.textContent,
  )
  expect(cells).toEqual(['\u2248150 tok', '\u224850 tok'])
})

const usageOf = (
  skills: Record<string, { sessions: number; activations: number; lastAt: number; byRuntime: Record<string, { sessions: number; activations: number }> }>,
): LibraryUsage => ({ generatedAt: 1, sessionsScanned: 9, skills })

it('the never-fired view leads with the most expensive idle row', async () => {
  await mount(
    library([
      entry('cheap-idle', ['reaches', 'absent'], { catalogTokens: 20 }),
      entry('dear-idle', ['reaches', 'absent'], { catalogTokens: 300 }),
      entry('working', ['reaches', 'reaches'], { catalogTokens: 500 }),
    ]),
    usageOf({ working: { sessions: 1, activations: 1, lastAt: 5, byRuntime: { one: { sessions: 1, activations: 1 } } } }),
  )
  await showMatrix()
  await chooseFilter('Never fired')
  const rows = [...document.body.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
  expect(rows).toEqual(['dear-idle', 'cheap-idle'])
})

it('the fired-here footer counts per agent over the rows on screen', async () => {
  await mount(
    library([
      entry('alpha', ['reaches', 'reaches'], { catalogTokens: 10 }),
      entry('beta', ['reaches', 'absent'], { catalogTokens: 10 }),
    ]),
    usageOf({
      alpha: { sessions: 2, activations: 4, lastAt: 5, byRuntime: { one: { sessions: 1, activations: 2 }, two: { sessions: 1, activations: 2 } } },
      beta: { sessions: 1, activations: 1, lastAt: 5, byRuntime: { one: { sessions: 1, activations: 1 } } },
    }),
  )
  await showMatrix()
  const fired = [...document.body.querySelectorAll('tfoot tr:last-child td')].map((node) => node.textContent)
  expect(fired).toEqual(['2 of 2', '1 of 2'])
})

it('a split that cannot name every activation shows the remainder', async () => {
  // 5 activations, 2 attributable to a live column: the other 3 were stored
  // under a registration that no longer exists, and the drawer must say so
  // rather than let "2×" stand next to "Fired 5×" unexplained.
  await mount(
    library([entry('alpha', ['reaches', 'absent'], { catalogTokens: 10 })]),
    usageOf({
      alpha: { sessions: 3, activations: 5, lastAt: 5, byRuntime: { one: { sessions: 1, activations: 2 }, retired: { sessions: 2, activations: 3 } } },
    }),
  )
  await showMatrix()
  const disclosure = document.body.querySelector('table [aria-expanded]') as HTMLButtonElement | null
  await act(async () => disclosure?.click())
  expect(document.body.textContent).toContain('2× First Agent')
  expect(document.body.textContent).toContain('3× under earlier registrations')
})

it('the drawer offers to install where the entry does not reach', async () => {
  // The row is the unit of management: an absent cell is one click from an
  // install, and the click opens a preview rather than doing anything.
  const request = await mount(library([entry('alpha', ['reaches', 'absent'])]))
  await showMatrix()
  await act(async () => {
    ;[...document.body.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('alpha'))
      ?.click()
  })
  const install = [...document.body.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Install to Second Agent'),
  )
  expect(install).toBeTruthy()
  await act(async () => install?.click())
  const planned = request.mock.calls.find((one) => one[0] === 'library/plan')
  expect(planned).toBeTruthy()
  expect((planned?.[1] as { intents: unknown[] }).intents).toEqual([
    {
      kind: 'installSkill',
      name: 'alpha',
      sourcePath: '/home/u/.claude/skills/alpha',
      targetRuntime: runtimeId('two'),
    },
  ])
})

it('detects the hollow directories and turns them into one previewed clean-up', async () => {
  const request = await mount(
    library([entry('good', ['reaches', 'reaches']), partialEntry('ghost', ['hollow', 'absent'])]),
  )
  await chooseChip('Needs you')
  expect(document.body.textContent).toContain('1 directory holds a skill’s name and no definition')
  await act(async () => {
    ;[...document.body.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('Clean up…'))
      ?.click()
  })
  const planned = request.mock.calls.find((one) => one[0] === 'library/plan')
  expect((planned?.[1] as { intents: unknown[] }).intents).toEqual([
    { kind: 'removeCopy', name: 'ghost', path: '/home/u/.claude/skills/ghost' },
  ])
})

it('says which copy wins an agent’s scan order, and which is shadowed', async () => {
  // Two copies, both read by the first agent; the location table's order
  // decides which one loads, and the drawer says so on each copy.
  const two: LibraryEntry = {
    ...entry('dup', ['differs', 'absent']),
    copies: [
      {
        path: '/home/u/proj/.claude/skills/dup',
        scope: 'project',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'aaa',
        readOnly: false,
      },
      {
        path: '/home/u/.claude/skills/dup',
        scope: 'user',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'bbb',
        readOnly: false,
      },
    ],
  }
  const value: Library = {
    ...library([two]),
    locations: [
      {
        runtime: runtimeId('one'),
        kind: 'skill',
        path: '/home/u/.claude/skills',
        scope: 'user',
        scanned: true,
        exists: true,
        readOnly: false,
      },
      {
        runtime: runtimeId('one'),
        kind: 'skill',
        path: '/home/u/proj/.claude/skills',
        scope: 'project',
        scanned: true,
        exists: true,
        readOnly: false,
      },
    ],
  }
  await mount(value)
  await showMatrix()
  await act(async () => {
    ;[...document.body.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('dup'))
      ?.click()
  })
  const chips = [...document.body.querySelectorAll('[title*="scan order"]')].map(
    (one) => one.textContent,
  )
  expect(chips).toContain('loads for First Agent')
  expect(chips).toContain('shadowed for First Agent')
})

it('arriving from the banner opens the import flow over the same page', async () => {
  // The first-run offer routes here instead of applying anything itself; the
  // page it lands on is the ordinary Library with the import dialog already up.
  await mount(library([entry('alpha', ['reaches', 'absent'])]), undefined, {
    initialFlow: 'import',
  })
  expect(document.body.textContent).toContain('Import between runtimes')
  expect(document.body.textContent).toContain('Nothing changes until a preview is confirmed')
})

it('a row whose copies disagree offers Resolve, never Install', async () => {
  // Installing from a name with two truths would silently pick one of them.
  const two: LibraryEntry = {
    ...entry('dup', ['differs', 'absent']),
    copies: [
      {
        path: '/home/u/proj/.claude/skills/dup',
        scope: 'project',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'aaa',
        readOnly: false,
      },
      {
        path: '/home/u/.claude/skills/dup',
        scope: 'user',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'bbb',
        readOnly: false,
      },
    ],
  }
  await mount(library([two]))
  await showMatrix()
  await act(async () => {
    ;[...document.body.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('dup'))
      ?.click()
  })
  const labels = [...document.body.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(labels.some((label) => label.includes('Install to'))).toBe(false)
  expect(labels.some((label) => label.includes('Resolve copies'))).toBe(true)
})

it('a bulk import carries the source agent\u2019s own copy, not a namesake', async () => {
  // Same digest in two places, read by different agents: "import from First
  // Agent" must take the copy First Agent actually reads, so the install's
  // provenance matches its label.
  const kit: LibraryEntry = {
    kind: 'skill',
    name: 'kit',
    title: null,
    description: null,
    copies: [
      {
        path: '/home/u/proj/.claude/skills/kit',
        scope: 'project',
        readBy: [runtimeId('three')],
        hollow: false,
        digest: 'aaa',
        readOnly: false,
      },
      {
        path: '/home/u/.claude/skills/kit',
        scope: 'user',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'aaa',
        readOnly: false,
      },
    ],
    reach: [
      { runtime: runtimeId('one'), state: 'reaches', basis: 'scanned' },
      { runtime: runtimeId('two'), state: 'absent', basis: 'scanned' },
      { runtime: runtimeId('three'), state: 'reaches', basis: 'scanned' },
    ],
  }
  const value: Library = {
    generatedAt: 1,
    home: HOME,
    runtimes: [runtimeId('one'), runtimeId('two'), runtimeId('three')],
    locations: [skillLocation('one'), skillLocation('two'), skillLocation('three')],
    entries: [kit],
    gaps: [],
  }
  const request = await mount(value, undefined, {
    initialFlow: 'import',
    runtimes: [
      runtime('one', 'First Agent'),
      runtime('two', 'Second Agent'),
      runtime('three', 'Third Agent'),
    ],
  })
  const radios = (group: string): readonly HTMLButtonElement[] => [
    ...(document.body
      .querySelector(`[role="radiogroup"][aria-label="${group}"]`)
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []),
  ]
  await act(async () => {
    radios('Import from')
      .find((one) => one.textContent === 'First Agent')
      ?.click()
  })
  await act(async () => {
    radios('Import into')
      .find((one) => one.textContent === 'Second Agent')
      ?.click()
  })
  const preview = [...document.body.querySelectorAll('button')].find((one) =>
    one.textContent?.startsWith('Preview 1'),
  )
  expect(preview).toBeTruthy()
  await act(async () => preview?.click())
  const planned = request.mock.calls.find((one) => one[0] === 'library/plan')
  expect((planned?.[1] as { intents: unknown[] }).intents).toEqual([
    {
      kind: 'installSkill',
      name: 'kit',
      sourcePath: '/home/u/.claude/skills/kit',
      targetRuntime: runtimeId('two'),
    },
  ])
})

it('keeps changes off the Library foot and offers them in More', async () => {
  await mount(library([entry('alpha', ['reaches', 'reaches'])]))
  expect(document.body.textContent).not.toContain('Changes made from here')
  expect(document.body.textContent).not.toContain('Restore…')
  await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="More"]')?.click())
  expect(document.body.textContent).toContain('Changes made here…')
})

it('never offers to install a server into an agent with no config file for one', async () => {
  const server: LibraryEntry = {
    kind: 'mcp',
    name: 'fetcher',
    title: null,
    description: null,
    copies: [
      {
        path: '/home/u/.claude.json#fetcher',
        scope: 'user',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'aaa',
        readOnly: false,
      },
    ],
    reach: [
      { runtime: runtimeId('one'), state: 'reaches', basis: 'scanned' },
      { runtime: runtimeId('two'), state: 'absent', basis: 'scanned' },
    ],
  }
  const hostLocation = {
    runtime: runtimeId('one'),
    kind: 'mcp' as const,
    path: '/home/u/.claude.json',
    scope: 'user' as const,
    scanned: true,
    exists: true,
    readOnly: false,
  }
  // The MCP rows live behind their own tab, and the drawer behind the row.
  const openFetcher = async (): Promise<void> => {
    await chooseKind('mcp')
    await act(async () => {
      ;[...document.body.querySelectorAll('button')]
        .find((one) => one.textContent?.includes('fetcher'))
        ?.click()
    })
  }

  // Only the first agent declares an MCP config: the absent cell stays a
  // fact, not a button, because the plan could only ever refuse it.
  await mount({ ...library([server]), locations: [hostLocation] })
  await showMatrix()
  await openFetcher()
  const offers = () =>
    [...document.body.querySelectorAll('button')].filter((one) =>
      one.textContent?.includes('Add to Second Agent'),
    )
  expect(offers()).toHaveLength(0)

  // Give the second agent a config file and the same cell becomes an offer.
  act(() => root.unmount())
  root = createRoot(container)
  await mount({
    ...library([server]),
    locations: [hostLocation, { ...hostLocation, runtime: runtimeId('two'), path: '/home/u/.two.json', exists: false }],
  })
  // A second mount is a second page: the view switch resets with it.
  await showMatrix()
  await openFetcher()
  expect(offers()).toHaveLength(1)
})

it.each([['skill', 'list'], ['skill', 'matrix'], ['mcp', 'list'], ['mcp', 'matrix']] as const)('many runtimes collapse the %s %s offers into one previewed plan', async (kind, layout) => {
  // One button per agent is fine at four and a keyboard row at ten. Past
  // three targets, one button previews a plan with an op per agent — every
  // target still named, apply still per-op.
  const ids = ['one', 'two', 'three', 'four', 'five', 'six']
  const wide: LibraryEntry = {
    kind,
    name: 'alpha',
    title: null,
    description: null,
    copies: [
      {
        path: '/home/u/.claude/skills/alpha',
        scope: 'user',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'abc',
        readOnly: false,
      },
    ],
    reach: ids.map((id, index) => ({
      runtime: runtimeId(id),
      state: index === 0 ? ('reaches' as const) : ('absent' as const),
      basis: 'scanned' as const,
    })),
  }
  const value: Library = {
    generatedAt: 1,
    home: HOME,
    runtimes: ids.map((id) => runtimeId(id)),
    locations: ids.map((id) => ({ ...skillLocation(id), kind })),
    entries: [wide],
    gaps: [],
  }
  const request = await mount(value, undefined, {
    runtimes: ids.map((id, index) => runtime(id, `Agent ${index + 1}`)),
  })
  if (kind === 'mcp') await chooseKind('mcp')
  if (layout === 'matrix') await showMatrix()
  await act(async () => {
    ;[...document.body.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('alpha'))
      ?.click()
  })
  const labels = [...document.body.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(labels.some((label) => label === 'Install to Agent 2')).toBe(false)
  const all = [...document.body.querySelectorAll('button')].find((one) =>
    one.textContent?.includes(`${kind === 'skill' ? 'Install' : 'Add'} to all 5 missing`),
  )
  expect(all).toBeTruthy()
  await act(async () => all?.click())
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(kind === 'skill' ? 'Install alpha for 5 runtimes' : `Add alpha ${layout === 'matrix' ? 'to' : 'for'} 5 runtimes`)
  const planned = request.mock.calls.find((one) => one[0] === 'library/plan')
  const intents = (planned?.[1] as { intents: readonly { targetRuntime: string }[] }).intents
  expect(intents).toHaveLength(5)
  expect(intents.map((one) => one.targetRuntime)).toEqual(['two', 'three', 'four', 'five', 'six'])
})

it('three or more column caveats fold behind their count', async () => {
  const reason =
    'This agent could not be asked what it loaded, so its column is read from disk.'
  const value: Library = {
    ...library([entry('alpha', ['reaches', 'reaches'])]),
    gaps: [
      { runtime: runtimeId('one'), kind: 'skill', reason },
      { runtime: runtimeId('two'), kind: 'skill', reason },
      { runtime: runtimeId('one'), kind: 'skill', reason: 'A second reason.' },
    ] as Library['gaps'],
  }
  await mount(value)
  expect(document.body.textContent).toContain(
    '3 columns are read from disk rather than from their runtimes',
  )
  // The fold hides nothing: each agent's own sentence is still there to open.
  expect(document.body.querySelector('details')).toBeTruthy()
  expect(document.body.textContent).toContain('A second reason.')
})

it('never offers a skill to an agent the location table cannot write to', async () => {
  // The agent registered before its brand joined the table: its column is
  // real, its gap line says why it is weak, and nothing offers to install
  // into a directory nobody can name.
  const value: Library = {
    ...library([entry('alpha', ['reaches', 'absent'])]),
    locations: [skillLocation('one')],
  }
  await mount(value)
  await showMatrix()
  await act(async () => {
    ;[...document.body.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('alpha'))
      ?.click()
  })
  const offer = [...document.body.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Install to Second Agent'),
  )
  expect(offer).toBeUndefined()
})

/* ——— the list, which is what the page now opens on ————————————————— */

const cards = (): readonly HTMLElement[] => [
  ...document.body.querySelectorAll<HTMLElement>('[data-slot="skill-card"], [data-slot="skill-row"]'),
]

it('opens on a list, one row per entry, each carrying what the thing is for', async () => {
  // The earned sentence stays whole on the row; the sheet reads the definition.
  await mount(
    library([
      entry('code-review', ['reaches', 'reaches'], {
        description: 'Review the current diff for correctness bugs.',
      }),
    ]),
  )
  expect(cards()).toHaveLength(1)
  expect(cards()[0]?.textContent).toContain('code-review')
  expect(cards()[0]?.textContent).toContain('Review the current diff for correctness bugs.')
})

it('keeps command names off the opening card', async () => {
  await mount(library([entry('brainstorming', ['reaches', 'reaches'])]))
  expect(cards()[0]?.textContent).not.toContain('/brainstorming')
})


it('Loaded by includes every runtime, dimming those that do not load it', async () => {
  await mount(library([entry('alpha', ['reaches', 'unscanned'])]))
  const marks = [...cards()[0]!.querySelectorAll('[data-runtime-state]')]
  expect(marks.map(node => node.getAttribute('title'))).toEqual(['First Agent: Reaches', 'Second Agent: Not read'])
  expect(marks[1]?.hasAttribute('data-problem')).toBe(true)
})


it('a problem gets a warning flag beside its single finding', async () => {
  await mount(library([partialEntry('alpha', ['hollow', 'reaches'])]))
  const row = cards()[0]!
  expect(row.querySelector('[data-card-finding][data-tone="warning"]')?.textContent).toBe('Empty on disk')
  expect(row.querySelector('[data-card-finding] svg')).toBeTruthy()
})


it('a row’s finding names the defect, never the symptom it causes', async () => {
  // The bug this pins: `hollow` and `differs` both mean nothing reaches, so
  // a "reaches nobody first" rule captioned an empty directory and a pair of
  // divergent copies with the same four words — burying the cause under a
  // symptom the reader can do nothing with.
  await mount(
    library([
      partialEntry('empty', ['hollow', 'absent'], {
        copies: [
          {
            path: '/home/u/.claude/skills/empty',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: true,
            digest: null,
            readOnly: false,
          },
        ],
      }),
      entry('split', ['differs', 'differs'], {
        copies: [
          {
            path: '/home/u/.claude/skills/split',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
          {
            path: '/home/u/.codex/skills/split',
            scope: 'user',
            readBy: [runtimeId('two')],
            hollow: false,
            digest: 'b',
            readOnly: false,
          },
        ],
      }),
    ]),
  )
  const text = cards().map((card) => card.textContent ?? '')
  expect(text[0]).toContain('Empty on disk')
  expect(text[1]).toContain('2 copies differ')
  expect(text.join(' ')).not.toContain('No agent loads this')
})

it('a stranded copy is captioned as stranded, not as absent', async () => {
  // The finding the whole library was built around, kept legible on a card:
  // a copy in a directory nothing scans is one move from working, and that
  // move is not the one an absent skill needs.
  await mount(
    library([
      entry('stray', ['unscanned', 'unscanned'], {
        copies: [
          {
            path: '/home/u/.agents/skills/stray',
            scope: 'user',
            readBy: [],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
        ],
      }),
    ]),
  )
  expect(cards()[0]?.textContent).toContain('Where no runtime looks')
})

it('opening a row reads the definition off the host and renders it', async () => {
  // The capability the page did not have: showing what a skill actually
  // says. A library that can locate an instruction bundle and not display
  // one is a library about directories.
  const request = await mount(library([entry('code-review', ['reaches', 'absent'])]), undefined, {
    definition: {
      name: 'code-review',
      kind: 'skill',
      path: '/home/u/.claude/skills/code-review',
      text: '---\nname: code-review\ndescription: Review the diff.\n---\n\n# Code review\n\nCorrectness first.',
      truncated: false,
      files: [{ path: 'SKILL.md', bytes: 90 }],
      moreFiles: 0,
    },
  })
  await act(async () => cards()[0]?.click())

  const asked = request.mock.calls.find(([method]) => method === 'library/definition')
  expect(asked?.[1]).toMatchObject({
    kind: 'skill',
    name: 'code-review',
    path: '/home/u/.claude/skills/code-review',
  })

  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  expect(sheet, 'the sheet should open').toBeTruthy()
  expect(sheet?.textContent).toContain('Code review')
  expect(sheet?.textContent).toContain('Correctness first.')
  // The frontmatter is lifted out rather than dropped: it is what the agent
  // reads to decide whether to fire, so a reader who cannot see it cannot
  // debug that decision.
  expect(sheet?.textContent).toContain('description: Review the diff.')
})

it('Use in composer leaves the page for the conversation, then hands the command over', async () => {
  // The composer ignores a compose event while a page, not the conversation,
  // is showing — so a bare event sent from the Library closed the sheet and
  // went nowhere, with no word that it had. The press has to go back to the
  // work first and keep handing over until a composer takes it.
  const calls: string[] = []
  await mount(library([entry('code-review', ['reaches', 'absent'])]), undefined, {
    definition: {
      name: 'code-review',
      kind: 'skill',
      path: '/home/u/.claude/skills/code-review',
      text: '---\nname: code-review\ndescription: Review the diff.\n---\n\n# Code review',
      truncated: false,
      files: [{ path: 'SKILL.md', bytes: 90 }],
      moreFiles: 0,
    },
    returnToWork: () => calls.push('returnToWork'),
  })
  await act(async () => cards()[0]?.click())
  const use = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use in composer')
  expect(use, 'the sheet should offer Use in composer').toBeTruthy()

  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ text: string; onReceived: () => void }>).detail
    calls.push(`compose ${detail.text}`)
    detail.onReceived()
  }
  window.addEventListener('harnessdesk:compose', listener)
  try {
    await act(async () => use?.click())
  } finally {
    window.removeEventListener('harnessdesk:compose', listener)
  }

  expect(calls).toEqual(['returnToWork', 'compose /code-review '])
  expect(document.querySelector('[data-slot="skill-sheet"]'), 'the sheet closes').toBeNull()
})

it('a definition the host cannot answer for is said, never left blank', async () => {
  await mount(library([entry('gone', ['reaches', 'absent'])]), undefined, { definition: null })
  await act(async () => cards()[0]?.click())
  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  expect(sheet?.textContent).toContain('could not be read')
})

it('a malformed answer is treated as unreadable rather than crashing the page', async () => {
  // It crossed a socket. A renderer that takes `answer.text` on faith blanks
  // the whole settings window when the host answers something else.
  await mount(library([entry('odd', ['reaches', 'absent'])]), undefined, {
    definition: { unexpected: true } as unknown as null,
  })
  await act(async () => cards()[0]?.click())
  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  expect(sheet, 'the sheet should still render').toBeTruthy()
  expect(sheet?.textContent).toContain('could not be read')
})

it('the sheet offers the same install the matrix does, and refuses it the same way', async () => {
  // The verbs are shared, not reimplemented: an entry whose copies disagree
  // offers Resolve and never Install, because *which* content would travel
  // is the open question.
  await mount(
    library([
      entry('split', ['differs', 'differs'], {
        copies: [
          {
            path: '/home/u/.claude/skills/split',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
          {
            path: '/home/u/.codex/skills/split',
            scope: 'user',
            readBy: [runtimeId('two')],
            hollow: false,
            digest: 'b',
            readOnly: false,
          },
        ],
      }),
    ]),
  )
  await act(async () => cards()[0]?.click())
  const labels = [...document.querySelectorAll('[data-slot="skill-sheet"] button')].map(
    (one) => one.textContent ?? '',
  )
  expect(labels.some((one) => one.includes('Resolve copies'))).toBe(true)
  expect(labels.some((one) => one.startsWith('Add to'))).toBe(false)
})

it('an empty library offers the way out of being empty', async () => {
  // "Nothing matches." answered both a filter that found nothing and a
  // machine with no skills on it. The second is a first run, and telling it
  // to adjust filters it never set is how a first run reads as broken.
  await mount(library([]))
  expect(document.body.textContent).toContain('No skills yet')
  const write = [...document.body.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Write a skill'),
  )
  expect(write, 'an empty library should offer to fill itself').toBeTruthy()
})

/* ——— switched off: present, and not loading ——————————————————————— */

it('a switched-off agent gets a switch, and every other state gets a sentence', async () => {
  // The switch appears only where it would work. A control on a row the host
  // would refuse is worse than no control, and every other state's answer is
  // a different verb — install it, resolve it, empty it out.
  await mount(
    library([
      entry('review', ['off', 'absent'], {
        copies: [
          {
            path: '/home/u/.claude/skills/review',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
        ],
        reach: [
          { runtime: runtimeId('one'), state: 'off', basis: 'reported' },
          { runtime: runtimeId('two'), state: 'absent', basis: 'scanned' },
        ],
      }),
    ]),
  )
  await act(async () => cards()[0]?.click())
  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  const switches = [...(sheet?.querySelectorAll('[role="switch"]') ?? [])]
  expect(switches).toHaveLength(1)
  expect(switches[0]?.getAttribute('aria-label')).toBe('review in First Agent')
  expect(sheet?.textContent).toContain('Not installed')
})

it('throwing the switch names the agent it belongs to, not the focused one', async () => {
  // The library's whole subject is *other* agents. Toggling Cursor's copy
  // from a page opened while Codex is focused would switch the wrong one.
  const enabled = vi.fn(async () => {})
  await mount(
    library([
      entry('review', ['off', 'absent'], {
        copies: [
          {
            path: '/home/u/.claude/skills/review',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
        ],
        reach: [
          { runtime: runtimeId('one'), state: 'off', basis: 'reported' },
          { runtime: runtimeId('two'), state: 'absent', basis: 'scanned' },
        ],
      }),
    ]),
    undefined,
    { setSkillEnabled: enabled },
  )
  await act(async () => cards()[0]?.click())
  const toggle = document.querySelector('[data-slot="skill-sheet"] [role="switch"]')
  await act(async () => (toggle as HTMLElement | null)?.click())

  expect(enabled).toHaveBeenCalledTimes(1)
  const [skill, next, on] = enabled.mock.calls[0] as unknown as [
    { name: string; path: string | null },
    boolean,
    string,
  ]
  expect(skill.name).toBe('review')
  expect(next).toBe(true)
  expect(on).toBe(runtimeId('one'))
})

it('the switch addresses the agent in the agent’s own spelling of the path', async () => {
  // The silent failure: a copy's path is the bundle directory we found on
  // disk; the agent may key the same skill by its SKILL.md. Sent the
  // directory, Codex accepts the write, records a config entry keyed on a
  // path it never matches, leaves the skill on, and the switch springs back
  // with no error anywhere. Measured against real Codex before this test.
  const enabled = vi.fn(async () => {})
  const reportedPath = '/home/u/.claude/skills/review/SKILL.md'
  await mount(
    library([
      entry('review', ['reaches', 'absent'], {
        copies: [
          {
            path: '/home/u/.claude/skills/review',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
        ],
        reach: [
          { runtime: runtimeId('one'), state: 'reaches', basis: 'reported', reportedPath },
          { runtime: runtimeId('two'), state: 'absent', basis: 'scanned' },
        ],
      }),
    ]),
    undefined,
    { setSkillEnabled: enabled },
  )
  await act(async () => cards()[0]?.click())
  const toggle = document.querySelector('[data-slot="skill-sheet"] [role="switch"]')
  await act(async () => (toggle as HTMLElement | null)?.click())

  const [skill] = enabled.mock.calls[0] as unknown as [{ name: string; path: string | null }]
  expect(skill.path).toBe(reportedPath)
  expect(skill.path).not.toBe('/home/u/.claude/skills/review')
})

it('an agent that reported no path is addressed by name, never by ours', async () => {
  const enabled = vi.fn(async () => {})
  await mount(
    library([
      entry('review', ['reaches', 'absent'], {
        copies: [
          {
            path: '/home/u/.claude/skills/review',
            scope: 'user',
            readBy: [runtimeId('one')],
            hollow: false,
            digest: 'a',
            readOnly: false,
          },
        ],
        reach: [
          { runtime: runtimeId('one'), state: 'reaches', basis: 'reported' },
          { runtime: runtimeId('two'), state: 'absent', basis: 'scanned' },
        ],
      }),
    ]),
    undefined,
    { setSkillEnabled: enabled },
  )
  await act(async () => cards()[0]?.click())
  const toggle = document.querySelector('[data-slot="skill-sheet"] [role="switch"]')
  await act(async () => (toggle as HTMLElement | null)?.click())

  const [skill] = enabled.mock.calls[0] as unknown as [{ name: string; path: string | null }]
  expect(skill.path).toBeNull()
})

it('a row says a skill is switched off before it says nobody loads it', async () => {
  // Same rule as hollow and differs: the cause outranks the symptom, and
  // "no agent loads this" is what a switch looks like from underneath.
  await mount(
    library([
      entry('review', ['off', 'off'], {
        reach: [
          { runtime: runtimeId('one'), state: 'off', basis: 'reported' },
          { runtime: runtimeId('two'), state: 'off', basis: 'reported' },
        ],
      }),
    ]),
  )
  expect(cards()[0]?.querySelector('[title="First Agent: Switched off"]')).toBeTruthy()
  expect(cards()[0]?.textContent).not.toContain('Loaded by nobody')
})

it('the switched-off filter isolates exactly the entries with a switch down', async () => {
  await mount(
    library([
      entry('on', ['reaches', 'reaches']),
      entry('paused', ['off', 'reaches'], {
        reach: [
          { runtime: runtimeId('one'), state: 'off', basis: 'reported' },
          { runtime: runtimeId('two'), state: 'reaches', basis: 'reported' },
        ],
      }),
    ]),
  )
  await chooseFilter('Switched off')
  expect(cards().map((card) => card.textContent?.includes('paused'))).toEqual([true])
})

it('an agent that refuses toggles gets a sentence, never a switch', async () => {
  // Claude Code and Cursor answer over ACP: a skill is a command the agent
  // declares, `toggleable` is false, and `runtime/skills/setEnabled` throws.
  // A switch there can only fail and spring back.
  await mount(
    library([
      entry('review', ['reaches', 'reaches'], {
        reach: [
          { runtime: runtimeId('one'), state: 'reaches', basis: 'reported', toggleable: false },
          { runtime: runtimeId('two'), state: 'reaches', basis: 'reported', toggleable: true },
        ],
      }),
    ]),
  )
  await act(async () => cards()[0]?.click())
  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  const switches = [...(sheet?.querySelectorAll('[role="switch"]') ?? [])]
  // Only the agent that accepts the write gets one.
  expect(switches.map((one) => one.getAttribute('aria-label'))).toEqual(['review in Second Agent'])
  // And the one that does not still says what it is doing.
  expect(sheet?.textContent).toContain('Loads it')
})

/**
 * Type into the page's own search box the way a person does — through the
 * native setter, so React's onChange fires.
 */
const typeSearch = async (text: string): Promise<void> => {
  const box = document.body.querySelector(
    'input[aria-label="Search library"]',
  ) as HTMLInputElement | null
  expect(box, 'the page should have a search box').toBeTruthy()
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(box, text)
    box?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A filter row's count, read with the menu open and the menu closed again. */
const countOf = async (label: string): Promise<string | null | undefined> => {
  await openFilter()
  const text = filterRow(label)?.textContent
  await closeFilter()
  return text
}

it('a count counts what choosing it will show, search included', async () => {
  await mount(
    library([
      entry('alpha', ['absent', 'absent']),
      entry('beta', ['absent', 'absent']),
      entry('gamma', ['reaches', 'reaches']),
    ]),
  )
  // Two reach nobody, and that is the honest number for the whole library.
  expect(await countOf('Reach none')).toContain('2')

  // Narrow to one of them. The count used to keep saying 2 — and choosing
  // it, which is the only thing a count does, left an empty page.
  await typeSearch('alpha')
  expect(await countOf('Reach none')).toContain('1')
  expect(await countOf('Everything')).toContain('1')
  await chooseFilter('Reach none')
  expect(cards().length).toBe(1)
  expect(cards()[0]?.textContent).toContain('alpha')

  // Chosen, it stays offered at zero so it can be seen and left: search for
  // the one entry that reaches everything and the chosen row reads 0.
  await typeSearch('gamma')
  await openFilter()
  expect(filterRow('Reach none')?.textContent).toContain('0')
  expect(filterRow('Reach none')?.getAttribute('aria-checked')).toBe('true')
  // At zero the number carries no amber: nothing is wrong in what is shown.
  expect(filterRow('Reach none')?.querySelector('[data-tone="warning"]')).toBeNull()

  // Left, a search that leaves nothing in that state withdraws the row
  // rather than offering a choice that would empty the list.
  await act(async () => filterRow('Everything')?.click())
  await openFilter()
  expect(filterRow('Reach none')).toBeUndefined()
})

it('an empty list blames whichever of the two narrowings actually emptied it', async () => {
  await mount(
    library([entry('alpha', ['reaches', 'absent']), entry('beta', ['reaches', 'reaches'])]),
  )
  // One entry reaches some, so the filter is offered. Then search for the
  // *other* one: the search matched something, and the filter is what left
  // the page empty.
  await chooseFilter('Reach some')
  await typeSearch('beta')
  expect(document.body.textContent).toContain('Nothing matches')
  expect(container.querySelector('[data-slot="empty-state"] p')).toBeNull()
  expect(document.body.textContent).not.toContain('1 entry matches')
  // Not “No skill here is called beta” — there is one, and the state filter
  // is what is holding it back.
  expect(document.body.textContent).not.toContain('No skill here is called')
})

it('a skill is installed and a server is added, in every place that offers it', async () => {
  await mount(library([entry('alpha', ['reaches', 'absent'])]))
  await act(async () => cards()[0]?.click())
  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  // One verb per kind. The drawer said "Install to Second Agent" and the
  // sheet said "Add to Second Agent" about the identical act.
  expect(sheet?.textContent).toContain('Install to Second Agent')
  expect(sheet?.textContent).not.toContain('Add to Second Agent')
})

it('the matrix says what its marks mean, on screen', async () => {
  await mount(library([entry('alpha', ['reaches', 'unscanned'])]))
  await showMatrix()
  const legend = document.body.querySelector('[data-slot="library-legend"]')
  expect(legend, 'the matrix should carry a visible key').toBeTruthy()
  expect(legend?.textContent).toContain('Reaches')
  expect(legend?.textContent).toContain('Not read')
  // Only what is on screen: a key explaining five absent states is furniture.
  expect(legend?.textContent).not.toContain('Cannot host')
})

it('draws each matrix state in the meta ink it judges by, loads-it as the readiness light', async () => {
  await mount(library([entry('alpha', ['reaches', 'unscanned'])]))
  await showMatrix()
  const marks = [...document.body.querySelectorAll<HTMLElement>('td [data-reach]')]
  const [loads, unread] = marks
  expect(marks.map((mark) => mark.dataset['reach'])).toEqual(['reaches', 'unscanned'])
  expect(loads?.dataset['role']).toBe('meta')
  expect(loads?.dataset['placement']).toBe('cell')
  expect(loads?.querySelector('[data-slot="dot"]')?.getAttribute('data-state')).toBe('ready')
  expect(loads?.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Reaches')
  expect(unread?.dataset['tone']).toBe('warning')
  expect(unread?.querySelector('[data-slot="dot"]')).toBeNull()
  // A copy no agent has read is the task list's pending ring, not a drawing of one.
  expect(unread?.querySelector('svg')?.classList.contains('lucide-circle')).toBe(true)
})

it('a copy an agent has not read back yet says so, and is not filed as a fault', async () => {
  await mount(
    library([
      entry('alpha', ['reaches', 'stale'], {
        reach: [
          { runtime: runtimeId('one'), state: 'reaches', basis: 'reported' },
          {
            runtime: runtimeId('two'),
            state: 'stale',
            basis: 'reported',
            note: 'Installed where this agent looks, and absent from the list it reported.',
          },
        ],
      }),
    ]),
  )
  // The row a second after an install: it worked, and the last step is the
  // agent's.
  expect(cards()[0]?.querySelector('[title="Second Agent: Not loaded yet"]')).toBeTruthy()
  // Quietly — the problems filter is for defects, and this is not one, so
  // there is no problem to choose.
  await openFilter()
  expect(filterRow('Problems')).toBeUndefined()
})

it('the sheet offers to make a stale agent look again, and reports a refusal', async () => {
  const stale = library([
    entry('alpha', ['reaches', 'stale'], {
      reach: [
        { runtime: runtimeId('one'), state: 'reaches', basis: 'reported' },
        { runtime: runtimeId('two'), state: 'stale', basis: 'reported' },
      ],
    }),
  ])
  const request = await mount(stale)
  await act(async () => cards()[0]?.click())
  const sheet = () => document.querySelector('[data-slot="skill-sheet"]')
  expect(sheet()?.textContent).toContain('Second Agent lists the skills it read when it started')

  const press = () =>
    [...(sheet()?.querySelectorAll('button') ?? [])].find((node) =>
      node.textContent?.includes('Have it look again'),
    )
  expect(press(), 'the sheet should offer the step, not only describe it').toBeTruthy()
  await act(async () => press()?.click())
  // Asked for the agent that is behind, not the one that is fine.
  expect(request).toHaveBeenCalledWith('runtime/refreshCatalog', { runtime: runtimeId('two') })

  /*
   * The refusal that matters is not an exception — it is a *resolved* call
   * that did nothing. An ACP agent refreshes by restarting and declines while
   * a turn is in flight; the host answers `refreshed: false` with a reason.
   * An earlier version of this test threw instead, which is a shape the host
   * hardly ever produces, and the button it was guarding reported that
   * polite refusal as a success.
   */
  request.mockImplementation(async (method: string) => {
    if (method === 'runtime/refreshCatalog') {
      return { checkedAt: 1, installation: null, refreshed: false, reason: 'A turn is in flight.' }
    }
    return method === 'library/usage'
      ? { generatedAt: 1, sessionsScanned: 0, skills: {} }
      : method === 'audit/query'
        ? []
        : method === 'library/definition'
          ? null
          : stale
  })
  await act(async () => press()?.click())
  expect(sheet()?.textContent).toContain('Second Agent')
  expect(sheet()?.textContent).toContain('A turn is in flight.')
})

it('an agent that re-read and still does not list it is not asked to look a third time', async () => {
  const stale = library([
    entry('alpha', ['reaches', 'stale'], {
      reach: [
        { runtime: runtimeId('one'), state: 'reaches', basis: 'reported' },
        { runtime: runtimeId('two'), state: 'stale', basis: 'reported' },
      ],
    }),
  ])
  // The refresh succeeds — and the library still reports the skill as stale,
  // because this agent will not load the definition. "It has not looked
  // since" is spent as an explanation, and the sheet says so instead of
  // offering the same press for ever.
  await mount(stale, undefined, {})
  await act(async () => cards()[0]?.click())
  const sheet = () => document.querySelector('[data-slot="skill-sheet"]')
  const press = () =>
    [...(sheet()?.querySelectorAll('button') ?? [])].find((node) =>
      node.textContent?.includes('Have it look again'),
    )
  await act(async () => press()?.click())
  expect(sheet()?.textContent).toContain('re-read and still does not list it')
  expect(sheet()?.textContent).toContain('may be one it will not accept')
})

it('a throw is still reported, named for the agent it happened to', async () => {
  const stale = library([
    entry('alpha', ['reaches', 'stale'], {
      reach: [
        { runtime: runtimeId('one'), state: 'reaches', basis: 'reported' },
        { runtime: runtimeId('two'), state: 'stale', basis: 'reported' },
      ],
    }),
  ])
  const request = await mount(stale)
  request.mockImplementation(async (method: string) => {
    if (method === 'runtime/refreshCatalog') throw new Error('the host is gone')
    return method === 'library/usage'
      ? { generatedAt: 1, sessionsScanned: 0, skills: {} }
      : method === 'audit/query'
        ? []
        : method === 'library/definition'
          ? null
          : stale
  })
  await act(async () => cards()[0]?.click())
  const sheet = () => document.querySelector('[data-slot="skill-sheet"]')
  const press = () =>
    [...(sheet()?.querySelectorAll('button') ?? [])].find((node) =>
      node.textContent?.includes('Have it look again'),
    )
  await act(async () => press()?.click())
  expect(sheet()?.textContent).toContain('the host is gone')
})

it('a definition an agent refused says so in the agent’s own words, and warns before it spreads', async () => {
  /*
   * From disk this is indistinguishable from a skill the agent has not
   * re-read — a `SKILL.md` is there and the agent did not name it. The
   * difference is that looking again will never help, and the agent already
   * knows why: Codex answers `skills/list` with an `errors` array beside the
   * skills, naming the file and the fault.
   */
  await mount(
    library([
      entry('broken', ['rejected', 'absent'], {
        reach: [
          {
            runtime: runtimeId('one'),
            state: 'rejected',
            basis: 'reported',
            note: 'missing field `description`',
          },
          { runtime: runtimeId('two'), state: 'absent', basis: 'reported' },
        ],
      }),
    ]),
  )
  // The row leads with it: it is the one thing here somebody can act on.
  expect(cards()[0]?.textContent).toContain('Refused by First Agent')

  await act(async () => cards()[0]?.click())
  const sheet = document.querySelector('[data-slot="skill-sheet"]')
  expect(sheet?.textContent).toContain('This runtime read the definition and would not load it')
  // Its reason, verbatim. We did not decide this and must not paraphrase a
  // loader rule we have not measured.
  expect(sheet?.textContent).toContain('missing field `description`')
  // And a word before the obvious next click, which would copy a definition
  // one agent has already refused into another.
  expect(sheet?.textContent).toContain('First Agent would not load this one.')
})

it('determines winning copy under Windows-style scan roots (#664)', async () => {
  const winRoot = 'C:\\repo\\project'
  const winCopy = 'c:\\Repo\\Project\\.claude\\skills\\alpha'
  const userCopy = 'C:\\Users\\User\\.claude\\skills\\alpha'

  await mount(
    {
      ...library([
        entry('alpha', ['reaches', 'absent'], {
          copies: [
            {
              path: winCopy,
              scope: 'project',
              readBy: [runtimeId('one')],
              hollow: false,
              digest: 'a',
              readOnly: false,
            },
            {
              path: userCopy,
              scope: 'user',
              readBy: [runtimeId('one')],
              hollow: false,
              digest: 'b',
              readOnly: false,
            },
          ],
        }),
      ]),
      locations: [
        {
          runtime: runtimeId('one'),
          kind: 'skill',
          path: winRoot,
          scope: 'project',
          scanned: true,
          exists: true,
          readOnly: false,
        },
        {
          runtime: runtimeId('one'),
          kind: 'skill',
          path: 'C:\\Users\\User',
          scope: 'user',
          scanned: true,
          exists: true,
          readOnly: false,
        },
      ],
    },
  )
  await showMatrix()
  expect(document.body.textContent).toContain('alpha')
})

/**
 * Phase 12 Task 6: the Agent filter is a declaration filter, never a second
 * reach measurement. A skill two different Agents both declare stays one row
 * whichever of them is chosen; the row's own measured reach — which runtime
 * actually loads it — is untouched by that choice; and a declared name with
 * nothing behind it (unresolved) never causes the Agent's *other*, real rows
 * to disappear.
 */
it('Agent filter preserves measured reach: same skill declared by two origins but loaded by one runtime; distinguish declarations and reach, retain unresolved rows', async () => {
  const value = library([
    entry('shared-skill', ['reaches', 'absent']), // reaches "one" only — declared by both agents below
    entry('orphan-skill', ['reaches', 'reaches']), // declared by neither agent
  ])
  const agentA: AgentEntry = {
    id: 'agent-a', origin: 'user', path: '/home/u/.harnessdesk/agents/agent-a/AGENT.md', digest: 'da', shadows: [], problems: [],
    definition: { id: 'agent-a', name: 'Agent A', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], mcp: [], prefer: [], brief: '' } as unknown as AgentEntry['definition'],
  }
  const agentB: AgentEntry = {
    id: 'agent-b', origin: 'project', path: '/repo/.harnessdesk/agents/agent-b/AGENT.md', digest: 'db', shadows: [], problems: [],
    definition: { id: 'agent-b', name: 'Agent B', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], mcp: [], prefer: [], brief: '' } as unknown as AgentEntry['definition'],
  }
  const viewFor: Record<string, AgentAttachmentsView> = {
    'agent-a': {
      agent: 'agent-a', origin: 'user', agentDigest: 'da', skillsMode: 'allowlist', mcpMode: 'runtime-defaults', support: [],
      declarations: [
        { kind: 'skill', name: 'shared-skill', identity: { kind: 'skill', name: 'shared-skill', digest: 'x'.repeat(64), source: 'agent', pathLabel: 'p' }, problem: null },
        // Declared, but nothing in the catalogue resolves it — must never
        // suppress this Agent's other, real declaration below.
        { kind: 'skill', name: 'ghost-name', identity: null, problem: 'Could not resolve this name.' },
      ],
    },
    'agent-b': {
      agent: 'agent-b', origin: 'project', agentDigest: 'db', skillsMode: 'allowlist', mcpMode: 'runtime-defaults', support: [],
      declarations: [
        { kind: 'skill', name: 'shared-skill', identity: { kind: 'skill', name: 'shared-skill', digest: 'y'.repeat(64), source: 'agent', pathLabel: 'q' }, problem: null },
      ],
    },
  }
  const request = vi.fn(async (method: string, _params?: unknown) =>
    method === 'library/usage' ? { generatedAt: 1, sessionsScanned: 0, skills: {} }
    : method === 'library/plan' ? { plannedAt: 1, ops: [] }
    : value,
  )
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [runtime('one', 'First Agent'), runtime('two', 'Second Agent')],
    agents: [agentA, agentB],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    loadAgents: vi.fn(async () => {}),
    readAgentAttachments: vi.fn(async (id: string) => viewFor[id]),
  } as unknown as AppStore
  await act(async () => {
    root.render(<StoreProvider store={store}><LibraryHarness /></StoreProvider>)
  })
  // Settle the roster's own declaration read — a microtask past mount.
  await act(async () => {})

  // Unfiltered: both catalogue rows are on screen.
  expect(document.body.textContent).toContain('shared-skill')
  expect(document.body.textContent).toContain('orphan-skill')

  await chooseAgent('Agent A')
  expect(filterTrigger().textContent).toBe('Filter1')
  expect(document.body.textContent).toContain('shared-skill')
  expect(document.body.textContent).not.toContain('orphan-skill')

  // The first-body Agent choice can be cleared through its same menu.
  await chooseAgent('Any Agent')
  expect(document.body.textContent).toContain('orphan-skill')
  expect(document.activeElement).toBe(filterTrigger())

  await chooseAgent('Agent A')

  await chooseAgent('Agent B')
  expect(document.body.textContent).toContain('shared-skill')
  expect(document.body.textContent).not.toContain('orphan-skill')

  // Reach is untouched by the Agent filter: switch to the matrix and confirm
  // "shared-skill" still shows its own measured reach, not a loaded-by-Seat
  // fiction. `showMatrix()` looks for a button by its accessible name, which
  // survives the filter narrowing the rows above it.
  await showMatrix()
  const names = cellNames()
  expect(names).toContain('shared-skill — First Agent: Reaches')
  expect(names).toContain('shared-skill — Second Agent: Not installed')
})

/**
 * PR #893's CI (`e2e/ui-system/provenance.spec.ts`) caught a page-wide crash:
 * `store.readAgentAttachments` resolved `undefined` for one Agent in the
 * roster — exactly what a store that does not honor its own
 * `Promise<AgentAttachmentsView>` contract can produce, which is what the
 * preview harness fixture (missing an implementation) actually did — and
 * this effect read `result.view.declarations` with no guard, throwing
 * `Cannot read properties of undefined (reading 'declarations')` before
 * `setDeclaredBy` ever ran. One unreadable Agent must never blank out every
 * other Agent's declarations.
 */
it('an Agent whose attachments view could not be read is treated as nothing declared, not a crash (#893)', async () => {
  const value = library([entry('shared-skill', ['reaches', 'absent'])])
  const agentA: AgentEntry = {
    id: 'agent-a', origin: 'user', path: '/home/u/.harnessdesk/agents/agent-a/AGENT.md', digest: 'da', shadows: [], problems: [],
    definition: { id: 'agent-a', name: 'Agent A', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], mcp: [], prefer: [], brief: '' } as unknown as AgentEntry['definition'],
  }
  const agentB: AgentEntry = {
    id: 'agent-b', origin: 'project', path: '/repo/.harnessdesk/agents/agent-b/AGENT.md', digest: 'db', shadows: [], problems: [],
    definition: { id: 'agent-b', name: 'Agent B', ceiling: 'edit', ceilingFrom: 'permission', answers: [], produces: [], skills: [], mcp: [], prefer: [], brief: '' } as unknown as AgentEntry['definition'],
  }
  const viewFor: Record<string, AgentAttachmentsView | undefined> = {
    'agent-a': {
      agent: 'agent-a', origin: 'user', agentDigest: 'da', skillsMode: 'allowlist', mcpMode: 'runtime-defaults', support: [],
      declarations: [
        { kind: 'skill', name: 'shared-skill', identity: { kind: 'skill', name: 'shared-skill', digest: 'x'.repeat(64), source: 'agent', pathLabel: 'p' }, problem: null },
      ],
    },
    // agent-b's read never resolves a real view — never thrown, never
    // rejected, just missing, exactly like the unimplemented preview-harness
    // stub CI actually hit.
    'agent-b': undefined,
  }
  const request = vi.fn(async (method: string, _params?: unknown) =>
    method === 'library/usage' ? { generatedAt: 1, sessionsScanned: 0, skills: {} }
    : method === 'library/plan' ? { plannedAt: 1, ops: [] }
    : value,
  )
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    runtimes: [runtime('one', 'First Agent'), runtime('two', 'Second Agent')],
    agents: [agentA, agentB],
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    transport: { request },
    loadAgents: vi.fn(async () => {}),
    readAgentAttachments: vi.fn(async (id: string) => viewFor[id]),
  } as unknown as AppStore

  await act(async () => {
    root.render(<StoreProvider store={store}><LibraryHarness /></StoreProvider>)
  })
  // Settle the roster's own declaration read — a microtask past mount, same
  // as the sibling test above.
  await act(async () => {})

  await chooseAgent('Agent A')
  // Agent A's own, real declaration must survive Agent B's unreadable one —
  // never blanked out by a sibling that could not be read.
  expect(document.body.textContent).toContain('shared-skill')
})

it('cards sort by name, clamp descriptions and open the existing sheet', async () => {
  const description = 'A complete description that remains available in the definition.'
  await mount(library([entry('zulu', ['reaches', 'absent']), entry('alpha', ['reaches', 'reaches'], { description })]))
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['alpha', 'zulu'])
  expect(cards()[0]?.querySelector('[data-skill-description]')?.textContent).toBe(description)
  await act(async () => cards()[0]!.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(description)
})

it('the server List uses the same labelled columns, without a skill invocation', async () => {
  await mount(library([entry('workspace-tools', ['reaches', 'absent'], { kind: 'mcp' })]))
  await chooseKind('mcp')
  expect([...container.querySelectorAll('thead th')].map(head => head.textContent)).toEqual(['Server', 'State', 'Loaded by'])
  const row = container.querySelector('tbody tr')!
  expect(row.textContent).not.toContain('/workspace-tools')
  expect(row.textContent).toContain('Ready')
})


it('mounts only the measured List layout before child layout effects run', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 599 } as DOMRect)
  const layouts: (string | null | undefined)[] = []
  const Probe = () => {
    useLayoutEffect(() => { layouts.push(container.querySelector('[data-slot="skill-list"]')?.getAttribute('data-layout')) }, [])
    return null
  }
  await act(async () => root.render(<SkillList><Probe /></SkillList>))
  expect(layouts).toEqual(['list'])
})

it('keeps a mark for every runtime without capping the strip', async () => {
  const infos = Array.from({ length: 6 }, (_, i) => runtime(`runtime-${i}`, `Runtime ${i + 1}`))
  const loaded = entry('shared', [], { reach: infos.map(info => ({ runtime: info.id, state: 'reaches', basis: 'reported' })) })
  await mount({ ...library([loaded]), runtimes: infos.map(info => info.id) }, undefined, { runtimes: infos })
  expect(cards()[0]?.querySelectorAll('[data-runtime-state]')).toHaveLength(6)
  expect(cards()[0]?.querySelector('[aria-label="Loaded by 6 of 6 runtimes"]')).toBeTruthy()
})


it('uses Banner anatomy for the empty-directory alert and keeps cleanup actionable', async () => {
  await mount(library([partialEntry('empty', ['hollow', 'absent'])]))
  await chooseChip('Needs you')
  const attention = container.querySelector('[data-slot="library-attention"]')!
  expect(attention.querySelector('[data-part="banner-icon"]')).not.toBeNull()
  expect(attention.querySelector('[data-slot="alert-title"]')?.textContent).toBe('Empty skill directories')
  expect(attention.querySelector('[data-slot="alert"]')?.parentElement?.getAttribute('data-measure')).toBe('container')
  const cleanup = [...attention.querySelectorAll('button')].find(button => button.textContent?.includes('Clean up'))!
  await act(async () => cleanup.click())
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Clean up empty skill directories')
})

it('clamps a table description to two lines and keeps the full description in its detail', async () => {
  const description = 'Canvas checks can run in a browser, compare visual output, and record the exact behavior expected before changes are made.'
  await mount(library([entry('canvas', ['reaches', 'absent'], { description })]))
  const row = container.querySelector<HTMLButtonElement>('[data-slot="skill-card"]')!
  expect(row.querySelector('[data-detail-lines]')?.getAttribute('data-detail-lines')).toBe('2')

  await act(async () => row.click())
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(description)
})

it('labels the broad filter in sentence case', async () => {
  await mount(library([entry('code-review', ['reaches', 'absent'])]))
  await openFilter()
  expect(document.body.textContent).toContain('Any agent')
  expect(container.textContent).not.toContain('Any Agent')
})

it('says a repeated load state once and leaves different states on their own rows', async () => {
  const agents = Array.from({ length: 12 }, (_, index) => runtime(`agent-${index + 1}`, `Agent ${index + 1}`))
  const reaches = agents.map((info, index) => ({
    runtime: runtimeId(info.id),
    state: index === 11 ? 'reaches' as const : 'unscanned' as const,
    basis: 'scanned' as const,
  }))
  const autopilot = entry('autopilot', reaches.map(reach => reach.state), { reach: reaches })
  await mount({ ...library([autopilot]), runtimes: agents.map(info => runtimeId(info.id)), locations: [] }, undefined, { runtimes: agents })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="skill-card"]')?.click())

  const dialog = document.body.querySelector('[role="dialog"]')!
  const group = [...dialog.querySelectorAll('section')].find(one => one.querySelector('h3')?.textContent === 'Which runtimes load it')!
  const repeated = 'Installed where this runtime does not look'
  const grouped = 'Installed where these runtimes do not look'
  const rows = [...group.querySelectorAll<HTMLElement>('[role="listitem"]')]
  expect(rows).toHaveLength(12)
  expect(group.textContent?.match(new RegExp(grouped, 'g'))).toHaveLength(1)
  expect(group.querySelector('[data-slot="note"][data-ink="muted"]')?.textContent).toBe(grouped)
  expect(rows.filter(one => one.textContent?.includes(repeated))).toHaveLength(0)
  expect(rows.find(one => one.textContent?.includes('Agent 12'))?.textContent).toContain('Loads it')
})

it('groups identical Why notes once and names the agents they cover', async () => {
  const agents = Array.from({ length: 12 }, (_, index) => runtime(`agent-${index + 1}`, `Agent ${index + 1}`))
  const reason = 'On disk, but not in any directory this agent reads — it did not report it.'
  const reaches = agents.map((info, index) => ({
    runtime: runtimeId(info.id),
    state: index === 11 ? 'reaches' as const : 'unscanned' as const,
    basis: 'scanned' as const,
    ...(index < 3 ? { note: reason } : {}),
  }))
  const autopilot = entry('autopilot', reaches.map(reach => reach.state), { reach: reaches })
  await mount({ ...library([autopilot]), runtimes: agents.map(info => runtimeId(info.id)), locations: [] }, undefined, {
    runtimes: agents,
  })
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="skill-card"]')?.click())

  const why = [...document.body.querySelectorAll('section')].find(one => one.querySelector('h3')?.textContent === 'Why')!
  expect(why.querySelector('[role="list"]')?.textContent).toBe(`Agent 1, Agent 2, Agent 3 — ${reason}`)
})


it('E6 controlled sections and import intents keep one destination body', async () => {
  const value = library([entry('alpha', ['reaches', 'absent']), entry('server', ['reaches', 'absent'], { kind: 'mcp' })])
  const snapshot = { ...emptySnapshot(), status: 'open', agents: [], runtimes: [runtime('one', 'First Agent'), runtime('two', 'Second Agent')] } as AppSnapshot
  const request = vi.fn(async (method: string, _params?: unknown) => method === 'library/usage' ? { generatedAt: 1, sessionsScanned: 0, skills: {} } : method === 'audit/query' ? [] : value)
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, transport: { request } } as unknown as AppStore
  const change = vi.fn()
  const draw = async (section: 'skill' | 'mcp', intent: number, active = true) => act(async () => root.render(
    <StoreProvider store={store}><TopBarProvider><DestinationPageScope owner="destination:library" active={active}>
      <LibrarySection section={section} onSection={change} importIntent={intent} />
    </DestinationPageScope><TopBarOutlet owner="destination:library" fallback={{ place: 'Fallback', more: () => null }} /></TopBarProvider></StoreProvider>
  ))
  await draw('mcp', 0)
  expect(container.querySelector('[data-topbar-title]')).toBeNull()
  expect(container.querySelector('thead')?.textContent).toBe('ServerStateLoaded by')
  await chooseKind('skill')
  expect(change).toHaveBeenCalledWith('skill')
  // The route remains controlled until its owner applies the visit.
  expect(container.querySelector('thead')?.textContent).toBe('ServerStateLoaded by')
  await draw('skill', 1)
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Import between runtimes')
  const close = document.body.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!
  await act(async () => close.click())
  await draw('skill', 1)
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  await draw('skill', 2)
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Import between runtimes')
  await draw('skill', 2, false)
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  await draw('skill', 2, true)
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it('E6 hidden Library cancels a late scan before starting usage and rereads on return', async () => {
  const value = library([entry('fresh', ['reaches', 'absent'])])
  let reply!: (value: Library) => void
  const first = new Promise<Library>(resolve => { reply = resolve })
  const request = vi.fn(async (method: string, _params?: unknown) => method === 'library/read' ? first
    : method === 'library/usage' ? {generatedAt:1,sessionsScanned:0,skills:{}} : [])
  const snapshot = {...emptySnapshot(),status:'open',agents:[]} as AppSnapshot
  const store = {subscribe:()=>()=>{},getSnapshot:()=>snapshot,transport:{request}} as unknown as AppStore
  const draw = async (active: boolean) => act(async () => root.render(<StoreProvider store={store}><DestinationPageScope owner="destination:library" active={active}>
    <LibrarySection section="skill" onSection={()=>{}} importIntent={0} />
  </DestinationPageScope></StoreProvider>))
  await draw(true)
  await draw(false)
  await act(async () => reply(value))
  expect(request.mock.calls.filter(call=>call[0]==='library/usage')).toHaveLength(0)
  expect(container.textContent).not.toContain('fresh')
  await draw(true)
  expect(request.mock.calls.filter(call=>call[0]==='library/read')).toHaveLength(2)
  expect(request.mock.calls.filter(call=>call[0]==='library/usage')).toHaveLength(1)
  expect(container.textContent).toContain('fresh')
})


it('omits reserved folders and skills without any nonempty definition from both views', async () => {
  const real = entry('review', ['reaches', 'reaches'], { description: 'Read `src/` first. <script>bad()</script>' })
  await mount(library([entry('_hd', ['reaches', 'reaches']), entry('empty', ['hollow', 'absent']), real]))
  expect(cards()).toHaveLength(1)
  expect(document.body.querySelector('[title="Library sections"]')?.textContent).toBe('Skills1')
  expect(document.body.querySelector('[data-skill-description] code')?.textContent).toBe('src/')
  expect(document.body.querySelector('script')).toBeNull()
  await showMatrix()
  expect([...document.body.querySelectorAll('tbody th[scope="row"]')].map(node => node.textContent)).toEqual(['reviewRead src/ first. '])
  expect(document.body.querySelector('tbody code')?.textContent).toBe('src/')
  expect(document.body.querySelector('script')).toBeNull()
})

const updateOrigin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: '1234567890abcdef', path: 'review/code-review' }
const skillUpdate = (status: LibrarySkillUpdate['status'], over: Partial<LibrarySkillUpdate> = {}): LibrarySkillUpdate => ({ name: 'code-review', runtime: runtimeId('one'), origin: updateOrigin, latest: 'abcdef1234567890', status, reason: null, ...over })
const pressUpdateCheck = async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  const check = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent === 'Check for updates')
  expect(check).toBeTruthy()
  await act(async () => check!.click())
}

it.each([
  { statuses: ['behind', 'current'], title: '1 update available', tone: 'neutral' },
  { statuses: ['current'], title: 'Everything from a repository is up to date', tone: 'success' },
  { statuses: [], title: 'No skill here came from a repository', tone: 'neutral' },
  { statuses: ['behind', 'unreachable', 'gone'], title: '2 sources could not be checked', tone: 'warning' },
] as const)('checks only on click, reloads, and toasts $title', async ({ statuses, title, tone }) => {
  const request = await mount(library([entry('code-review', ['reaches'])]))
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(request.mock.calls.some(([method]) => method === 'library/sources/check')).toBe(false)
  const original = request.getMockImplementation()!
  request.mockImplementation(async method => method === 'library/sources/check' ? statuses.map(status => skillUpdate(status, { reason: status === 'unreachable' ? 'The source did not answer.' : null })) : original(method))
  await pressUpdateCheck()
  expect(request).toHaveBeenCalledWith('library/sources/check', {})
  expect(request.mock.calls.filter(([m]) => m === 'library/read')).toHaveLength(2)
  expect(toast).toHaveBeenCalledOnce()
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title, tone, ...(tone === 'warning' ? { body: 'The source did not answer.' } : {}) }))
})

it('keeps a host check failure in the page ActionError and allows retry', async () => {
  const request = await mount(library([]))
  request.mockRejectedValueOnce(new Error('The source check was refused.'))
  await pressUpdateCheck()
  expect(container.textContent).toContain('The source check was refused.')
  expect(toast).not.toHaveBeenCalled()
})

it('shows Checking and disables another check while the first request is pending', async () => {
  const request = await mount(library([]))
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await pressUpdateCheck()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  const checking = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent === 'Checking…')
  expect(checking?.getAttribute('aria-disabled')).toBe('true')
  await act(async () => { finish([]) })
})

const mountUpdateSheet = async (updates?: readonly LibrarySkillUpdate[], origins = [updateOrigin]) => {
  const value = entry('code-review', ['reaches'], {
    copies: origins.map((origin, index) => ({ path: `/home/jane/.runtime-${index}/skills/code-review`, scope: 'user', readBy: [runtimeId('one')], hollow: false, digest: 'same', readOnly: false, origin })),
    ...(updates ? { update: updates } : {}),
  })
  const request = await mount(library([value]))
  await act(async () => cards()[0]!.click())
  return request
}
const updateSheet = () => document.querySelector('[data-slot="skill-sheet"]')!
const reviewUpdate = () => [...updateSheet().querySelectorAll('button')].find(b => b.textContent === 'Review update…')

it('shows the recorded origin once before any check and no update state', async () => {
  await mountUpdateSheet(undefined, [updateOrigin, updateOrigin])
  const text = updateSheet().textContent!
  expect(text.match(/Where it came from/g)).toHaveLength(1)
  expect(text.match(/acme-dev\/skills/g)).toHaveLength(1)
  expect(text).toContain('review/code-review · main, pinned at 1234567')
  expect(text).not.toContain('Update available')
  expect(text).not.toContain('Could not check')
  expect(reviewUpdate()).toBeUndefined()
})

it('shows each distinct recorded origin, and nothing about origins for a local skill', async () => {
  await mountUpdateSheet(undefined, [updateOrigin, { ...updateOrigin, ref: 'stable' }])
  expect(updateSheet().textContent).toContain('main, pinned at 1234567')
  expect(updateSheet().textContent).toContain('stable, pinned at 1234567')
})

it.each(['behind', 'gone', 'unreachable', 'current'] as const)('renders the %s update state in the facts column', async status => {
  await mountUpdateSheet([skillUpdate(status, { reason: 'The source did not answer.' })])
  const sheet = updateSheet()
  if (status === 'behind') {
    expect(sheet.textContent).toContain('Update available')
    expect(sheet.textContent).toContain('1234567 → abcdef1')
    expect(reviewUpdate()).toBeTruthy()
  } else {
    expect(reviewUpdate()).toBeUndefined()
    if (status === 'gone') expect(sheet.textContent).toContain('The branch main no longer exists in acme-dev/skills.')
    if (status === 'unreachable') {
      const quiet = [...sheet.querySelectorAll('*')].find(n => n.textContent === 'Could not check: The source did not answer.')
      expect(quiet).toBeTruthy()
      expect(quiet!.closest('[data-slot="notice"]')).toBeNull()
    }
    if (status === 'current') expect(sheet.textContent).not.toContain('Update available')
  }
})

it('fetches each distinct behind origin once and plans every runtime from the matching dir at the fetched commit', async () => {
  const second = { ...updateOrigin, url: 'https://github.com/acme-dev/other-skills', path: 'review/other' }
  const updates = [skillUpdate('behind'), skillUpdate('behind', { runtime: runtimeId('two'), origin: { ...updateOrigin, commit: 'older-pinned-commit' } }), skillUpdate('behind', { runtime: runtimeId('three'), origin: second }), skillUpdate('current', { runtime: runtimeId('four') })]
  const request = await mountUpdateSheet(updates)
  const original = request.getMockImplementation()!
  request.mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'library/source/fetch') {
      const p = params as typeof updateOrigin
      return { ...p, repo: 'acme-dev/skills', commit: 'fresh-commit', skills: [{ name: 'code-review', dir: 'wrong', bundle: 'wrong' }, { name: 'folder-name-differs', dir: p.path, bundle: `bundle-${p.path}` }], refused: [] }
    }
    return original(method)
  })
  await act(async () => reviewUpdate()!.click())
  expect(request.mock.calls.filter(([m]) => m === 'library/source/fetch')).toEqual([
    ['library/source/fetch', { url: updateOrigin.url, ref: 'main', path: updateOrigin.path }],
    ['library/source/fetch', { url: second.url, ref: 'main', path: second.path }],
  ])
  expect(request).toHaveBeenCalledWith('library/plan', { intents: updates.filter(u => u.status === 'behind').map(u => ({ kind: 'updateSkill', name: 'code-review', targetRuntime: u.runtime, origin: { ...u.origin, commit: 'fresh-commit', bundle: `bundle-${u.origin.path}` } })) })
  expect(updateSheet()).toBeNull()
})

it.each(['missing', 'refused', 'failure'] as const)('keeps a %s fetch in the banner and opens no plan', async result => {
  const request = await mountUpdateSheet([skillUpdate('behind')])
  request.mockImplementationOnce(async () => {
    if (result === 'failure') throw new Error('The repository did not answer.')
    return { ...updateOrigin, commit: 'fresh', skills: [], refused: result === 'refused' ? [{ dir: updateOrigin.path, reason: 'The requested folder contains no skill.' }] : [] }
  })
  await act(async () => reviewUpdate()!.click())
  expect(updateSheet().textContent).toContain(result === 'failure' ? 'The repository did not answer.' : result === 'refused' ? 'The requested folder contains no skill.' : 'No skill was found at review/code-review.')
  expect(request.mock.calls.some(([m]) => m === 'library/plan')).toBe(false)
})

it('keeps Fetching disabled while fetching and clears the update only through the post-apply library read', async () => {
  const request = await mountUpdateSheet([skillUpdate('behind')])
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => reviewUpdate()!.click())
  const fetching = [...updateSheet().querySelectorAll('button')].find(b => b.textContent === 'Fetching…')!
  expect(fetching.disabled).toBe(true)
  const original = request.getMockImplementation()!
  request.mockImplementation(async (method: string) => {
    if (method === 'library/plan') return { plannedAt: 1, ops: [{ id: 'u', kind: 'skill', name: 'code-review', action: 'update', targetPath: '/home/jane/.alpha/skills/code-review', guardDigest: 'same', backup: false, replaceBundle: true }] }
    if (method === 'library/apply') return [{ id: 'u', outcome: 'done' }]
    if (method === 'library/read') return library([entry('code-review', ['reaches'])])
    return original(method)
  })
  await act(async () => finish({ ...updateOrigin, commit: 'fresh', skills: [{ dir: updateOrigin.path, bundle: 'fresh-bundle' }], refused: [] }))
  await act(async () => [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Apply 1 change')!.click())
  expect(request.mock.calls.filter(([m]) => m === 'library/read')).toHaveLength(2)
  expect(cards()[0]?.textContent).not.toContain('Update available')
})

it('a local skill has no source fact or update banner', async () => {
  await mount(library([entry('local-review', ['reaches'])]))
  await act(async () => cards()[0]!.click())
  expect(updateSheet().textContent).not.toContain('Where it came from')
  expect(updateSheet().textContent).not.toContain('Update available')
  expect(reviewUpdate()).toBeUndefined()
})
it('a matching refusal wins over a listed skill and a second-source refusal opens no partial plan', async () => {
  const second = { ...updateOrigin, path: 'review/other' }
  const request = await mountUpdateSheet([skillUpdate('behind'), skillUpdate('behind', { runtime: runtimeId('two'), origin: second })])
  request.mockImplementationOnce(async () => ({ ...updateOrigin, commit: 'fresh', skills: [{ dir: updateOrigin.path, bundle: 'bundle' }], refused: [] }))
  request.mockImplementationOnce(async () => ({ ...second, commit: 'fresh', skills: [{ dir: second.path, bundle: 'bundle' }], refused: [{ dir: second.path, reason: 'The folder was refused.' }] }))
  await act(async () => reviewUpdate()!.click())
  expect(updateSheet().textContent).toContain('The folder was refused.')
  expect(request.mock.calls.some(([m]) => m === 'library/plan')).toBe(false)
})
it('closing a sheet during a fetch cannot open a late plan', async () => {
  const request = await mountUpdateSheet([skillUpdate('behind')])
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => reviewUpdate()!.click())
  await act(async () => updateSheet().querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
  await act(async () => finish({ ...updateOrigin, commit: 'fresh', skills: [{ dir: updateOrigin.path, bundle: 'bundle' }], refused: [] }))
  expect(request.mock.calls.some(([m]) => m === 'library/plan')).toBe(false)
})

it('Rescan during a pending check still refreshes the checked library and reports its result', async () => {
  const request = await mount(library([entry('code-review', ['reaches'])]))
  const original = request.getMockImplementation()!
  let finish!: (value: unknown) => void
  request.mockImplementation(async (method, params) => method === 'library/sources/check' ? new Promise(resolve => { finish = resolve }) : original(method, params))
  await pressUpdateCheck()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  await act(async () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent === 'Rescan')!.click())
  await act(async () => finish([skillUpdate('behind')]))
  expect(request.mock.calls.filter(([m]) => m === 'library/read')).toHaveLength(3)
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: '1 update available' }))
})

it('Rescan cannot suppress a pending check failure', async () => {
  const request = await mount(library([]))
  const original = request.getMockImplementation()!
  let fail!: (error: Error) => void
  request.mockImplementation(async (method, params) => method === 'library/sources/check' ? new Promise((_resolve, reject) => { fail = reject }) : original(method, params))
  await pressUpdateCheck()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.click())
  await act(async () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent === 'Rescan')!.click())
  await act(async () => fail(new Error('The repository did not answer.')))
  expect(container.textContent).toContain('The repository did not answer.')
  expect(toast).not.toHaveBeenCalled()
})


const chooseChip = async (name: string) => {
  const chip = container.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)
  expect(chip).toBeTruthy()
  await act(async () => chip!.click())
}
it('chips count all skills ignoring search and Filter, and narrow together', async () => {
  await mount(library([entry('alpha', ['reaches', 'absent']), entry('beta', ['reaches', 'reaches']),
    entry('paused', ['off', 'reaches']), entry('off', ['off', 'off']), entry('warn', ['rejected', 'reaches'])]))
  await chooseChip('One runtime')
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['alpha', 'paused'])
  expect(await countOf('Everything')).toBe('Everything2')
  expect(await countOf('Never fired')).toBe('Never fired2')
  expect(await countOf('Switched off')).toBe('Switched off1')
  await chooseFilter('Switched off')
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['paused'])
  await typeSearch('alpha')
  expect(container.textContent).toContain('Nothing matches')
  expect(container.querySelector('[aria-label="All"]')?.textContent).toBe('All5')
  expect(container.querySelector('[aria-label="Needs you"]')?.textContent).toBe('Needs you1')
  expect(container.querySelector('[aria-label="One runtime"]')?.textContent).toBe('One runtime2')
  expect(container.querySelector('[aria-label="Nobody"]')?.textContent).toBe('Nobody1')
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Clear the filters')!.click())
  expect(cards()).toHaveLength(5)
  await chooseChip('Nobody')
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['off'])
})
it('keeps banners exclusively under Needs you and cleanup still plans the same copies', async () => {
  const request = await mount(library([partialEntry('empty', ['hollow', 'reaches'], { catalogTokens: 5000 })]))
  expect(container.querySelector('[data-slot="library-attention"]')).toBeNull()
  await chooseChip('Needs you')
  expect(container.textContent).toContain('Empty skill directories')
  expect(container.textContent).toContain('Second Agent skill catalogue')
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Clean up…')!.click())
  expect(request).toHaveBeenCalledWith('library/plan', { intents: [{ kind: 'removeCopy', name: 'empty', path: '/home/u/.claude/skills/empty' }] })
})
it('cards have one finding at most, quiet updates and every runtime state', async () => {
  await mount(library([entry('update', ['reaches', 'reaches'], { update: [skillUpdate('behind')] }),
    entry('warn', ['rejected', 'reaches'], { update: [skillUpdate('behind')] }), entry('plain', ['reaches', 'absent'])]))
  const card = (name: string) => container.querySelector(`[data-slot="skill-card"][aria-label="${name}"]`)!
  expect(card('warn').querySelectorAll('[data-card-finding]')).toHaveLength(1)
  expect(card('warn').textContent).toContain('Refused by First Agent')
  expect(card('warn').textContent).not.toContain('Update available')
  expect(card('update').querySelector('[data-card-finding] [data-tone="warning"]')).toBeNull()
  expect(card('update').textContent).toContain('Update available')
  expect(card('plain').textContent).toContain('No description in its frontmatter')
  expect(card('plain').querySelector('[aria-label="Loaded by 1 of 2 runtimes"]')).toBeTruthy()
  expect([...card('plain').querySelectorAll('[data-runtime-state]')].map(n => n.getAttribute('title'))).toEqual(['First Agent: Reaches', 'Second Agent: Not installed'])
  expect(card('plain').textContent).not.toContain('/plain')
  expect(card('plain').querySelectorAll('button')).toHaveLength(0)
  const descriptions = card('plain').getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)!)
  expect(descriptions.map(node => node.textContent)).toContain('No description in its frontmatter')
  expect(descriptions.find(node => node.getAttribute('role') === 'img')?.getAttribute('aria-label')).toBe('Loaded by 1 of 2 runtimes')
  await act(async () => (card('plain') as HTMLButtonElement).click())
  expect(document.querySelector('[data-slot="skill-sheet"]')).toBeTruthy()
})
it('empty skills and filtered regions render only a short title and their own actions', async () => {
  await mount(library([]))
  expect(container.textContent).toContain('No skills yet')
  expect(container.querySelector('[data-slot="empty-state"] p')).toBeNull()
  expect(container.textContent).not.toContain('A skill is a folder')
  expect([...container.querySelectorAll('button')].map(b => b.textContent)).toContain('From GitHub…')
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'From GitHub…')!.click())
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add from GitHub')
})
it('Needs you with no findings has no empty action', async () => {
  await mount(library([entry('ready', ['reaches', 'reaches'])]))
  await chooseChip('Needs you')
  expect(container.textContent).toContain('Nothing needs you')
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Clear the filters')).toBe(false)
})

it.each([
  { label: 'Empty on disk', expected: ['empty'] },
  { label: 'Copies differ', expected: ['split'] },
  { label: 'Reach some', expected: ['empty', 'one', 'paused'] },
  { label: 'Reach none', expected: ['nobody', 'split'] },
  { label: 'Switched off', expected: ['paused'] },
  { label: 'Never fired', expected: ['empty', 'one', 'paused'] },
])('Filter $label retains its state semantics and count', async ({ label, expected }) => {
  const split = entry('split', ['differs', 'differs'])
  await mount(library([partialEntry('empty', ['hollow', 'reaches']), entry('one', ['reaches', 'absent']),
    entry('paused', ['off', 'reaches']), entry('nobody', ['stale', 'absent']),
    { ...split, copies: [...split.copies, { ...split.copies[0]!, path: '/home/u/.beta/skills/split', digest: 'other' }] }]))
  await openFilter()
  expect(filterRow(label)?.textContent).toBe(`${label}${expected.length}`)
  await act(async () => filterRow(label)!.click())
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(expected)
})
it('Never fired stays disabled with its counting reason until usage arrives', async () => {
  await mount(library([entry('one', ['reaches', 'absent'])]), new Promise(() => {}))
  await openFilter()
  expect(filterRow('Never fired')?.getAttribute('aria-disabled')).toBe('true')
  expect(filterRow('Never fired')?.textContent).toContain('Counting activations in the stored conversations…')
})
it.each([
  { label: 'Write a skill', dialog: 'New skill' },
  { label: 'From GitHub…', dialog: 'Add from GitHub' },
  { label: 'Copy from another runtime…', dialog: 'Import between runtimes' },
])('Add skill opens the existing $dialog flow', async ({ label, dialog }) => {
  await mount(library([]))
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Add skill"]')!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(n => n.textContent === label)!.click())
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(dialog)
})
it('MCP empty copy is a title without a description', async () => {
  await mount(library([]))
  await chooseKind('mcp')
  expect(container.textContent).toContain('No MCP servers yet')
  expect(container.querySelector('[data-slot="empty-state"] p')).toBeNull()
  expect(container.textContent).not.toContain('Nothing was found in any configuration file')
})

it('shows the short skills loading copy and keeps a failed read in ActionError', async () => {
  let fail!: (error: Error) => void
  const read = new Promise<Library>((_resolve, reject) => { fail = reject })
  await mount(library([]), undefined, { read })
  expect(container.querySelector('[data-slot="empty-state"]')?.textContent).toBe('Reading skills…')
  expect(container.textContent).not.toContain('directories…')
  await act(async () => fail(new Error('The library is unavailable.')))
  expect(container.textContent).toContain('The library could not be read: The library is unavailable.')
  expect(container.textContent).not.toContain('Reading skills…')
})

it('the matrix prices the chip-filtered rows and names that scope', async () => {
  await mount(library([entry('ready', ['reaches', 'reaches'], { catalogTokens: 100 }),
    entry('refused', ['rejected', 'reaches'], { catalogTokens: 40 })]))
  await chooseChip('Needs you')
  await showMatrix()
  expect(container.querySelector('tfoot th')?.textContent).toBe('Advertised each turn (these rows)')
  expect([...container.querySelectorAll('tfoot tr:first-child td')].map(node => node.textContent)).toEqual(['—', '≈40 tok'])
})

it('a count with nothing to show is not offered', async () => {
  // A zero-count filter is a row that would empty the list, so it is not
  // offered at all — and the one that is always a way back, "Everything", is.
  await mount(library([entry('good', ['reaches', 'reaches'], { kind: 'mcp' })]))
  await chooseKind('mcp')
  await openFilter()
  const counts = filterRows().map((node) => node.textContent)
  expect(counts.some((text) => text?.startsWith('Empty on disk'))).toBe(false)
  expect(counts.some((text) => text?.startsWith('Problems'))).toBe(false)
  expect(counts.some((text) => text?.startsWith('Everything'))).toBe(true)
})

it('the first body options own search, filter and view; the selected filter can be left', async () => {
  await mount(library([entry('good', ['reaches', 'reaches'], { kind: 'mcp' }), partialEntry('empty', ['hollow', 'absent'], { kind: 'mcp' })]))
  await chooseKind('mcp')
  const options = document.body.querySelector('[data-slot="page-options"]')!
  expect(options.querySelector('[aria-label="Search library"]')).not.toBeNull()
  expect(options.querySelector('[data-slot="popover-trigger"][title="How to show the library"]')).not.toBeNull()
  expect(options.contains(filterTrigger())).toBe(true)
  expect(document.body.querySelector('[data-slot="library-toolbar"]')).toBeNull()
  await openFilter()
  expect(filterRow('Empty on disk')?.textContent).toContain('1')
  await act(async () => filterRow('Empty on disk')?.click())
  expect(filterTrigger().textContent).toBe('Empty on disk')
  expect(cards()).toHaveLength(1)
  await chooseFilter('Everything')
  expect(cards()).toHaveLength(2)
  expect(filterTrigger().textContent).toBe('Everything')
  expect(document.activeElement).toBe(filterTrigger())
})

it('uses one menu trigger form for the view, filter and agent choices', async () => {
  await mount(library([entry('good', ['reaches', 'reaches'], { kind: 'mcp' })]))
  await chooseKind('mcp')
  const options = document.body.querySelector('[data-slot="page-options"]')!
  const triggers = [...options.querySelectorAll<HTMLElement>('[data-slot="popover-trigger"]')]

  expect(triggers.map((trigger) => trigger.getAttribute('title'))).toEqual([
    'Library sections',
    'How to show the library',
    'Filter the library',
    'Declared by',
  ])
  expect(options.querySelectorAll('[data-slot="native-select"]')).toHaveLength(0)
})


it('catalogue Show never fired leaves Needs you and shows unused cards', async () => {
  await mount(library([entry('never', ['reaches', 'reaches'], { catalogTokens: 6000 })]))
  await chooseChip('Needs you')
  expect(cards()).toHaveLength(0)
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Show never fired')!.click())
  expect(container.querySelector('[aria-label="All"]')?.getAttribute('aria-checked')).toBe('true')
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['never'])
})
it('switching from MCP Problems to skills selects Everything', async () => {
  await mount(library([entry('skill', ['reaches', 'reaches']), entry('server', ['absent', 'absent'], { kind: 'mcp' })]))
  await chooseKind('mcp')
  await chooseFilter('Problems')
  await chooseKind('skill')
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['skill'])
  await openFilter()
  expect(filterRow('Everything')?.getAttribute('aria-checked')).toBe('true')
})
it('chip counts include behind and gone updates but not current or unreachable updates', async () => {
  await mount(library((['behind', 'gone', 'current', 'unreachable'] as const).map(status =>
    entry(status, ['reaches', 'reaches'], { update: [skillUpdate(status)] }))))
  expect(container.querySelector('[aria-label="Needs you"]')?.textContent).toBe('Needs you2')
  await chooseChip('Needs you')
  expect(cards().map(card => card.getAttribute('aria-label'))).toEqual(['behind', 'gone'])
})
