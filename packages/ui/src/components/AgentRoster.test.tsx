import { act, useState } from 'react'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { DestinationPageScope } from '../panels/destination-page'
import { installTopBarTestLayout } from '../test/top-bar-layout'
installTopBarTestLayout()
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type RuntimeInfo, type SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentsRosterSection } from './AgentRoster'

/**
 * The Agents catalogue keeps role purpose, observed seats and ceilings distinct.
 * Sources and shadowed copies stay inspectable in precedence order through
 * the shared source disclosure; parse and seating failures stay accessible.
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

const agent = (
  id: string,
  name: string,
  origin: AgentEntry['origin'],
  over: Partial<AgentEntry> = {},
): AgentEntry => ({
  id,
  origin,
  path: origin === 'user' ? `/home/dev/.harnessdesk/agents/${id}/AGENT.md` : `/w/storefront/.harnessdesk/agents/${id}/AGENT.md`,
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
  agent('code-reviewer', 'Storefront reviewer', 'project', {
    shadows: [{ origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md' }],
  }),
  agent('scout', 'Scout', 'user'),
  agent('judge', 'Judge', 'builtin'),
  agent('security-reviewer', 'Security reviewer', 'builtin'),
  agent('draft', 'Draft', 'user', {
    definition: null,
    problems: [{ level: 'error', at: 'permission', text: '"admin" is not a permission — it is read, publish or merge' }],
  }),
]

const taken = (id: string, label: string, runtime = 'runtime-one'): SeatPlan => ({
  id,
  from: 'prefer',
  winner: 0,
  blocked: null,
  ceiling: { level: 'edit', hold: 'asked' },
  candidates: [{ seat: { runtime }, label, runtimeName: label.split(' · ')[0] ?? label, state: 'taken', reason: null, fix: null }],
})

const PLANS = new Map<string, SeatPlan>([
  ['code-reviewer', taken('code-reviewer', 'Claude · Opus 5 · High')],
  ['scout', taken('scout', 'Claude')],
  ['judge', taken('judge', 'Claude')],
  [
    'security-reviewer',
    {
      id: 'security-reviewer',
      from: 'prefer',
      winner: null,
      blocked: null,
      ceiling: null,
      candidates: [
        {
          seat: { runtime: 'cursor' },
          label: 'Cursor',
          runtimeName: 'Cursor',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'cursor' },
        },
      ],
    },
  ],
])

const RosterHarness = ({ focus: supplied, onFocus }: {
  readonly focus?: string | null; readonly onFocus?: (id: string | null) => void
}) => {
  const [own, setOwn] = useState<string | null>(null)
  return <TopBarProvider><DestinationPageScope owner="destination:agents" active>
    <AgentsRosterSection focus={supplied === undefined ? own : supplied} onFocus={id => { setOwn(id); onFocus?.(id) }} />
  </DestinationPageScope><TopBarOutlet owner="destination:agents" fallback={{ place: 'Agents', more: () => null }} /></TopBarProvider>
}

const mount = (over: Partial<AppSnapshot> = {}, storeOver: Record<string, unknown> = {}, selection: { focus?: string | null; onFocus?: (id: string | null) => void } = {}): AppStore => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/home/dev',
    stateDir: '/home/dev/.harnessdesk',
    workspace: { path: '/w/storefront', name: 'storefront', lastOpenedAt: 1 },
    runtimes: [{ id: runtimeId('claude-code'), capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
    agents: ROSTER,
    agentsProject: '/w/storefront',
    agentPlans: PLANS,
    ...over,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    // The overview's unfinished-saves banner: neutral (none) unless a test overrides it.
    authoringPending: vi.fn(async () => []),
    resumeAuthoringSave: vi.fn(async () => ({ token: null, edits: [], issues: [{ at: 'save', text: 'not wired in this test', fix: '' }], resuming: true })),
    discardAuthoringSave: vi.fn(async () => []),
    applyAuthoringSave: vi.fn(async () => ({ state: 'refused', written: [], message: 'not wired in this test' })),
    loadAgents: vi.fn(async () => {}),
    loadSeating: vi.fn(async () => {}),
    readAuthoring: vi.fn(async (target: { readonly id?: string }) => ({
      target,
      source: '---\nname: x\n---\nBrief.\n',
      digest: `digest-${target.id ?? 'x'}`,
      exists: true,
      displayPath: 'AGENT.md',
      writable: true,
      issues: [],
    })),
    ...storeOver,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <RosterHarness {...selection} />
      </StoreProvider>,
    )
  })
  return store
}

const sectionText = (label: string): string =>
  container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? ''

const openSources = () => act(() => {
  const disclosure = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.trim() === 'Sources and precedence')!
  expect(disclosure).toBeDefined()
  if (disclosure.getAttribute('aria-expanded') === 'false') disclosure.click()
})
const catalogueCard = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="agent-card"]')]
  .find(card => card.getAttribute('aria-label') === name)!
const issueReason = (name: string) => catalogueCard(name).querySelector('[data-slot="issue-mark"]')?.getAttribute('aria-label') ?? ''

it('heads the page as the roadmap says', () => {
  mount()
  expect(container.querySelector('[data-topbar-title]')).toBeNull()
  expect(container.querySelector('[data-slot="page-title"]')).toBeNull()
  expect(container.textContent).toContain('Reusable roles for your Teams.')
})

it('lists role sections and disclosed source folders in precedence order', () => {
  mount()
  const headings = [...container.querySelectorAll('section[aria-label]')].map((one) => one.getAttribute('aria-label'))
  expect(headings).toEqual(['Project', 'Yours', 'Built in'])
  expect(container.querySelector('[data-slot="middle-truncate"]')).toBeNull()
  openSources()
  expect([...container.querySelectorAll('section[aria-label^="Sources:"]')].map(one => one.getAttribute('aria-label'))).toEqual(['Sources: Project', 'Sources: Yours', 'Sources: Built in'])
  const projectSource = container.querySelector('section[aria-label="Sources: Project"] [data-slot="middle-truncate"]')!
  expect(projectSource.textContent).toContain('storefront/.harnessdesk/agents')
  expect(projectSource.getAttribute('title')).toBe('/w/storefront/.harnessdesk/agents')
  expect(sectionText('Sources: Yours')).toContain('~/.harnessdesk/agents')
  expect(sectionText('Sources: Built in')).toContain('Ships with HarnessDesk')
})

it('middle-truncates the Yours source path and keeps its full title', async () => {
  mount()
  await act(async () => {})
  openSources()
  const note = container.querySelector<HTMLElement>('section[aria-label="Sources: Yours"] [data-slot="note"]')!
  const path = note.querySelector<HTMLElement>('[data-slot="middle-truncate"]')
  expect(path).not.toBeNull()
  expect(path?.getAttribute('title')).toBe('/home/dev/.harnessdesk/agents')
  expect(path?.textContent).toContain('~/.harnessdesk/agents')
  expect(note.dataset['layout']).toBe('inline')
})

it('shows each Agent with what it is for, its ceiling as asked, and the seat it would take here', () => {
  mount()
  const project = sectionText('Project')
  expect(project).toContain('Storefront reviewer')
  expect(project).toContain('Storefront reviewer does the work.')
  expect(project).toContain('Edit · asked, not enforced')
  expect(catalogueCard('Storefront reviewer').querySelector('[data-ceiling]')?.getAttribute('data-ceiling')).toBe('edit')
  expect(catalogueCard('Storefront reviewer').querySelector('[data-ceiling]')?.getAttribute('data-hold')).toBe('asked')
  expect(project).toContain('Claude · Opus 5 · High')
  // No wire: never the spec, never the digest.
  expect(container.textContent).not.toContain('claude-code')
  expect(container.textContent).not.toContain('=opus')
})

it('uses a seat mark and an Agent name avatar when no seat can be taken', async () => {
  const store = mount()
  const runtime = store.getSnapshot().runtimes[0]!.id
  const reviewer = PLANS.get('code-reviewer')!
  const plans = new Map(PLANS)
  plans.set('code-reviewer', {
    ...reviewer,
    candidates: reviewer.candidates.map(candidate => ({ ...candidate, seat: { ...candidate.seat, runtime } })),
  })
  mount({ agentPlans: plans })
  await act(async () => {})

  const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button[data-kind="record"]')]
    .find((one) => one.textContent?.includes(name))!
  const marked = row('Storefront reviewer').querySelector('[data-slot="agent-card-face"]')!
  expect(marked.querySelector('svg[class*="brand-"]')).not.toBeNull()
  expect(marked.querySelector('svg.lucide-bot')).toBeNull()
  expect(row('Security reviewer').querySelector('[data-slot="agent-card-face"] [data-slot="monogram"]')?.textContent).toBe('SR')
  expect(row('draft').querySelector('[data-slot="agent-card-face"] [data-slot="monogram"]')?.textContent).toBe('D')
})

it('uses the Agent name avatar when a seated runtime has no mark', async () => {
  const id = runtimeId('unbranded-runtime')
  const info = { id, capabilities: {}, presentation: { name: 'General runtime' } } as unknown as RuntimeInfo
  mount({
    runtimes: [info],
    agentPlans: new Map([['code-reviewer', taken('code-reviewer', 'Seat A', id)]]),
  })
  await act(async () => {})
  const face = container.querySelector('section[aria-label="Project"] button[data-kind="record"] [data-slot="agent-card-face"]')!
  expect(face.querySelector('svg')).toBeNull()
  expect(face.querySelector('[data-slot="monogram"]')?.textContent).toBe('SR')
})

it('keeps legacy ceiling sentences out of roster rows and group notes', async () => {
  const release = agent('release', 'Release', 'user')
  const scout = agent('scout', 'Scout', 'user')
  const safety = agent('safety', 'Safety', 'user', {
    definition: { ...agent('safety', 'Safety', 'user').definition!, ceiling: 'publish' },
  })
  const plans = new Map(PLANS)
  plans.set('release', taken('release', 'Seat A'))
  plans.set('safety', { ...taken('safety', 'Seat B'), ceiling: { level: 'publish', hold: 'asked' } })
  mount({
    agents: [release, scout, safety],
    agentPlans: plans,
  })
  await act(async () => {})

  const yours = container.querySelector('section[aria-label="Yours"]')!
  const sentence = "Set by this file's older permission line"
  const rows = [...yours.querySelectorAll<HTMLButtonElement>('button[data-kind="record"]')]
  expect(yours.textContent).not.toContain(sentence)
  expect(rows.every((row) => !row.querySelector('[data-slot="agent-card-description"]')?.textContent?.includes(sentence))).toBe(true)
  expect(rows.map(row => row.querySelector('[data-ceiling]')?.getAttribute('data-ceiling')).filter(Boolean)).toEqual(['edit', 'edit', 'publish'])
  expect(rows.every(row => row.querySelector('[data-ceiling]')?.getAttribute('data-hold') === 'asked')).toBe(true)
  expect(rows.map(row => row.querySelector('[data-ceiling]')?.textContent)).toEqual(['Edit · asked, not enforced', 'Edit · asked, not enforced', 'Publish · asked, not enforced'])
})

it('keeps role purpose separate from a stale winner refusal', async () => {
  const candidate = {
    seat: { runtime: 'runtime-gamma' },
    label: 'Gamma',
    runtimeName: 'Gamma',
    state: 'passed' as const,
    reason: { kind: 'signedOut' as const },
    fix: { kind: 'signIn' as const, runtime: 'runtime-gamma' },
  }
  const plan = PLANS.get('code-reviewer')!
  mount({ agentPlans: new Map([...PLANS, ['code-reviewer', { ...plan, from: 'machine', winner: 0, candidates: [candidate] }]]) })
  await act(async () => {})

  const reviewer = container.querySelector('section[aria-label="Project"] button[data-kind="record"]')!
  const desc = reviewer.querySelector<HTMLElement>('[data-slot="agent-card-description"]')?.textContent ?? ''
  expect(desc).toBe('Storefront reviewer does the work.')
  expect(reviewer.querySelector('[data-slot="agent-card-runtime"]')).toBeNull()
  expect(issueReason('Storefront reviewer')).toBe('Gamma is signed out')
  expect(desc).not.toContain("Set by this file's older permission line")
  expect(reviewer.querySelector('[data-slot="chip"]')?.textContent).toBe("Can't seat here")
})

it('middle-truncates a project Agents folder in its quiet source note', async () => {
  mount()
  await act(async () => {})
  openSources()
  const note = container.querySelector('section[aria-label="Sources: Project"] [data-slot="middle-truncate"]')
  expect(note).not.toBeNull()
  expect(note?.textContent).toContain('storefront/.harnessdesk/agents')
  expect(note?.getAttribute('title')).toBe('/w/storefront/.harnessdesk/agents')
  expect(note?.className).not.toContain('flex-1')
  expect(note?.closest('[data-slot="note"]')?.getAttribute('data-layout')).toBe('inline')
})

/** A refusal is the row’s one reading; the ceiling is not repeated beside it. */
it('a refused Agent has one warning reading instead of a second ceiling chip', () => {
  mount()
  const row = [...container.querySelectorAll('button')].find(one => one.textContent?.includes('Security reviewer'))!
  expect(row.querySelectorAll('[data-slot="chip"]')).toHaveLength(1)
  expect(row.querySelector('[data-slot="chip"]')?.getAttribute('data-tone')).toBe('warning')
  expect(row.querySelector('[data-ceiling]')).toBeNull()
})

