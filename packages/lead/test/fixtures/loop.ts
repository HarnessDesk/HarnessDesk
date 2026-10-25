import assert from 'node:assert/strict'
import { parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import type { ClientEvent } from '@harnessdesk/client'
import * as lead from '../../src/index.js'
import { fakeMessages, message, type FakeStep } from './fake-messages.js'

export const project = { id: 'demo', path: '/workspace/demo' }
export const policy = { version: 1 as const, revision: 1, mode: 'manage' as const, rules: [] }
export const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Repair the check', project,
  policyRevision: 1, steps: [{ id: 'work', title: 'Reviewed repair', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1',
    variables: {}, attendance: 'attended', assignments: [
      { role: 'implement', agent: 'implementer', seat: { runtime: 'fixture', model: 'fixture/model' }, ceiling: 'edit' },
      { role: 'review', agent: 'code-reviewer', seat: { runtime: 'fixture', model: 'fixture/model' }, ceiling: 'read' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'Unit check passes' }, { id: 'review', kind: 'review', description: 'Independent review approves' },
    { id: 'blockers', kind: 'blocking-findings', description: 'No unresolved blockers' }], caps: { usdMicros: 100_000, rounds: 10 } })
export const input = { messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Plan the repair' }] }], maxTokens: 100 }
export const click = { version: 1 as const, cardId: 'plan', cardType: 'plan' as const, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' as const }
export const evidence = () => ({ project, runId: 'run-1', contractDigest: contract.digest, revision: 'head-1', observedAt: 100,
  complete: true, spendComplete: true, checks: [{ assertionId: 'unit', id: 'check-1', revision: 'head-1', observedAt: 100,
    exit: 0, timedOut: false, dirty: false, counted: true }],
  reviews: [{ assertionId: 'review', id: 'review-1', revision: 'head-1', observedAt: 100, verdict: 'approve', complete: true }],
  findings: [], findingsComplete: true, diffs: [] })
export const exported = (name: string): any => {
  const value = (lead as Record<string, unknown>)[name]
  assert.equal(typeof value, 'function', `${name} must enforce the portable management guard`)
  return value
}
export const fixture = async (steps: FakeStep[] = [message()]) => {
  const records: lead.LeadJournalRecord[] = []
  const storage = { async read() { return structuredClone(records) }, async append(record: lead.LeadJournalRecord) { records.push(structuredClone(record)) } }
  const journal = await lead.createLeadJournal(storage)
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: contract.caps, freshnessMs: 1000 })
  const calls: any[] = [], scheduled: (() => void)[] = [], fake = fakeMessages(steps)
  let now = 100, seq = 0, ready = true, generation = 0, previewExpires = 200, resolvedStep = contract.steps[0]
  let snapshot: any = { teams: [], runs: [], boards: [], seats: [], approvals: [], reviews: [], waiting: [] }
  let currentEvidence: any = evidence()
  let wake: ((value: IteratorResult<ClientEvent>) => void) | null = null
  const events: ClientEvent[] = []
  let done = false
  const iterator = { next(): Promise<IteratorResult<ClientEvent>> {
    if (events.length) return Promise.resolve({ done: false, value: events.shift()! })
    if (done) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => { wake = resolve })
  }, async return() { done = true; wake?.({ done: true, value: undefined }); return { done: true as const, value: undefined } } }
  const emit = (body: Record<string, unknown>) => {
    const event = { v: 1, at: '2026-10-17T12:00:00Z', ...body } as ClientEvent
    if (wake) { const resolve = wake; wake = null; resolve({ done: false, value: event }) } else events.push(event)
  }
  const desk = { async call(method: string, params: unknown) {
    calls.push({ method, params })
    if (method === 'client/subscribe') return { baseline: ++generation }
    if (method === 'flow/start-goal') return { id: 'run-1', goal: 'team-1', rounds: [{ n: 1 }], state: 'running' }
    if (method === 'flow/execution') return { id: 'run-1', goal: 'team-1', rounds: [{ n: 1 }], state: 'running' }
    return { ok: true }
  }, events() { return { [Symbol.asyncIterator]: () => iterator } }, async synced() { if (!ready) throw new Error('baseline unavailable') }, snapshot() { return structuredClone(snapshot) } }
  const options: any = { journal, desk, clock: { now: () => now, schedule(callback: () => void) {
    scheduled.push(callback); return () => { const at = scheduled.indexOf(callback); if (at >= 0) scheduled.splice(at, 1) }
  } }, project, nextId: () => `loop-${++seq}`,
    messages: { apiKey: 'synthetic-loop-key', model: 'fixture-model', prices: { 'fixture-model': {
      inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000,
      cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 } }, transport: fake,
      countInput: async () => 100, wait: async () => {} },
    freezePlan: async (proposal: unknown) => structuredClone(proposal),
    resolveTool: async (call: any) => ({ project, runId: call.params.run ?? null,
      start: call.method === 'flow/start-goal' ? resolvedStep : null, stepId: 'work',
      preview: { token: 'preview-1', source: (lead as any).leadReviewedResultSource, expiresAt: previewExpires },
      context: { desk: policy, projectPolicy: null, project, approved: null, budget: null, now, policyInterpretation: 'idle' } }),
    readEvidence: async () => structuredClone(currentEvidence) }
  return { journal, records, storage, calls, fake, options, emit, scheduled,
    setNow(value: number) { now = value }, setReady(value: boolean) { ready = value }, setPreviewExpires(value: number) { previewExpires = value },
    setStep(value: any) { resolvedStep = value }, setSnapshot(value: any) { snapshot = value }, setEvidence(value: any) { currentEvidence = value },
    async approve() { await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: contract.digest, contract }); await journal.decideCard(click, 1000) },
    async drain() { for (let i = 0; i < 40; i++) await Promise.resolve() },
    async tick() { for (const callback of scheduled.splice(0)) callback(); for (let i = 0; i < 100; i++) await Promise.resolve() } }
}
