import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  runtimeId,
  sessionKey,
  type AgentEntry,
  type MachineSeating,
  type ModelInfo,
  type RuntimeInfo,
  type SeatCandidate,
  type SeatPlan,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AgentPage } from './AgentPage'
import { AgentsRosterSection } from './AgentRoster'

/**
 * An Agent's page: where it comes from, what it may do, the seats it asks for
 * and their state on this Mac, what it hands back, and its brief — with
 * starting it, customizing it and removing it.
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

const agent = (id: string, name: string, origin: AgentEntry['origin'], over: Partial<AgentEntry> = {}): AgentEntry => ({
  id,
  origin,
  path:
    origin === 'user'
      ? `/Users/dev/.harnessdesk/agents/${id}/AGENT.md`
      : origin === 'project'
        ? `/w/storefront/.harnessdesk/agents/${id}/AGENT.md`
        : `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name} does the work.`,
    ceiling: 'edit',
    ceilingFrom: 'permission',
    answers: ['approve', 'request-changes'],
    produces: ['review'],
    skills: ['checkout-rules'],
    mcp: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'You review a change.\nSomebody else wrote it.\n\n## How to report\n\nFindings first.',
  },
  ...over,
})

const EXACT_SEAT = agent('exact', 'Exact', 'builtin')

const ROSTER: readonly AgentEntry[] = [
  agent('code-reviewer', 'Code reviewer', 'project', {
    shadows: [{ origin: 'builtin', path: '/app/agents/code-reviewer/AGENT.md' }],
  }),
  agent('scout', 'Scout', 'user'),
  agent('judge', 'Judge', 'builtin'),
  agent('draft', 'draft', 'user', {
    definition: null,
    problems: [{ level: 'error', at: 'permission', text: '"admin" is not a permission — it is read, publish or merge' }],
  }),
  // Correction 2: a built-in Agent whose own prefer names an exact seat —
  // Customize to the project is greyed, never withdrawn.
  { ...EXACT_SEAT, definition: { ...EXACT_SEAT.definition!, prefer: [{ runtime: 'claude-code', model: 'opus-5' }] } },
  // Correction 3: not a real Agent folder at all — the placeholder a
  // project's own unreadable Agent directory becomes (Task 9's
  // `unreadDirectory`): an id naming the directory, and a path that is the
  // directory itself, never a file inside it.
  {
    id: '.harnessdesk/agents',
    origin: 'project',
    path: '/w/storefront/.harnessdesk/agents',
    digest: null,
    shadows: [],
    problems: [{ level: 'error', at: '.harnessdesk/agents', text: 'this directory could not be read — EACCES: permission denied' }],
    definition: null,
  },
]

const candidate = (
  runtime: string,
  label: string,
  state: SeatCandidate['state'],
  over: Partial<SeatCandidate> = {},
): SeatCandidate => ({ seat: { runtime }, label, runtimeName: label.split(' · ')[0]!, state, reason: null, fix: null, ...over })

const PLANS = new Map<string, SeatPlan>([
  [
    'judge',
    {
      id: 'judge',
      from: 'prefer',
      winner: 1,
      blocked: null,
      ceiling: { level: 'edit', hold: 'asked' },
      candidates: [
        candidate('cursor', 'Cursor', 'passed', { reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } }),
        candidate('claude-code', 'Claude · Opus 5 · High', 'taken'),
      ],
    },
  ],
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'machine',
      winner: 0,
      blocked: null,
      ceiling: { level: 'edit', hold: 'asked' },
      candidates: [candidate('codex', 'Codex · GPT-5.6 Sol', 'taken'), candidate('claude-code', 'Claude', 'untried')],
      own: [candidate('claude-code', 'Claude', 'taken')],
    },
  ],
  [
    'scout',
    {
      id: 'scout',
      from: 'prefer',
      winner: 1,
      blocked: null,
      ceiling: { level: 'edit', hold: 'asked' },
      candidates: [
        candidate('claude-code', 'Claude · Opus 9', 'passed', { reason: { kind: 'noModel', model: 'opus-9' }, fix: { kind: 'seats' } }),
        candidate('claude-code', 'Claude', 'taken'),
      ],
    },
  ],
])

const COPY: AgentEntry = { ...ROSTER[2]!, origin: 'user', path: '/Users/dev/.harnessdesk/agents/judge/AGENT.md' }

const SEATING: MachineSeating = {
  revision: 1,
  path: '/Users/dev/.harnessdesk/seating.json',
  entries: [{ id: 'code-reviewer', seats: [{ runtime: 'codex' }, { runtime: 'claude-code' }] }],
  problems: [],
}

const MODELS: readonly ModelInfo[] = [
  { id: 'opus-5', displayName: 'Opus 5', reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: false },
]

const snapshotFor = (seating: MachineSeating): AppSnapshot =>
  ({
    ...emptySnapshot(),
    status: 'open',
    home: '/Users/dev',
    stateDir: '/Users/dev/.harnessdesk',
    workspace: { path: '/w/storefront', name: 'storefront', lastOpenedAt: 1 },
    runtimes: [{ id: runtimeId('claude-code'), capabilities: {}, presentation: { name: 'Claude' } } as unknown as RuntimeInfo],
    agents: ROSTER,
    agentsProject: '/w/storefront',
    agentPlans: PLANS,
    seating,
  }) as unknown as AppSnapshot

const storeFor = (snapshot: AppSnapshot, overrides: Record<string, unknown> = {}): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAgents: vi.fn(async () => {}),
    openFile: vi.fn(),
    revealAgent: vi.fn(async () => {}),
    customizeAgent: vi.fn(async () => COPY),
    trashAgent: vi.fn(async () => {}),
    clearMachineSeats: vi.fn(async () => {}),
    startAsAgent: vi.fn(async () => sessionKey(runtimeId('claude-code'), 's1')),
    askSeatFix: vi.fn(),
    askSettings: vi.fn(),
    loadSeating: vi.fn(async () => {}),
    setSeating: vi.fn(async () => {}),
    modelsFor: vi.fn(async () => MODELS),
    // Neutral defaults: every AgentPage render now mounts AgentAttachments
    // and AgentNotes unconditionally, so a test with no opinion about either
    // still needs a settled promise rather than "not a function". Tests
    // about the allowlists or notes themselves override these explicitly.
    readAgentAttachments: vi.fn(async () => ({
      agent: 'x',
      origin: 'user',
      agentDigest: 'd',
      skillsMode: 'runtime-defaults',
      mcpMode: 'runtime-defaults',
      declarations: [],
      support: [],
    })),
    previewAttachmentEdit: vi.fn(async () => ({ path: '/AGENT.md', digest: 'd', diff: '' })),
    writeAttachmentEdit: vi.fn(async (entry: AgentEntry) => entry),
    readAgentNotes: vi.fn(async () => ({ path: '/NOTES.md', text: null, digest: null, writable: true, problem: null })),
    clearAgentNotes: vi.fn(async () => ({ path: '/NOTES.md', text: '', digest: 'e'.repeat(64), writable: true, problem: null })),
    // Task 5's editable fields: a neutral document for whichever Agent is
    // open, so every existing test — which has no opinion about editing a
    // field — still settles rather than throwing "not a function".
    readAuthoring: vi.fn(async (target: { readonly id?: string }) => ({
      target,
      source: '---\nname: x\n---\nBrief.\n',
      digest: `digest-${target.id ?? 'x'}`,
      exists: true,
      displayPath: 'AGENT.md',
      writable: true,
      issues: [],
    })),
    previewAgentEdit: vi.fn(async () => ({ token: null, edits: [], issues: [{ at: 'file', text: 'not wired in this test', fix: '' }], resuming: false })),
    applyAuthoringSave: vi.fn(async () => ({ state: 'refused', written: [], message: 'not wired in this test' })),
    // The overview's unfinished-saves banner: neutral (none) unless a test says otherwise.
    authoringPending: vi.fn(async () => []),
    resumeAuthoringSave: vi.fn(async () => ({ token: null, edits: [], issues: [{ at: 'save', text: 'not wired in this test', fix: '' }], resuming: true })),
    discardAuthoringSave: vi.fn(async () => []),
    ...overrides,
  }) as unknown as AppStore

const mount = ({ seating = SEATING, ...props }: { readonly focus?: string; readonly seating?: MachineSeating } = {}) => {
  const onLeave = vi.fn()
  const snapshot = snapshotFor(seating)
  const store = storeFor(snapshot)
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <AgentsRosterSection {...props} onLeave={onLeave} />
      </StoreProvider>,
    )
  })
  return { store, onLeave }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}
const hasButton = (label: string): boolean =>
  [...document.body.querySelectorAll('button')].some((one) => one.textContent?.trim() === label)
const rowFor = (name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.startsWith(name))
  if (!found) throw new Error(`no roster row for ${name}`)
  return found
}
const settle = () => act(async () => {})
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('opens from its roster row, names its file, and opens or reveals it', () => {
  const { store, onLeave } = mount()
  act(() => rowFor('Judge').click())
  expect(container.querySelector('[data-slot="page-title"]')).toBeNull()
  expect(hasButton('Agents')).toBe(true)
  const text = container.textContent ?? ''
  expect(text).toContain('Judge does the work.')
  expect(text).toContain('HarnessDesk › agents/judge/AGENT.md')
  act(() => button('Reveal').click())
  expect(store.revealAgent).toHaveBeenCalledWith('judge', 'builtin')
  act(() => button('Open file').click())
  expect(store.openFile).toHaveBeenCalledWith('/app/agents/judge/AGENT.md')
  expect(onLeave).toHaveBeenCalled()
})

it('opens on the Agent Settings was asked for, and goes back to the roster', () => {
  mount({ focus: 'scout' })
  expect(container.textContent).toContain('Scout does the work.')
  act(() => button('Agents').click())
  expect(container.querySelector('[data-slot="page-title"]')?.textContent).toBe('Agents')
})

it('says its ceiling and lists each seat with its state here and the fix for one that fails', () => {
  const { store } = mount({ focus: 'judge' })
  const text = container.textContent ?? ''
  expect(text).toContain('May change files and commit in its own checkout, and never push.')
  expect(text).toContain('Cursor is signed out')
  expect(text).toContain('The seat it takes here')
  act(() => button('Sign in to Cursor').click())
  expect(store.askSeatFix).toHaveBeenCalledWith({ kind: 'signIn', runtime: 'cursor' }, 'judge')
})

it('lists its own seats, muted, where this Mac’s replace them', () => {
  mount({ focus: 'code-reviewer' })
  const text = container.textContent ?? ''
  expect(text).toContain('Not used on this Mac')
  expect(text).toContain('Free here')
  expect(text).toContain('Comes first over the one that ships')
})

it('shows what it answers and produces, and reads its editable Skills/Servers section from the host, never "None"', async () => {
  const { store } = mount({ focus: 'judge' })
  const text = container.textContent ?? ''
  expect(text).toContain('Approve · Request changes')
  expect(text).toContain('Review')
  await settle()
  // Task 5's replacement for the old read-only Skills row: declarations come
  // from the host (`attachment/agent`), keyed by this exact Agent/origin —
  // never rendered as "None" for whatever this fixture's own default answers.
  expect(store.readAgentAttachments).toHaveBeenCalledWith('judge', 'builtin')
  expect(container.textContent ?? '').toContain('Runtime defaults')
})

it('opens on the brief’s first paragraph, and opens the rest in the editor', () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  expect(container.textContent).toContain('You review a change. Somebody else wrote it.')
  expect(container.textContent).not.toContain('Findings first.')
  act(() => button('Open in editor').click())
  expect(store.openFile).toHaveBeenCalledWith('/app/agents/judge/AGENT.md')
  expect(onLeave).toHaveBeenCalled()
})

it('starts a conversation as it, and leaves the window once one is open', async () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  act(() => button('Start a conversation as Judge').click())
  await settle()
  expect(store.startAsAgent).toHaveBeenCalledWith('judge')
  expect(onLeave).toHaveBeenCalled()
})

it('customizes a built-in into yours or the project’s, then opens the copy', async () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  expect(hasButton('Remove…')).toBe(false)
  act(() => button('Customize…').click())
  const choices = [...document.body.querySelectorAll('[role="radio"]')].map((one) => one.textContent ?? '')
  expect(choices[0]).toContain('For storefront')
  expect(choices[1]).toContain('For you')
  act(() => (document.body.querySelectorAll('[role="radio"]')[1] as HTMLButtonElement).click())
  act(() => button('Copy and open').click())
  await settle()
  expect(store.customizeAgent).toHaveBeenCalledWith('judge', 'builtin', 'user')
  expect(store.openFile).toHaveBeenCalledWith(COPY.path)
  expect(onLeave).toHaveBeenCalled()
})

it('removes one of yours to the Trash, after asking, and goes back to the roster', async () => {
  const { store } = mount({ focus: 'scout' })
  act(() => button('Remove…').click())
  act(() => button('Move to Trash').click())
  await settle()
  expect(store.trashAgent).toHaveBeenCalledWith('scout', 'user')
  expect(container.querySelector('[data-slot="page-title"]')?.textContent).toBe('Agents')
})

it('opens a file that will not parse on why, with nothing to start', () => {
  mount({ focus: 'draft' })
  const text = container.textContent ?? ''
  expect(text).toContain('Why it will not parse')
  expect(text).toContain('"admin" is not a permission')
  expect(hasButton('Start a conversation as draft')).toBe(false)
  expect(hasButton('Remove…')).toBe(true)
})

/*
 * Correction 2: Customize to the project is refused, server-side, for an
 * Agent whose own seats name a model, an effort or thinking (the Task 9 fix,
 * H6). `copyTargets` still offers the option; the page greys it instead of
 * withdrawing it, with the reason on screen, and never submits it.
 */
