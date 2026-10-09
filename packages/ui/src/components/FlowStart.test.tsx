import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, CompiledFlow, FlowEntry, FlowPreview, FlowPreviewSeat, SeatCandidate, SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot } from '../state/snapshot'
import type { AppStore } from '../state/store'
import { FlowStart, type FlowChoice } from './FlowStart'
import { TEAM_START_POLICIES } from '../preview/team-start-fixture'

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

const AGENT = (id: string, name: string): AgentEntry => ({
  id, origin: 'project', path: `/repo/.harnessdesk/agents/${id}/AGENT.md`, problems: [], shadows: [],
  definition: { name, description: null, ceiling: 'edit', ceilingFrom: 'ceiling', answers: [], prefer: [], order: '' } as unknown as AgentEntry['definition'],
  digest: 'd1',
})

const candidate = (over: Partial<SeatCandidate> = {}): SeatCandidate => ({
  seat: { runtime: 'codex' }, label: 'Codex', runtimeName: 'Codex', state: 'passed',
  reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'codex' }, ...over,
})

const compiled = (extra: Partial<CompiledFlow['document']> = {}): CompiledFlow => ({
  document: {
    format: 'agents',
    flow: { version: 2, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240 },
    ...extra,
  } as CompiledFlow['document'],
  bindings: [], problems: [],
})

const emptyPreview = (): FlowPreview => ({ token: 't', compiled: compiled(), seats: [], commands: [], guards: [], messaging: 'board-only', problems: [] })

const store = (options: {
  readonly entries: readonly FlowEntry[]
  readonly agents?: readonly AgentEntry[]
  readonly source: (id: string) => Promise<string> | string
  readonly preview: (source: string) => Promise<FlowPreview> | FlowPreview
}): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: (() => { const snapshot = emptySnapshot(); return () => snapshot })(),
    flowGeneration: () => 0,
    flowCatalog: vi.fn().mockResolvedValue(options.entries),
    agentsIn: vi.fn().mockResolvedValue(options.agents ?? []),
    flowSource: vi.fn((_root: string, id: string) => Promise.resolve(options.source(id))),
    previewFlow: vi.fn((_root: string, source: string) => Promise.resolve(options.preview(source))),
  }) as unknown as AppStore

const ENTRY = (id: string): FlowEntry => ({ id, origin: 'project', path: `.harnessdesk/flows/${id}.yml`, name: id, description: null, format: 'agents', problem: null, shadows: [] })

it('the review options preserve the review cap and require recorded approval before automatic merging', async () => {
  const flow: import('@harnessdesk/protocol').FlowPolicy = TEAM_START_POLICIES['fix-and-review']
  let current = flow
  const onPolicy = vi.fn((next: import('@harnessdesk/protocol').FlowPolicy) => { current = next; paint() })
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview })
  const paint = () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: current, template: flow, preview: emptyPreview(), roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy }} /></StoreProvider>)
  act(paint)
  const press = (label: string) => act(() => [...container.querySelectorAll('button')].find(one => one.textContent === label)!.click())
  for (const rounds of [1, 2, 3]) {
    press(String(rounds))
    expect(onPolicy.mock.lastCall?.[0].budget?.rounds).toBe(rounds * 2 + 1)
  }
  press('Merge it')
  const automatic = onPolicy.mock.lastCall?.[0] as import('@harnessdesk/protocol').FlowPolicy
  expect(automatic.roles.find(role => role.id === 'referee')).toMatchObject({ kind: 'agent', uses: ['merger'], grant: 'merge' })
  expect(automatic.rules.find(rule => rule.then.role === 'referee')?.when).toEqual({ evidence: [{ review: 'approve' }, { pr: 'open' }] })
  press('Wait for me')
  expect(onPolicy.mock.lastCall?.[0].roles.find(role => role.id === 'referee')).toMatchObject({ kind: 'person' })
})

const render = (theStore: AppStore, onChange: (choice: FlowChoice | null) => void) => {
  act(() => {
    root.render(
      <StoreProvider store={theStore}>
        <FlowStart root="/repo" onChange={onChange} />
      </StoreProvider>,
    )
  })
}

