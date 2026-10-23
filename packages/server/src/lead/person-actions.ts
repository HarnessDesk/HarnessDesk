import { createHash } from 'node:crypto'
import { leadPlanRuns, type LeadJournal } from '@harnessdesk/lead'
import type { Approval, HostParams, LeadAction, LeadActionInput, Sha } from '@harnessdesk/protocol'
import type { EvidencePlane } from '../evidence/plane.js'
import type { Host } from '../host.js'
import { readChecksAt } from '../evidence/checks-file.js'
import { leadContainsSecret } from './secrets.js'
import { leadRefusal } from './controls.js'

type Target = { readonly action: LeadAction; readonly answer: (choice: LeadActionInput['choice']) => Promise<unknown> }
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
/** Person-only host capability. No client surface entry, plugin tool or child port exports it. */
export class LeadPersonActions {
  constructor(private readonly journal: LeadJournal, private readonly host: Pick<Host, 'registry' | 'teamPlane' | 'flowsPlane' | 'call'>,
    private readonly evidence: EvidencePlane, private readonly assertPublic: (value: unknown) => Promise<void>) {}

  async #targets(): Promise<Target[]> {
    const state = this.journal.state, contract = state.contract
    if (!contract || ['accepted', 'declined', 'stopped'].includes(state.phase)) return []
    const targets: Target[] = []
    for (const record of this.host.registry.all()) {
      const seat = this.evidence.seats.all().find(seat => !seat.closed && seat.session.runtime === record.runtime && seat.session.sessionId === record.session.id)
      const owned = seat && state.runs.find(run => run.teamId === seat.board)
      if (!owned) continue
      for (const approval of record.approvals.values()) {
        const raw = requestOf(approval)
        let request = wellFormed(raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '))
        let safe = !leadContainsSecret(raw)
        try { await this.assertPublic(raw) } catch { safe = false }
        request = safe ? request.length > 240 ? `${wellFormed(request.slice(0, 239))}…` : request : 'a request whose details are hidden for privacy'
        const options = 'options' in approval ? approval.options : []
        const yes = safe ? options.find(option => option.intent === 'approve') : undefined
        const no = options.find(option => option.intent === 'deny') ?? options.find(option => option.intent === 'cancel')
        const action: Extract<LeadAction, { kind: 'worker-approval' }> = { kind: 'worker-approval', id: `worker-${identity([record.runtime, record.session.id, approval])}`,
          runId: owned.runId, role: roleOf(seat!.role), request, choices: [...(yes ? ['yes-once' as const] : []), ...(no ? ['no' as const] : [])] }
        targets.push({ action, answer: async choice => {
          const option = choice === 'yes-once' ? yes : choice === 'no' ? no : undefined
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
  async perform(input: LeadActionInput): Promise<void> {
    if (input.contractDigest !== this.journal.state.contract?.digest) throw leadRefusal('lead-card-stale')
    const targets = await this.#targets()
    const target = targets.find(target => target.action.id === input.id)
    if (!target || input.contractDigest !== this.journal.state.contract?.digest) throw leadRefusal('lead-card-stale')
    await target.answer(input.choice)
  }
}
