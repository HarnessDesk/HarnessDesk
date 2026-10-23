import { createLeadJournal, createLeadTools, leadReviewedResultSource, type LeadJournalRecord } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import { LeadAdmission } from '../../src/lead/admission.js'
import { LeadBudgets } from '../../src/lead/budgets.js'
import { FlowPreviews } from '../../src/flow-preview.js'
import { createLeadClientAuthority } from '../../src/lead/client-authority.js'
import { flowMethods } from '../../src/methods/flows.js'
import { agent, goalRig } from './flow-goal-rig.js'

export const leadRig = async (t: { after(fn: () => Promise<void>): void }) => {
  let budgets!: LeadBudgets
  const rig = await goalRig(t, { executionOptions: { lead: {
    bind: (run: any) => budgets.bind(run), round: (run: any, id: string) => budgets.round(run, id), gate: (run: any) => budgets.gate(run),
  } } })
  rig.providers.set('alpha', 'writer-vendor'); rig.providers.set('beta', 'review-vendor')
  const project = { id: 'demo', path: rig.dir }
  const records: LeadJournalRecord[] = []
  const storage = { async read() { return structuredClone(records) }, async append(record: LeadJournalRecord) { records.push(structuredClone(record)) } }
  const journal = await createLeadJournal(storage)
  const seats = { implement: [{ runtime: 'alpha', model: 'fixture/model' }], review: [{ runtime: 'beta', model: 'fixture/model' }] }
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair the check', project,
    policyRevision: 1, steps: [{ id: 'work', title: 'Repair', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended', assignments: [
      { role: 'implement', agent: 'implementer', seat: seats.implement[0], ceiling: 'edit' },
      { role: 'review', agent: 'code-reviewer', seat: seats.review[0], ceiling: 'read' }] }],
    assertions: [{ id: 'review', kind: 'review', description: 'Independent review' }], caps: { usdMicros: 100_000, rounds: 10 } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: contract.caps, freshnessMs: 1000 })
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 1000)
  let member = true, held = true, now = 100, next = 0, stopFails = false, admitted = 0
  const agents = [agent('implementer', ['committed']), { ...agent('code-reviewer', ['approve', 'request-changes'], 'beta'),
    definition: { ...agent('code-reviewer', ['approve', 'request-changes'], 'beta').definition!, ceiling: 'read' as const, produces: ['review' as const] } }]
  const previews = new FlowPreviews({ confine: async () => {}, agents: async () => agents,
    providerOf: async runtime => rig.providers.get(runtime) ?? null,
    previewAgent: async (_root, id, choices, grant, options) => ({ id, from: 'prefer', winner: 0, blocked: null,
      ceiling: { level: grant, hold: held && options?.requireHeld ? 'held' : 'asked' }, candidates: [
        { seat: choices[0] ?? { runtime: id === 'implementer' ? 'alpha' : 'beta' }, label: 'Synthetic', runtimeName: 'Synthetic', state: 'taken', reason: null, fix: null }] }), now: () => now })
  const timers = new Map<number, () => void>()
  let timerId = 0
  budgets = new LeadBudgets({ schedule: callback => {
    const id = ++timerId; timers.set(id, callback)
    return () => { timers.delete(id) }
  }, now: () => now, runs: () => rig.flows.leadRuns(), member: async () => member,
    interruptChecks: goal => rig.flows.interruptChecks(goal), stop: async (run, reason) => {
      if (stopFails) throw new Error('synthetic cleanup failure')
      return rig.flows.stopRun(run, reason, 'desk')
    } })
  const unregister = budgets.register(journal)
  t.after(async () => { await budgets.idle(); unregister() })
  const admission = new LeadAdmission({ journal, budgets, previews, project, readIntents: goal => rig.team.stateFor(goal).intents, now: () => now, nextId: () => `host-start-${++next}` })
  const authority = await createLeadClientAuthority({ host: { call: async () => ({ goal: { root: project.path } }),
    clientScopeViews: () => journal.state.runs.map(run => ({ goal: { id: run.teamId, root: project.path } })) } as any,
    project: project.path, owned: [], admission })
  const ctx: any = { flowPreviews: previews, flows: rig.flows, leadStarts: budgets, workspaces: { admitTeamProject: async () => { admitted++ } } }
  const params = async () => {
    const preview = await admission.preview({ root: project.path, source: leadReviewedResultSource, vars: {}, seats, attended: true })
    if (!preview.token) throw new Error(JSON.stringify(preview.problems))
    return { root: project.path, source: leadReviewedResultSource, sentence: contract.goal, token: preview.token, vars: {}, seats, attended: true }
  }
  const admit = async (request: Awaited<ReturnType<typeof params>>) => {
    let ready!: () => void, finish!: () => void
    const entered = new Promise<void>(resolve => { ready = resolve })
    const finished = new Promise<void>(resolve => { finish = resolve })
    const id = `child-start-${++next}`, step = contract.steps[0]!
    const task = journal.execute({ id, stepId: step.id,
      request: { method: 'flow/start-goal', params: request, project, runId: null, start: step },
      context: { desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now, policyInterpretation: 'idle' } }, async () => {
        ready(); await finished
        const run = journal.state.runs.find(run => run.correlationId === id)
        return run ? { value: null, identity: run } : { value: null, identity: null, created: false }
      })
    t.after(async () => { finish(); await task })
    await Promise.race([entered, task.then(() => { throw new Error('fixture start was refused') })])
  }
  const start = async () => {
    const request = await params()
    const tools = createLeadTools({ journal, project, now: () => now, nextId: () => `child-start-${++next}`, synchronized: () => true,
      desk: { call: async (method: any, args: any) => {
        const refused = await authority.authorize({ id: 1, method, params: args })
        if (refused) throw new Error(refused)
        return (flowMethods as any)[method](ctx, args)
      } } as any,
      resolveTool: async () => ({ project, runId: null, start: contract.steps[0]!, stepId: 'work',
        preview: { token: request.token, source: request.source, expiresAt: now + 1000 },
        context: { desk: journal.state.policy!, projectPolicy: null, project, approved: null, budget: null, now, policyInterpretation: 'idle' } }) })
    const result = await tools.execute({ method: 'flow/start-goal', params: request })
    if (result.outcome !== 'succeeded') throw new Error(`fixture start: ${result.outcome}`)
    return result.value as Awaited<ReturnType<typeof flowMethods['flow/start-goal']>>
  }
  const observe = async (usdMicros = 1) => {
    const budget = journal.state.budget!
    await budgets.update('logical-1', { version: 1, type: 'observe', now, at: now, revision: budget.revision + 1, source: 'worker-samples', sourceIds: ['synthetic-sample'],
      goalId: budget.goalId!, executionIds: budget.executionIds, quality: 'known', usdMicros })
  }
  return { rig, journal, storage, budgets, previews, admission, authority, ctx, params, admit, start, observe, unregister, contract, project, records,
    admitted: () => admitted, setMember: (value: boolean) => { member = value }, setHeld: (value: boolean) => { held = value },
    setNow: (value: number) => { now = value }, setStopFails: (value: boolean) => { stopFails = value },
    /** Runs every callback the budgets have scheduled, as the host's timers would once they are due. */
    fireTimers: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback() } } }
}
