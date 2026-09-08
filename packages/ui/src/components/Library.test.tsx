import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'
import type { Library, LibraryEntry, LibraryUsage, ReachState, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { LibrarySection } from './Library'

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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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

const mount = async (
  value: Library,
  usage?: LibraryUsage,
  options: {
    audit?: readonly Record<string, unknown>[]
    initialFlow?: 'import' | null
    runtimes?: readonly RuntimeInfo[]
    /** What `library/definition` answers — null is the host's ordinary miss. */
    definition?: unknown
    /** Stands in for the store verb, so a toggle's arguments can be read. */
    setSkillEnabled?: (...args: unknown[]) => Promise<void>
  } = {},
): Promise<ReturnType<typeof vi.fn>> => {
  // Method-aware: the page asks for the library, then usage, then its own
  // history; answering everything with the library was one `undefined.skills`
  // from a crash.
  const request = vi.fn(async (method: string) =>
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
            : value,
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
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <LibrarySection initialFlow={options.initialFlow ?? null} />
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
 * by the toggle's own accessible name rather than by position, so a third
 * view added later cannot silently re-point these at the wrong one.
 */
const showMatrix = async (): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === 'Show every entry against every agent',
  )
  expect(button, 'the view switch should offer the matrix').toBeTruthy()
  await act(async () => button?.click())
}

const cellNames = (): readonly string[] =>
  [...container.querySelectorAll('[role="img"]')].map(
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
  const headers = [...container.querySelectorAll('th[scope="col"]')].map((node) => node.textContent)
  expect(headers).toEqual(['Name', 'First Agent', 'Second Agent'])
})

it('draws a hollow directory as its own state, not as missing', async () => {
  await mount(library([entry('browse', ['hollow', 'absent'])]))
  await showMatrix()
  expect(cellNames()).toContain('browse — First Agent: Empty')
})

it('a count filters the table down to what it counted', async () => {
  await mount(
    library([
      entry('good', ['reaches', 'reaches']),
      entry('empty', ['hollow', 'absent']),
    ]),
  )
  await showMatrix()
  expect(container.textContent).toContain('good')
  expect(container.textContent).toContain('empty')

  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('empty on disk'),
  )
  expect(button, 'the summary strip should offer the hollow count').toBeTruthy()
  await act(async () => button?.click())

  const rows = [...container.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
  expect(rows).toEqual(['empty'])
})

it('only-problems means defects and strandings, never mere non-reach', async () => {
  // On a real machine `unscanned` is the most common state there is. A filter
  // that treats it as a problem keeps every row, and a switch that changes
  // nothing teaches people to stop pressing it.
  await mount(
    library([
      entry('quiet', ['reaches', 'unscanned']),
      entry('empty', ['hollow', 'absent']),
      entry('stranded', ['unscanned', 'unscanned']),
    ]),
  )
  await showMatrix()
  const toggle = container.querySelector('[role="switch"]') as HTMLElement | null
  expect(toggle, 'the problems switch should render').toBeTruthy()
  await act(async () => toggle?.click())
  const rows = [...container.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
  expect(rows).toEqual(['empty', 'stranded'])
})

it('a count with nothing to show cannot be pressed', async () => {
  await mount(library([entry('good', ['reaches', 'reaches'])]))
  const button = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('empty on disk'),
  )
  expect((button as HTMLButtonElement | undefined)?.disabled).toBe(true)
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
  const disclosure = container.querySelector('[aria-expanded]') as HTMLButtonElement | null
  expect(disclosure).toBeTruthy()
  await act(async () => disclosure?.click())
  // With the tilde, because that is how the path is written everywhere else
  // it appears — in a shell, in the agent's own config, in its documentation.
  // Spelled out, four copies of one skill are four lines whose differing part
  // begins past the fold.
  expect(container.textContent).toContain('~/.agents/skills/alpha')
  expect(container.textContent).not.toContain('/home/u/.agents')
  expect(container.textContent).toContain('No agent reads this directory.')
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
  expect(container.textContent).toContain('Second Agent')
  expect(container.textContent).toContain('read from disk')
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
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <LibrarySection />
      </StoreProvider>,
    )
  })
  expect(container.textContent).toContain('the host said no')
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
  const tile = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('never fired'),
  )
  expect(tile, 'the never-fired tile should render once usage arrives').toBeTruthy()
  await act(async () => tile?.click())
  const rows = [...container.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
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
  const cells = [...container.querySelectorAll('tfoot tr:first-child td')].map(
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
  const tile = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('never fired'),
  )
  await act(async () => tile?.click())
  const rows = [...container.querySelectorAll('tbody th[scope="row"]')].map((node) => node.textContent)
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
  const fired = [...container.querySelectorAll('tfoot tr:last-child td')].map((node) => node.textContent)
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
  const disclosure = container.querySelector('[aria-expanded]') as HTMLButtonElement | null
  await act(async () => disclosure?.click())
  expect(container.textContent).toContain('2× First Agent')
  expect(container.textContent).toContain('3× under earlier registrations')
})