it('keeps a refused Agent with its first reason accessible', () => {
  mount()
  expect(sectionText('Built in')).toContain("Can't seat here")
  expect(issueReason('Security reviewer')).toBe('Cursor is signed out')
  // Said in the warning tone: the person has to act before it can seat here.
  const refusal = [...container.querySelectorAll('section[aria-label="Built in"] [data-slot="chip"][data-tone="warning"]')]
    .find((one) => one.textContent?.startsWith("Can't seat here"))
  expect(refusal).toBeDefined()
})

it('discloses a shadowed copy under its source with a value and explanatory sentence', () => {
  mount()
  expect(container.textContent).not.toContain('Shadowed')
  openSources()
  const row = [...container.querySelectorAll('section[aria-label="Sources: Built in"] [data-slot="row"]')]
    .find((one) => one.textContent?.includes('Shadowed by the project copy'))!
  const chip = row.querySelector<HTMLElement>('[data-slot="row-ctl"] [data-slot="chip"]')
  expect(row.textContent).toContain('Shadowed by the project copy. This copy is not used.')
  expect(chip?.textContent).toBe('Shadowed')
  expect(chip?.getAttribute('data-tone')).toBe('neutral')
})

it('lists a file that will not parse, with why', () => {
  mount()
  expect(issueReason('draft')).toContain('permission — "admin" is not a permission')
  expect(catalogueCard('draft').querySelector('[data-slot="agent-card-description"]')?.textContent).toBe('Open this Agent to inspect its file.')
  expect(sectionText('Yours')).toContain('Will not parse')
})

