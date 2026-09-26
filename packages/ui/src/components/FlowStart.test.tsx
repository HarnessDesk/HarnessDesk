import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, CompiledFlow, FlowEntry, FlowPreview, FlowPreviewSeat, SeatCandidate, SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot } from '../state/snapshot'
import type { AppStore } from '../state/store'
import { FlowStart, type FlowChoice } from './FlowStart'

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
  expect(chips).toEqual(expect.arrayContaining(['Edit · held', 'Read · asked']))
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
