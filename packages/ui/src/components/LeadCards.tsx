import { useRef, useState, type MutableRefObject } from 'react'
import type { LeadAcceptanceContract, LeadBudgetState, LeadCard, LeadCardDecision, RuntimeInfo } from '@harnessdesk/protocol'
import { Banner, Button, Chip, LeadContract, Row, Rows, Text } from '../design'
import { Markdown } from './Markdown'
import { formatLeadConsentTime } from './lead-consent-time'
import { PERMISSION_LABELS } from './lead-permission-labels'

export const leadDollars = (micros: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(micros / 1000000)

/** Data and decisions are window-owned. The child cannot answer these controls. */
export const LeadCards = ({ cards, contract, budget, runtimes, onDecide, onChanges, onApprovals, onError, onSettled, decisionLock, decisionPending, setDecisionPending, expiry }: {
  readonly decisionLock?: MutableRefObject<boolean>
  readonly decisionPending?: string | null
  readonly setDecisionPending?: (id: string | null) => void
  readonly expiry?: number | null
  readonly cards: readonly LeadCard[]
  readonly contract?: LeadAcceptanceContract | null
  readonly budget?: LeadBudgetState | null
  readonly runtimes: readonly RuntimeInfo[]
  readonly onDecide: (decision: LeadCardDecision) => Promise<unknown>
  readonly onChanges: () => void
  readonly onApprovals: (runId: string) => void
  readonly onError?: (error: unknown) => void
  readonly onSettled?: () => void
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
  return <>{cards.map(card => {
    const person = card.type === 'waiting' && card.kind === 'person' || card.type === 'result' && card.outcome === 'reviewed'
    const approval = card.type === 'plan' || card.type === 'permission-change' || card.type === 'budget-change'
    const title = card.type === 'plan' ? 'Plan' : card.type === 'waiting' ? card.kind === 'person' ? 'Your acceptance' : 'Worker approval'
      : card.type === 'result' ? 'Result' : card.type === 'permission-change' ? 'Permission change' : card.type === 'budget-change' ? 'Allowance change' : 'Stopped'
    const worker = card.type === 'waiting' && card.kind === 'worker-approval'
    const renewal = card.type === 'plan' && expiry != null && card.contractDigest === contract?.digest && JSON.stringify(card.contract) === JSON.stringify(contract)

    const summary = worker ? 'A worker is waiting for a command approval.' : renewal ? `The earlier approval expired at ${formatLeadConsentTime(expiry!)}. ${card.contract.goal}` : card.type === 'permission-change' ? 'Review the proposed permissions before the Lead uses them.' : card.type === 'budget-change' ? 'Review the higher allowances before work continues.' : 'summary' in card ? card.summary : card.type === 'plan' ? card.contract.goal : undefined
    const spend = 'budget' in card ? card.budget : budget
    const assertions = 'assertions' in card ? card.assertions : []
    const caps = renewal && budget ? budget.caps : card.type === 'plan' ? card.contract.caps : undefined
    const scope = card.type === 'plan' ? card.contract : contract
    return <LeadContract key={`${card.id}:${card.revision}`} cardId={card.id} cardType={card.type} title={title} state={renewal ? 'Renewal' : card.type === 'stopped' ? 'Stopped' : card.type === 'result' && card.outcome !== 'reviewed' ? { accepted: 'Accepted', declined: 'Declined' }[card.outcome] : undefined} revision={card.revision} summary={summary}
      focusRef={element => { if (element) focus.current.set(card.id, element); else focus.current.delete(card.id) }}
      pending={pending !== null} approveLabel={person ? 'Accept' : 'Approve'}
      onApprove={person || approval ? () => { void decide(card, person ? 'accept' : 'approve') } : undefined}
      onDecline={person || approval ? () => { void decide(card, 'decline') } : undefined}
      links={worker ? <Button variant="outline" onClick={() => onApprovals(card.runId)}>Open approvals</Button> : card.type === 'waiting' || card.type === 'result' ? <><Button variant="outline" onClick={onChanges}>Open Changes</Button>

      </> : undefined}>
      {card.type === 'plan' && <>
        <Rows variant="inset">{card.contract.steps.map(step => <Row key={step.id} layout="record" title={step.title} desc={step.assignments.map((assignment, i) => <Text key={i} as="span" role="meta">{runtimes.find(runtime => runtime.id === assignment.seat.runtime)?.presentation.name ?? 'Worker unavailable'}{assignment.seat.model ? ` · ${assignment.seat.model}` : ''}{i < step.assignments.length - 1 ? '; ' : ''}</Text>)} />)}</Rows>
        <Rows variant="inset">{card.contract.assertions.map(assertion => <Row key={assertion.id} title={assertion.description} titleChip={<Chip tone="neutral">{{ check: 'Check', review: 'Review', 'blocking-findings': 'Findings', diff: 'Changes' }[assertion.kind]}</Chip>} />)}</Rows>
        <Rows variant="inset">
          <Row title="Allowance" desc="Stops when reported spend reaches the cap." control={<span>{leadDollars(caps!.usdMicros)} · {caps!.rounds} rounds</span>} />
          <Row title="Approval scope" desc={<><Text as="div" role="meta">{card.contract.project.path}</Text><Markdown text="Only these steps, assignments and acceptance assertions. Publishing, merging and deleting require separate approval." /></>} />
        </Rows>
      </>}
      {(card.type === 'waiting' && !worker || card.type === 'result') && <>
        <Rows variant="inset">{(['check', 'review', 'blocking-findings', 'diff'] as const).map(kind => {
          const expected = scope?.assertions.filter(assertion => assertion.kind === kind) ?? []
          const results = expected.map(assertion => assertions.find(result => result.assertionId === assertion.id))
          const known = expected.length > 0 && results.every(result => result && result.contractRevision === scope?.revision && result.evidence.length > 0)
          const status = known ? results.some(result => result?.status === 'failed') ? 'Failed' : results.every(result => result?.status === 'passed') ? 'Passed' : 'Unknown' : 'Unknown'
          return <Row key={kind} layout="record" title={{ check: 'Checks', review: 'Review', 'blocking-findings': 'Findings', diff: 'Changes' }[kind]} titleChip={<Chip tone="neutral">{status}</Chip>} desc={<>
            {results.filter(result => result !== undefined).map(result => <div key={result.assertionId}>
              {result.reason && <Markdown text={result.reason} />}
            </div>)}
          </>} />
        })}</Rows>
        <Rows variant="inset"><Row title="Lead spend" control={<span>{spend ? leadDollars(spend.leadUsdMicros) : 'Unknown'}</span>} />
          <Row title="Worker spend (reported)" control={<span>{spend?.spend === 'known' ? leadDollars(spend.workerUsdMicros) : 'Unknown'}</span>} /></Rows>

      </>}
      {card.type === 'permission-change' && <>
        {([{ label: 'Current policy', policy: card.previous }, { label: 'Proposed policy', policy: card.proposed }] as const).map(({ label, policy }) => <Rows variant="inset" key={label}><Row title={label} titleChip={<Chip tone="neutral">{{ plan: 'Plan', default: 'Default', manage: 'Manage' }[policy.mode]}</Chip>} />
          {policy.rules.map(rule => <Row key={rule.id} title={<span title={rule.method}>{PERMISSION_LABELS[rule.method]}</span>} titleChip={<Chip tone="neutral">{{ allow: 'Allow', ask: 'Ask', deny: 'Deny' }[rule.effect]}</Chip>} desc={`${rule.action ?? 'All actions'} · ${rule.project ?? 'Approved project'}`} />)}
        </Rows>)}
      </>}
      {card.type === 'budget-change' && <Rows variant="inset"><Row title="Dollar allowance" desc={`${leadDollars(card.previous.caps.usdMicros)} → ${leadDollars(card.proposed.usdMicros)}`} /><Row title="Round allowance" desc={`${card.previous.caps.rounds} → ${card.proposed.rounds}`} /></Rows>}
      {card.type === 'stopped' && <Banner>{card.reason === 'unknown-spend' ? 'Worker spend is unknown. Inspect the run before continuing.' : 'The Lead stopped. Inspect its allowance and run.'}</Banner>}
    </LeadContract>
  })}</>
}
