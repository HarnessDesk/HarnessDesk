import { useState, useSyncExternalStore } from 'react'
import { LEAD_LIMITS, leadNoSpendLimit, type LeadThreadState, type LeadWindowProjection } from '@harnessdesk/protocol'
import { Button, Checklist, ChecklistItem, Chip, FormStack, InlineParts, Input, LeadSlot, ListRow, ListRows, Popover, Progress, SummaryItem, SummaryList, Text, ToolBody, ToolProse, ToolSection, leadRoleWord, type ChecklistState } from '../design'
import { useStore } from '../state/context'
import { sanitizeText } from '../lib/sanitize'
import { leadRefusalText } from './lead-refusals'
import { leadDollars, leadSpendCap } from './LeadCards'
import { PencilIcon } from './Icons'
import { LeadRecap } from './LeadAway'
import { LeadWork } from './LeadWork'

/** A Flow role is an id (`implement`); the rail says it in the plan card's word, capitalised for a row title. */
const roleTitle = (role: string) => { const word = leadRoleWord(sanitizeText(role)); return word.charAt(0).toUpperCase() + word.slice(1) }
const roundsWords = (rounds: number) => `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`

/** The plan's state in a word; the two that wait on the person carry the warning tone. */
const planWord = (phase: LeadThreadState, progress: LeadWindowProjection['progress'] | null) =>
  phase === 'awaiting-plan' ? <Chip tone="warning">Waiting for you</Chip>
  : phase === 'waiting-for-user' ? <Chip tone="warning">Needs you</Chip>
  : phase === 'running' && progress ? `Step ${progress.step} of ${progress.steps}`
  : ({ draft: 'Planning', planning: 'Planning', running: 'Running', following: 'Following', accepted: 'Accepted', declined: 'Declined', stopped: 'Stopped' } as const)[phase]

/** The goal's limits, changed from the Spend card: tightening applies at once, raising asks on a card in the conversation. */
const LeadLimits = ({ disabled }: { readonly disabled: boolean }) => {
  const store = useStore(), state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state), caps = state.settings?.caps
  const [dollars, setDollars] = useState(''), [rounds, setRounds] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  if (!caps) return null
  const micros = Math.round(Number(dollars) * 1000000), roundCount = Number(rounds)
  // With no spending limit the dollar field starts empty and empty keeps it: only a figure typed in caps this goal.
  const unlimited = leadNoSpendLimit(caps.usdMicros), dollarsAt = unlimited && dollars.trim() === '' ? caps.usdMicros : micros
  const valid = (unlimited || dollars.trim() !== '') && rounds.trim() !== '' && Number.isSafeInteger(dollarsAt) && dollarsAt >= 0 && dollarsAt <= LEAD_LIMITS.maxUsdMicros && Number.isSafeInteger(roundCount) && roundCount >= 0 && roundCount <= LEAD_LIMITS.rounds
  const raises = valid && (dollarsAt > caps.usdMicros || roundCount > caps.rounds)
  return <Popover title="Lead and reviewed-run limits" aria-label="Change limits" triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} disabled={disabled} label={<PencilIcon />}
    onOpenChange={open => { if (open) { setDollars(unlimited ? '' : String(caps.usdMicros / 1000000)); setRounds(String(caps.rounds)); setError(null) } }}>
    {close => <LeadSlot slot="lead-limits"><FormStack>
      <Text role="muted">Covers Lead replies and reviewed runs. Ordinary chats have their own session spend.</Text>
      <InlineParts><Text role="muted">Up to $</Text><Input aria-label="Dollar limit" type="number" min={0} step="0.01" placeholder={unlimited ? 'No limit' : undefined} value={dollars} disabled={pending} onChange={event => setDollars(event.target.value)} /></InlineParts>
      <InlineParts><Input aria-label="Round limit" type="number" min={0} max={LEAD_LIMITS.rounds} step={1} value={rounds} disabled={pending} onChange={event => setRounds(event.target.value)} /><Text role="muted">rounds</Text></InlineParts>
      <Text role="muted">{raises ? 'Raising asks for your approval in the conversation.' : 'Tightening applies at once.'}</Text>
      {error && <Text role="muted">{error}</Text>}
      <Button disabled={pending || !valid || dollarsAt === caps.usdMicros && roundCount === caps.rounds} aria-busy={pending} onClick={async () => {
        setPending(true); setError(null)
        try { await store.lead.updateSettings({ caps: { usdMicros: dollarsAt, rounds: roundCount } }); close() } catch (failure) { setError(leadRefusalText(failure)) } finally { setPending(false) }
      }}>{raises ? 'Ask to raise' : 'Apply'}</Button>
    </FormStack></LeadSlot>}
  </Popover>
}