it('greys Copy to the project, with the reason on screen, when the Agent’s own seats name a model — never withdrawn', () => {
  mount({ focus: 'exact' })
  act(() => button('Customize…').click())
  const radios = [...document.body.querySelectorAll('[role="radio"]')]
  expect(radios).toHaveLength(2)
  const project = radios.find((one) => one.textContent?.includes('For storefront'))!
  expect(project.textContent).toContain('Its seats name models, and a project’s Agent names runtimes only.')
  expect(project).toHaveProperty('disabled', true)
  // The dialog opens on a target it can actually submit, not the greyed one.
  expect(button('Copy and open')).not.toHaveProperty('disabled', true)
})

/*
 * Correction 3: the placeholder entry for a project's own unreadable Agent
 * directory is not a real Agent folder — no file to open, reveal, copy or
 * remove — and the page must withhold those on its own rather than lean on
 * the host's refusal.
 */
it('offers no file action on a placeholder that is not a real Agent folder, and says why it cannot be read', () => {
  mount({ focus: '.harnessdesk/agents' })
  const text = container.textContent ?? ''
  expect(text).toContain('this directory could not be read')
  expect(hasButton('Open file')).toBe(false)
  expect(hasButton('Reveal')).toBe(false)
  expect(hasButton('Customize…')).toBe(false)
  expect(hasButton('Remove…')).toBe(false)
  expect([...document.body.querySelectorAll('button')].some((one) => one.textContent?.startsWith('Start a conversation'))).toBe(
    false,
  )
})

