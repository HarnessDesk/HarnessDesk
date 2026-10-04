import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  approvalId, sessionId, sessionKey, type Approval, type FlowExecution, type FlowPolicyRule, type Intent, type RuntimeInfo,
} from '@harnessdesk/protocol'
import type { NeedsYouAnswers } from '../lib/needs-you'
import { StoreProvider } from './context'
import { answerStep, useNeedsYouAnswers } from './needs-you'
import { emptySnapshot, type AppSnapshot, type AppStore } from './store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let box: HTMLDivElement
let root: Root
beforeEach(() => { box = document.createElement('div'); document.body.append(box); root = createRoot(box) })
afterEach(() => { act(() => root.unmount()); box.remove() })

const ROOM = 'team-1'

it('gives the answer the board gives, as the same request', async () => {
  const teamIntent = vi.fn().mockResolvedValue(undefined)
  const store = { teamIntent } as unknown as AppStore
  await answerStep(store, ROOM, 7, 'approved', '')
  // What the board's own menu sends for a person's word, argument for argument.
  expect(teamIntent).toHaveBeenLastCalledWith(ROOM, 7, 'done', undefined, 'approved')
  await answerStep(store, ROOM, 7, null, '')
  expect(teamIntent).toHaveBeenLastCalledWith(ROOM, 7, 'done')
  // The note is the context package the next round reads.
  await answerStep(store, ROOM, 7, 'approved', 'Ship it.')
  expect(teamIntent).toHaveBeenLastCalledWith(ROOM, 7, 'done', undefined, 'approved', 'Ship it.')
  await answerStep(store, ROOM, 7, null, 'Done by hand.')
  expect(teamIntent).toHaveBeenLastCalledWith(ROOM, 7, 'done', undefined, undefined, 'Done by hand.')
})

it('rejects with the host\'s refusal', async () => {
  const store = { teamIntent: vi.fn().mockRejectedValue(new Error('This card was already answered.')) } as unknown as AppStore
  await expect(answerStep(store, ROOM, 7, 'approved', '')).rejects.toThrow('This card was already answered.')
})

const rule = (id: string, on: string, then: string, when?: FlowPolicyRule['when']): FlowPolicyRule => ({ id, on, ...(when ? { when } : {}), then: { role: then, title: 'Next' } })
const execution = (): FlowExecution => ({
  version: 2, id: 'run-1', goal: ROOM, state: 'running', reason: null, legacyRun: null, operations: [],
  rounds: [{ n: 1, role: 'decide', cards: [7], seats: [], evidence: [], state: 'running', cause: 'seed' }],
  document: { format: 'agents', flow: {
    version: 2, name: 'Flow', inputs: [], roles: [{ id: 'decide', kind: 'person', outcomes: ['approved'] }],
    rules: [rule('ship', 'decide', 'decide', { every: ['approved'] })], seed: { role: 'decide', title: 'Start' }, messaging: 'board-only', wait: 240,
  } },
})
const card = (id: number): Intent => ({ id, title: `Card ${id}`, state: 'open', files: [], dependsOn: [], createdAt: 1, updatedAt: 2, role: 'decide' })
const KEY = sessionKey('acp', 'beta')
const grants = [
  { id: 'no', label: 'Reject', intent: 'deny' as const },
  { id: 'session', label: 'Allow tool', intent: 'approveAlways' as const, grant: 'session-tool' as const },
  { id: 'once', label: 'Allow', intent: 'approve' as const },
]
const tool: Approval = { id: approvalId('a1'), sessionId: sessionId('beta'), requestedAt: 1, type: 'permission', summary: 'claim_work (harnessdesk MCP Server)', options: grants }
const runtime = (id: string, words: boolean, capable = words): RuntimeInfo => ({
  id, presentation: { name: 'Agent', ...(words ? { boardToolApproval: { permanentApprovalSetting: 'setting', sessionOptionLabel: 'Allow for this session', onceOptionLabel: 'Allow once' } } : {}) },
  capabilities: { perToolMcpApproval: capable },
} as unknown as RuntimeInfo)

const mount = (patch: Partial<AppSnapshot>, store: Partial<AppStore> = {}): {
  current: NeedsYouAnswers
  update: (patch: Partial<AppSnapshot>) => void
} => {
  const held: { current: NeedsYouAnswers } = { current: null as never }
  const Probe = () => { held.current = useNeedsYouAnswers({ room: ROOM, execution: execution(), cards: [card(7)], openBoard: () => {} }); return null }
  let snapshot = { ...emptySnapshot(), ...patch } as AppSnapshot
  const listeners = new Set<() => void>()
  const full = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    ...store,
  } as unknown as AppStore
  act(() => root.render(<StoreProvider store={full}><Probe /></StoreProvider>))
  return {
    get current() { return held.current },
    update: (next) => {
      snapshot = { ...snapshot, ...next }
      act(() => listeners.forEach((listener) => listener()))
    },
  }
}

