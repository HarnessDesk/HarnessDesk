import type { LeadJournalPort } from './child-ipc.js'
import { clientTierFor, parseLeadAcceptanceContract, type LeadAcceptanceContract, type LeadAction, type LeadProject, type LeadThreadState, type LeadAssertionResult, type LeadBudgetState } from '@harnessdesk/protocol'
import type { ClientEvent, ClientSnapshot } from '@harnessdesk/client'
import { leadInstructions, leadObservation, type LeadSeatChoices } from './instructions.js'
import { createLeadMessages } from './messages.js'
import type { LeadMessagesOptions, LeadMessagesRequest, LeadMessagesResult, MessagesTurn } from './messages-types.js'
import { createLeadTools, LEAD_TOPICS, leadWorkerApprovalRelay, type LeadResolvedTool } from './tools.js'
import { evaluateLeadAcceptance, type LeadAcceptanceEvidence, type LeadAcceptanceResult } from './acceptance.js'
import { leadBudgetProjection } from './budget.js'
import { leadPlanRuns } from './state.js'
import type { LeadDeskPort } from './ports.js'
import type { LeadPermissionCall } from './permissions.js'

export interface LeadLoopClock {
  now(): number
  /** One deferred batch, not one callback per event. Must not invoke synchronously.
   * The owner chooses the coalescing window; detach cancels a pending batch. */
  schedule(callback: () => void): () => void
}
export interface LeadLoopOptions {
  readonly journal: LeadJournalPort
  readonly desk: LeadDeskPort
  readonly project: LeadProject
  readonly clock: LeadLoopClock
  readonly nextId: () => string
  readonly messages: Omit<LeadMessagesOptions, 'journal' | 'now' | 'nextId' | 'resolveTool' | 'dispatch'>
  /** Resolve eligibility and mint the frozen approval digest from host facts.
   * This is preparation only: the authenticated window owns the later click. */
  readonly freezePlan: (proposal: LeadAcceptanceContract) => Promise<LeadAcceptanceContract>
  readonly resolveTool: (call: LeadPermissionCall) => Promise<LeadResolvedTool>
  /** Host-derived normalized evidence. Reads use this permission-checked reader;
   * the port must not turn assistant prose into evidence or claim complete paging. */
  readonly readEvidence: (runId: string, read: (call: LeadPermissionCall) => Promise<unknown>) => Promise<LeadAcceptanceEvidence>
  readonly freshnessMs?: number
  /** What a plan's assignments may name. Absent means the desk offers no seat, and the model is told so. */
  readonly seats?: LeadSeatChoices
}
export interface LeadLoopState {
  readonly phase: LeadThreadState
  readonly reason: string | null
  readonly synchronized: boolean
  readonly snapshot: ClientSnapshot | null
  readonly relays: readonly ReturnType<typeof leadWorkerApprovalRelay>[]
  readonly acceptance: readonly { readonly runId: string; readonly result: LeadAcceptanceResult }[]
}
const terminal = (phase: LeadThreadState) => ['accepted', 'declined', 'stopped'].includes(phase)
const resultSignature = (contract: string, assertions: readonly LeadAssertionResult[], budget: LeadBudgetState) => JSON.stringify({
  contract, assertions: assertions.map(({ revision: _revision, ...fact }) => fact),
  budget: { caps: budget.caps, leadUsdMicros: budget.leadUsdMicros, workerUsdMicros: budget.workerUsdMicros,
    reservedUsdMicros: budget.reservedUsdMicros, spend: budget.spend, stop: budget.stop },
})
const empty = (): ClientSnapshot => ({ teams: [], runs: [], boards: [], seats: [], approvals: [], reviews: [], waiting: [] })
/** API-only management. Messages is the sole model brain. This owner supplies
 * scope, observations, durable cards and wakeups; it never interprets a CLI or
 * treats the subscription stream as an alternate agent. */
