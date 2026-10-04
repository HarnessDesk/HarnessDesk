import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { BoardEvidence, FlowCheckAttempt, FlowCheckAttempts, FlowExecution } from '@harnessdesk/protocol'

import { useCheckAttempts } from './check-attempts'
import { StoreProvider } from './context'
import { emptySnapshot, type AppStore } from './store'

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
const settle = (): Promise<void> => act(async () => {})

const attempt = (n: number, patch: Partial<FlowCheckAttempt> = {}): FlowCheckAttempt =>
  ({ id: `attempt-${n}`, n, at: n * 1000, commit: 'abc', exit: n === 1 ? 1 : 0, timedOut: false, outcome: n === 1 ? 'fail' : 'pass', tail: `attempt ${n}`, ...patch })
const attemptsRead = (attempts: readonly FlowCheckAttempt[], complete = true): FlowCheckAttempts => ({ attempts, complete })

const run = (patch: Partial<FlowExecution> = {}): FlowExecution => ({
  version: 2, id: 'run-1', goal: 'team', state: 'running', reason: null, legacyRun: null,
  operations: [{ key: 'check:2:0', kind: 'check', state: 'finished', card: 2, seat: null }],
  rounds: [
    { n: 1, role: 'writer', cards: [1], seats: [], evidence: [], state: 'closed', cause: 'seed' },
    { n: 2, role: 'verify', cards: [2], seats: [], evidence: [], state: 'closed', cause: 'rule' },
    { n: 3, role: 'verify', cards: [3, 4], seats: [], evidence: [], state: 'running', cause: 'rule' },
  ],
  document: { format: 'agents', flow: { version: 2, name: 'Gate', inputs: [], messaging: 'board-only', wait: 1, rules: [], seed: { role: 'writer', title: 'Go' },
    roles: [{ id: 'writer', kind: 'agent', uses: ['coder'], seats: [], isolate: false, grant: 'edit', independentOf: [] }, { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 60, exits: { '0': 'pass' }, otherwise: 'fail' } }] } },
  ...patch,
})
const evidence = (latest: Record<number, string>, extra: Partial<BoardEvidence> = {}): BoardEvidence => ({ room: 'team', stamp: 1, checks: [], refused: [], unreadable: null, ...extra,
  cards: Object.entries(latest).map(([card, id]) => ({ card: Number(card), running: [], facts: [{ freshness: { state: 'fresh' as const }, by: null,
    record: { id, observedAt: 1, round: 2, fact: { kind: 'check' as const, name: 'verify', run: 'pnpm verify', exit: 0, timedOut: false, at: 'abc', dirty: false, tail: '' } } }] })) })

type Inputs = Parameters<typeof useCheckAttempts>[0]
let latest: ReturnType<typeof useCheckAttempts>
const Probe = (props: Inputs) => { latest = useCheckAttempts(props); return null }
const storeOf = (read: (run: string, card: number) => Promise<FlowCheckAttempts>) => {
  const readCheckAttempts = vi.fn(read)
  return { store: { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), readCheckAttempts } as unknown as AppStore, readCheckAttempts }
}
const mount = async (store: AppStore, props: Inputs) => {
  act(() => root.render(<StoreProvider store={store}><Probe {...props} /></StoreProvider>))
  await settle()
}

it('reads the attempts of every check card of the Run, and only the check cards, while the Run is on show', async () => {
  const { store, readCheckAttempts } = storeOf(async (_run, card) => attemptsRead([attempt(1), attempt(2, { tail: `card ${card}` })]))
  await mount(store, { execution: run(), evidence: evidence({ 2: 'f1' }), active: true })
  expect(readCheckAttempts.mock.calls.map(([run, card]) => `${run}:${card}`).sort()).toEqual(['run-1:2', 'run-1:3', 'run-1:4'])
  expect([...latest.attempts!.keys()].sort()).toEqual([2, 3, 4])
  expect(latest.attempts!.get(3)![1]!.tail).toBe('card 3')
  expect(latest.read).toBeUndefined()
})

it('reads nothing while the Run is not on show, and nothing for a Run with no check card', async () => {
  const { store, readCheckAttempts } = storeOf(async () => attemptsRead([attempt(1)]))
  await mount(store, { execution: run(), evidence: undefined, active: false })
  await mount(store, { execution: run({ rounds: [run().rounds[0]!] }), evidence: undefined, active: true })
  await mount(store, { execution: undefined, evidence: undefined, active: true })
  expect(readCheckAttempts).not.toHaveBeenCalled()
})

it('says reading until the first answer lands, then nothing', async () => {
  let answer!: (read: FlowCheckAttempts) => void
  const { store } = storeOf(() => new Promise(resolve => { answer = resolve }))
  act(() => root.render(<StoreProvider store={store}><Probe execution={run({ rounds: [run().rounds[1]!] })} evidence={undefined} active /></StoreProvider>))
  expect(latest.read).toBe('reading')
  expect(latest.attempts?.size ?? 0).toBe(0)
  await act(async () => answer(attemptsRead([attempt(1), attempt(2)])))
  expect(latest.read).toBeUndefined()
  expect(latest.attempts!.get(2)).toHaveLength(2)
})

it('says reading for a newly opened check in the same Run and keeps attempts already read', async () => {
  let release!: (read: FlowCheckAttempts) => void
  const { store } = storeOf(async (_run, card) => card === 2
    ? attemptsRead([attempt(1), attempt(2)])
    : new Promise(resolve => { release = resolve }))
  const base = run()
  const original = { ...base, rounds: [base.rounds[1]!] }
  await mount(store, { execution: original, evidence: undefined, active: true })
  expect(latest.attempts!.get(2)).toHaveLength(2)

  const added = { ...base, rounds: [base.rounds[1]!, { ...base.rounds[2]!, cards: [5] }] }
  act(() => root.render(<StoreProvider store={store}><Probe execution={added} evidence={undefined} active /></StoreProvider>))
  expect(latest.read).toBe('reading')
  expect(latest.attempts!.get(2)).toHaveLength(2)
  await act(async () => release(attemptsRead([attempt(1)])))
  expect(latest.read).toBeUndefined()
})

