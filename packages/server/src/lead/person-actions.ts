import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { hasPendingLeadPlan, leadPlanRuns, type LeadJournal } from '@harnessdesk/lead'
import { leadWorkerApprovalKey, leadWorkerApprovalTarget, type LeadWorkerApprovalKey } from '@harnessdesk/protocol'
import type { Approval, HostParams, LeadAction, LeadActionInput, Sha } from '@harnessdesk/protocol'
import type { EvidencePlane } from '../evidence/plane.js'
import type { Host } from '../host.js'
import { readChecksAt } from '../evidence/checks-file.js'
import { leadContainsSecret } from './secrets.js'
import { leadRefusal } from './controls.js'

type Target = { readonly runtime?: string; readonly sessionId?: string; readonly approvalId?: string; readonly key?: LeadWorkerApprovalKey; readonly pending?: () => boolean; readonly action: LeadAction; readonly answer: (choice: LeadActionInput['choice']) => Promise<unknown> }
const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const wellFormed = (value: string): string => (value as string & { toWellFormed(): string }).toWellFormed()
const roleOf = (role: string | null) => role === 'implement' ? 'implementer' : role === 'review' ? 'code reviewer' : 'worker'
const requestOf = (approval: Approval): string => {
  switch (approval.type) {
    case 'command': return approval.kind === 'stdin' ? `send input to ${approval.command}: ${approval.input ?? ''}` : `run ${approval.command}`
    case 'permission': return approval.summary
    case 'fileChange': return `change ${approval.changes.map(change => change.path).join(', ')}`
    case 'userInput': return `answer ${approval.tool}`
    case 'elicitation': return approval.message
  }
}
/** Resolve fresh at admission: a link inside a project must not grant an outside or authority file. */
const pathSafe = (key: LeadWorkerApprovalKey, project: string): boolean => {
  if (key.kind === 'tool') return true
  try {
    const root = realpathSync.native(project)
    if (key.kind === 'command') return realpathSync.native(key.cwd) === join(root, relative(project, key.cwd)) && leadWorkerApprovalKey({ type: 'command', command: key.command, cwd: realpathSync.native(key.cwd) } as Approval, root) !== null
    let path: string
    try { path = realpathSync.native(key.path) }
    catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') return false
      try { lstatSync(key.path); return false } catch (missing) { if ((missing as { code?: string }).code !== 'ENOENT') return false }
      path = join(realpathSync.native(dirname(key.path)), basename(key.path))
    }
    return path === join(root, relative(project, key.path)) && leadWorkerApprovalKey({ type: 'fileChange', changes: [{ path, kind: { type: 'update' }, diff: '' }] } as unknown as Approval, root) !== null
  } catch { return false }
}
/** Person-only host capability. No client surface entry, plugin tool or child port exports it. */
export class LeadPersonActions {
  readonly #automatic = new Map<string, Promise<boolean>>()
  constructor(private readonly journal: LeadJournal, private readonly host: Pick<Host, 'registry' | 'teamPlane' | 'flowsPlane' | 'call'>,
    private readonly evidence: EvidencePlane, private readonly assertPublic: (value: unknown) => Promise<void>) {}