export const createLeadLoop = (options: LeadLoopOptions) => {
  const { journal, desk, project, clock, nextId } = options
  let synchronized = false, generation = 0, closed = false, reason: string | null = null
  let personActions: LeadAction[] = []
  let snapshot: ClientSnapshot | null = null, relays: ReturnType<typeof leadWorkerApprovalRelay>[] = []
  let acceptance: { runId: string; result: LeadAcceptanceResult }[] = []
  let cancelBatch: (() => void) | null = null, dirty = false, continuationPending = false
  let tail: Promise<unknown> = Promise.resolve(), iterator: AsyncIterator<ClientEvent> | null = null
  let pump: Promise<void> | null = null, active: AbortController | null = null
  let history: readonly MessagesTurn[] | null = null, requestTemplate: LeadMessagesRequest | null = null
  let lastResultSignature: string | null = null
  let noProgressTurns = 0, waitingForResume = false
  const tools = createLeadTools({ journal, desk, project, now: () => clock.now(), nextId, synchronized: () => synchronized && !closed,
    resolveTool: options.resolveTool })
  const messages = createLeadMessages({ ...options.messages, journal, now: () => clock.now(), nextId,
    resolveTool: tools.resolveTool, dispatch: tools.dispatch })
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation)
    tail = next.catch(() => {})
    return next
  }
  // Built once for a goal and then reused byte for byte: a provider refuses to replay reasoning behind a
  // system prompt that changed, so a rename or a settings change waits for the next goal.
  let instructionsFor: string | null = null, instructions = ''
  const standingInstructions = (): string => {
    const state = journal.state, goal = state.budget?.logicalGoalId ?? ''
    if (instructionsFor !== goal) {
      instructions = leadInstructions({ name: state.name === 'lex' ? 'Lex' : 'Dex', project, policyRevision: state.policy?.revision ?? 1,
        caps: state.budget!.caps, ...(options.seats ? { seats: options.seats } : {}) })
      instructionsFor = goal
    }
    return instructions
  }
  const waitForUser = async (code: string) => {
    if (!terminal(journal.state.phase)) {
      await journal.setManagementPhase('waiting-for-user', code)
      waitingForResume = true
    }
    else reason = code
  }
  const read = async (call: LeadPermissionCall): Promise<unknown> => {
    if (clientTierFor(call.method, call.params) !== 'read') throw new Error('lead-observation-read-only')
    const result = await tools.execute(call)
    if (result.outcome !== 'succeeded') throw new Error('lead-observation-unavailable')
    return result.value
  }
  const invalidate = async () => {
    if (lastResultSignature !== null || journal.state.cards.some(card => card.type === 'result' && !journal.state.decidedCards.includes(`${card.id}:${card.revision}`)))
      await journal.invalidateResults()
    acceptance = []
  }
  const writeOffUncertain = async () => {
    for (const request of journal.state.budget?.requests ?? []) if (request.uncertain)
      await journal.updateBudget({ version: 1, type: 'write-off', now: clock.now(), requestId: request.reservation.requestId })
  }
  const refresh = async (): Promise<void> => {
    if (closed) return
    const expected = generation
    try {
      await desk.synced()
      const next = structuredClone(desk.snapshot())
      // Whole replacement, including cleared waiting/approval/review collections.
      if (generation !== expected || closed) return
      snapshot = next
      await tools.settleStarts()
      await writeOffUncertain()
      const state = journal.state, contract = state.contract
      relays = (next.waiting ?? []).filter(item => item.kind === 'approval' && item.team !== null && state.teams.includes(item.team)).map(leadWorkerApprovalRelay)
      const evaluated: typeof acceptance = []
      const actions: LeadAction[] = []
      for (const run of leadPlanRuns(state)) {
        await read({ method: 'flow/execution', params: { run: run.runId } })
        const facts = structuredClone(await options.readEvidence(run.runId, read))
        actions.push(...facts.personActions ?? [])
        if (closed || generation !== expected) return
        if (!contract || facts.runId !== run.runId || facts.contractDigest !== contract.digest ||
          facts.project.id !== project.id || facts.project.path !== project.path) throw new Error('lead-evidence-scope')
        // Step 8 runs stop effects for caps crossed by observed worker spend,
        // uncertain-request write-offs, or Messages usage settlements.
        if (facts.spend) await journal.updateBudget(facts.spend)
        const accounting = journal.state.budget && leadBudgetProjection(journal.state.budget!, clock.now())
        evaluated.push({ runId: run.runId, result: evaluateLeadAcceptance(contract, { ...facts,
          spendComplete: facts.spendComplete && accounting?.spend === 'known' && accounting.reservedUsdMicros === 0 },
          { now: clock.now(), freshnessMs: options.freshnessMs ?? 60_000, revision: journal.state.seq }) })
      }
      if (closed || generation !== expected) return
      personActions = actions
      const budget = journal.state.budget && leadBudgetProjection(journal.state.budget!, clock.now())
      const reviewed = contract && state.steps.every(step => step.state === 'started') && evaluated.length > 0 &&
        evaluated.every(item => item.result.status === 'reviewed') && budget?.spend === 'known' && budget.reservedUsdMicros === 0
      if (!reviewed) await invalidate()
      else if (!terminal(journal.state.phase)) {
        const assertions: LeadAssertionResult[] = contract.assertions.map(assertion => {
          const facts = evaluated.map(item => item.result.assertions.find(result => result.assertionId === assertion.id)!)
          return { ...facts[0]!, evidence: facts.flatMap(fact => fact.evidence) }
        })
        const signature = resultSignature(contract.digest, assertions, budget!)
        const stored = journal.state.cards.find(card => card.id === `result-${contract.revision}`)
        if (signature !== lastResultSignature || stored?.type !== 'result' ||
          resultSignature(stored.contractDigest, stored.assertions, stored.budget) !== signature) {
          await invalidate()
          if (closed || generation !== expected) return
          const old = journal.state.cards.find(card => card.id === `result-${contract.revision}`)
          // Mark a publication in flight before the writer's first await. An
          // event then queues invalidation after this offer and before a click.
          lastResultSignature = signature
          try { await journal.offerCard({ version: 1, id: `result-${contract.revision}`, revision: (old?.revision ?? 0) + 1,
            type: 'result', contractDigest: contract.digest, outcome: 'reviewed', summary: 'Fresh checks and review are ready for your decision.', assertions, budget: budget! }) }
          catch (error) {
            lastResultSignature = null
            if ((error as { wireCode?: unknown })?.wireCode === 'lead-card-too-large') { await waitForUser('lead-card-too-large'); return }
            if ((journal.state.cardRevisions[`result-${contract.revision}`] ?? 0) >= 32)
              await waitForUser('lead-result-revisions-exhausted')
            throw error
          }
          if (closed || generation !== expected) { await invalidate(); return }
        } else {
          const card = journal.state.cards.find(card => card.id === `result-${contract.revision}`)!
          if (journal.state.decidedCards.includes(`${card.id}:${card.revision}`)) {
            await journal.restoreResult(card.id, card.revision)
            if (closed || generation !== expected) { await invalidate(); return }
          }
        }
        await waitForUser('lead-result-awaiting-person')
      }
      acceptance = evaluated
      if (journal.state.budget?.stop) reason = 'lead-budget-stopped'
      else if (!terminal(journal.state.phase) && budget && budget.spend !== 'known') reason = 'lead-budget-unknown'
      else if (reason === 'lead-budget-unknown') reason = null
      if (generation === expected && !closed) {
        synchronized = true
        if (['lead-connection-gap', 'lead-observations-unavailable'].includes(reason ?? '')) reason = null
        if ((continuationPending || dirty) && history && requestTemplate && !blocked() && journal.state.phase !== 'awaiting-plan') schedule(false)
      }
    } catch {
      synchronized = false; snapshot = empty(); relays = []; personActions = []
      await invalidate()
      reason = 'lead-observations-unavailable'
    }
  }
  const blocked = () => {
    const state = journal.state, budget = state.budget && leadBudgetProjection(state.budget, clock.now())
    if (terminal(state.phase)) { reason ??= state.budget?.stop ? 'lead-budget-stopped' : 'lead-terminal'; return true }
    if (state.phase === 'waiting-for-user') { waitingForResume = true; return true }
    if (waitingForResume) { noProgressTurns = 0; waitingForResume = false }
    if (state.recoveryBlocked || !synchronized || closed) return true
    if (!budget || budget.stop || budget.spend !== 'known' || state.budget!.requests.length) {
      if (budget?.spend !== 'known') reason = 'lead-budget-unknown'
      return true
    }
    if (reason === 'lead-budget-unknown') reason = null
    return false
  }
  const step = async (input: LeadMessagesRequest, signal?: AbortSignal): Promise<LeadMessagesResult | null> => {
    if (blocked()) return null
    if (journal.state.phase === 'draft') await journal.setManagementPhase('planning')
    active = new AbortController()
    const abort = () => active?.abort()
    if (signal?.aborted) active.abort()
    signal?.addEventListener('abort', abort, { once: true })
    let result: LeadMessagesResult
    try { result = await messages.request({ ...input, system: [input.system, standingInstructions()].filter(Boolean).join('\n') }, active.signal) }
    catch { result = { status: 'failed', reason: 'lead-messages-failed' } }
    finally { signal?.removeEventListener('abort', abort); active = null }
    history = result.messages ?? history
    requestTemplate = input
    // What the model said belongs to the person, in the order it was said: before the card or the wait that
    // follows it. A text the desk will not keep stays in the result, so the host scans it and refuses it by name.
    if (result.text && !terminal(journal.state.phase)) {
      try { await journal.appendReply(result.text) }
      catch { await waitForUser('lead-request-failed'); return result }
      const { text: _kept, ...delivered } = result
      result = delivered
    }
    if (!['completed'].includes(result.status)) {
      await writeOffUncertain()
      await waitForUser(`lead-request-${result.status}`)
      return result
    }
    try { await tools.settleStarts() }
    catch { await waitForUser('lead-start-binding-failed'); return result }
    if (journal.state.budget?.stop) reason = 'lead-budget-stopped'
    const proposal = result.proposals?.plan
    if (proposal && !terminal(journal.state.phase)) {
      try {
        const proposed = parseLeadAcceptanceContract(await options.freezePlan(structuredClone(proposal)))
        if (proposed.project.id !== project.id || proposed.project.path !== project.path || proposed.steps.some(step => step.flow !== 'lead-reviewed-result' || step.sourceRevision !== 'recipe-1'))
          throw new Error('lead-plan-scope')
        await journal.offerCard({ version: 1, id: nextId(), revision: 1, type: 'plan', contractDigest: proposed.digest, contract: proposed })
      } catch (error) {
        const code = (error as { wireCode?: unknown })?.wireCode
        await waitForUser(code === 'lead-card-too-large' || code === 'lead-plan-unseatable' || code === 'lead-plan-not-independent' ? code : 'lead-plan-refused')
      }
    }
    // Model-proposed result/waiting cards are summaries only. The loop constructs
    // actionable cards from fresh reads, and never offers a worker approval card.
    await refresh()
    if (result.reason === 'lead-predecessor-unavailable' || result.reason === 'lead-predecessor-unverifiable') { await waitForUser(result.reason); return result }
    const waitForDesk = !!result.deskActivityTools?.length
    const countedTools = result.toolResults?.filter(tool => !result.deskActivityTools?.includes(tool.tool_use_id)) ?? []
    if (countedTools.length) {
      const permanentRefusal = countedTools.some(tool => tool.is_error && !result.transientTools?.includes(tool.tool_use_id))
      noProgressTurns = result.succeededTools?.length && !permanentRefusal ? 0 : noProgressTurns + 1
    }
    if (countedTools.length && (noProgressTurns >= 3 ||
      countedTools.every(tool => tool.is_error && !result.transientTools?.includes(tool.tool_use_id)))) {
      await waitForUser('lead-tools-refused')
      return result
    }
    if (result.toolResults?.length && !waitForDesk && !result.proposals?.plan) {
      continuationPending = true
      if (!blocked()) schedule(false)
    }
    // An approved goal whose turn ended without a tool call and with nothing started goes nowhere on its own,
    // because nothing on the desk will wake the model. Say so, and leave the way on to the person.
    else if (!result.toolResults?.length && journal.state.phase === 'running' && journal.state.contract && !leadPlanRuns(journal.state).length)
      await waitForUser('lead-run-not-started')
    return result
  }
  const schedule = (activity = true) => {
    dirty ||= activity
    if (cancelBatch || closed) return
    cancelBatch = clock.schedule(() => {
      cancelBatch = null
      void queue(async () => {
        if (closed) return
        const activity = dirty, continueTools = continuationPending
        dirty = false; continuationPending = false
        await refresh()
        if (blocked()) {
          const state = journal.state
          // Preserve work through synchronization and spend fences without
          // scheduling another batch until a refresh clears the blocker.
          if (!terminal(state.phase) && state.phase !== 'waiting-for-user' && !state.recoveryBlocked) {
            dirty ||= activity; continuationPending ||= continueTools
          }
          return
        }
        if ((!activity && !continueTools) || journal.state.phase === 'awaiting-plan' || !history || !requestTemplate) return
        const observation: MessagesTurn = { role: 'user', content: [{ type: 'text', text: `Desk activity changed. Inspect fresh desk observations before acting.\n${leadObservation(personActions)}` }] }
        await step({ ...requestTemplate!, messages: [...history!, ...(activity ? [observation] : [])] })
      }).catch(async () => { await waitForUser('lead-activity-failed') }).catch(() => {})
    })
  }
  const observe = async () => {
    try {
      while (!closed && iterator) {
        const item = await iterator.next()
        if (item.done) { if (!closed) { synchronized = false; generation++; await invalidate(); reason = 'lead-connection-ended' }; return }
        const event = item.value
        if (event.type === 'gap' || event.type === 'end') {
          synchronized = false; generation++; snapshot = null; relays = []; personActions = []
          cancelBatch?.(); cancelBatch = null
          // Fence immediately, then invalidate durable cards through the writer.
          await invalidate(); reason = event.type === 'gap' ? 'lead-connection-gap' : 'lead-connection-ended'
          if (event.type === 'end') return
          void queue(refresh).catch(() => {})
        } else {
          const state = journal.state
          if ('run' in event && !state.runs.some(run => run.runId === event.run)) continue
          if ('team' in event && event.team !== null && !state.teams.includes(event.team)) continue
          // Notices carry prose, not changed evidence. Refresh them in the batch
          // without consuming another decision revision for identical facts.
          if (event.type !== 'notice' && event.type !== 'hello') {
            synchronized = false; generation++
            // A person can click while observations coalesce: invalidate first.
            await invalidate()
          }
          const wakesModel = ['run.changed', 'card.changed', 'review.changed', 'waiting'].includes(event.type) &&
            (('run' in event && state.runs.some(run => run.runId === event.run)) || ('team' in event && event.team !== null && state.teams.includes(event.team)))
          schedule(wakesModel)
        }
      }
    } catch { synchronized = false; generation++; reason = 'lead-connection-ended'; await invalidate() }
  }
  let started = false
  const start = async () => {
    if (started || closed) return
    started = true
    iterator = desk.events()[Symbol.asyncIterator]()
    pump = observe().catch(() => {})
    try {
      await journal.recoverUnsettledRequests()
      const subscribed = await tools.execute({ method: 'client/subscribe', params: { topics: LEAD_TOPICS, scope: { project: project.path } } })
      if (subscribed.outcome !== 'succeeded') throw new Error('lead-subscription-refused')
      await refresh()
    } catch { synchronized = false; await waitForUser('lead-subscription-failed') }
  }
  return {
    get state(): LeadLoopState { return structuredClone({ phase: journal.state.phase, reason: journal.state.budget?.stop ? 'lead-budget-stopped' : journal.state.phase === 'waiting-for-user' ? journal.state.managementReason ?? reason : reason, synchronized, snapshot, relays, acceptance }) },
    start: () => queue(start),
    request: (input: LeadMessagesRequest, signal?: AbortSignal) => queue(async () => { await start(); return step(input, signal) }),
    refresh: () => queue(async () => { await start(); await refresh() }),
    idle: async () => { await tail },
    async close() {
      closed = true; synchronized = false; generation++; active?.abort(); cancelBatch?.(); cancelBatch = null
      await iterator?.return?.()
      await pump; await tail
    },
  }
}
export type LeadLoop = ReturnType<typeof createLeadLoop>