/*
 * Correction 4: Remove says what it does — naming the folder — and, only
 * when this Mac's own seating.json has an entry for this id (`plan.from ===
 * 'machine'`, the same signal the dry run itself uses), offers to clear it
 * too, unchecked by default, calling `agent/seating/set` with null once the
 * Remove itself has succeeded.
 */
it('names the folder on Remove, and — only when this Mac has seats for it — offers to clear them too, after the Remove succeeds', async () => {
  const { store } = mount({ focus: 'code-reviewer' })
  act(() => button('Remove…').click())
  expect(document.body.textContent).toContain('/w/storefront/.harnessdesk/agents/code-reviewer/AGENT.md')
  const checkbox = document.body.querySelector('[data-slot="checkbox"]')
  expect(checkbox).not.toBeNull()
  expect(checkbox).toHaveProperty('ariaChecked', 'false')
  act(() => (checkbox as HTMLElement).click())
  act(() => button('Move to Trash').click())
  await settle()
  expect(store.trashAgent).toHaveBeenCalledWith('code-reviewer', 'project')
  expect(store.clearMachineSeats).toHaveBeenCalledWith('code-reviewer')
})

it('offers no checkbox to clear this Mac’s seats when it has none for this Agent', async () => {
  const { store } = mount({ focus: 'scout' })
  act(() => button('Remove…').click())
  expect(document.body.querySelector('[data-slot="checkbox"]')).toBeNull()
  act(() => button('Move to Trash').click())
  await settle()
  expect(store.clearMachineSeats).not.toHaveBeenCalled()
})

