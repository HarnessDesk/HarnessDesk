import { approvalId, sessionId, sessionKey, type Approval, type FlowExecution, type Intent } from '@harnessdesk/protocol'
import { approvalDoor, stepDoor, type NeedsYouAnswers } from '../lib/needs-you'
import { teamOverview, type TeamOverviewInput } from '../lib/team-overview'
import { overviewInput, overviewRun } from './team-overview-fixture'

/**
 * What waits on a person, in each way the Overview can be asked to answer it:
 * placeholder names and commands only, drawn by the production row.
 */
export const NEEDS_YOU_STATES = ['approval', 'stdin', 'approval-refused', 'access', 'step', 'question', 'form', 'review', 'refused', 'narrow'] as const
export type NeedsYouScene = typeof NEEDS_YOU_STATES[number]

const at = Date.now() - 90_000
const KEY = sessionKey('codex', 'overview-1')
const base = { sessionId: sessionId('overview-1'), requestedAt: at }

const approvals: Record<'approval' | 'stdin' | 'access' | 'question' | 'form', Approval> = {
  approval: {
    ...base, id: approvalId('answer-command'), type: 'command', command: 'pnpm verify', cwd: '/work/storefront', actions: [],
    reason: 'The check needs a clean checkout of the branch.',
    options: [
      { id: 'no', label: 'Deny', intent: 'deny' },
      { id: 'session', label: 'Allow for this session', intent: 'approveAlways', grant: 'session-tool' },
      { id: 'once', label: 'Allow once', intent: 'approve' },
    ],
  },
  stdin: {
    ...base, id: approvalId('answer-stdin'), type: 'command', kind: 'stdin', command: 'npm login', input: 'y\n', cwd: '/work/storefront', actions: [],
    options: [{ id: 'no', label: 'Deny', intent: 'deny' }, { id: 'once', label: 'Send input', intent: 'approve' }],
  },
  access: {
    ...base, id: approvalId('answer-access'), type: 'permission', summary: 'Reach the package registry',
    reason: 'Installing the checkout dependencies needs the network.',
    filesystem: ['/work/storefront/node_modules'], network: ['registry.example.com'],
    options: [{ id: 'no', label: 'Deny', intent: 'deny' }, { id: 'once', label: 'Allow once', intent: 'approve' }],
  },
  question: {
    ...base, id: approvalId('answer-question'), type: 'userInput', tool: 'ask',
    questions: [{ id: 'target', question: 'Which service should the retry apply to?', multiSelect: false, options: [
      { id: 'payments', label: 'Payments', description: 'The payment service the checkout calls' },
      { id: 'inventory', label: 'Inventory' },
    ] }],
  },
  form: {
    ...base, id: approvalId('answer-form'), type: 'userInput', tool: 'ask',
    questions: [
      { id: 'target', question: 'Which services should the retry apply to?', multiSelect: true, options: [{ id: 'payments', label: 'Payments' }, { id: 'inventory', label: 'Inventory' }] },
      { id: 'limit', question: 'How many attempts?', multiSelect: false, options: [{ id: '3', label: '3' }, { id: '5', label: '5' }] },
    ],
  },
}

/** A step for the person that decides, with a rule after each word; or one that also reads a review. */
const decideRun = (review: boolean): FlowExecution => {
  const run = overviewRun('running')
  const flow = run.document.flow as Extract<FlowExecution['document'], { format: 'agents' }>['flow']
  return {
    ...run,
    rounds: [...run.rounds, { n: 3, role: 'decide', cards: [4], seats: [], evidence: [], state: 'running', cause: 'review' }],
    document: { format: 'agents', flow: {
      ...flow,
      roles: [
        { id: 'fixer', kind: 'agent', uses: ['fixer'], seats: [], isolate: false, grant: 'edit', independentOf: [] },
        { id: 'verify', kind: 'check', check: { run: 'pnpm verify', timeout: 600, exits: { '0': 'pass' }, otherwise: 'fail' } },
        { id: 'decide', kind: 'person', outcomes: ['approved', 'request-changes'] },
      ],
      rules: [
        { id: 'ship', on: 'decide', when: { every: ['approved'], ...(review ? { evidence: [{ review: 'approved' }] } : {}) }, then: { role: 'verify', title: 'Verify the change' } },
        { id: 'rework', on: 'decide', when: { every: ['request-changes'] }, then: { role: 'fixer', title: 'Answer the review' } },
      ],
    } },
  }
}
const decide: Intent = {
  id: 4, title: 'Decide whether the retry change ships', state: 'open', role: 'decide', files: [], dependsOn: [3], createdAt: at, updatedAt: at,
}

const inputOf = (scene: NeedsYouScene): { input: TeamOverviewInput; execution: FlowExecution } => {
  const found = overviewInput('running')
  const asked = scene === 'approval' || scene === 'approval-refused' || scene === 'narrow' ? approvals.approval
    : scene === 'stdin' ? approvals.stdin : scene === 'access' ? approvals.access : scene === 'question' ? approvals.question : scene === 'form' ? approvals.form : null
  const person = scene === 'step' || scene === 'review' || scene === 'refused' || scene === 'narrow'
  const execution = person ? decideRun(scene === 'review') : overviewRun('running')
  const seats = found.seats.slice(0, 3).map((seat, index) => ({
    ...seat, session: null, unreadSince: null, approvals: index === 1 && asked ? [asked] : [],
  }))
  return { execution, input: { ...found, seats, cards: person ? [...found.cards, decide] : found.cards, run: { execution, startedAt: at } } }
}

export const needsYouModel = (scene: NeedsYouScene) => teamOverview(inputOf(scene).input)

/** The doors the window builds from the same data, with a host that takes every request, or refuses answers. */
export const needsYouAnswers = (scene: NeedsYouScene, refusal: string | null = null): NeedsYouAnswers => {
  const { input, execution } = inputOf(scene)
  return {
    stepDoor: (card) => { const found = input.cards.find((one) => one.id === card); return found ? stepDoor(found, execution) : null },
    approvalDoor: (id, key) => {
      const owner = input.seats.find((seat) => sessionKey(seat.record.session.runtime, seat.record.session.sessionId) === key)
      const found = owner?.approvals.find((one) => one.id === id)
      return found ? { key, ...approvalDoor(found) } : null
    },
    answerStep: async () => { if (refusal !== null) throw new Error(refusal) },
    approvalRefusals: (key, id) => scene === 'approval-refused' && key === KEY && id === approvals.approval.id
      ? [{ choiceId: 'once', message: 'The approval was already answered.' }]
      : [],
    respond: async () => {},
    openBoard: () => {},
  }
}