it('the drawer offers to install where the entry does not reach', async () => {
  // The row is the unit of management: an absent cell is one click from an
  // install, and the click opens a preview rather than doing anything.
  const request = await mount(library([entry('alpha', ['reaches', 'absent'])]))
  await showMatrix()
  await act(async () => {
    ;[...container.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('alpha'))
      ?.click()
  })
  const install = [...container.querySelectorAll('button')].find((one) =>
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
    library([entry('good', ['reaches', 'reaches']), entry('ghost', ['hollow', 'absent'])]),
  )
  expect(container.textContent).toContain('1 directory holds a skill’s name and no definition')
  await act(async () => {
    ;[...container.querySelectorAll('button')]
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
    ;[...container.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('dup'))
      ?.click()
  })
  const chips = [...container.querySelectorAll('[title*="scan order"]')].map(
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
  expect(container.textContent).toContain('Import between agents')
  expect(container.textContent).toContain('Nothing changes until a preview is confirmed')
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
    ;[...container.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('dup'))
      ?.click()
  })
  const labels = [...container.querySelectorAll('button')].map((one) => one.textContent ?? '')
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
    ...(container
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
  const preview = [...container.querySelectorAll('button')].find((one) =>
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

it('history shows what changed from here, and a kept backup can be restored', async () => {
  const audit = [
    {
      at: 1724800000000,
      runtime: runtimeId('one'),
      sessionId: 's',
      kind: 'library/write',
      op: 'skill/replace',
      name: 'alpha',
      path: '/home/u/.claude/skills/alpha',
      status: 'done',
      backupPath: '/hd/library/backups/2026-alpha',
    },
    {
      at: 1724800001000,
      runtime: runtimeId('one'),
      sessionId: 's',
      kind: 'library/write',
      op: 'mcp/create',
      name: 'fetcher',
      path: '/home/u/.claude.json',
      status: 'failed',
      detail: 'No write permission',
    },
    // The rest of the audit log is other work; the page only owns its own.
    { at: 1724800002000, runtime: runtimeId('one'), sessionId: 's', kind: 'turn' },
  ]
  const request = await mount(library([entry('alpha', ['reaches', 'reaches'])]), undefined, {
    audit,
  })
  expect(container.textContent).toContain('Changes made from here')
  expect(container.textContent).toContain('Replaced a copy of alpha')
  // Newest on top: the log appends oldest-first, the page reads it back.
  expect(container.textContent?.indexOf('fetcher')).toBeLessThan(
    container.textContent?.indexOf('Replaced a copy of alpha') ?? -1,
  )
  // A failure reads as a sentence, verb in the infinitive, reason attached.
  expect(container.textContent).toContain('Failed to add fetcher — No write permission')
  const restore = [...container.querySelectorAll('button')].find(
    (one) => one.textContent === 'Restore\u2026',
  )
  expect(restore).toBeTruthy()
  await act(async () => restore?.click())
  const planned = request.mock.calls.find((one) => one[0] === 'library/plan')
  expect((planned?.[1] as { intents: unknown[] }).intents).toEqual([
    {
      kind: 'restoreCopy',
      name: 'alpha',
      backupPath: '/hd/library/backups/2026-alpha',
      targetPath: '/home/u/.claude/skills/alpha',
    },
  ])
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
    await act(async () => {
      ;[...container.querySelectorAll('button')]
        .find((one) => one.textContent?.startsWith('MCP servers'))
        ?.click()
    })
    await act(async () => {
      ;[...container.querySelectorAll('button')]
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
    [...container.querySelectorAll('button')].filter((one) =>
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

it('ten agents collapse the drawer offers into one previewed plan', async () => {
  // One button per agent is fine at four and a keyboard row at ten. Past
  // three targets, one button previews a plan with an op per agent — every
  // target still named, apply still per-op.
  const ids = ['one', 'two', 'three', 'four', 'five', 'six']
  const wide: LibraryEntry = {
    kind: 'skill',
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
    locations: ids.map((id) => skillLocation(id)),
    entries: [wide],
    gaps: [],
  }
  const request = await mount(value, undefined, {
    runtimes: ids.map((id, index) => runtime(id, `Agent ${index + 1}`)),
  })
  await showMatrix()
  await act(async () => {
    ;[...container.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('alpha'))
      ?.click()
  })
  const labels = [...container.querySelectorAll('button')].map((one) => one.textContent ?? '')
  expect(labels.some((label) => label === 'Install to Agent 2')).toBe(false)
  const all = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Install to all 5 missing'),
  )
  expect(all).toBeTruthy()
  await act(async () => all?.click())
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
  expect(container.textContent).toContain(
    '3 columns are read from disk rather than from their agents',
  )
  // The fold hides nothing: each agent's own sentence is still there to open.
  expect(container.querySelector('details')).toBeTruthy()
  expect(container.textContent).toContain('A second reason.')
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
    ;[...container.querySelectorAll('button')]
      .find((one) => one.textContent?.includes('alpha'))
      ?.click()
  })
  const offer = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Install to Second Agent'),
  )
  expect(offer).toBeUndefined()
})

/* ——— the list, which is what the page now opens on ————————————————— */

const cards = (): readonly HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-slot="skill-row"]'),
]

it('opens on a list, one row per entry, each carrying what the thing is for', async () => {
  // The redesign's whole claim: the description is content, not a subtitle
  // on a row of dots. If a card cannot say what its skill does, nothing has
  // been fixed.
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

it('writes a skill’s name as the command that fires it', async () => {
  // Both reference apps do this and it is not decoration: the on-disk
  // identity and the invocation are different strings, and a page showing
  // only the first leaves the second to guesswork.
  await mount(library([entry('brainstorming', ['reaches', 'reaches'])]))
  expect(cards()[0]?.textContent).toContain('/brainstorming')
})

it('a row says who loads it without a table, and names each state for readers', async () => {
  await mount(library([entry('alpha', ['reaches', 'unscanned'])]))
  const faces = [...container.querySelectorAll('[data-slot="skill-reach"]')].map((node) => ({
    state: node.getAttribute('data-state'),
    label: node.getAttribute('aria-label'),
  }))
  expect(faces).toEqual([
    { state: 'reaches', label: 'First Agent: Loads it' },
    {
      state: 'unscanned',
      label: 'Second Agent: Installed where this agent does not look',
    },
  ])
})

it('a row’s finding names the defect, never the symptom it causes', async () => {
  // The bug this pins: `hollow` and `differs` both mean nothing reaches, so
  // a "reaches nobody first" rule captioned an empty directory and a pair of
  // divergent copies with the same four words — burying the cause under a
  // symptom the reader can do nothing with.
  await mount(
    library([
      entry('empty', ['hollow', 'absent'], {
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
  expect(cards()[0]?.textContent).toContain('Where no agent looks')
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
  expect(container.textContent).toContain('No skills on this machine yet')
  const write = [...container.querySelectorAll('button')].find((one) =>
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
  expect(cards()[0]?.textContent).toContain('Switched off')
  expect(cards()[0]?.textContent).not.toContain('Loaded by nobody')
})

it('the switched-off chip isolates exactly the entries with a switch down', async () => {
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
  const chip = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('switched off'),
  )
  expect(chip, 'the chip row should offer the switched-off count').toBeTruthy()
  await act(async () => chip?.click())
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
  const box = container.querySelector(
    'input[aria-label="Filter the library by name"]',
  ) as HTMLInputElement | null
  expect(box, 'the page should have a search box').toBeTruthy()
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(box, text)
    box?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const chipNamed = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('[data-slot="library-count"]')].find((node) =>
    node.textContent?.includes(label),
  ) as HTMLButtonElement | undefined

it('a count counts what pressing it will show, search included', async () => {
  await mount(
    library([
      entry('alpha', ['absent', 'absent']),
      entry('beta', ['absent', 'absent']),
      entry('gamma', ['reaches', 'reaches']),
    ]),
  )
  // Two reach nobody, and that is the honest number for the whole library.
  expect(chipNamed('reach none')?.textContent).toContain('2')

  // Narrow to one of them. The chip used to keep saying 2 — and pressing it,
  // which is the only thing a chip does, left an empty page.
  await typeSearch('alpha')
  expect(chipNamed('reach none')?.textContent).toContain('1')
  expect(chipNamed('in all')?.textContent).toContain('1')
  await act(async () => chipNamed('reach none')?.click())
  expect(cards().length).toBe(1)
  expect(cards()[0]?.textContent).toContain('alpha')

  // Release it, and a search that leaves nothing in that state disables the
  // chip rather than offering a press that would empty the list.
  await act(async () => chipNamed('reach none')?.click())
  await typeSearch('gamma')
  expect(chipNamed('reach none')?.textContent).toContain('0')
  expect(chipNamed('reach none')?.disabled).toBe(true)
})

it('an empty list blames whichever of the two narrowings actually emptied it', async () => {
  await mount(
    library([entry('alpha', ['reaches', 'absent']), entry('beta', ['reaches', 'reaches'])]),
  )
  // One entry reaches some, so the chip is pressable. Then search for the
  // *other* one: the search matched something, and the filter is what left
  // the page empty.
  await act(async () => chipNamed('reach some')?.click())
  await typeSearch('beta')
  expect(container.textContent).toContain('Nothing matches')
  expect(container.textContent).toContain('1 entry matches “beta”')
  // Not “No skill here is called beta” — there is one, and the state filter
  // is what is holding it back.
  expect(container.textContent).not.toContain('No skill here is called')
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
  const legend = container.querySelector('[data-slot="library-legend"]')
  expect(legend, 'the matrix should carry a visible key').toBeTruthy()
  expect(legend?.textContent).toContain('Reaches')
  expect(legend?.textContent).toContain('Not read')
  // Only what is on screen: a key explaining five absent states is furniture.
  expect(legend?.textContent).not.toContain('Cannot host')
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
  expect(cards()[0]?.textContent).toContain('Not read yet by Second Agent')
  // Quietly — the problems filter is for defects, and this is not one.
  await act(async () => {
    const only = container.querySelector('[role="switch"]') as HTMLElement | null
    only?.click()
  })
  expect(container.textContent).toContain('Nothing matches')
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
  expect(sheet?.textContent).toContain('This agent read the definition and would not load it')
  // Its reason, verbatim. We did not decide this and must not paraphrase a
  // loader rule we have not measured.
  expect(sheet?.textContent).toContain('missing field `description`')
  // And a word before the obvious next click, which would copy a definition
  // one agent has already refused into another.
  expect(sheet?.textContent).toContain('First Agent would not load this one.')
})