it('says a row could not be checked, rather than "Checking seats…" forever, once the dry run has failed', () => {
  mount({ agentPlans: new Map(), agentPlansFailed: true })
  expect(sectionText('Project')).toContain('Seats not checked')
  expect(catalogueCard('Storefront reviewer').querySelector('[data-ceiling]')).toBeNull()
  expect(sectionText('Project')).not.toContain('Checking seats')
})

it('says "Checking seats…" only while a plan is still pending, not after a failure', () => {
  mount({ agentPlans: new Map(), agentPlansFailed: false })
  expect(sectionText('Project')).toContain('Checking seats…')
})

it('flags an Agent still on permission: or on no ceiling, and draws the seat’s ceiling as the chip', () => {
  const said = (id: string, name: string, origin: AgentEntry['origin'], ceilingFrom: 'ceiling' | 'permission' | 'none') =>
    agent(id, name, origin, {
      definition: {
        id,
        name,
        description: `${name} does the work.`,
        ceiling: ceilingFrom === 'none' ? 'read' : 'edit',
        ceilingFrom,
        answers: [],
        produces: [],
        skills: [],
        mcp: [],
        prefer: [{ runtime: 'claude-code' }],
        brief: 'Work.',
      },
    })
  mount({
    agents: [
      said('code-reviewer', 'Storefront reviewer', 'project', 'permission'),
      said('scout', 'Scout', 'user', 'none'),
      said('tidy', 'Tidy', 'user', 'ceiling'),
    ],
  })
  expect(sectionText('Project')).toContain('Storefront reviewer does the work.')
  expect(sectionText('Project')).not.toContain("Set by this file's older permission line")
  expect(sectionText('Yours')).toContain('Scout does the work.')
  expect(sectionText('Yours')).not.toContain('No ceiling written, so it runs as read.')
  expect(sectionText('Yours')).toContain('Tidy does the work.')
  expect(sectionText('Yours')).not.toContain("Tidy does the work. Set by")
  expect(sectionText('Yours')).not.toContain('Tidy does the work. No ceiling')
  const chip = container.querySelector('section[aria-label="Project"] [data-ceiling]')
  expect(chip?.getAttribute('data-hold')).toBe('asked')
  // Asked is the ordinary ceiling state, so the shared chip stays neutral.
  expect(chip?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
  expect(sectionText('Yours')).toContain('Edit')
})

it('an unfinished save from a restart offers Resume or Discard, never resuming on its own', async () => {
  const store = mount({}, {
    authoringPending: vi.fn(async () => [
      { id: 'save-1', scope: 'user', root: null, files: ['agents/scout/AGENT.md'], written: [], message: 'This save stopped before any file was known to be written. Resume to check each file and write what is missing.' },
    ]),
    resumeAuthoringSave: vi.fn(async () => ({ token: 'tok-resume', edits: [{ path: 'agents/scout/AGENT.md', before: 'a', after: 'b' }], issues: [], resuming: true })),
  })
  await act(async () => {})

  expect(sectionText('Unfinished saves')).toContain('This save stopped before any file was known to be written')
  expect(store.resumeAuthoringSave).not.toHaveBeenCalled()
  expect(store.applyAuthoringSave).not.toHaveBeenCalled()

  const resumeButton = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Resume')
  await act(async () => {
    resumeButton?.click()
  })

  expect(store.resumeAuthoringSave).toHaveBeenCalledWith('save-1')
  expect(store.applyAuthoringSave).toHaveBeenCalledWith('tok-resume')
})

it('discarding an unfinished save drops its record and writes nothing', async () => {
  const store = mount({}, {
    authoringPending: vi.fn(async () => [
      { id: 'save-2', scope: 'project', root: '/w/storefront', files: ['agents/code-reviewer/AGENT.md'], written: [], message: 'An earlier save did not finish.' },
    ]),
  })
  await act(async () => {})

  const discardButton = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Discard')
  await act(async () => {
    discardButton?.click()
  })

  expect(store.discardAuthoringSave).toHaveBeenCalledWith('save-2')
  expect(store.resumeAuthoringSave).not.toHaveBeenCalled()
  expect(store.applyAuthoringSave).not.toHaveBeenCalled()
})

it('an unfinished save is titled by where it is, not by its own sentence, names the project, and shows no raw file path', async () => {
  mount({}, {
    authoringPending: vi.fn(async () => [
      { id: 'save-1', scope: 'user', root: null, files: ['agents/scout/AGENT.md'], written: [], message: 'This save stopped before any file was known to be written. Resume to check each file and write what is missing.' },
      { id: 'save-2', scope: 'project', root: '/w/storefront', files: ['agents/code-reviewer/AGENT.md'], written: [], message: 'An earlier save did not finish.' },
    ]),
  })
  await act(async () => {})

  const titles = [...container.querySelectorAll('section[aria-label="Unfinished saves"] [class*="_rowTitle_"]')]
    .map((one) => one.textContent?.trim())

  // A title is a short place, never the sentence that belongs on the line
  // under it, and a project-scoped save names the project by name.
  expect(titles).not.toContain('This save stopped before any file was known to be written. Resume to check each file and write what is missing.')
  expect(titles).not.toContain('An earlier save did not finish.')
  expect(titles.some((title) => title?.includes('storefront'))).toBe(true)

  // The sentence itself is still readable, on the second line — never the raw path instead.
  expect(sectionText('Unfinished saves')).toContain('This save stopped before any file was known to be written')
  expect(sectionText('Unfinished saves')).not.toContain('agents/scout/AGENT.md')
  expect(sectionText('Unfinished saves')).not.toContain('agents/code-reviewer/AGENT.md')
})

it('gives each card a purpose, separate runtime metadata, and one ceiling or refusal state', async () => {
  mount()
  await act(async () => {})
  const reviewer = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('Storefront reviewer'))!
  expect(reviewer.querySelector('[data-slot="agent-card-face"]')).not.toBeNull()
  expect(reviewer.querySelector('[data-slot="agent-card-description"]')?.textContent).toBe('Storefront reviewer does the work.')
  expect(reviewer.querySelector('[data-slot="agent-card-runtime"]')?.textContent).toBe('Claude · Opus 5 · High')
  expect(reviewer.querySelectorAll('[data-slot="chip"]')).toHaveLength(1)
  expect(reviewer.querySelector('[data-ceiling]')?.getAttribute('data-ceiling')).toBe('edit')
  expect(reviewer.querySelector('[data-ceiling]')?.getAttribute('data-hold')).toBe('asked')
  expect(reviewer.querySelector('[data-slot="chip"]')?.textContent).toBe('Edit · asked, not enforced')
  const refused = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('Security reviewer'))!
  expect(refused.querySelectorAll('[data-slot="chip"]')).toHaveLength(1)
  expect(refused.querySelector('[data-slot="chip"]')?.textContent).toBe("Can't seat here")
  expect(refused.querySelector('[data-slot="agent-card-description"]')?.textContent).toBe('Security reviewer does the work.')
  expect(issueReason('Security reviewer')).toBe('Cursor is signed out')
})

