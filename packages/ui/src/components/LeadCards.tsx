import { OutsideHeadBanner } from './GitRecord'
import { useRef, useState, type MutableRefObject } from 'react'
import type { LeadSavedApproval, LeadProactive, LeadAcceptanceContract, LeadAction, LeadActionInput, LeadBudgetState, LeadCard, LeadCardDecision, LeadDecisionMessage, LeadPullRequest } from '@harnessdesk/protocol'
import { LEAD_LIMITS, type LeadCaps } from '@harnessdesk/protocol'
import { Banner, Button, Chip, CodeText, Dialog, FormStack, Input, Row, Rows, LeadContract, LeadPlanFlow, Text } from '../design'
import { leadRepeatWords } from '../lib/lead-repeat'
import { folderName } from '../lib/projects'
import { LeadDecision } from './LeadDecision'
import { LEAD_HANDBACK_LIMIT, LEAD_REPAIR_RECOVERY_FAILED } from './lead-wait-copy'
import { PERMISSION_LABELS } from './lead-permission-labels'
import { Markdown } from './Markdown'
import { sanitizeText } from '../lib/sanitize'

const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
/** Money the way a person reads it, in whole cents. An amount above zero that would round to $0.00 is said in words, because $0.00 means none. */
/** Only what changes is asked about: an allowance whose rounds stay put is a question about dollars alone. */
export const budgetQuestion = (from: { readonly usdMicros: number; readonly rounds: number }, to: { readonly usdMicros: number; readonly rounds: number }): string => {
  const parts = [
    ...(from.usdMicros !== to.usdMicros ? [`from ${leadDollars(from.usdMicros)} to ${leadDollars(to.usdMicros)}`] : []),
    ...(from.rounds !== to.rounds ? [`from ${from.rounds} to ${to.rounds} rounds`] : []),
  ]
  return parts.length === 0 ? 'Keep the allowance as it is?' : `Raise the allowance ${parts.join(' and ')}?`
}

export const leadDollars = (micros: number) => {
  const text = cents.format(micros / 1000000)
  return micros > 0 && text === '$0.00' ? 'less than $0.01' : text
}
export const leadAllowance = (caps: { readonly usdMicros: number; readonly rounds: number }, project?: string): string =>
  `Up to ${leadDollars(caps.usdMicros)} · ${caps.rounds} rounds${project ? ` · ${folderName(project)}` : ''}`
const policyMode = { plan: 'Plan', default: 'Default', manage: 'Manage' }
const ruleWords = (rule: { effect: string; method: keyof typeof PERMISSION_LABELS; action: string | null; project: string | null } | undefined) => rule ? `${rule.effect} · ${PERMISSION_LABELS[rule.method]} · ${rule.action ?? 'All actions'} · ${rule.project ?? 'Approved project'}` : 'No rule'