/*
 * Correction 5: a refusal from the host is shown in the dialog that asked,
 * as its own sentence, and nothing closes or navigates on it.
 */
it('shows Customize’s own refusal in its dialog, and neither closes nor opens anything', async () => {
  const { store, onLeave } = mount({ focus: 'judge' })
  store.customizeAgent = vi.fn(async () => {
    throw new Error('A copy in your Agents would be shadowed by the built-in “judge” already there — remove or rename it first.')
  })
  act(() => button('Customize…').click())
  act(() => button('Copy and open').click())
  await settle()
  expect(document.body.textContent).toContain('would be shadowed by the built-in')
  expect(store.openFile).not.toHaveBeenCalled()
  expect(onLeave).not.toHaveBeenCalled()
  // Still open: the choices are still on screen.
  expect(hasButton('Cancel')).toBe(true)
})

it('shows Remove’s own refusal in its dialog on a server-only host, and stays on the page', async () => {
  const { store } = mount({ focus: 'scout' })
  store.trashAgent = vi.fn(async () => {
    throw new Error('Moving an Agent to the Trash needs the desktop app.')
  })
  act(() => button('Remove…').click())
  act(() => button('Move to Trash').click())
  await settle()
  expect(document.body.textContent).toContain('needs the desktop app')
  expect(container.querySelector('[data-slot="page-title"]')).toBeNull()
  expect(hasButton('Keep')).toBe(true)
})