it('names the linked checkout that was actually read rather than the main checkout', async () => {
  mount({ agentsProject: '/w/review-copy', workspace: { path: '/w/review-copy', checkoutRoot: '/w/review-copy', name: 'storefront', lastOpenedAt: 1, repo: { root: '/w/main', worktree: true, key: 'root:/w/main' } } as AppSnapshot['workspace'] })
  await act(async () => {})
  openSources()
  const source = container.querySelector('section[aria-label="Sources: Project"] [data-slot="middle-truncate"]')!
  expect(source.getAttribute('title')).toBe('/w/review-copy/.harnessdesk/agents')
  expect(source.textContent).toContain('review-copy/.harnessdesk/agents')
  expect(source.getAttribute('title')).not.toContain('/w/main/.harnessdesk/agents')
})

it('names no folder for a roster still read for the workspace open before', () => {
  // The workspace changed and its own roster has not arrived (or failed): these rows came from /w/old.
  mount({ agentsProject: '/w/old', workspace: { path: '/w/storefront', checkoutRoot: '/w/storefront', name: 'storefront', lastOpenedAt: 1 } as AppSnapshot['workspace'] })
  openSources()
  expect(sectionText('Sources: Project')).toContain('Read from the Agents folder, and committed with the code')
  expect(container.textContent).not.toContain('/w/storefront/.harnessdesk/agents')
  expect(container.textContent).not.toContain('undefined')
})