const select = async (value: string): Promise<void> => {
  const control = container.querySelector('select') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('previews the recorded source and inputs without reading the current catalogue file', async () => {
  const theStore = store({ entries: [], source: () => { throw new Error('must not read'); }, preview: () => ({ ...emptyPreview(), compiled: compiled({ flow: {
    version: 2, name: 'Fix', inputs: [{ id: 'brief', label: 'Brief' }, { id: 'task', label: 'Task' }], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240,
  } }) }) })
  const initial = { source: 'frozen source', vars: { task: 'Retry', brief: 'Two\nparagraphs' }, seats: {}, attended: true }
  const change = vi.fn()
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={initial} onChange={change} /></StoreProvider>))
  expect(theStore.flowSource).not.toHaveBeenCalled()
  expect(theStore.previewFlow).toHaveBeenCalledWith('/repo', initial.source, initial.vars, { seats: {}, attended: true })
  expect(container.querySelector('textarea')!.value).toBe(initial.vars.brief)
  expect(change).toHaveBeenLastCalledWith({ source: initial.source, vars: initial.vars, token: 't', seats: {}, attended: true })
})

it('shows a continuation refusal rather than calling its empty preview an old-format Flow', async () => {
  const refusal = 'A newer Run continues this one. Start work on that Run instead.'
  const preview: FlowPreview = { ...emptyPreview(), token: null,
    compiled: { document: { format: 'legacy', flow: { name: '', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
    problems: [{ level: 'error', at: 'run', text: refusal }],
  }
  const theStore = store({ entries: [], source: () => '', preview: () => preview })
  const change = vi.fn()
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" continues="earlier" initial={{ source: 'saved', vars: {} }} onChange={change} /></StoreProvider>))
  expect(container.textContent).toContain(refusal)
  expect(container.textContent).not.toContain('This flow uses the old format')
  expect(container.textContent).not.toContain('Reading the earlier Run’s Flow')
  expect(container.textContent).not.toContain('This flow names no Agent role')
  expect(change).toHaveBeenLastCalledWith(null)
})

it('keeps the migration banner for a parsed old-format Flow without a separate format problem', async () => {
  const preview: FlowPreview = { ...emptyPreview(), token: null,
    compiled: { document: { format: 'legacy', flow: { name: 'Old Flow', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
    problems: [],
  }
  const theStore = store({ entries: [], source: () => '', preview: () => preview })
  const change = vi.fn()
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={{ source: 'saved', vars: {} }} onChange={change} /></StoreProvider>))
  expect(container.textContent).toContain('This flow uses the old format')
  expect(container.textContent).not.toContain('This flow will not run yet')
  expect(change).toHaveBeenLastCalledWith(null)
})

it('edits and resets one Seat slot while preserving every other Seat and role', async () => {
  const first = { runtime: 'alpha' }, second = { runtime: 'beta', model: 'second' }, changed = { runtime: 'alpha', effort: 'high' }
  const dry = emptyPreview()
  const slot = (index: number): FlowPreviewSeat => ({ role: 'reviewer', index, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'prefer', winner: index, blocked: null, ceiling: { level: 'read', hold: 'held' },
      candidates: [first, second, changed].map((seat, n) => candidate({ seat, label: `Choice ${n}`, runtimeName: 'Agent', state: n === index ? 'taken' : 'untried', reason: null, fix: null })) } })
  const preview = { ...dry, compiled: compiled({ flow: { version: 2, name: 'Review', inputs: [],
    roles: [{ id: 'reviewer', kind: 'agent', uses: ['reviewer'], seats: [first, second], isolate: false, grant: 'read', independentOf: [] }],
    rules: [], seed: { role: 'reviewer', title: 'Review' }, messaging: 'board-only', wait: 240 } }), seats: [slot(0), slot(1)] }
  const theStore = store({ entries: [], source: () => '', preview: () => preview })
  theStore.previewFlow = vi.fn(async (_root, _source, _vars, options) => ({ ...preview, seats: preview.seats.map(seat => {
    const chosen = options?.seats?.reviewer?.[seat.index]
    return chosen ? { ...seat, plan: { ...seat.plan, winner: 0, candidates: seat.plan.candidates.filter(candidate => JSON.stringify(candidate.seat) === JSON.stringify(chosen)) } } : seat
  }) }))
  const change = vi.fn()
  const initial = { source: 'saved', vars: {}, seats: { writer: [{ runtime: 'writer' }] }, attended: true }
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={initial} onChange={change} /></StoreProvider>))
  expect(container.querySelectorAll('select')).toHaveLength(2)
  const controls = () => [...container.querySelectorAll('select')]
  const chooseSlot = async (index: number, value: string) => act(async () => {
    const control = controls()[index]!
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await chooseSlot(0, JSON.stringify(changed))
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: { ...initial.seats, reviewer: [changed, second] }, attended: true })
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ seats: { ...initial.seats, reviewer: [changed, second] } }))
  expect([...controls()[0]!.options].map(option => option.value)).toContain(JSON.stringify(first))
  await chooseSlot(1, JSON.stringify(first))
  await chooseSlot(0, '')
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: { ...initial.seats, reviewer: [first, first] }, attended: true })
  await chooseSlot(1, '')
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: initial.seats, attended: true })
})