  async #targets(): Promise<Target[]> {
    const state = this.journal.state, contract = state.contract
    if (!contract || ['accepted', 'declined', 'stopped', 'following'].includes(state.phase)) return []
    const targets: Target[] = []
    for (const record of this.host.registry.all()) {
      const seat = this.evidence.seats.all().find(seat => !seat.closed && seat.session.runtime === record.runtime && seat.session.sessionId === record.session.id)
      const owned = seat && state.runs.find(run => run.teamId === seat.board)
      if (!owned) continue
      for (const approval of record.approvals.values()) {
        let raw = requestOf(approval)
        let request = wellFormed(raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '))
        // Grants need the complete scope: exact command/folder, tool, or a path with its whole diff.
        let key = !hasPendingLeadPlan(state) && contract.project && leadPlanRuns(state).some(run => run.runId === owned.runId) && state.steps.some(step => step.attemptId === owned.correlationId && step.contractDigest === contract.digest) ? leadWorkerApprovalKey(approval, contract.project.path) : null
        if (key && !pathSafe(key, contract.project.path)) key = null
        const details = approval.type === 'fileChange' && key ? approval.changes[0]!.diff : undefined
        const whole = key !== null && !approval.reason && (!details || details.length <= 8000) || approval.type === 'permission' && !approval.reason && !approval.filesystem?.length && !approval.network?.length
        if (key) request = raw = key.kind === 'command' ? `run ${leadWorkerApprovalTarget(key)}` : key.kind === 'fileChange' ? `change ${key.path}` : approval.type === 'permission' ? approval.summary : raw
        let safe = whole && request === raw && request.length <= 240 && !leadContainsSecret([raw, details ?? '']) &&
          (!details || !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(details))
        try { await this.assertPublic([raw, details ?? '']) } catch { safe = false }
        request = safe ? request : 'Request details are hidden; the full request is on the desk.'
        const options = 'options' in approval ? approval.options : []
        const yes = safe ? options.find(option => option.intent === 'approve' && option.once !== false && !option.grant) : undefined
        const no = options.find(option => option.intent === 'deny') ?? options.find(option => option.intent === 'cancel')
        const action: Extract<LeadAction, { kind: 'worker-approval' }> = { kind: 'worker-approval', id: `worker-${identity([record.runtime, record.session.id, approval])}`,
          runId: owned.runId, role: roleOf(seat!.role), request, ...(safe && details ? { details } : {}), choices: [...(yes ? ['yes-once' as const] : []), ...(yes && key && state.workerApprovals.length < 128 ? ['yes-goal' as const] : []), ...(no ? ['no' as const] : [])] }
        const snapshot = JSON.stringify(approval)
        const pending = () => {
          const current = this.journal.state
          return !!key && pathSafe(key, contract.project.path) && current.contract?.digest === contract.digest && current.contract.revision === contract.revision && current.goalStartedSeq === state.goalStartedSeq &&
            !['accepted', 'declined', 'stopped', 'following', 'awaiting-plan'].includes(current.phase) &&
            JSON.stringify(record.approvals.get(approval.id)) === snapshot &&
            this.evidence.seats.all().some(seat => !seat.closed && seat.board === owned.teamId && seat.session.runtime === record.runtime && seat.session.sessionId === record.session.id) &&
            leadPlanRuns(current).some(run => run.runId === owned.runId && run.teamId === owned.teamId)
        }
        targets.push({ action, runtime: record.runtime, sessionId: record.session.id, approvalId: approval.id, ...(safe && yes && key ? { key, pending } : {}), answer: async choice => {
          const option = choice === 'yes-once' || choice === 'yes-goal' ? yes : choice === 'no' ? no : undefined
          if (!option) throw leadRefusal('lead-operation-refused')
          // This is exactly the window's normal approval path, including held ceilings and stopped questions.
          await this.host.call('approval/respond', { runtime: record.runtime, sessionId: record.session.id, approvalId: approval.id,
            decision: { type: 'option', optionId: option.id } })
        } })
      }
    }
    if (!contract.assertions.some(assertion => assertion.kind === 'check')) return targets
    for (const owned of leadPlanRuns(state)) {
      const execution = this.host.flowsPlane.executionOf(owned.runId)
      if (!execution || execution.state !== 'running') continue
      const ids = new Set(execution.rounds.flatMap(round => round.cards))
      const board = this.host.teamPlane.stateFor(owned.teamId)
      const implementation = board.intents.filter(card => ids.has(card.id) && card.role === 'implement' && card.state === 'done').at(-1)
      if (!implementation) continue
      const evidence = await this.host.call('evidence/board', { room: owned.teamId })
      const facts = evidence.cards.filter(card => ids.has(card.card)).flatMap(card => card.facts)
      const review = facts.filter(one => one.record.fact.kind === 'review' && one.freshness.state === 'fresh').at(-1)?.record.fact
      if (review?.kind !== 'review' || review.verdict !== 'approve') continue
      const file = await readChecksAt(contract.project.path, review.at as Sha)
      if (!file.digest) continue
      for (const check of file.checks) {
        if (facts.some(one => one.freshness.state === 'fresh' && one.record.fact.kind === 'check' && one.record.fact.at === review.at &&
          one.record.fact.name === check.name && one.record.fact.run === check.run && one.record.fact.digest === file.digest && one.record.fact.counted === true) ||
          evidence.cards.some(card => ids.has(card.card) && card.running.some(running => running.name === check.name))) continue
        // A command must reach the person whole, screened by the same key guard as Lead prose.
        if (leadContainsSecret(check.run)) continue
        try { await this.assertPublic(check.run) } catch { continue }
        const params: HostParams<'evidence/check/run'> = { room: owned.teamId, card: implementation.id, name: check.name, seen: check.run, digest: file.digest }
        targets.push({ action: { kind: 'check', id: `check-${identity([owned.runId, review.at, params])}`, runId: owned.runId, name: check.name, command: check.run },
          answer: async choice => {
            if (choice !== 'run') throw leadRefusal('lead-operation-refused')
            await this.host.call('evidence/check/run', params)
          } })
      }
    }
    return targets
  }
  async read(): Promise<readonly LeadAction[]> { return (await this.#targets()).map(target => target.action) }
  async revoke(input: { readonly id: string; readonly contractDigest: string }): Promise<void> {
    await this.journal.revokeWorkerApproval(input.id, input.contractDigest)
  }
  /** Host event path only. Neither a child command nor a worker can supply a rule. */
  autoAnswer(runtime: string, sessionId: string, approvalId: string): Promise<boolean> {
    const id = identity([runtime, sessionId, approvalId])
    const pending = this.#automatic.get(id)
    if (pending) return pending
    const operation = this.#autoAnswer(runtime, sessionId, approvalId)
    this.#automatic.set(id, operation)
    void operation.finally(() => this.#automatic.delete(id)).catch(() => {})
    return operation
  }
  async #autoAnswer(runtime: string, sessionId: string, approvalId: string): Promise<boolean> {
    const target = (await this.#targets()).find(target => target.runtime === runtime && target.sessionId === sessionId && target.approvalId === approvalId)
    if (!target?.key || !target.pending) return false
    const rule = this.journal.state.workerApprovals.find(rule => JSON.stringify(rule.key) === JSON.stringify(target.key))
    if (!rule) return false
    return this.journal.useWorkerApproval(rule.id, target.pending, () => target.answer('yes-once'))
  }
  async perform(input: LeadActionInput): Promise<void> {
    if (input.contractDigest !== this.journal.state.contract?.digest) throw leadRefusal('lead-card-stale')
    const targets = await this.#targets()
    const target = targets.find(target => target.action.id === input.id)
    if (!target || input.contractDigest !== this.journal.state.contract?.digest) throw leadRefusal('lead-card-stale')
    if (input.choice === 'yes-goal') {
      if (!target.key || !target.pending?.() || target.action.kind !== 'worker-approval' || !target.action.choices.includes('yes-goal')) throw leadRefusal('lead-operation-refused')
      const state = this.journal.state
      const existing = state.workerApprovals.find(rule => JSON.stringify(rule.key) === JSON.stringify(target.key))
      if (existing) { await target.answer('yes-once'); return }
      await this.journal.saveWorkerApproval({ id: `rule-${identity([state.goalStartedSeq, input.contractDigest, target.key])}`, contractDigest: input.contractDigest,
        goalStartedSeq: state.goalStartedSeq, key: target.key, target: leadWorkerApprovalTarget(target.key), count: 0 }, target.pending, () => target.answer('yes-once'))
      return
    }
    await target.answer(input.choice)
  }
}