it('the supplied Agent route is authoritative and its parent records the list route', () => {
  const onFocus = vi.fn()
  mount({}, { readAgentAttachments: vi.fn(async () => ({ declarations: [], support: [] })), readAgentNotes: vi.fn(async () => ({ text: null })) }, { focus: ROSTER[0]!.id, onFocus })
  const parent = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Back to Agents')
  expect(parent).toBeTruthy()
  act(() => parent!.click())
  expect(onFocus).toHaveBeenCalledWith(null)
  mount({}, {}, { focus: null, onFocus })
  expect(container.textContent).toContain('Reusable roles for your Teams.')
})


const setSearch = (value: string) => act(() => {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search Agents"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const setOrigin = (value: string) => act(() => {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent origin"]')!
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
})
const catalogueNames = () => [...container.querySelectorAll('[data-slot="agent-card-title"]')].map(node => node.textContent)

it('searches role purpose and observed seat metadata within the chosen source and keeps exact detail identity', () => {
  const onFocus = vi.fn()
  mount({}, {}, { focus: null, onFocus })
  expect(container.querySelector('input[aria-label="Search Agents"]')).not.toBeNull()
  expect(container.querySelector('select[aria-label="Agent origin"]')).not.toBeNull()
  setSearch('Opus 5')
  expect(catalogueNames()).toEqual(['Storefront reviewer'])
  setOrigin('user')
  expect(catalogueNames()).toEqual([])
  expect(container.textContent).toContain('No matching Agents')
  setSearch('scout does')
  expect(catalogueNames()).toEqual(['Scout'])
  act(() => container.querySelector<HTMLButtonElement>('[data-slot="agent-card"]')!.click())
  expect(onFocus).toHaveBeenCalledWith('scout')
})