it('finds a person\'s card among the Team\'s cards, and none for a card that is not there', () => {
  const answers = mount({})
  expect(answers.current.stepDoor(7)?.kind).toBe('answer')
  expect(answers.current.stepDoor(8)).toBeNull()
})

it('finds an open request by its id with the conversation it belongs to, words its board-tool grants as the runtime does', () => {
  const answers = mount({ approvals: [{ key: KEY, approval: tool }], runtimes: [runtime('acp', true)] })
  const door = answers.current.approvalDoor(approvalId('a1'), KEY)
  expect(door?.key).toBe(KEY)
  expect(door?.choices.map((one) => one.label)).toEqual(['Reject', 'Allow for this session', 'Allow once'])
  expect(answers.current.approvalDoor(approvalId('gone'), KEY)).toBeNull()
  // Words alone are not enough: the docked card words them only for a runtime that approves tool by tool.
  for (const [words, capable] of [[false, false], [true, false]] as const) {
    const plain = mount({ approvals: [{ key: KEY, approval: tool }], runtimes: [runtime('acp', words, capable)] })
    expect(plain.current.approvalDoor(approvalId('a1'), KEY)?.choices.map((one) => one.label)).toEqual(['Reject', 'Allow tool', 'Allow'])
  }
})

it('uses the full session identity when an approval id is reused by another conversation', () => {
  const otherKey = sessionKey('other', 'beta')
  const otherApproval = { ...tool, options: [{ id: 'other', label: 'Other choice', intent: 'approve' as const }] }
  const answers = mount({
    approvals: [{ key: KEY, approval: tool }, { key: otherKey, approval: otherApproval }],
    runtimes: [runtime('acp', false), runtime('other', false)],
  })
  const door = answers.current.approvalDoor(approvalId('a1'), otherKey)
  expect(door?.key).toBe(otherKey)
  expect(door?.choices.map((one) => one.label)).toEqual(['Other choice'])
})

it('keeps a refused choice with its approval after the request is restored', async () => {
  const message = 'The approval was already answered.'
  const answers = mount({ approvals: [{ key: KEY, approval: tool }] }, {
    respondToApproval: vi.fn().mockResolvedValue({ ok: false, message }),
  })
  await act(async () => {
    await answers.current.respond(KEY, tool, { type: 'option', optionId: 'once' }, 'answer-once')
  })
  expect(answers.current.approvalRefusals(KEY, tool)).toEqual([
    { choiceId: 'answer-once', message },
  ])
})

it('keeps a pending refusal with its request when a new request reuses its id', async () => {
  const message = 'The approval was already answered.'
  let finish!: (result: { ok: false; message: string }) => void
  const response = new Promise<{ ok: false; message: string }>((resolve) => { finish = resolve })
  const original = tool
  const fresh = { ...tool, requestedAt: tool.requestedAt + 1 }
  const answers = mount({ approvals: [{ key: KEY, approval: original }] }, {
    respondToApproval: vi.fn().mockReturnValue(response),
  })
  let pending!: Promise<void>
  act(() => {
    pending = answers.current.respond(KEY, original, { type: 'option', optionId: 'once' }, 'answer-once')
  })

  answers.update({ approvals: [] })
  answers.update({ approvals: [{ key: KEY, approval: fresh }] })
  finish({ ok: false, message })
  await act(async () => pending)

  expect(answers.current.approvalRefusals(KEY, fresh)).toEqual([])
  answers.update({ approvals: [] })
  answers.update({ approvals: [{ key: KEY, approval: original }] })
  expect(answers.current.approvalRefusals(KEY, original)).toEqual([
    { choiceId: 'answer-once', message },
  ])
})

it('does not let a stale row answer a replacement request with the same id', async () => {
  const original = tool
  const fresh = { ...tool, requestedAt: tool.requestedAt + 1 }
  const respondToApproval = vi.fn().mockResolvedValue({ ok: true })
  const answers = mount({ approvals: [{ key: KEY, approval: original }] }, { respondToApproval })
  const staleRespond = answers.current.respond
  answers.update({ approvals: [{ key: KEY, approval: fresh }] })

  await act(async () => staleRespond(KEY, original, { type: 'option', optionId: 'once' }, 'once'))
  expect(respondToApproval).not.toHaveBeenCalled()
  await act(async () => answers.current.respond(KEY, fresh, { type: 'option', optionId: 'once' }, 'once'))
  expect(respondToApproval).toHaveBeenCalledWith(KEY, fresh.id, { type: 'option', optionId: 'once' })
})

it('sends the decision through the store the docked approval answers through', async () => {
  const respondToApproval = vi.fn().mockResolvedValue({ ok: true })
  const answers = mount({ approvals: [{ key: KEY, approval: tool }] }, { respondToApproval })
  await act(async () => answers.current.respond(KEY, tool, { type: 'option', optionId: 'once' }, 'once'))
  expect(respondToApproval).toHaveBeenCalledWith(KEY, 'a1', { type: 'option', optionId: 'once' })
})