/* --- On this Mac (Task 16) ------------------------------------------------ */

const section = (label: string): string => container.querySelector(`section[aria-label="${label}"]`)?.textContent ?? ''
const labelled = (label: string): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`),
]
const choose = (label: string, value: string): void => {
  const tag = [...document.body.querySelectorAll('label')].find((one) => one.textContent === label)
  const select = tag ? document.getElementById(tag.htmlFor) : null
  if (!(select instanceof HTMLSelectElement)) throw new Error(`no field labelled ${label}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('lists this Mac’s seats in order, each with its state here, and names the file they live in', () => {
  const { store } = mount({ focus: 'code-reviewer' })
  expect(store.loadSeating).toHaveBeenCalled()
  const here = section('On this Mac')
  expect(here.indexOf('Codex · GPT-5.6 Sol')).toBeLessThan(here.indexOf('Claude'))
  expect(here).toContain('The seat it takes here')
  expect(here).toContain('Not reached: a seat before it is free')
  expect(here).toContain('~/.harnessdesk/seating.json')
})

it('a seat moves, or goes, and Clear gives the Agent its own list back', async () => {
  const { store } = mount({ focus: 'code-reviewer' })
  const expected = [{ runtime: 'codex' }, { runtime: 'claude-code' }]
  expect(labelled('Move up')).toHaveLength(2)
  expect(labelled('Move down')).toHaveLength(2)
  expect(labelled('Move up')[0]!.textContent).toContain('Move up')
  expect(labelled('Move down')[0]!.textContent).toContain('Move down')
  expect(labelled('Move up')[0]!.disabled).toBe(true)
  expect(labelled('Move down')[1]!.disabled).toBe(true)
  act(() => labelled('Move down')[0]!.click())
  await settle()
  expect(store.setSeating).toHaveBeenLastCalledWith(
    'code-reviewer',
    [{ runtime: 'claude-code' }, { runtime: 'codex' }],
    expected,
  )
  act(() => labelled('Remove this seat')[1]!.click())
  await settle()
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', [{ runtime: 'codex' }], expected)
  act(() => button('Clear').click())
  await settle()
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', null, expected)
})

it('the last seat removed gives the Agent its own list back too', () => {
  const { store } = mount({
    focus: 'code-reviewer',
    seating: { ...SEATING, entries: [{ id: 'code-reviewer', seats: [{ runtime: 'codex' }] }] },
  })
  act(() => labelled('Remove this seat')[0]!.click())
  expect(store.setSeating).toHaveBeenLastCalledWith('code-reviewer', null, [{ runtime: 'codex' }])
})

it('disables every seat edit while a move is in flight, so a quick remove cannot undo it from the old list', async () => {
  const { store } = mount({ focus: 'code-reviewer' })
  const write = deferred<void>()
  store.setSeating = vi.fn(() => write.promise)

  act(() => labelled('Move down')[0]!.click())
  expect(labelled('Move up').every((one) => one.disabled)).toBe(true)
  expect(labelled('Move down').every((one) => one.disabled)).toBe(true)
  expect(labelled('Remove this seat').every((one) => one.disabled)).toBe(true)
  expect(button('Clear').disabled).toBe(true)
  expect(button('Add a seat…').disabled).toBe(true)

  act(() => labelled('Remove this seat')[1]!.click())
  expect(store.setSeating).toHaveBeenCalledTimes(1)
  expect(store.setSeating).toHaveBeenCalledWith(
    'code-reviewer',
    [{ runtime: 'claude-code' }, { runtime: 'codex' }],
    [{ runtime: 'codex' }, { runtime: 'claude-code' }],
  )

  await act(async () => {
    write.resolve(undefined)
    await write.promise
  })
})