it('every candidate and effective ceiling remains visible', async () => {
  const seatHeld: FlowPreviewSeat = {
    role: 'fixer', index: 0, agent: 'builder', isolate: true, reviews: false,
    plan: {
      id: 'builder', from: 'prefer', winner: 2, blocked: null, ceiling: { level: 'edit', hold: 'held' },
      candidates: [
        candidate({ label: 'Cursor', runtimeName: 'Cursor', seat: { runtime: 'cursor' }, reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } }),
        candidate({ label: 'Codex', reason: { kind: 'notInstalled', added: false }, fix: { kind: 'add', runtime: 'codex' } }),
        candidate({ label: 'Claude Code', runtimeName: 'Claude Code', seat: { runtime: 'claude-code' }, state: 'taken', reason: null, fix: null }),
      ],
    } as SeatPlan,
  }
  const seatAsked: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'asked' }, candidates: [candidate({ state: 'taken', reason: null, fix: null, label: 'Codex' })] } as SeatPlan,
  }
  const preview: FlowPreview = { ...emptyPreview(), seats: [seatHeld, seatAsked] }
  const theStore = store({
    entries: [ENTRY('fix')],
    agents: [AGENT('builder', 'Builder'), AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n',
    preview: () => preview,
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  expect(container.textContent).toContain('Builder — fixer, isolated')
  expect(container.textContent).toContain('Reviewer — reviewer')
  expect(container.textContent).toContain('Cursor')
  expect(container.textContent).toContain('Codex')
  expect(container.textContent).toContain('Claude Code')
  expect(container.textContent).toContain('is signed out')
  expect(container.textContent).toContain('Sign in to Cursor')
  expect(container.textContent).toContain('is not added to HarnessDesk')

  const chips = [...container.querySelectorAll('[data-ceiling], [data-tone]')].map((one) => one.textContent)
  expect(chips).toEqual(expect.arrayContaining(['Edit', 'Read only · asked, not enforced']))
})

it('renders provider warnings, held-ceiling refusals, and additional provider reasons', async () => {
  const reviewer: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: {
      id: 'reviewer', from: 'machine', winner: null, blocked: null, ceiling: null,
      candidates: [
        candidate({
          label: 'Codex · GPT-6 Luna · Extra high',
          reason: { kind: 'sameProvider' },
          fix: { kind: 'seats' },
        }),
        candidate({
          label: 'Claude Code · Sonnet 5.5', runtimeName: 'Claude Code',
          seat: { runtime: 'claude-code', model: 'sonnet' },
          reason: { kind: 'unheld', level: 'read', detail: null }, fix: { kind: 'ceilings' },
        }),
        candidate({
          label: 'Cursor · Gamma', runtimeName: 'Cursor', seat: { runtime: 'cursor' },
          state: 'taken', reason: null, fix: null,
        }),
        candidate({
          label: 'Cursor · Delta', runtimeName: 'Cursor', seat: { runtime: 'cursor' },
          reason: { kind: 'unheld', level: 'read', detail: null }, fix: { kind: 'ceilings' },
          alsoPassed: [{ kind: 'sameProvider' }],
        }),
      ],
    } as SeatPlan,
  }
  const warning = 'Can’t confirm that Cursor uses a different provider from fixer, so independence is checked when this step is reached.'
  const preview: FlowPreview = { ...emptyPreview(), seats: [reviewer], problems: [{ level: 'warning', at: 'roles.reviewer', text: warning }] }
  const theStore = store({
    entries: [ENTRY('fix')], agents: [AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n', preview: () => preview,
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  expect(container.textContent).toContain('Same provider as the writer')
  expect(container.textContent).toContain('cannot hold read')
  // Delta's alsoPassed reason renders beside its primary one; Alpha's alone would not prove it.
  expect(container.textContent).toMatch(/only asked — Same provider as the writer/)
  expect(container.textContent).not.toContain('Can’t confirm a different provider from the writer')
  expect(container.textContent).toContain('Picked')
  expect(container.textContent).toContain(warning)
})

// #1053: a reading step handed an isolated step's one commit gets a worktree of its own, and the dry run says so.
it('a seat the run opens at the commit it is handed says so, in plain words', async () => {
  const seat: FlowPreviewSeat = {
    role: 'tester', index: 0, agent: 'reviewer', isolate: false, atPredecessor: 'always', reviews: true,
    plan: { id: 'reviewer', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'asked' }, candidates: [candidate({ state: 'taken', reason: null, fix: null, label: 'Codex' })] } as SeatPlan,
  }
  const theStore = store({
    entries: [ENTRY('fix')],
    agents: [AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n',
    preview: () => ({ ...emptyPreview(), seats: [seat] }),
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  expect(container.textContent).toContain('Reviewer — tester')
  const chip = [...container.querySelectorAll('[title="Opens in a worktree of its own, at the commit it is handed"]')]
  expect(chip.map((one) => one.textContent)).toEqual(['Own worktree'])
})

it('a seat with mixed predecessor routes says its worktree is conditional', async () => {
  const seat: FlowPreviewSeat = {
    role: 'tester', index: 0, agent: 'reviewer', isolate: false, atPredecessor: 'may', reviews: true,
    plan: { id: 'reviewer', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'asked' }, candidates: [candidate({ state: 'taken', reason: null, fix: null, label: 'Codex' })] } as SeatPlan,
  }
  const theStore = store({
    entries: [ENTRY('fix')],
    agents: [AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n',
    preview: () => ({ ...emptyPreview(), seats: [seat] }),
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  const chip = [...container.querySelectorAll('[title="May open in a worktree of its own, at the commit it is handed, depending on which rule opens it"]')]
  expect(chip.map((one) => one.textContent)).toEqual(['Sometimes own worktree'])
})

it('a review flow discloses its effective budget and the blind-round messaging restriction; a plain flow shows neither', async () => {
  const reviewSeat: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'held' }, candidates: [] } as SeatPlan,
  }
  const reviewPreview: FlowPreview = {
    ...emptyPreview(),
    seats: [reviewSeat],
    compiled: {
      ...compiled({ flow: { version: 2, name: 'Review', inputs: [], roles: [], rules: [], seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240, budget: { rounds: 5, withoutProgress: 2 } } as never }),
      bindings: [{ role: 'reviewer', index: 0, agent: { id: 'reviewer', produces: ['review'] } as never, origin: 'project', digest: 'd', seats: [], grant: 'read' }],
    },
  }
  // An Agent that writes and reviews, seated to commit: the server says its Seats are not there to review.
  const debatePreview: FlowPreview = {
    ...reviewPreview,
    seats: [{ ...reviewSeat, role: 'analyst', agent: 'analyst', reviews: false }],
    compiled: {
      ...reviewPreview.compiled,
      bindings: [{ role: 'analyst', index: 0, agent: { id: 'analyst', produces: ['diff', 'review'] } as never, origin: 'project', digest: 'd', seats: [], grant: 'edit' }],
    },
  }
  const theStore = store({
    entries: [ENTRY('review'), ENTRY('plain'), ENTRY('debate')],
    agents: [AGENT('reviewer', 'Reviewer')],
    source: (id) => `version: 2\nname: ${id}\n`,
    preview: (source) => source.includes('review') ? reviewPreview : source.includes('debate') ? debatePreview : emptyPreview(),
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('review')
  await act(async () => {})
  expect(container.textContent).toContain('stop for a person after 5 rounds')
  expect(container.textContent).toContain('cannot message or post')

  await select('plain')
  await act(async () => {})
  expect(container.textContent).not.toContain('stop for a person after')
  expect(container.textContent).not.toContain('cannot message or post')

  await select('debate')
  await act(async () => {})
  expect(container.textContent).not.toContain('stop for a person after')
  expect(container.textContent).not.toContain('cannot message or post')
})

it('late preview cannot re-enable Start after source changes', async () => {
  let resolveA!: (text: string) => void
  const theStore = store({
    entries: [ENTRY('a'), ENTRY('b')],
    source: (id) => (id === 'a' ? new Promise<string>((resolve) => { resolveA = resolve }) : 'version: 2\nname: B\n'),
    preview: (source) => source.includes('name: B')
      ? { ...emptyPreview(), token: null, problems: [{ level: 'error', at: 'roles.b.uses', text: 'There is no usable Agent called "missing".' }] }
      : { ...emptyPreview(), token: 'tokA' },
  })
  const onChange = vi.fn()
  render(theStore, onChange)
  await act(async () => {})

  await select('a')
  await select('b')
  await act(async () => {})
  expect(container.textContent).toContain('There is no usable Agent called')
  expect(onChange).toHaveBeenLastCalledWith(null)

  const callsBefore = onChange.mock.calls.length
  await act(async () => {
    resolveA('version: 2\nname: A\n')
    await Promise.resolve()
    await Promise.resolve()
  })
  // A's late reply changed nothing: no further onChange call adopted it, and
  // B's error is still what is on screen.
  expect(onChange.mock.calls.length).toBe(callsBefore)
  expect(onChange).toHaveBeenLastCalledWith(null)
  expect(container.textContent).toContain('There is no usable Agent called')
})

const previewWithRule = (messaging: FlowPreview['messaging']): FlowPreview => ({
  token: 't', messaging,
  compiled: {
    document: {
      format: 'agents',
      flow: {
        version: 2, name: 'Members', inputs: [], roles: [], messaging, wait: 240,
        seed: { role: 'fixer', title: 'Go' },
        rules: [{ id: 'r1', on: 'fixer', when: { every: ['done'] }, then: { role: 'reviewer', title: 'Look' } }],
      },
    },
    bindings: [], problems: [],
  },
  seats: [], commands: [],
  guards: [{ rule: 'r1', unevidenced: true, requires: [] }],
  problems: [],
})

it('unevidenced merge is an error and messages are disclosure only', async () => {
  const mergeError: FlowPreview = {
    ...emptyPreview(),
    token: null,
    problems: [{ level: 'error', at: 'rules[0]', text: 'This merge step needs fresh evidence. Add an evidence guard before starting it.' }],
  }
  const membersPreview = previewWithRule('members')
  const boardOnlyPreview = previewWithRule('board-only')

  const onChange = vi.fn()
  const theStore = store({
    entries: [ENTRY('merge'), ENTRY('members'), ENTRY('board')],
    source: (id) => `version: 2\nname: ${id}\n`,
    preview: (source) => source.includes('name: merge')
      ? mergeError
      : source.includes('name: members')
        ? membersPreview
        : boardOnlyPreview,
  })
  render(theStore, onChange)
  await act(async () => {})

  await select('merge')
  await act(async () => {})
  expect(container.textContent).toContain('This merge step needs fresh evidence')
  expect(onChange).toHaveBeenLastCalledWith(null)

  await select('members')
  await act(async () => {})
  expect(container.textContent).toContain('Unevidenced')
  expect(container.textContent).toContain('Members may message each other')
  expect(onChange).toHaveBeenLastCalledWith({ source: 'version: 2\nname: members\n', token: 't', vars: {} })

  await select('board')
  await act(async () => {})
  expect(container.textContent).toContain('Board-only: members do not message each other')
})

const previewWithGuard = (): FlowPreview => ({
  token: 't', messaging: 'board-only',
  compiled: {
    document: {
      format: 'agents',
      flow: {
        version: 2, name: 'Guarded', inputs: [], roles: [], messaging: 'board-only', wait: 240,
        seed: { role: 'fixer', title: 'Go' },
        rules: [{ id: 'r1', on: 'verify', when: { every: ['done'] }, then: { role: 'reviewer', title: 'Review the fix' } }],
      },
    },
    bindings: [], problems: [],
  },
  seats: [], commands: [],
  guards: [{ rule: 'r1', unevidenced: false, requires: [{ check: 'verify' }] }],
  problems: [],
})

it("a long guard sentence wraps as the round row's description, not its value column", async () => {
  const theStore = store({
    entries: [ENTRY('guarded')],
    source: (id) => `version: 2\nname: ${id}\n`,
    preview: () => previewWithGuard(),
  })
  render(theStore, () => {})
  await act(async () => {})

  await select('guarded')
  await act(async () => {})

  // The guard's sentence-length requirement belongs in a wrapped description
  // (`data-wrap`), never squeezed into the row's fixed value column — that
  // column does not shrink or wrap, so a sentence placed there instead
  // collapses the title next to it.
  const wrapped = [...container.querySelectorAll('[data-wrap]')].map((el) => el.textContent ?? '').join(' | ')
  expect(wrapped).toContain('A passing “verify” check at the selected revision')
})

const briefPreview = (): FlowPreview => ({
  ...emptyPreview(),
  compiled: compiled({ flow: {
    version: 2, name: 'Fix', inputs: [{ id: 'brief', label: 'Instructions', default: 'Existing draft' }, { id: 'ticket', label: 'Ticket', default: '42' }],
    roles: [], rules: [], seed: { role: 'fixer', title: 'Fix the ticket' }, messaging: 'board-only', wait: 240,
  } }),
})

const chooseBrief = async () => {
  const theStore = store({ entries: [ENTRY('brief'), ENTRY('plain')], source: (id) => id, preview: (source) => source === 'brief' ? briefPreview() : emptyPreview() })
  const onChange = vi.fn()
  render(theStore, onChange)
  await act(async () => {})
  await select('brief')
  return { theStore, onChange }
}

const editBrief = async (value: string) => {
  const control = container.querySelector('textarea')!
  expect(control).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const attachBrief = async (file: File) => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('only a declared brief is multiline; other inputs keep their labels and defaults', async () => {
  await chooseBrief()
  const area = container.querySelector('textarea')!
  expect(area).not.toBeNull()
  expect(area.value).toBe('Existing draft')
  expect(container.querySelector(`label[for="${area.id}"]`)?.textContent).toBe('Brief')
  expect(container.querySelector('input:not([type="file"])')?.getAttribute('value')).toBe('42')
  expect(container.textContent).toContain('Ticket')
  expect(container.textContent).toContain('Attach a file…')
  await select('plain')
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('input[type="file"]')).toBeNull()
})

it('paragraphs reach the preview and the start choice intact as vars.brief', async () => {
  const { theStore, onChange } = await chooseBrief()
  const brief = 'Fix the ticket.\n\nKeep the current interface.\n\nVerify the result.'
  await editBrief(brief)
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'brief', { brief, ticket: '42' })
  expect(onChange).toHaveBeenLastCalledWith({ source: 'brief', token: 't', vars: { brief, ticket: '42' } })
})

it('a text file replaces the brief through the same vars path, including a file at the cap', async () => {
  const { theStore } = await chooseBrief()
  const text = 'A'.repeat(64 * 1024)
  const file = new File([text], 'brief.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'text', { value: async () => text })
  await attachBrief(file)
  expect(container.querySelector('textarea')?.value).toBe(text)
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'brief', { brief: text, ticket: '42' })
})

it('an oversized file is refused before reading and names the cap, preserving the draft', async () => {
  await chooseBrief()
  const file = new File(['A'.repeat(64 * 1024 + 1)], 'brief.txt', { type: 'text/plain' })
  const read = vi.fn()
  Object.defineProperty(file, 'text', { value: read })
  await attachBrief(file)
  expect(read).not.toHaveBeenCalled()
  expect(container.textContent).toContain('64 KiB')
  expect(container.querySelector('textarea')?.value).toBe('Existing draft')
})

it('a non-text or unreadable file preserves the draft and shows a refusal', async () => {
  await chooseBrief()
  const binary = new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })
  const read = vi.fn()
  Object.defineProperty(binary, 'text', { value: read })
  await attachBrief(binary)
  expect(read).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Choose a text file')
  const file = new File(['text'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: async () => { throw new Error('unreadable') } })
  await attachBrief(file)
  expect(container.textContent).toContain('could not be read')
  expect(container.querySelector('textarea')?.value).toBe('Existing draft')
})

it('a late file read cannot replace newer typing or the newly selected flow', async () => {
  const { theStore, onChange } = await chooseBrief()
  let resolve!: (text: string) => void
  const file = new File(['old'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((done) => { resolve = done }) })
  await attachBrief(file)
  await editBrief('Newer typing')
  expect(onChange).toHaveBeenLastCalledWith({ source: 'brief', token: 't', vars: { brief: 'Newer typing', ticket: '42' } })
  await act(async () => resolve('Old file'))
  expect(container.querySelector('textarea')?.value).toBe('Newer typing')
  await attachBrief(file)
  await select('plain')
  await act(async () => resolve('Old file'))
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'plain', {})
  expect(onChange).toHaveBeenLastCalledWith({ source: 'plain', token: 't', vars: {} })
})

it('preview replies for other inputs cannot enable Start during a file read', async () => {
  const { theStore, onChange } = await chooseBrief()
  let resolvePreview!: (preview: FlowPreview) => void
  vi.mocked(theStore.previewFlow).mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve }))
  const ticket = container.querySelector<HTMLInputElement>('input:not([type="file"])')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(ticket, '43')
    ticket.dispatchEvent(new Event('input', { bubbles: true }))
  })
  let resolveFile!: (text: string) => void
  const file = new File(['File brief'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve) => { resolveFile = resolve }) })
  await attachBrief(file)
  await act(async () => resolvePreview(briefPreview()))
  expect(onChange).toHaveBeenLastCalledWith(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(ticket, '44')
    ticket.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onChange).toHaveBeenLastCalledWith(null)
  await act(async () => resolveFile('File brief'))
  expect(onChange).toHaveBeenLastCalledWith({ source: 'brief', token: 't', vars: { brief: 'File brief', ticket: '44' } })
})