/** Window-owned details and revision-bound decisions. The child never receives a click. */
type DecisionCard = Extract<LeadCard, { type: LeadCardDecision['cardType'] }>
const decisionCard = (card: LeadCard): card is DecisionCard => !['stopped', 'second-look', 'allowance-warning'].includes(card.type)
export const LeadCards = ({ releasedBranch, cards, personActions = [], onPerform, savedApprovals = [], revokedApprovals = [], onRevoke, decisions = [], contract, budget, goalClosed = false, onDecide, onChanges, onApprovals, knownContracts = [], onRuns, onRaiseLimit, onError, onSettled, decisionLock, decisionPending, setDecisionPending, expiry, focusCard, waitReason, placement = 'both' }: {
  readonly savedApprovals?: readonly LeadSavedApproval[]
  readonly revokedApprovals?: readonly LeadSavedApproval[]
  readonly onRevoke?: (input: { readonly id: string; readonly contractDigest: string }) => Promise<unknown>
  readonly goalClosed?: boolean
  readonly knownContracts?: readonly LeadAcceptanceContract[]
  readonly onRuns?: (contract: LeadAcceptanceContract) => void
  readonly onRaiseLimit?: (logicalGoalId: string, caps: LeadCaps) => Promise<unknown>
  readonly releasedBranch?: LeadPullRequest | null
  readonly personActions?: readonly LeadAction[]; readonly onPerform?: (input: LeadActionInput) => Promise<unknown>
  readonly decisionLock?: MutableRefObject<boolean>; readonly decisionPending?: string | null
  readonly setDecisionPending?: (id: string | null) => void; readonly expiry?: number | null
  readonly waitReason?: 'lead-handback-limit' | 'lead-repair-recovery-failed'
  readonly focusCard?: string | null
  readonly cards: readonly LeadCard[]; readonly decisions?: readonly LeadDecisionMessage[]
  readonly contract?: LeadAcceptanceContract | null; readonly budget?: LeadBudgetState | null
  readonly placement?: 'thread' | 'dock' | 'both'
  readonly onDecide: (decision: LeadCardDecision) => Promise<unknown>; readonly onChanges: () => void
  readonly onApprovals: (runId: string) => void; readonly onError?: (error: unknown) => void; readonly onSettled?: () => void
}) => {
  const approvalRows = [...savedApprovals.map(rule => ({ ...rule, revoked: false })), ...revokedApprovals.map(rule => ({ ...rule, revoked: true }))]
  const [readingRule, setReadingRule] = useState<string | null>(null)
  const reading = approvalRows.find(rule => rule.id === readingRule)
  const latest = useRef(cards); latest.current = cards
  const localBusy = useRef(false), [localPending, setLocalPending] = useState<string | null>(null)
  const busy = decisionLock ?? localBusy, pending = decisionPending === undefined ? localPending : decisionPending
  const setPending = setDecisionPending ?? setLocalPending
  const latestActions = useRef(personActions); latestActions.current = personActions
  const currentDigest = useRef(contract?.digest); currentDigest.current = contract?.digest
  const perform = async (action: LeadAction, choice: LeadActionInput['choice']) => {
    if (busy.current || !onPerform || !contract || currentDigest.current !== contract.digest || !latestActions.current.some(current => current.id === action.id)) return
    busy.current = true; setPending(action.id)
    try { await onPerform({ id: action.id, contractDigest: contract.digest, choice }); onSettled?.() }
    catch (error) { onError?.(error) }
    finally { busy.current = false; setPending(null) }
  }
  const revoke = async (id: string) => {
    if (busy.current || !onRevoke || !contract || currentDigest.current !== contract.digest) return
    busy.current = true; setPending(id)
    try { await onRevoke({ id, contractDigest: contract.digest }); onSettled?.() }
    catch (error) { onError?.(error) }
    finally { busy.current = false; setPending(null) }
  }
  const focus = useRef(new Map<string, HTMLElement>())
  const decide = async (card: DecisionCard, choice: LeadCardDecision['choice']) => {
    if (busy.current || !latest.current.some(current => current.id === card.id && current.revision === card.revision && current.contractDigest === card.contractDigest)) return
    busy.current = true; setPending(card.id)
    let succeeded = false
    try { await onDecide({ version: 1, cardId: card.id, cardType: card.type, expectedRevision: card.revision, contractDigest: card.contractDigest, choice }); succeeded = true }
    catch (error) { onError?.(error) }
    finally { busy.current = false; setPending(null); if (succeeded && onSettled) onSettled(); else focus.current.get(card.id)?.focus() }
  }
  const active = cards.find(card => card.id === focusCard && decisionCard(card) && !(card.type === 'result' && card.outcome !== 'reviewed')) ?? [...cards].reverse().find(card => card.type === 'branch-ownership') ?? [...cards].reverse().find(card => card.type === 'plan') ?? cards.find(card => decisionCard(card) && !(card.type === 'result' && card.outcome !== 'reviewed'))
  const plans = new Map([...knownContracts.map(contract => [contract.digest, contract] as const), ...[...cards, ...decisions.map(({ card }) => card)].flatMap(card => card.type === 'plan' ? [[card.contractDigest, card.contract] as const] : [])])
  return <>{placement !== 'dock' && waitReason && <LeadContract cardType="waiting" cardId={waitReason === 'lead-handback-limit' ? 'handback-limit' : 'repair-recovery-failed'} summary={waitReason === 'lead-handback-limit' ? LEAD_HANDBACK_LIMIT : LEAD_REPAIR_RECOVERY_FAILED} />}{[...cards.map(card => ({ card, choice: undefined as LeadCardDecision['choice'] | undefined })), ...decisions.map(({ card, choice }) => ({ card, choice }))].map(({ card, choice }) => {
    if (card.type === 'second-look') return placement === 'dock' ? null : <LeadSecondLook key={card.id} card={card} />
    if (card.type === 'allowance-warning') {
      const current = card.logicalGoalId === budget?.logicalGoalId
      const historical = decisions.some(message => message.card.id === card.id)
      return placement === 'dock' ? null : <LeadAllowanceWarning key={card.id} card={card} currentCaps={current ? budget?.caps : undefined} onRaise={current && !goalClosed && !historical ? onRaiseLimit : undefined} />
    }
    const worker = card.type === 'waiting' && card.kind === 'worker-approval'
    const person = card.type === 'waiting' && !worker || card.type === 'result' && card.outcome === 'reviewed'
    const approval = card.type === 'plan' || card.type === 'permission-change' || card.type === 'budget-change'
    const renewal = !choice && card.type === 'plan' && expiry != null && card.contractDigest === contract?.digest && JSON.stringify(card.contract) === JSON.stringify(contract)
    // A card is judged against the plan it was made under: a settled result from an earlier goal keeps its own verdict.
    const scope = card.type === 'plan' ? card.contract : card.contractDigest === contract?.digest ? contract : plans.get(card.contractDigest ?? '')
    const summary = worker ? card.summary : card.type === 'plan' ? `${renewal ? 'My earlier approval expired. Approve again to continue.\n\n' : ''}Here's my plan:`      : card.type === 'permission-change' ? `Change permission mode: ${policyMode[card.previous.mode]} → ${policyMode[card.proposed.mode]}\n\n${[...new Set([...card.previous.rules.map(rule => rule.id), ...card.proposed.rules.map(rule => rule.id)])].flatMap(id => { const old = card.previous.rules.find(rule => rule.id === id), next = card.proposed.rules.find(rule => rule.id === id); return JSON.stringify(old) === JSON.stringify(next) ? [] : [`- ${ruleWords(old)} → ${ruleWords(next)}`] }).join('\n')}`
      : card.type === 'budget-change' ? budgetQuestion(card.previous.caps, card.proposed)
      : card.type === 'stopped' ? card.reason === 'unknown-spend' ? 'Worker spend is unknown. Inspect the run before continuing.' : 'The Lead stopped. Inspect its allowance and run.' : card.summary
    const state = choice ? { approve: 'Approved', decline: 'Declined', accept: 'Accepted', 'accept-open-pr': 'Accepted and opened PR', 'reclaim-branch': 'Branch reclaimed' }[choice] : card.type === 'result' && card.outcome !== 'reviewed' ? { accepted: 'Accepted', declined: 'Declined' }[card.outcome] : undefined
    const spend = 'budget' in card ? card.budget : budget
    const assertions = 'assertions' in card ? card.assertions : []
    const caps = renewal && budget ? budget.caps : card.type === 'plan' ? card.contract.caps : undefined
    const ref = (element: HTMLElement | null) => { if (element) focus.current.set(card.id, element); else focus.current.delete(card.id) }
    return <div key={`${card.id}:${card.revision}:${choice ?? 'pending'}`}>
      {card.type === 'branch-ownership' && !state && placement !== 'dock' && <OutsideHeadBanner branch={releasedBranch?.branch ?? `Branch for #${card.number}`} head={card.observedHead} previous={releasedBranch?.head} rewritten={releasedBranch?.branchChange === 'rewrite'} disabled={pending !== null} onReclaim={() => { void decide(card, 'reclaim-branch') }} />}
      {placement !== 'dock' && (card.type !== 'branch-ownership' || state) && <LeadContract cardId={card.id} cardType={card.type} summary={summary} state={state} focusRef={ref}>
        {card.type === 'plan' && <>
          {card.contract.repeat && <><Chip tone="neutral">Repeats</Chip><Text as="p" role="subject">How it repeats</Text>
            <Text as="p" role="prose">{leadRepeatWords[card.contract.repeat.every]} at {card.contract.repeat.at}</Text>
            <Text as="p" role="muted">{card.contract.repeat.every === 'mondays' || card.contract.repeat.every === 'fridays' ? 'Skips a week while the last run waits for you' : 'Skips a run while the last one waits for you'}</Text>
            <Text as="p" role="muted">Runs once when the desk wakes, if it was asleep</Text></>}
          <LeadPlanFlow steps={card.contract.steps} /><Markdown text={`Done when:\n\n${card.contract.assertions.map(assertion => `- ${assertion.description}`).join('\n')}`} /></>}
        {card.type === 'result' && card.publication === 'push' && <Text as="p" role="meta">Push the reviewed changes and open a pull request.</Text>}
        {caps && <><Text as="p" role="meta">{card.type === 'plan' && card.contract.repeat ? `Up to ${leadDollars(caps.usdMicros)} a run · ${caps.rounds} rounds` : leadAllowance(caps, scope?.project.path)}</Text><Text as="p" role="meta">Publishing, merging and deleting still need your separate approval.</Text></>}
        {(card.type === 'plan' || card.type === 'result') && scope?.repeat && onRuns && <Button variant="quiet" onClick={() => onRuns(scope)}>Runs</Button>}
        {(card.type === 'waiting' && !worker || card.type === 'result') && <>
          <Text as="p" role="meta">{(['check', 'review', 'blocking-findings', 'diff'] as const).flatMap(kind => {
            const expected = scope?.assertions.filter(assertion => assertion.kind === kind) ?? []
            if (!expected.length) return []
            const results = expected.map(assertion => assertions.find(result => result.assertionId === assertion.id))
            // No blocking finding is recorded as a pass with nothing to cite; every other kind needs evidence to be known.
            const known = results.every(result => result && result.contractRevision === scope?.revision && (result.evidence.length > 0 || kind === 'blocking-findings' && result.status === 'passed'))
            const status = known ? results.some(result => result?.status === 'failed') ? 'failed' : results.every(result => result?.status === 'passed') ? 'passed' : 'unknown' : 'unknown'
            return [status === 'passed' && kind === 'blocking-findings' ? 'No blocking findings' : status === 'passed' && kind === 'diff' ? 'Changes ready' : `${{ check: 'Checks', review: 'Review', 'blocking-findings': 'Findings', diff: 'Changes' }[kind]} ${status === 'unknown' ? 'not confirmed' : status}`]
          }).join(' · ')}</Text>
          {assertions.filter(result => scope?.assertions.some(assertion => assertion.id === result.assertionId)).map(result => result.reason ? <LeadReason key={result.assertionId} text={result.reason} /> : null)}
          {spend && <Text as="p" role="meta">I spent {leadDollars(spend.leadUsdMicros)}{spend.spend === 'known' && <> · workers reported {leadDollars(spend.workerUsdMicros)}</>}.</Text>}
        </>}
      </LeadContract>}
      {card.type !== 'branch-ownership' && placement !== 'thread' && !state && active === card && !personActions.some(action => action.id === card.id) && <LeadDecision key={`${card.id}:${card.revision}`} id={card.id} type={card.type} detail={card.type === 'permission-change' || card.type === 'budget-change' ? summary : undefined} title={card.type === 'plan' ? 'Approve this plan?' : worker ? 'A worker needs your approval' : person ? 'Accept these changes?' : 'Approve this change?'} pending={pending !== null} focusRef={ref}
        approveLabel={person ? 'Accept' : 'Approve'} onApprove={person || approval ? () => { void decide(card as DecisionCard, person ? 'accept' : 'approve') } : undefined}
        onOpenPr={card.type === 'result' && card.outcome === 'reviewed' ? () => { void decide(card, 'accept-open-pr') } : undefined}
        onDecline={person || approval ? () => { void decide(card as DecisionCard, 'decline') } : undefined}
        link={worker ? { label: 'Open approvals', run: () => onApprovals(card.runId) } : person ? { label: 'Open changes', run: onChanges } : undefined} />}
    </div>
  })}{placement !== 'thread' && personActions.map(action => <Row key={action.id} kind="record" layout="record"
    title={action.kind === 'worker-approval' ? `The ${action.role} wants to ${action.request}` : `Run check ${action.name}`}
    desc={action.kind === 'check' ? <CodeText block wrap>{action.command}</CodeText> : action.details ? <CodeText block wrap>{sanitizeText(action.details)}</CodeText> : undefined}
    control={action.kind === 'worker-approval' ? <>
      {action.choices.includes('yes-once') && <Button disabled={pending !== null || !onPerform} onClick={() => void perform(action, 'yes-once')}>Yes once</Button>}
      {action.choices.includes('yes-goal') && <Button disabled={pending !== null || !onPerform} onClick={() => void perform(action, 'yes-goal')}>Yes for this goal</Button>}
      {action.choices.includes('no') && <Button disabled={pending !== null || !onPerform} onClick={() => void perform(action, 'no')}>No</Button>}
    </> : <Button disabled={pending !== null || !onPerform} onClick={() => void perform(action, 'run')}>{`Run check ${action.name}`}</Button>} />)}
    {placement !== 'dock' && approvalRows.length > 0 && <section aria-label="Saved approvals for this goal">
      <Text as="p" role="subject">Saved approvals for this goal</Text>
      <Rows>{approvalRows.map(rule => <Row key={rule.id} title={<>{sanitizeText(rule.target)}{rule.revoked ? <Chip tone="neutral">Revoked</Chip> : rule.uncertain ? <Chip tone="warning">Needs review</Chip> : null}</>} desc={`${rule.count} ${rule.count === 1 ? 'request' : 'requests'} answered`}
        control={<>{!!rule.entries?.length && <Button variant="secondary" onClick={() => setReadingRule(rule.id)}>View changes</Button>}{!rule.revoked && <Button variant="secondary" disabled={pending !== null || !onRevoke || goalClosed} onClick={() => void revoke(rule.id)}>Revoke</Button>}</>} />)}</Rows>
    </section>}
    {reading && <Dialog title="Changes under this approval" description={sanitizeText(reading.target)} onClose={() => setReadingRule(null)} footer={<Button onClick={() => setReadingRule(null)}>Close</Button>}>
      <Text as="p" role="meta">{reading.revoked && <Chip tone="neutral">Revoked</Chip>}{` Newest first · ${reading.entries?.filter(entry => !entry.uncertain).length ?? 0} of ${reading.count} ${reading.count === 1 ? 'answer' : 'answers'} retained${reading.entries?.some(entry => entry.uncertain) ? ` · ${reading.entries.filter(entry => entry.uncertain).length} needs review` : ''}`}</Text>
      <Rows>{reading.entries?.map(entry => <Row key={entry.id} kind="record" layout="record" title={<>{`Request ${entry.number}`}{entry.uncertain && <Chip tone="warning">Needs review</Chip>}</>} desc={<CodeText block wrap>{sanitizeText(entry.diff)}</CodeText>} />)}</Rows>
    </Dialog>}
  </>
}
const LeadReason = ({ text }: { readonly text: string }) => <Markdown text={text} />

