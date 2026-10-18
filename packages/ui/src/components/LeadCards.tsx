import { useRef, useState } from 'react'
import type { LeadAcceptanceContract, LeadBudgetState, LeadCard, LeadCardDecision, RuntimeInfo } from '@harnessdesk/protocol'
import { Banner, Button, Chip, LeadContract, Row, Rows, Text } from '../design'
import { Markdown } from './Markdown'

export const leadDollars = (micros: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(micros / 1000000)

/** Data and decisions are window-owned. The child cannot answer these controls. */
export const LeadCards = ({ cards, contract, budget, runtimes, onDecide, onChanges, onApprovals, onError, onSettled }: {
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
  const busy = useRef(false), [pending, setPending] = useState<string | null>(null)
  const focus = useRef(new Map<string, HTMLElement>())
  const decide = async (card: Exclude<LeadCard, { type: 'stopped' }>, choice: LeadCardDecision['choice']) => {
    if (busy.current || !latest.current.some(current => current.id === card.id && current.revision === card.revision && current.contractDigest === card.contractDigest)) return
    busy.current = true; setPending(card.id)
    try { await onDecide({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: card.contractDigest, choice }) }
    catch (error) { onError?.(error) }
    finally { busy.current = false; setPending(null); if (onSettled) onSettled(); else focus.current.get(card.id)?.focus() }
  }
  return <>{cards.map(card => {
    const person = card.type === 'waiting' && card.kind === 'person' || card.type === 'result' && card.outcome === 'reviewed'
    const approval = card.type === 'plan' || card.type === 'permission-change' || card.type === 'budget-change'
    const title = card.type === 'plan' ? 'Plan' : card.type === 'waiting' ? card.kind === 'person' ? 'Your acceptance' : 'Worker approval'
      : card.type === 'result' ? 'Result' : card.type === 'permission-change' ? 'Permission change' : card.type === 'budget-change' ? 'Allowance change' : 'Stopped'
    const summary = 'summary' in card ? card.summary : card.type === 'plan' ? card.contract.goal : undefined
    const spend = 'budget' in card ? card.budget : budget
    const assertions = 'assertions' in card ? card.assertions : []
    const scope = card.type === 'plan' ? card.contract : contract
    return <LeadContract key={`${card.id}:${card.revision}`} cardId={card.id} cardType={card.type} title={title} revision={card.revision} summary={summary}
      focusRef={element => { if (element) focus.current.set(card.id, element); else focus.current.delete(card.id) }}
      pending={pending !== null} approveLabel={person ? 'Accept' : 'Approve'}
      onApprove={person || approval ? () => { void decide(card, person ? 'accept' : 'approve') } : undefined}
      onDecline={person || approval ? () => { void decide(card, 'decline') } : undefined}
      links={card.type === 'waiting' || card.type === 'result' ? <><Button variant="outline" onClick={onChanges}>Open Changes</Button>
        {card.type === 'waiting' && card.kind === 'worker-approval' && <Button variant="outline" onClick={() => onApprovals(card.runId)}>Open approvals</Button>}
      </> : undefined}>
      {card.type === 'plan' && <>
        <Rows>{card.contract.steps.map((step, index) => <Row key={step.id} layout="record" title={`${index + 1}. ${step.title}`} desc={<>
          <Text as="div" role="prose">Flow: {step.flow} · Source revision: {step.sourceRevision} · {step.attendance}</Text>
          {step.assignments.map((assignment, i) => <Text key={i} as="div" role="prose">{assignment.role}: {assignment.agent} · {runtimes.find(runtime => runtime.id === assignment.seat.runtime)?.presentation.name ?? 'Runtime unavailable'}{assignment.seat.model ? ` · ${assignment.seat.model}` : ''}{assignment.seat.effort ? ` · ${assignment.seat.effort}` : ''}{assignment.seat.thinking ? ` · ${assignment.seat.thinking}` : ''} · Ceiling: {assignment.ceiling}</Text>)}
          {Object.entries(step.variables).map(([name, value]) => <Text as="div" role="prose" key={name}>{name}: {value}</Text>)}
        </>} />)}</Rows>
        <Rows>{card.contract.assertions.map(assertion => <Row key={assertion.id} title={assertion.description} titleChip={<Chip tone="neutral">{assertion.kind}</Chip>} />)}</Rows>
        <Rows>
          <Row title="Allowance" desc="Stops when reported spend reaches the cap." control={<span>{leadDollars(card.contract.caps.usdMicros)} · {card.contract.caps.rounds} rounds</span>} />
          <Row title="Approval scope" desc={<><Text as="div" role="prose">{card.contract.project.path} · Contract revision {card.contract.revision} · Policy revision {card.contract.policyRevision}</Text><Text as="div" role="prose" className="break-all">{card.contractDigest}</Text><Text as="div" role="prose">Only these steps, assignments and acceptance assertions. Publishing, merging and deleting require separate approval.</Text></>} />
        </Rows>
      </>}
      {(card.type === 'waiting' || card.type === 'result') && <>
        <Rows>{(['check', 'review', 'blocking-findings', 'diff'] as const).map(kind => {
          const expected = scope?.assertions.filter(assertion => assertion.kind === kind) ?? []
          const results = expected.map(assertion => assertions.find(result => result.assertionId === assertion.id))
          const known = expected.length > 0 && results.every(result => result && result.contractRevision === scope?.revision && result.evidence.length > 0)
          const status = known ? results.some(result => result?.status === 'failed') ? 'Failed' : results.every(result => result?.status === 'passed') ? 'Passed' : 'Unknown' : 'Unknown'
          return <Row key={kind} layout="record" title={{ check: 'Checks', review: 'Review', 'blocking-findings': 'Findings', diff: 'Changes' }[kind]} titleChip={<Chip tone="neutral">{status}</Chip>} desc={<>
            {results.filter(result => result !== undefined).map(result => <div key={result.assertionId}>
              <Text as="div" role="prose">Assertion revision {result.revision} · Contract revision {result.contractRevision}</Text>
              {result.evidence.map(evidence => <Text as="div" role="prose" key={`${evidence.kind}:${evidence.id}:${evidence.revision}`}>{evidence.kind}: {evidence.id} · Revision {evidence.revision}</Text>)}
              {result.reason && <Markdown text={result.reason} />}
            </div>)}
          </>} />
        })}</Rows>
        <Rows><Row title="Lead spend" control={<span>{spend ? leadDollars(spend.leadUsdMicros) : 'Unknown'}</span>} />
          <Row title="Worker spend (reported)" control={<span>{spend?.spend === 'known' ? leadDollars(spend.workerUsdMicros) : 'Unknown'}</span>} /></Rows>

      </>}
      {card.type === 'permission-change' && <>
        {([{ label: 'Current policy', policy: card.previous }, { label: 'Proposed policy', policy: card.proposed }] as const).map(({ label, policy }) => <Rows key={label}><Row title={label} desc={`Revision ${policy.revision} · ${policy.mode}`} />
          {policy.rules.map(rule => <Row key={rule.id} title={`${rule.effect}: ${rule.method}`} desc={`${rule.action ?? 'All actions'} · ${rule.project ?? 'Approved project'}`} />)}
          {!policy.rules.length && <Row title="Rules" desc="No additional rules." />}
        </Rows>)}
      </>}
      {card.type === 'budget-change' && <Rows><Row title="Dollar allowance" desc={`${leadDollars(card.previous.caps.usdMicros)} → ${leadDollars(card.proposed.usdMicros)}`} /><Row title="Round allowance" desc={`${card.previous.caps.rounds} → ${card.proposed.rounds}`} /></Rows>}
      {card.type === 'stopped' && <Banner>{card.reason === 'unknown-spend' ? 'Worker spend is unknown. Inspect the run before continuing.' : 'The Lead stopped. Inspect its allowance and run.'}</Banner>}
    </LeadContract>
  })}</>
}
