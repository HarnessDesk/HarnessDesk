import { useRef, useState, type MutableRefObject } from 'react'
import type { LeadAcceptanceContract, LeadBudgetState, LeadCard, LeadCardDecision, LeadDecisionMessage, RuntimeInfo } from '@harnessdesk/protocol'
import { LeadContract, Text } from '../design'
import { LeadDecision } from './LeadDecision'
import { formatLeadConsentTime } from './lead-consent-time'
import { PERMISSION_LABELS } from './lead-permission-labels'
import { Markdown } from './Markdown'

export const leadDollars = (micros: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(micros / 1000000)
const allowance = (micros: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1000000)
const policyMode = { plan: 'Plan', default: 'Default', manage: 'Manage' }
const ruleWords = (rule: { effect: string; method: keyof typeof PERMISSION_LABELS; action: string | null; project: string | null } | undefined) => rule ? `${rule.effect} · ${PERMISSION_LABELS[rule.method]} · ${rule.action ?? 'All actions'} · ${rule.project ?? 'Approved project'}` : 'No rule'

/** Window-owned details and revision-bound decisions. The child never receives a click. */
export const LeadCards = ({ cards, decisions = [], contract, budget, runtimes, onDecide, onChanges, onApprovals, onError, onSettled, decisionLock, decisionPending, setDecisionPending, expiry, focusCard, placement = 'both' }: {
  readonly decisionLock?: MutableRefObject<boolean>; readonly decisionPending?: string | null
  readonly setDecisionPending?: (id: string | null) => void; readonly expiry?: number | null
  readonly focusCard?: string | null
  readonly cards: readonly LeadCard[]; readonly decisions?: readonly LeadDecisionMessage[]
  readonly contract?: LeadAcceptanceContract | null; readonly budget?: LeadBudgetState | null
  readonly runtimes: readonly RuntimeInfo[]; readonly placement?: 'thread' | 'dock' | 'both'
  readonly onDecide: (decision: LeadCardDecision) => Promise<unknown>; readonly onChanges: () => void
  readonly onApprovals: (runId: string) => void; readonly onError?: (error: unknown) => void; readonly onSettled?: () => void
}) => {
  const latest = useRef(cards); latest.current = cards
  const localBusy = useRef(false), [localPending, setLocalPending] = useState<string | null>(null)
  const busy = decisionLock ?? localBusy, pending = decisionPending === undefined ? localPending : decisionPending
  const setPending = setDecisionPending ?? setLocalPending
  const focus = useRef(new Map<string, HTMLElement>())
  const decide = async (card: Exclude<LeadCard, { type: 'stopped' }>, choice: LeadCardDecision['choice']) => {
    if (busy.current || !latest.current.some(current => current.id === card.id && current.revision === card.revision && current.contractDigest === card.contractDigest)) return
    busy.current = true; setPending(card.id)
    let succeeded = false
    try { await onDecide({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: card.contractDigest, choice }); succeeded = true }
    catch (error) { onError?.(error) }
    finally { busy.current = false; setPending(null); if (succeeded && onSettled) onSettled(); else focus.current.get(card.id)?.focus() }
  }
  const active = cards.find(card => card.id === focusCard && card.type !== 'stopped' && !(card.type === 'result' && card.outcome !== 'reviewed')) ?? [...cards].reverse().find(card => card.type === 'plan') ?? cards.find(card => card.type !== 'stopped' && !(card.type === 'result' && card.outcome !== 'reviewed'))
  return <>{[...cards.map(card => ({ card, choice: undefined as LeadCardDecision['choice'] | undefined })), ...decisions.map(({ card, choice }) => ({ card, choice }))].map(({ card, choice }) => {
    const worker = card.type === 'waiting' && card.kind === 'worker-approval'
    const person = card.type === 'waiting' && !worker || card.type === 'result' && card.outcome === 'reviewed'
    const approval = card.type === 'plan' || card.type === 'permission-change' || card.type === 'budget-change'
    const renewal = !choice && card.type === 'plan' && expiry != null && card.contractDigest === contract?.digest && JSON.stringify(card.contract) === JSON.stringify(contract)
    const scope = card.type === 'plan' ? card.contract : contract
    const summary = worker ? 'A worker is waiting for you to approve a command.' : card.type === 'plan' ? `${renewal ? `My earlier approval expired at ${formatLeadConsentTime(expiry!)}. Approve again to continue.\n\n` : ''}Here's my plan:\n\n${card.contract.steps.map((step, i) => `${i + 1}. ${step.title} — ${step.assignments.map(assignment => `${runtimes.find(runtime => runtime.id === assignment.seat.runtime)?.presentation.name ?? 'Worker unavailable'}${assignment.seat.model ? ` · ${assignment.seat.model}` : ''}`).join('; ')}`).join('\n')}\n\nDone when:\n\n${card.contract.assertions.map(assertion => `- ${assertion.description}`).join('\n')}`
      : card.type === 'permission-change' ? `Change permission mode: ${policyMode[card.previous.mode]} → ${policyMode[card.proposed.mode]}\n\n${[...new Set([...card.previous.rules.map(rule => rule.id), ...card.proposed.rules.map(rule => rule.id)])].flatMap(id => { const old = card.previous.rules.find(rule => rule.id === id), next = card.proposed.rules.find(rule => rule.id === id); return JSON.stringify(old) === JSON.stringify(next) ? [] : [`- ${ruleWords(old)} → ${ruleWords(next)}`] }).join('\n')}`
      : card.type === 'budget-change' ? `Raise the allowance from ${allowance(card.previous.caps.usdMicros)} to ${allowance(card.proposed.usdMicros)} and from ${card.previous.caps.rounds} to ${card.proposed.rounds} rounds?`
      : card.type === 'stopped' ? card.reason === 'unknown-spend' ? 'Worker spend is unknown. Inspect the run before continuing.' : 'The Lead stopped. Inspect its allowance and run.' : card.summary
    const state = choice ? { approve: 'Approved', decline: 'Declined', accept: 'Accepted' }[choice] : card.type === 'result' && card.outcome !== 'reviewed' ? { accepted: 'Accepted', declined: 'Declined' }[card.outcome] : undefined
    const spend = 'budget' in card ? card.budget : budget
    const assertions = 'assertions' in card ? card.assertions : []
    const caps = renewal && budget ? budget.caps : card.type === 'plan' ? card.contract.caps : undefined
    const ref = (element: HTMLElement | null) => { if (element) focus.current.set(card.id, element); else focus.current.delete(card.id) }
    return <div key={`${card.id}:${card.revision}:${choice ?? 'pending'}`}>
      {placement !== 'dock' && <LeadContract cardId={card.id} cardType={card.type} summary={summary} state={state} focusRef={ref}>
        {caps && <><Text as="p" role="meta">Up to {allowance(caps.usdMicros)} · {caps.rounds} rounds · {scope?.project.path}</Text><Text as="p" role="meta">Publishing, merging and deleting still need your separate approval.</Text></>}
        {(card.type === 'waiting' && !worker || card.type === 'result') && <>
          {(['check', 'review', 'blocking-findings', 'diff'] as const).map(kind => {
            const expected = scope?.assertions.filter(assertion => assertion.kind === kind) ?? []
            const results = expected.map(assertion => assertions.find(result => result.assertionId === assertion.id))
            const known = expected.length > 0 && results.every(result => result && result.contractRevision === scope?.revision && result.evidence.length > 0)
            const status = known ? results.some(result => result?.status === 'failed') ? 'failed' : results.every(result => result?.status === 'passed') ? 'passed' : 'unknown' : 'unknown'
            const title = { check: 'Checks', review: 'Review', 'blocking-findings': 'Findings', diff: 'Changes' }[kind]
            return <div key={kind}><Text as="p" role="meta">{title} {status}</Text>{results.filter(result => result !== undefined).map(result => result.reason ? <LeadReason key={result.assertionId} text={result.reason} /> : null)}</div>
          })}
          <Text as="p" role="meta">I spent {spend ? leadDollars(spend.leadUsdMicros) : 'unknown'} · workers reported {spend?.spend === 'known' ? leadDollars(spend.workerUsdMicros) : 'unknown'}.</Text>
        </>}
      </LeadContract>}
      {placement !== 'thread' && !state && active === card && <LeadDecision key={`${card.id}:${card.revision}`} id={card.id} type={card.type} title={card.type === 'plan' ? 'Approve this plan?' : worker ? 'A worker needs your approval' : person ? 'Accept these changes?' : 'Approve this change?'} pending={pending !== null} focusRef={ref}
        approveLabel={person ? 'Accept' : 'Approve'} onApprove={person || approval ? () => { void decide(card as Exclude<LeadCard, { type: 'stopped' }>, person ? 'accept' : 'approve') } : undefined}
        onDecline={person || approval ? () => { void decide(card as Exclude<LeadCard, { type: 'stopped' }>, 'decline') } : undefined}
        link={worker ? { label: 'Open approvals', run: () => onApprovals(card.runId) } : person ? { label: 'Open changes', run: onChanges } : undefined} />}
    </div>
  })}</>
}
const LeadReason = ({ text }: { readonly text: string }) => <Markdown text={text} />