/**
 * The Lead's rail: the goal, its plan, the workers the current step seats and
 * what it has spent, in the cards the session and Team rails use. The plan
 * card's decision stays in the conversation; this only reads it back.
 */
export const LeadDetails = () => {
  const store = useStore(), state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const thread = state.thread, phase = thread?.state
  // A plan awaiting approval is the latest plan card's, even when an earlier plan was approved before it.
  const proposed = thread && [...thread.cards].reverse().find(card => card.type === 'plan')?.contract
  const contract = phase === 'awaiting-plan' ? proposed ?? thread?.contract : thread?.contract ?? proposed
  const progress = phase === 'running' ? state.progress : undefined, budget = thread?.budget
  const caps = budget?.caps ?? state.settings?.caps
  const current = progress ? progress.step - 1 : 0
  const stepState = (at: number): ChecklistState => phase === 'accepted' || progress && at < current ? 'done' : progress && at === current ? 'active' : 'pending'
  // Which step is under way is known only while it runs; before the run starts the card names every role the
  // plan seats, and once it has stopped or waits on the person it says nothing rather than guess the step.
  const seated = progress ? contract?.steps[current]?.assignments ?? []
    : phase === 'draft' || phase === 'planning' || phase === 'awaiting-plan' ? contract?.steps.flatMap(step => step.assignments) ?? [] : []
  const workers = [...new Set(seated.map(worker => roleTitle(worker.role)))]
  const known = budget?.spend === 'known', spent = budget ? budget.leadUsdMicros + (known ? budget.workerUsdMicros : 0) : 0
  return <ToolBody>
    {/* One short line while there is no goal: what this rail will hold, and what comes first. */}
    {!(contract && phase) && <ToolSection label="Goal">
      <ToolProse variant="note">{state.projectMissing ? 'Open a folder, then send a goal. Its plan, workers and spend show here.' : 'Send a goal. Its plan, workers and spend show here.'}</ToolProse>
    </ToolSection>}
    <LeadWork />
    {thread && thread.messages.length > 0 && <LeadRecap />}
    {contract && phase && <>
      <ToolSection label="Goal" fold><ToolProse>{sanitizeText(contract.goal)}</ToolProse></ToolSection>
      <ToolSection label="Plan" fold value={planWord(phase, state.progress)}>
        <Checklist surface="panel">{contract.steps.map((step, at) => <ChecklistItem key={step.id} state={stepState(at)}>{sanitizeText(step.title)}</ChecklistItem>)}</Checklist>
      </ToolSection>
      {workers.length > 0 && <ToolSection label="Workers" fold value={workers.length}>
        <ListRows surface="panel">{workers.map(role => <ListRow key={role} size="sm" title={role} />)}</ListRows>
      </ToolSection>}
    </>}
    {caps && <ToolSection label="Spend" value={budget ? known ? leadNoSpendLimit(caps.usdMicros) ? `${leadDollars(spent)} · no limit` : `${leadDollars(spent)} of ${leadDollars(caps.usdMicros)}` : 'Not confirmed' : leadSpendCap(caps.usdMicros)}
      action={<LeadLimits disabled={!!state.error || state.revision < 0} />}>
      <SummaryList surface="panel" aria-label="Spend facts">
        {budget && known && <SummaryItem label="Spent">{leadNoSpendLimit(caps.usdMicros) ? leadDollars(spent) : <Progress size="sm" value={spent} max={caps.usdMicros} label={`${leadDollars(spent)} of ${leadDollars(caps.usdMicros)}`} aria-label="Spent" />}</SummaryItem>}
        {budget && <SummaryItem label="Lead">{leadDollars(budget.leadUsdMicros)}</SummaryItem>}
        {budget && <SummaryItem label="Workers">{known ? leadDollars(budget.workerUsdMicros) : 'Not confirmed'}</SummaryItem>}
        <SummaryItem label="Rounds">{budget ? `${budget.roundsAdmitted} of ${caps.rounds}` : roundsWords(caps.rounds)}</SummaryItem>
      </SummaryList>
    </ToolSection>}
  </ToolBody>
}