it('keeps readable attempts and marks a partial history', async () => {
  const { store } = storeOf(async () => attemptsRead([attempt(1)], false))
  await mount(store, { execution: run({ rounds: [run().rounds[1]!] }), evidence: undefined, active: true })
  expect(latest.attempts!.get(2)!.map(one => one.id)).toEqual(['attempt-1'])
  expect(latest.attempts!.get(2)![0]!.n).toBeNull()
  expect(latest.incomplete.has(2)).toBe(true)
  expect(latest.read).toBeUndefined()
})

it('keeps earlier readable results but removes their ordinals when a later read is incomplete', async () => {
  let partial = false
  const { store } = storeOf(async () => partial
    ? attemptsRead([attempt(3)], false)
    : attemptsRead([attempt(1), attempt(2)]))
  const props = { execution: run({ rounds: [run().rounds[1]!] }), active: true }
  await mount(store, { ...props, evidence: evidence({ 2: 'f1' }) })
  partial = true
  await mount(store, { ...props, evidence: evidence({ 2: 'f2' }) })
  expect(latest.incomplete.has(2)).toBe(true)
  expect(latest.attempts!.get(2)!.map(one => one.id)).toEqual(['attempt-1', 'attempt-2', 'attempt-3'])
  expect(latest.attempts!.get(2)!.map(one => one.n)).toEqual([null, null, null])
})

it('reads a card again when a new result lands for it or its operation moves, and not when something else changes', async () => {
  const { store, readCheckAttempts } = storeOf(async () => attemptsRead([attempt(1), attempt(2)]))
  const props = { execution: run({ rounds: [run().rounds[1]!] }), active: true }
  await mount(store, { ...props, evidence: evidence({ 2: 'f1' }) })
  expect(readCheckAttempts).toHaveBeenCalledTimes(1)
  // A periodic refresh of the board stamps it afresh, a pull request arrives, a finding is raised: none is a result of this check.
  await mount(store, { ...props, evidence: { ...evidence({ 2: 'f1' }), stamp: 99 } })
  await mount(store, { ...props, evidence: { ...evidence({ 2: 'f1' }), cards: [...evidence({ 2: 'f1' }).cards, { card: 2, running: [], facts: [{ freshness: { state: 'fresh' }, by: null, record: { id: 'pr', observedAt: 5, round: null, fact: { kind: 'pr', number: 7, head: 'abc', state: 'open', url: null } } }] }] } })
  expect(readCheckAttempts).toHaveBeenCalledTimes(1)
  await mount(store, { ...props, evidence: evidence({ 2: 'f2' }) })
  expect(readCheckAttempts).toHaveBeenCalledTimes(2)
  await mount(store, { ...props, execution: { ...props.execution, operations: [{ key: 'check:2:0', kind: 'check', state: 'started', card: 2, seat: null }] }, evidence: evidence({ 2: 'f2' }) })
  expect(readCheckAttempts).toHaveBeenCalledTimes(3)
})

it('reads again when asked to', async () => {
  const { store, readCheckAttempts } = storeOf(async () => attemptsRead([attempt(1), attempt(2)]))
  const props = { execution: run({ rounds: [run().rounds[1]!] }), evidence: undefined, active: true }
  await mount(store, { ...props, nonce: 0 })
  await mount(store, { ...props, nonce: 1 })
  expect(readCheckAttempts).toHaveBeenCalledTimes(2)
})

it('keeps the attempts it has when a later read fails, and says the read failed', async () => {
  let fail = false
  const { store } = storeOf(async () => { if (fail) throw new Error('The desk did not answer.'); return attemptsRead([attempt(1), attempt(2)]) })
  const props = { execution: run({ rounds: [run().rounds[1]!] }), active: true }
  await mount(store, { ...props, evidence: evidence({ 2: 'f1' }) })
  expect(latest.attempts!.get(2)).toHaveLength(2)
  fail = true
  await mount(store, { ...props, evidence: evidence({ 2: 'f2' }) })
  expect(latest.read).toBe('failed')
  expect(latest.attempts!.get(2)).toHaveLength(2)
  fail = false
  await mount(store, { ...props, evidence: evidence({ 2: 'f3' }) })
  expect(latest.read).toBeUndefined()
})

it('never shows one Run’s attempts under another, and drops an answer that arrives after the Run changed', async () => {
  let answer!: (read: FlowCheckAttempts) => void
  const { store } = storeOf((id) => id === 'run-1' ? new Promise(resolve => { answer = resolve })
    : id === 'run-3' ? new Promise(() => {}) : Promise.resolve(attemptsRead([attempt(1), attempt(2, { tail: 'run two' })])))
  const one = { execution: run({ rounds: [run().rounds[1]!] }), evidence: undefined, active: true }
  await mount(store, one)
  await mount(store, { ...one, execution: { ...one.execution, id: 'run-2' } })
  expect(latest.attempts!.get(2)![1]!.tail).toBe('run two')
  await act(async () => answer(attemptsRead([attempt(1), attempt(2, { tail: 'run one, late' })])))
  expect(latest.attempts!.get(2)![1]!.tail).toBe('run two')
  // A third Run still being read shows nothing of the second's: it is reading, not none.
  await mount(store, { ...one, execution: { ...one.execution, id: 'run-3' } })
  expect(latest.attempts).toBeUndefined()
  expect(latest.read).toBe('reading')
})