const LeadSecondLook = ({ card }: { readonly card: Extract<LeadCard, { type: 'second-look' }> }) => <LeadContract cardId={card.id} cardType={card.type}>
  <Text as="p" role="subject">Second look</Text>
  <Rows>{(['said', 'found', 'did'] as const).map(key => <Row key={key} title={{ said: 'Said', found: 'Found', did: 'Did' }[key]} desc={sanitizeText(card[key])} />)}</Rows>
</LeadContract>

const LeadAllowanceWarning = ({ card, currentCaps, onRaise }: {
  readonly card: Extract<LeadCard, { type: 'allowance-warning' }>
  readonly currentCaps?: LeadCaps
  readonly onRaise?: (logicalGoalId: string, caps: LeadCaps) => Promise<unknown>
}) => {
  const [open, setOpen] = useState(false), [dollars, setDollars] = useState(''), [rounds, setRounds] = useState('')
  const [pending, setPending] = useState(false), [error, setError] = useState(false), busy = useRef(false)
  const caps = currentCaps ?? card.caps
  const usdMicros = Math.round(Number(dollars) * 1000000), count = Number(rounds)
  const valid = dollars.trim() !== '' && rounds.trim() !== '' && Number.isSafeInteger(usdMicros) && usdMicros >= caps.usdMicros && usdMicros <= LEAD_LIMITS.maxUsdMicros && Number.isSafeInteger(count) && count >= caps.rounds && count <= LEAD_LIMITS.rounds && (usdMicros > caps.usdMicros || count > caps.rounds)
  return <LeadContract cardId={card.id} cardType={card.type}>
    <Text as="p" role="subject">At 80%</Text>
    <Text as="p" role="value" tone="warning">{leadDollars(card.usdMicros)} of {leadDollars(caps.usdMicros)}</Text>
    <Text as="p" role="muted">At {leadDollars(caps.usdMicros)} the goal stops</Text>
    {onRaise && <Button variant="outline" onClick={() => { setDollars(String(caps.usdMicros / 1000000)); setRounds(String(caps.rounds)); setError(false); setOpen(true) }}>Raise limit…</Button>}
    {open && <Dialog title="Raise limit" description="Applies to this goal. A goal that has stopped stays stopped." onClose={() => { if (!busy.current) setOpen(false) }}
      footer={<><Button disabled={pending || !valid} aria-busy={pending} onClick={async () => {
        if (!valid || !onRaise || busy.current) return
        busy.current = true; setPending(true); setError(false)
        try { await onRaise(card.logicalGoalId, { usdMicros, rounds: count }); setOpen(false) } catch { setError(true) } finally { busy.current = false; setPending(false) }
      }}>Apply</Button><Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button></>}>
        <FormStack><Rows>
          <Row title="Dollar cap" control={<Input aria-label="New dollar cap" type="number" min={caps.usdMicros / 1000000} max={LEAD_LIMITS.maxUsdMicros / 1000000} step="0.01" value={dollars} disabled={pending} onChange={event => setDollars(event.target.value)} />} />
          <Row title="Rounds" control={<Input aria-label="New rounds" type="number" min={caps.rounds} max={LEAD_LIMITS.rounds} step={1} value={rounds} disabled={pending} onChange={event => setRounds(event.target.value)} />} />
        </Rows>{error && <Banner tone="warning" role="alert">The limit could not be changed. Read the current goal and try again.</Banner>}</FormStack>
    </Dialog>}
  </LeadContract>
}

/** A single host-shaped finding, qualification and next step; navigation never answers a decision. */
export const LeadProactiveCard = ({ report, onAction }: { readonly report: LeadProactive; readonly onAction?: (action: NonNullable<LeadProactive['action']>) => void }) => <LeadContract>
  <Text as="p" role="prose" data-proactive-part="finding">{sanitizeText(report.finding)}</Text>
  <Text as="p" role="muted" data-proactive-part="caveat">{sanitizeText(report.caveat)}</Text>
  <div data-proactive-part="ask">{report.action && onAction
    ? <Button variant="outline" onClick={() => onAction(report.action!)}>{sanitizeText(report.ask)}</Button>
    : <Text as="p" role="prose">{sanitizeText(report.ask)}</Text>}</div>
</LeadContract>
