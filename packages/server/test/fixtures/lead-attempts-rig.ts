import { realpath } from 'node:fs/promises'
import type { TestContext } from 'node:test'
import { createLeadJournal, type LeadJournalRecord, type LeadPermissionCall, type LeadPermissionContext } from '@harnessdesk/lead'
import { evidenceDesk } from './evidence-desk.js'

/** The real host and its context, an ordinary fake runtime and a journaled Lead; no child, model or vendor traffic. */
export const rig = async (t: TestContext, prior?: { readonly stateDir: string; readonly repo: Awaited<ReturnType<typeof evidenceDesk>>['repo']; readonly records: LeadJournalRecord[] }) => {
  const { StateStore } = await import('../../src/index.js')
  const { tempDir } = await import('../scratch.js')
  const stateDir = prior?.stateDir ?? tempDir('hd-lead-attempts-state-')
  const state = new StateStore(`${stateDir}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state }, prior ? { stateDir: prior.stateDir, repo: prior.repo } : undefined)
  const project = { id: 'project-demo', path: await realpath(desk.repo.dir) }
  const records: LeadJournalRecord[] = prior?.records ?? []
  const journal = await createLeadJournal({ read: async () => [...records], append: async record => { records.push(record) } })
  if (!prior) {
    await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
    await journal.updateBudget({ version: 1, type: 'initialize', logicalGoalId: 'ordinary-delegation', now: Date.now(), caps: { usdMicros: 100000, rounds: 3 }, freshnessMs: 60000 })
  }
  const context = (): LeadPermissionContext => ({ desk: journal.state.policy!, projectPolicy: null, project, approved: null,
    budget: null, now: Date.now(), policyInterpretation: 'idle' })
  const service = desk.host.createLeadService({ journal, project, prices: {},
    resolveTool: async () => ({ project, runId: null, start: null, stepId: null, context: context() }),
    freezePlan: async proposal => proposal, readEvidence: async () => { throw new Error('unused') },
    createSupervisor: () => ({ live: false, ensure: async () => {}, send: async () => ({ status: 'completed', text: '' }), stop: async () => {}, ownershipWithdrawn() {} }),
  })
  await service.setEnabled(true)
  let attempt = records.length
  const execute = (call: LeadPermissionCall) => journal.execute({ id: `attempt-${++attempt}`, request: { ...call, project, runId: null, start: null }, context: context() },
    async parsed => ({ value: await desk.host.call(parsed.method, parsed.params as never), identity: null }))
  /** The person writes to the Lead: the journal's own record of a person message, as the window's send appends it. */
  let said = records.length
  const personWrites = async (text: string) => journal.appendMessage(`person-${++said}`, text, 'person')
  const answer = async (text: string) => {
    await desk.host.leadPresence.observe()
    const finish = await desk.host.leadPresence.beforeSend(undefined, text)
    const receipt = await personWrites(text)
    await finish?.(true, receipt.messageId)
  }
  return { ...desk, stateDir, project, journal, records, execute, personWrites, answer }
}
export type Rig = Awaited<ReturnType<typeof rig>>