it('separates a role purpose from its observed runtime and keeps an unchecked plan unknown', () => {
  mount()
  const card = container.querySelector('[data-slot="agent-card"]')!
  expect(card.querySelector('[data-slot="agent-card-description"]')?.textContent).toBe('Storefront reviewer does the work.')
  expect(card.querySelector('[data-slot="agent-card-runtime"]')?.textContent).toBe('Claude · Opus 5 · High')
  mount({ agentPlans: new Map() })
  const unknown = container.querySelector('[data-slot="agent-card"]')!
  expect(unknown.textContent).toContain('Checking seats…')
  expect(unknown.querySelector('[data-ceiling]')).toBeNull()
  expect(unknown.textContent).not.toContain('Ready')
})

it('keeps refusal explanations accessible without making long runtime errors the card purpose', () => {
  const detail = 'A runtime connection could not be opened. '.repeat(40)
  const plan = PLANS.get('security-reviewer')!
  mount({ agentPlans: new Map([...PLANS, ['security-reviewer', { ...plan, candidates: plan.candidates.map(one => ({ ...one, reason: { kind: 'unavailable' as const, detail } })) }]]) })
  const refused = [...container.querySelectorAll('[data-slot="agent-card"]')].find(one => one.textContent?.includes('Security reviewer'))!
  expect(refused.querySelector('[data-slot="agent-card-description"]')?.textContent).toBe('Security reviewer does the work.')
  expect(refused.querySelector('[data-slot="issue-mark"]')?.getAttribute('aria-label')).toContain(detail)
  expect(refused.querySelector('[data-ceiling]')).toBeNull()
})

it('keeps project identities out of catalogue headings and discloses sources and shadowed copies on request', () => {
  mount({ agentsProject: '/w/123e4567-e89b-12d3-a456-426614174000', workspace: { path: '/w/123e4567-e89b-12d3-a456-426614174000', name: '123e4567-e89b-12d3-a456-426614174000', lastOpenedAt: 1 } as AppSnapshot['workspace'] })
  expect(container.querySelector('section[aria-label="Project"]')).not.toBeNull()
  const disclosure = container.querySelector<HTMLButtonElement>('[data-slot="agent-catalogue-sources"] button')!
  expect(disclosure?.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('/w/123e4567-e89b-12d3-a456-426614174000/.harnessdesk/agents')
  act(() => disclosure.click())
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  expect(container.querySelector('[title="/w/123e4567-e89b-12d3-a456-426614174000/.harnessdesk/agents"]')).not.toBeNull()
  expect(container.textContent).toContain('Shadowed')
})
