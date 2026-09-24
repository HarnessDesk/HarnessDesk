import { createHash } from 'node:crypto'

import type { TriggerStopReason } from '@harnessdesk/protocol'

import type { AttentionInput } from './attention.js'

/**
 * Every wait on one trigger Goal, named: who it waits on, in a sentence, and
 * what opens it. A pure function of what the waits' owners hold — the Team's
 * channel, the host's approvals and held actions, the flow engine's person
 * steps and run state, the budget's stop, the journal's firings and the
 * publisher's postings — so each kind of wait is exactly one branch here and
 * one read in the host, and nothing is inferred from outside text.
 *
 * Each wait's key names the request or reason it stands for, so the same
 * wait read again is the same attention, and another one never replaces it.
 */

/** What the host itself holds on a Goal for a person, read as a snapshot. */
export interface HostWaits {
  /** Messages the Team holds: who sent it, to whom, and why it is held. */
  readonly messages: readonly { readonly id: string; readonly from: string; readonly to: string; readonly reason: string | null }[]
  /** Approvals a runtime asked of a Seat's conversation, and desk actions held under a Seat's ceiling. */
  readonly approvals: readonly { readonly id: string; readonly seat: string; readonly what: string; readonly held: boolean }[]
  /** Questions a runtime asked a Seat's conversation: nobody is there to answer them. */
  readonly questions: readonly { readonly id: string; readonly seat: string; readonly what: string }[]
  /** Cards a flow addressed to a person, not yet done — before any Seat exists too. */
  readonly steps: readonly { readonly card: number; readonly title: string }[]
  /** Members a Seat waits for, by their Agent or seat label. */
  readonly members: readonly { readonly key: string; readonly label: string; readonly sentence: string }[]
  /** Postings a person has to look at: moved heads, uncertain sends, refused batches. */
  readonly postings: readonly { readonly key: string; readonly reason: string }[]
}

export const NO_WAITS: HostWaits = { messages: [], approvals: [], questions: [], steps: [], members: [], postings: [] }

export interface GoalWaitInput {
  readonly goal: string
  readonly trigger: string
  readonly host: HostWaits
  readonly run: { readonly id: string; readonly state: string; readonly reason: string | null } | null
  readonly stop: { readonly reason: TriggerStopReason; readonly detail: string; readonly at: number } | null
  /** Why a firing on this Goal needed a person: its round refused, its release held, a head it opens no round for. */
  readonly firings: readonly { readonly key: string; readonly attention: string }[]
}

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

const YOU = { kind: 'person', label: 'You' } as const

const MONEY = /^(Out of budget|Timed out|Spend is unknown|Today’s trigger spend cap|Every trigger is paused)/

export function goalWaits(input: GoalWaitInput): AttentionInput[] {
  const { goal, trigger, host } = input
  const out: AttentionInput[] = []
  const base = { goal, trigger } as const
  for (const message of host.messages) {
    out.push({
      ...base, key: `message:${goal}:${message.id}`, kind: 'message', waitingOn: YOU, action: 'open-goal',
      sentence: `A message from ${message.from} to ${message.to} is held for you${message.reason ? `: ${message.reason}` : '.'} Releasing it grants nothing.`,
    })
  }
  for (const approval of host.approvals) {
    out.push({
      ...base, key: `approval:${goal}:${approval.id}`, kind: 'approval', waitingOn: YOU,
      action: approval.held ? 'open-permissions' : 'open-goal',
      sentence: `${approval.seat} is waiting for your ${approval.held ? 'decision on a held action' : 'approval'}: ${approval.what}`,
    })
  }
  for (const question of host.questions) {
    out.push({
      ...base, key: `question:${goal}:${question.id}`, kind: 'question', waitingOn: YOU, action: 'open-goal',
      sentence: `${question.seat} asked a question nobody is here to answer: ${question.what} Its turn stops after twenty seconds, and what it said is kept.`,
    })
  }
  for (const step of host.steps) {
    out.push({
      ...base, key: `step:${goal}:${step.card}`, kind: 'person-step', waitingOn: YOU, action: 'open-goal',
      sentence: `Card #${step.card} is yours to answer: ${step.title}`,
    })
  }
  for (const member of host.members) {
    out.push({
      ...base, key: `member:${goal}:${member.key}`, kind: 'member', waitingOn: { kind: 'member', label: member.label }, action: 'open-goal',
      sentence: member.sentence,
    })
  }
  for (const posting of host.postings) {
    out.push({
      ...base, key: `posting:${goal}:${posting.key}:${short(posting.reason)}`, kind: 'publication', waitingOn: YOU, action: 'open-goal',
      sentence: posting.reason,
    })
  }
  if (input.stop) {
    out.push({
      ...base, key: `budget:${goal}:${input.stop.at}`, kind: 'budget', waitingOn: YOU,
      action: /spend|allowance|cap/i.test(input.stop.detail) ? 'open-usage' : 'open-goal',
      sentence: `This Goal stopped: ${input.stop.detail} Its cards, answers and findings are kept.`,
    })
  }
  // A run waiting for a person says why, once: a budget stop above already says it.
  const run = input.run
  if (run && (run.state === 'stalled' || run.state === 'stopped') && run.reason && run.reason !== input.stop?.detail) {
    const question = /question/i.test(run.reason)
    const money = MONEY.test(run.reason)
    out.push({
      ...base, key: `run:${run.id}:${short(run.reason)}`, kind: question ? 'question' : money ? 'budget' : 'person-step',
      waitingOn: YOU, action: money ? 'open-usage' : 'open-goal',
      sentence: `This Goal's work ${run.state === 'stopped' ? 'stopped' : 'waits for you'}: ${run.reason}`,
    })
  }
  for (const firing of input.firings) {
    // A firing that stopped the run for a person is said once, by the run.
    if (run && firing.attention === run.reason && (run.state === 'stalled' || run.state === 'stopped')) continue
    const money = MONEY.test(firing.attention)
    out.push({
      ...base, key: `firing:${firing.key}:${short(firing.attention)}`, kind: money ? 'budget' : 'person-step', waitingOn: YOU,
      action: money ? 'open-usage' : 'open-goal', sentence: firing.attention,
    })
  }
  return out
}
