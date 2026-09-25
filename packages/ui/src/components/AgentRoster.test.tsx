import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, type AgentEntry, type RuntimeInfo, type SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentsRosterSection } from './AgentRoster'

/**
 * The Agents window's overview: three sections in precedence order, each
 * footnoted with the folder it reads, a row per Agent with its ceiling and
 * seat, and nothing hidden — a shadowed copy and a file that will not parse
 * are both listed, with why.
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
  path: origin === 'user' ? `/Users/dev/.harnessdesk/agents/${id}/AGENT.md` : `/w/storefront/.harnessdesk/agents/${id}/AGENT.md`,
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

const taken = (id: string, label: string): SeatPlan => ({
  id,
  from: 'prefer',
  winner: 0,
  blocked: null,
  ceiling: { level: 'edit', hold: 'asked' },
  candidates: [{ seat: { runtime: 'claude-code' }, label, runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
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

const mount = (over: Partial<AppSnapshot> = {}, storeOver: Record<string, unknown> = {}): AppStore => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
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
        <AgentsRosterSection />
      </StoreProvider>,
    )
  })
  return store
}

const sectionText = (label: string): string =>
  container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? ''

it('heads the page as the roadmap says', () => {
  mount()
  expect(container.querySelector('[data-slot="page-title"]')?.textContent).toBe('Agents')
  expect(container.textContent).toContain('Who does the work: a brief, the most it may do, and the seats it prefers.')
})

it('lists three sections in precedence order, each naming the folder it reads', () => {
  mount()
  const headings = [...container.querySelectorAll('section[aria-label]')].map((one) => one.getAttribute('aria-label'))
  expect(headings).toEqual(['In storefront', 'Yours', 'Built in'])
  expect(sectionText('In storefront')).toContain('/w/storefront/.harnessdesk/agents')
  expect(sectionText('Yours')).toContain('~/.harnessdesk/agents')
  expect(sectionText('Built in')).toContain('Ships with HarnessDesk')
})

it('shows each Agent with what it is for, its ceiling as asked, and the seat it would take here', () => {
  mount()
  const project = sectionText('In storefront')
  expect(project).toContain('Storefront reviewer')
  expect(project).toContain('Storefront reviewer does the work.')
  expect(project).toContain('Edit')
  expect(project).toContain('Claude · Opus 5 · High')
  // No wire: never the spec, never the digest.
  expect(container.textContent).not.toContain('claude-code')
  expect(container.textContent).not.toContain('=opus')
})

/**
 * `security-reviewer`'s plan has no seat (every candidate passed on it), so
 * `plan.ceiling` is `null` — the same branch a runtime with no computed plan
 * at all falls into. It used to fall out of `CeilingChip` entirely there,
 * into a bare, unstyled ceiling word ("Edit") with no "asked"/"held" and no
 * chip around it, the one row in the roster that did not read like the
 * others (#898).
 */
it('draws every Agent’s ceiling through the same chip, held plan or none', () => {
  mount()
  const built = sectionText('Built in')
  expect(built).toContain('Edit · asked')
  const row = [...container.querySelectorAll('button')].find((one) =>
    one.textContent?.includes('Security reviewer'),
  )
  const chip = row?.querySelector('[data-ceiling]')
  expect(chip?.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('neutral')
})

it('keeps an Agent that cannot be seated here, with the first reason on screen', () => {
  mount()
  expect(sectionText('Built in')).toContain("Can't seat here · Cursor is signed out")
})

it('lists a shadowed copy where it lives, in the Plugins-superseded idiom — a chip and a sentence', () => {
  mount()
  const text = sectionText('Built in')
  expect(text).toContain('Shadowed')
  expect(text).toContain('Shadowed by the one in storefront')
})

it('lists a file that will not parse, with why', () => {
  mount()
  expect(sectionText('Yours')).toContain('permission — "admin" is not a permission')
  expect(sectionText('Yours')).toContain('Will not parse')
})

it('says a row could not be checked, rather than "Checking seats…" forever, once the dry run has failed', () => {
  mount({ agentPlans: new Map(), agentPlansFailed: true })
  expect(sectionText('In storefront')).toContain('Its seats could not be checked')
  expect(sectionText('In storefront')).not.toContain('Checking seats')
})

it('says "Checking seats…" only while a plan is still pending, not after a failure', () => {
  mount({ agentPlans: new Map(), agentPlansFailed: false })
  expect(sectionText('In storefront')).toContain('Checking seats…')
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
  expect(sectionText('In storefront')).toContain("Storefront reviewer does the work. Set by this file's older permission line, which counts as Edit.")
  expect(sectionText('Yours')).toContain('Scout does the work. No ceiling written, so it runs as read.')
  expect(sectionText('Yours')).toContain('Tidy does the work.')
  expect(sectionText('Yours')).not.toContain("Tidy does the work. Set by")
  expect(sectionText('Yours')).not.toContain('Tidy does the work. No ceiling')
  const chip = container.querySelector('section[aria-label="In storefront"] [data-ceiling]')
  expect(chip?.getAttribute('data-hold')).toBe('asked')
  // Neutral: `asked` is the ordinary state for a ceiling with no runtime
  // control that holds it, not a warning (#898).
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