it.each(['unreadable', 'binary'])('a pending %s file restores the valid choice without changing the draft', async (kind) => {
  const { onChange } = await chooseBrief()
  const previous = onChange.mock.calls.at(-1)![0]
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  const file = new File(['text'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((done, fail) => { resolve = done; reject = fail }) })
  await attachBrief(file)
  expect(onChange).toHaveBeenLastCalledWith(null)
  await act(async () => {
    if (kind === 'unreadable') reject(new Error('unreadable'))
    else resolve('binary\0text')
  })
  expect(container.querySelector('textarea')?.value).toBe('Existing draft')
  expect(onChange).toHaveBeenLastCalledWith(previous)
})

it('changing a recorded seat preference invalidates consent until that exact choice is previewed', async () => {
  const first: FlowPreview = { ...emptyPreview(), seats: [{ role: 'fixer', index: 0, agent: 'builder', isolate: false, reviews: false,
    plan: { id: 'builder', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'held' }, candidates: [
      candidate({ state: 'taken', label: 'Alpha', reason: null, fix: null }),
      candidate({ state: 'untried', label: 'Beta', seat: { runtime: 'beta' }, reason: null, fix: null }),
    ] } }] }
  let resolve!: (value: FlowPreview) => void
  let calls = 0
  const theStore = store({ entries: [], source: () => 'unused', preview: () => ++calls === 1 ? first : new Promise<FlowPreview>(done => { resolve = done }) })
  const change = vi.fn()
  const initial = { source: 'saved', vars: {} }
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={initial} onChange={change} /></StoreProvider>))
  await select(JSON.stringify({ runtime: 'beta' }))
  expect(change).toHaveBeenLastCalledWith(null)
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: { fixer: [{ runtime: 'beta' }] }, attended: undefined })
  await act(async () => resolve({ ...first, token: 'second' }))
  expect(change).toHaveBeenLastCalledWith({ source: 'saved', vars: {}, token: 'second', seats: { fixer: [{ runtime: 'beta' }] }, attended: undefined })
})

it.each([
  ['Build the checkout', 'Build the checkout'],
  ['', 'What both should attempt'],
  ['  ', 'What both should attempt'],
  ['Keep {{task}} literal', 'Keep {{task}} literal'],
])('fills the seed preview from the form (%s)', async (value, expected) => {
  const flow: import('@harnessdesk/protocol').FlowPolicy = {
    version: 2, name: 'Comparison', inputs: [{ id: 'task', label: 'What both should attempt' }],
    roles: [], seed: { role: 'competitor', title: '{{ task }}' },
    rules: [{ id: 'check', on: 'competitor', then: { role: 'verify', title: 'Check the attempt' } }],
    messaging: 'board-only', wait: 240,
  }
  const theStore = store({ entries: [], source: () => '', preview: () => ({ ...emptyPreview(), compiled: compiled({ flow }) }) })
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={{ source: 'saved', vars: { task: value } }} onChange={() => {}} /></StoreProvider>))
  const rounds = () => container.querySelector('[aria-label="Rounds and rules"]')!.textContent
  expect(rounds()).toContain(`Seed round — ${expected}`)
  const control = container.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(control, 'The edited task')
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(rounds()).toContain('Seed round — The edited task')
})