it('two pages editing one Agent refuse the stale page, reload it, and show the refusal without undoing the first edit', async () => {
  const message = "This Agent's seats on this Mac changed in another window; nothing was saved. The page now shows the current seats."
  const original = [{ runtime: 'codex' }, { runtime: 'claude-code' }]
  let hostSeats: readonly { readonly runtime: string }[] | null = original
  const firstStore = storeFor(snapshotFor(SEATING), {
    setSeating: vi.fn(async (_id: string, seats: readonly { readonly runtime: string }[] | null, expected: unknown) => {
      expect(expected).toEqual(original)
      hostSeats = seats
    }),
  })
  const staleStore = storeFor(snapshotFor(SEATING), {
    setSeating: vi.fn(async (_id: string, seats: readonly { readonly runtime: string }[] | null, expected: unknown) => {
      if (JSON.stringify(expected) !== JSON.stringify(hostSeats)) throw new Error(message)
      hostSeats = seats
    }),
    loadSeating: vi.fn(async () => {}),
  })

  act(() => {
    root.render(
      <>
        <div data-page="first">
          <StoreProvider store={firstStore}>
            <AgentPage entry={ROSTER[0]!} onBack={() => {}} onLeave={() => {}} />
          </StoreProvider>
        </div>
        <div data-page="stale">
          <StoreProvider store={staleStore}>
            <AgentPage entry={ROSTER[0]!} onBack={() => {}} onLeave={() => {}} />
          </StoreProvider>
        </div>
      </>,
    )
  })
  await settle()
  vi.mocked(firstStore.loadSeating).mockClear()
  vi.mocked(staleStore.loadSeating).mockClear()
  const first = container.querySelector<HTMLElement>('[data-page="first"]')!
  const stale = container.querySelector<HTMLElement>('[data-page="stale"]')!
  const firstMove = [...first.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.getAttribute('aria-label') === 'Move down')!
  const staleRemoves = [...stale.querySelectorAll<HTMLButtonElement>('button')].filter(
    (one) => one.getAttribute('aria-label') === 'Remove this seat',
  )

  act(() => firstMove.click())
  await settle()
  expect(hostSeats).toEqual([{ runtime: 'claude-code' }, { runtime: 'codex' }])

  act(() => staleRemoves[1]!.click())
  await settle()
  expect(staleStore.setSeating).toHaveBeenCalledWith('code-reviewer', [{ runtime: 'codex' }], original)
  expect(staleStore.loadSeating).toHaveBeenCalledTimes(1)
  expect(stale.textContent).toContain(message)
  expect(hostSeats).toEqual([{ runtime: 'claude-code' }, { runtime: 'codex' }])
})

it('adds a seat chosen in words to the end of this Mac’s list', async () => {
  const { store } = mount({ focus: 'judge' })
  expect(section('On this Mac')).toContain('Its own seats apply here')
  act(() => button('Add a seat…').click())
  await settle()
  expect(store.modelsFor).toHaveBeenCalledWith('claude-code')
  choose('Model', 'opus-5')
  choose('Effort', 'high')
  act(() => button('Add seat').click())
  await settle()
  expect(store.setSeating).toHaveBeenCalledWith(
    'judge',
    [{ runtime: 'claude-code', model: 'opus-5', effort: 'high' }],
    null,
  )
})

it('an entry this Mac cannot read says where and why; a file that will not read is not written over from here', () => {
  mount({
    focus: 'judge',
    seating: {
      ...SEATING,
      entries: [],
      problems: [{ id: 'judge', at: '[1]', text: '"+fast" is not a switch a seat takes — the only one is +thinking' }],
    },
  })
  expect(section('On this Mac')).toContain('"+fast" is not a switch a seat takes')
  expect(section('On this Mac')).toContain('At [1] in its entry')
  expect(button('Add a seat…').disabled).toBe(false)

  mount({ focus: 'judge', seating: { ...SEATING, entries: [], problems: [{ id: null, at: '', text: 'it is not JSON' }] } })
  expect(section('On this Mac')).toContain('it is not JSON')
  expect(button('Add a seat…').disabled).toBe(true)
})

