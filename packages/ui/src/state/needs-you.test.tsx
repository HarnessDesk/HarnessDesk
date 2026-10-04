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
const runtime = (id: string, words: boolean): RuntimeInfo => ({
  id, presentation: { name: 'Agent', ...(words ? { boardToolApproval: { permanentApprovalSetting: 'setting', sessionOptionLabel: 'Allow for this session', onceOptionLabel: 'Allow once' } } : {}) },
  capabilities: { perToolMcpApproval: words },
} as unknown as RuntimeInfo)

const mount = (patch: Partial<AppSnapshot>, store: Partial<AppStore> = {}): { current: NeedsYouAnswers } => {
  const held: { current: NeedsYouAnswers } = { current: null as never }
  const Probe = () => { held.current = useNeedsYouAnswers({ room: ROOM, execution: execution(), cards: [card(7)], openBoard: () => {} }); return null }
  const snapshot = { ...emptySnapshot(), ...patch } as AppSnapshot
  const full = { subscribe: () => () => {}, getSnapshot: () => snapshot, ...store } as unknown as AppStore
  act(() => root.render(<StoreProvider store={full}><Probe /></StoreProvider>))
  return held
}

it('finds a person\'s card among the Team\'s cards, and none for a card that is not there', () => {
  const answers = mount({})
  expect(answers.current.stepDoor(7)?.kind).toBe('answer')
  expect(answers.current.stepDoor(8)).toBeNull()
})

it('finds an open request by its id with the conversation it belongs to, words its board-tool grants as the runtime does', () => {
  const answers = mount({ approvals: [{ key: KEY, approval: tool }], runtimes: [runtime('acp', true)] })
  const door = answers.current.approvalDoor(approvalId('a1'))
  expect(door?.key).toBe(KEY)
  expect(door?.choices.map((one) => one.label)).toEqual(['Reject', 'Allow for this session', 'Allow once'])
  expect(answers.current.approvalDoor(approvalId('gone'))).toBeNull()
  const plain = mount({ approvals: [{ key: KEY, approval: tool }], runtimes: [runtime('acp', false)] })
  expect(plain.current.approvalDoor(approvalId('a1'))?.choices.map((one) => one.label)).toEqual(['Reject', 'Allow tool', 'Allow'])
})

it('sends the decision through the store the docked approval answers through', () => {
  const respondToApproval = vi.fn().mockResolvedValue(undefined)
  const answers = mount({}, { respondToApproval })
  answers.current.respond(KEY, approvalId('a1'), { type: 'option', optionId: 'once' })
  expect(respondToApproval).toHaveBeenCalledWith(KEY, 'a1', { type: 'option', optionId: 'once' })
})