it('a seat its runtime cannot give is fixed on this page, by a seat for this Mac', async () => {
  mount({ focus: 'scout' })
  expect(section('Seats')).toContain('Claude does not offer this model')
  act(() => button('Edit seats for this Mac').click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('A seat for Scout on this Mac')
})

/*
 * Correction 1 (task-16-corrections.md): until the dry run catches up with a
 * reorder, a row reads "Checking…" rather than lend one seat's words to
 * another — proven directly against the `weighed` guard: this Mac's own two
 * seats, but a plan whose candidates do not (yet) match them one for one.
 */
it('reads a row as “Checking…” when the dry run has not caught up with this Mac’s own list yet', () => {
  mount({
    focus: 'code-reviewer',
    seating: { ...SEATING, entries: [{ id: 'code-reviewer', seats: [{ runtime: 'claude-code' }, { runtime: 'codex' }] }] },
  })
  // The order above is the reverse of PLANS' code-reviewer candidates
  // (codex, then claude-code) — `sameSeat` fails at index 0, so nothing here
  // borrows either seat's words.
  const here = section('On this Mac')
  expect(here).toContain('Checking…')
  expect(here).not.toContain('Codex · GPT-5.6 Sol')
})

/*
 * Correction 2 (task-16-corrections.md): a model id may itself contain `=`,
 * `/` or `+` — the host writes the long form, and the dialog does nothing
 * special with it, so an id with a `/` in it must round-trip untouched.
 */
it('passes a model id with a slash in it through untouched — no special-casing', async () => {
  const { store } = mount({ focus: 'judge' })
  store.modelsFor = vi.fn(async () => [
    { id: 'gpt-5.6/preview', displayName: 'GPT-5.6 Preview', reasoningLevels: [], supportsImages: false },
  ])
  act(() => button('Add a seat…').click())
  await settle()
  choose('Model', 'gpt-5.6/preview')
  act(() => button('Add seat').click())
  await settle()
  expect(store.setSeating).toHaveBeenCalledWith(
    'judge',
    [{ runtime: 'claude-code', model: 'gpt-5.6/preview' }],
    null,
  )
})

it('only an editable flagged Agent offers Update…, and it opens from the Ceiling section', async () => {
  const project = mount({ focus: 'code-reviewer' })
  project.store.previewCeiling = vi.fn(async (_entry, level) => ({
    path: '/w/storefront/.harnessdesk/agents/code-reviewer/AGENT.md',
    digest: `preview-${level}`,
    line: 3,
    before: 'permission: read',
    after: `ceiling: ${level}`,
    diff: `--- a/AGENT.md\n+++ b/AGENT.md\n@@ -3 +3 @@\n-permission: read\n+ceiling: ${level}\n`,
  }))
  project.store.writeCeiling = vi.fn(async (entry) => entry)
  expect(section('Ceiling')).toContain('Written with permission:')
  act(() => button('Update…').click())
  await settle()
  expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Update Code reviewer')
  act(() => button('Cancel').click())

  mount({ focus: 'judge' })
  expect(section('Ceiling')).not.toContain('Update…')

  const explicit = agent('explicit', 'Explicit', 'user', {
    definition: { ...agent('explicit', 'Explicit', 'user').definition!, ceilingFrom: 'ceiling' },
  })
  const snapshot = { ...snapshotFor(SEATING), agents: [explicit], agentPlans: new Map() } as AppSnapshot
  const store = storeFor(snapshot)
  act(() => root.render(<StoreProvider store={store}><AgentPage entry={explicit} onBack={() => {}} onLeave={() => {}} /></StoreProvider>))
  expect(section('Ceiling')).not.toContain('Update…')
})

it('a successful update removes the flag, and project navigation closes an old preview', async () => {
  let snapshot = snapshotFor(SEATING)
  const listeners = new Set<() => void>()
  const pending = deferred<import('@harnessdesk/protocol').CeilingUpdate>()
  const store = storeFor(snapshot, {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    previewCeiling: vi.fn()
      .mockResolvedValueOnce({
        path: ROSTER[0]!.path,
        digest: 'shown-digest',
        line: 3,
        before: 'permission: edit',
        after: 'ceiling: edit',
        diff: '-permission: edit\n+ceiling: edit\n',
      })
      .mockReturnValueOnce(pending.promise),
    writeCeiling: vi.fn(async (entry: AgentEntry) => {
      const written = { ...entry, digest: 'written', definition: { ...entry.definition!, ceilingFrom: 'ceiling' as const } }
      snapshot = { ...snapshot, agents: snapshot.agents?.map((one) => one.path === entry.path ? written : one) ?? null }
      for (const listener of listeners) listener()
      return written
    }),
  })
  act(() => root.render(
    <StoreProvider store={store}>
      <AgentsRosterSection focus="code-reviewer" />
    </StoreProvider>,
  ))

  act(() => button('Update…').click())
  await vi.waitFor(() => expect(button('Write this line').disabled).toBe(false))
  act(() => button('Write this line').click())
  await settle()
  expect(section('Ceiling')).not.toContain('Written with permission:')
  expect(section('Ceiling')).not.toContain('Update…')

  act(() => {
    snapshot = {
      ...snapshot,
      agentsProject: '/w/another',
      agents: [{ ...ROSTER[0]!, path: '/w/another/.harnessdesk/agents/code-reviewer/AGENT.md' }],
    }
    for (const listener of listeners) listener()
  })
  await vi.waitFor(() => expect(hasButton('Update…')).toBe(true))
  act(() => button('Update…').click())
  await act(async () => {
    snapshot = { ...snapshot, agentsProject: '/w/third' }
    for (const listener of listeners) listener()
  })
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => pending.resolve({
    path: '/w/another/.harnessdesk/agents/code-reviewer/AGENT.md',
    digest: 'late',
    line: 3,
    before: 'permission: edit',
    after: 'ceiling: edit',
    diff: '-permission: edit\n+ceiling: edit\n',
  }))
  expect(store.writeCeiling).toHaveBeenCalledTimes(1)
})

it('a migrated Agent’s ceiling offers Edit… beside the legacy Update…, through the same authoring path as its other fields', async () => {
  const migrated = agent('explicit', 'Explicit', 'user', {
    definition: { ...agent('explicit', 'Explicit', 'user').definition!, ceilingFrom: 'ceiling', ceiling: 'read' },
  })
  const snapshot = { ...snapshotFor(SEATING), agents: [migrated], agentPlans: new Map() } as AppSnapshot
  const previewAgentEdit = vi.fn(async () => ({
    token: 'ceiling-tok',
    edits: [{ path: migrated.path, before: 'ceiling: read', after: 'ceiling: edit' }],
    issues: [],
    resuming: false,
  }))
  const applyAuthoringSave = vi.fn(async () => ({ state: 'applied', written: [migrated.path], message: 'Saved.' }))
  const store = storeFor(snapshot, { previewAgentEdit, applyAuthoringSave })
  act(() => root.render(<StoreProvider store={store}><AgentPage entry={migrated} onBack={() => {}} onLeave={() => {}} /></StoreProvider>))

  // Nothing to update: this Agent already reads `ceiling:`.
  expect(section('Ceiling')).not.toContain('Update…')
  const edit = [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Ceiling"] button')].find((one) => one.textContent?.trim() === 'Edit…')
  if (!edit) throw new Error('no Edit… on the Ceiling row')
  // Disabled until its document is read — the digest an edit previews against.
  await vi.waitFor(() => expect(edit.hasAttribute('disabled')).toBe(false))
  act(() => edit.click())
  await settle()

  const ceilingDialog = document.body.querySelector('[role="dialog"]')!
  expect(ceilingDialog.textContent).toContain('Edit Ceiling')
  const editChoice = [...ceilingDialog.querySelectorAll<HTMLElement>('button, [role="radio"]')].find((one) => one.textContent?.startsWith('Edit'))!
  act(() => editChoice.click())
  await settle()
  expect(previewAgentEdit).toHaveBeenCalledWith(
    { kind: 'agent', origin: 'user', id: 'explicit' },
    'digest-explicit',
    { key: 'ceiling', value: 'edit' },
  )

  act(() => {
    const save = [...ceilingDialog.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Save')!
    save.click()
  })
  await settle()
  expect(applyAuthoringSave).toHaveBeenCalledWith('ceiling-tok')
})

it('Seats’ own Edit… opens the same authoring path for prefer, and a legacy-permission Agent’s ceiling still refuses there rather than being silently reinterpreted', async () => {
  // The default `agent()` fixture is `ceilingFrom: 'permission'` — this
  // proves prefer editing on a legacy Agent works read/writes seats without
  // ever touching its ceiling, and that a *ceiling* edit attempted through
  // the same document still comes back refused in the host's own words.
  const previewAgentEdit = vi.fn(async (_target: unknown, _digest: string, edit: { readonly key: string }) =>
    edit.key === 'prefer'
      ? { token: 'prefer-tok', edits: [{ path: ROSTER[0]!.path, before: 'prefer: []', after: 'prefer: [claude-code]' }], issues: [], resuming: false }
      : { token: null, edits: [], issues: [{ at: 'ceiling', text: 'This Agent still says permission:, which is read differently from a ceiling.', fix: 'Update it to a ceiling from the Agent page first, then change it here.' }], resuming: false })
  const store = storeFor(snapshotFor(SEATING), { previewAgentEdit })
  act(() => root.render(<StoreProvider store={store}><AgentsRosterSection focus="code-reviewer" /></StoreProvider>))

  const editSeats = await vi.waitFor(() => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('section[aria-label="Seats"] button')].find((one) => one.textContent?.trim() === 'Edit…')
    if (!found) throw new Error('no Edit… on Seats yet')
    return found
  })
  act(() => editSeats.click())
  await settle()
  const dialog = document.body.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('Edit Seats for Code reviewer')
  expect(dialog?.querySelector('button[aria-label="Remove Claude"]')).not.toBeNull()

  act(() => {
    const remove = dialog!.querySelector('button[aria-label="Remove Claude"]') as HTMLButtonElement
    remove.click()
  })
  await settle()
  expect(previewAgentEdit).toHaveBeenLastCalledWith(
    { kind: 'agent', origin: 'project', id: 'code-reviewer', root: '/w/storefront' },
    'digest-code-reviewer',
    { key: 'prefer', value: [] },
  )
})
