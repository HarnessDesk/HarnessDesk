import { PullRequestRecord } from './GitRecord'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LEAD_LIMITS, type LeadStopReason, type LeadWindowProjection } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, FormStack, InlineParts, LeadSlot, ConversationComposerFrame, ComposerNoticeStack, ComposerText, ComposerTools, ComposerGap, ComposerSend, ComposerTrack, ConversationShell, ConversationThread, ConversationDock, ConversationEmptyState, Input, LeadAvatar, Menu, MenuItem, Page, Popover, Spinner, Text, TurnWorkLive, useComposerHeightVar } from '../design'
import { openExternal } from '../lib/desktop'
import { leadWakeLine } from '../lib/lead-presence'
import { LeadNameIntro } from './LeadNameIntro'
import { LeadWakeLedger } from './LeadWakeLedger'
import { LeadOpening } from './LeadOpening'
import { leadOpeningJobs } from '../lib/lead-opening'
import { LeadAway } from './LeadAway'
import { useDestinationPage, useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import { LeadMessage } from './LeadMessage'
import { LeadCards, leadDollars } from './LeadCards'
import { LEAD_HANDBACK_LIMIT, LEAD_REPAIR_RECOVERY_FAILED } from './lead-wait-copy'
import { REFUSALS, leadRefusalText } from './lead-refusals'
import { useConversationTopBar } from './use-conversation-top-bar'
import { AtIcon, FolderIcon, PlusIcon, RouteIcon, SendIcon, SettingsIcon } from './Icons'
import { LeadStatusPanel, useLeadControls } from './LeadControls'
import { sidebarPlacement } from '../state/workbench'
import { formatLeadConsentTime } from './lead-consent-time'

const WAITS: Record<NonNullable<LeadWindowProjection['waitReason']>, string> = {
  'lead-predecessor-unavailable': "The previous step's result wasn't accepted, so the next step can't start. Message {label} to change the plan, or stop this goal.",
  'lead-predecessor-unverifiable': "HarnessDesk can't confirm what the previous step produced, so the next step won't start. Message {label} to change the plan, or stop this goal.",
  'lead-renewal-blocked': 'The plan could not be renewed because the pending request limit was reached.',
  'lead-disabled': 'The Lead was disabled.',
  'lead-key-changed': 'The provider key changed. Continue with the current key.',
  'lead-host-shutdown': 'The desk stopped while the Lead was working.',
  'lead-ownership-withdrawn': 'The Lead no longer owns its previous run.',
  'lead-pr-branch-rewritten': 'The branch was rewritten outside this goal. Reclaim the branch to resume automatic repairs.',
  'lead-pr-head-changed': 'The pull request head changed outside this goal. Inspect the pull request before continuing.',
  'lead-handback-limit': LEAD_HANDBACK_LIMIT,
  'lead-repair-recovery-failed': LEAD_REPAIR_RECOVERY_FAILED,
  'lead-handback-pending': 'A repair is already running. The next event is waiting.',
  'lead-repair-failed': 'Checks failed on the repaired branch. Inspect the pull request before continuing.',
  'lead-repair-withdrawn': 'The repair was withdrawn when following was turned off. Inspect the pull request before continuing.',
  'lead-repair-abandoned': 'The repair ended after the branch changed. Inspect the current pull request before continuing.',
  'lead-repair-unverified': 'CI passed, but the current branch has no matching reviewed result. Inspect the work before continuing.',
  'lead-publication-needs-you': 'The branch or pull request could not be published. Inspect the work and try the approval again, or stop this goal.',
  'lead-result-awaiting-person': 'The result is waiting for your decision.',
  'lead-result-revisions-exhausted': 'The result reached its revision limit.',
  'lead-start-binding-failed': 'The run could not be linked to the approved plan.',
  'lead-plan-refused': 'The proposed plan could not be offered.',
  'lead-plan-unseatable': "A seat in the proposed plan can't work within its permissions, so the plan wasn't offered. Send a message to plan with other agents.",
  'lead-plan-not-independent': "The proposed plan's reviewer can't be shown to use a different provider from its implementer, so no review could ever accept the work. Add an agent from another provider, or send a message to plan again.",
  'lead-activity-failed': 'The Lead could not read the latest run activity.',
  'lead-subscription-failed': 'The Lead lost its run activity updates.',
  'lead-tools-refused': 'The requested desk operation was refused.',
  'lead-card-too-large': 'The request is too large to display safely.',
  'lead-budget-unknown': "HarnessDesk can't confirm what the workers have spent, so the Lead won't make another request. Sending a message tries again.",
  'lead-run-not-started': 'The plan is approved, but no work has started. Sending a message also continues.',
  'lead-request-failed': 'The request was interrupted. Sending a message also continues.',
  'lead-request-uncertain': 'The request was interrupted. Sending a message also continues.',
  'lead-send-deadline': 'The request timed out. Sending a message also continues.',
  'lead-child-exited': 'The Lead stopped unexpectedly. Sending a message also continues.',
  'lead-request-rate-limited': 'The provider asked the Lead to wait.',
  'lead-request-max-tokens': 'The request reached its response limit.',
  'lead-request-refused': 'The provider refused the request.',
  'lead-request-invalid-response': 'The provider returned an unreadable response.',
  'lead-request-cancelled': 'The request was cancelled.',
}
// Why a goal ended, when no stopped card says it already. A person's own Stop needs no reason.
const STOPPED: Record<LeadStopReason, string> = {
  cancelled: 'This goal was stopped.',
  budget: 'This goal was stopped at its spending allowance.',
  rounds: 'This goal was stopped at its round allowance.',
  'unknown-spend': "This goal was stopped because HarnessDesk couldn't confirm what the workers spent.",
  'connection-lost': 'This goal was stopped when the connection to the workers was lost.',
  recovery: "This goal was stopped because its work couldn't be recovered.",
  error: 'This goal was stopped by an error.',
}
const runsWords = (runs: number) => runs ? `${runs} ${runs === 1 ? 'run' : 'runs'}` : 'no runs yet'
/** Elapsed time beside Stop: minutes under an hour, then hours and minutes. */
export const leadElapsed = (ms: number) => { const minutes = Math.max(0, Math.floor(ms / 60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` }
const roundsWords = (rounds: number) => `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`

/** The goal's limits as one chip; tightening applies at once, raising asks on a card in the conversation. */
const LeadLimits = ({ disabled }: { readonly disabled: boolean }) => {
  const store = useStore(), state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state), caps = state.settings?.caps
  const [dollars, setDollars] = useState(''), [rounds, setRounds] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  if (!caps) return null
  const micros = Math.round(Number(dollars) * 1000000), roundCount = Number(rounds)
  const valid = dollars.trim() !== '' && rounds.trim() !== '' && Number.isSafeInteger(micros) && micros >= 0 && micros <= LEAD_LIMITS.maxUsdMicros && Number.isSafeInteger(roundCount) && roundCount >= 0 && roundCount <= LEAD_LIMITS.rounds
  const raises = valid && (micros > caps.usdMicros || roundCount > caps.rounds)
  return <ComposerTrack name="mode">
    <Popover title="Limits for this goal" drop="up" align="left" disabled={disabled} label={`Up to ${leadDollars(caps.usdMicros)} · ${roundsWords(caps.rounds)}`}
      onOpenChange={open => { if (open) { setDollars(String(caps.usdMicros / 1000000)); setRounds(String(caps.rounds)); setError(null) } }}>
      {close => <LeadSlot slot="lead-limits"><FormStack>
        <InlineParts><Text role="muted">Up to $</Text><Input aria-label="Dollar limit" type="number" min={0} step="0.01" value={dollars} disabled={pending} onChange={event => setDollars(event.target.value)} /></InlineParts>
        <InlineParts><Input aria-label="Round limit" type="number" min={0} max={LEAD_LIMITS.rounds} step={1} value={rounds} disabled={pending} onChange={event => setRounds(event.target.value)} /><Text role="muted">rounds</Text></InlineParts>
        <Text role="muted">{raises ? 'Raising asks for your approval in the conversation.' : 'Tightening applies at once.'}</Text>
        {error && <Text role="muted">{error}</Text>}
        <Button disabled={pending || !valid || micros === caps.usdMicros && roundCount === caps.rounds} aria-busy={pending} onClick={async () => {
          setPending(true); setError(null)
          try { await store.lead.updateSettings({ caps: { usdMicros: micros, rounds: roundCount } }); close() } catch (failure) { setError(leadRefusalText(failure)) } finally { setPending(false) }
        }}>{raises ? 'Ask to raise' : 'Apply'}</Button>
      </FormStack></LeadSlot>}
    </Popover>
  </ComposerTrack>
}
export const LeadPage = ({ initialGoal = '', focus = null }: { readonly initialGoal?: string; readonly focus?: string | null }) => {
  const store = useStore(), snapshot = useSnapshot(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const unavailable = state.settings?.unavailable === 'runtime'
  const [goal, setGoal] = useState(initialGoal), [error, setError] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false), [stopping, setStopping] = useState(false)
  const stoppingRef = useRef(false)
  const [choosingName, setChoosingName] = useState(false)
  const [sending, setSending] = useState(false), [resuming, setResuming] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null), inFlight = useRef(false), thread = useRef<HTMLDivElement>(null)
  const decisionLock = useRef(false), [decisionPending, setDecisionPending] = useState<string | null>(null)
  const pinned = useRef(true)
  const [selectedDecision, setSelectedDecision] = useState<string | null>(focus)
  const requestedDecisionFocus = useRef<string | null>(null)
  const focusDock = (id: string) => {
    const element = [...(shell.current?.querySelectorAll<HTMLElement>('[data-lead-decision]') ?? [])].find(node => node.dataset.leadDecision === id)?.querySelector<HTMLElement>('[data-slot="approval-card"]')
    if (element) { element.focus({ preventScroll: true }); requestedDecisionFocus.current = null }
  }
  const refusal = (error: unknown) => setError(leadRefusalText(error))
  const { owner } = useDestinationPage(), controls = useLeadControls(), { name, label, presence } = controls
  const shell = useRef<HTMLDivElement>(null), dock = useComposerHeightVar(shell)
  const terminalWait = state.waitReason === 'lead-predecessor-unavailable' || state.waitReason === 'lead-predecessor-unverifiable'
  const canStop = !!state.thread && !['stopped', 'accepted', 'declined'].includes(state.thread.state) &&
    (state.thread.state !== 'draft' || state.thread.messages.some(message => message.role === 'user'))
  const goalActive = canStop && !terminalWait
  const stopAction = <Button variant="ghost" disabled={stopping || decisionPending !== null} onClick={() => setConfirmStop(true)}>Stop goal</Button>
  const stop = async () => {
    if (stoppingRef.current || decisionLock.current) return
    stoppingRef.current = true; decisionLock.current = true; setStopping(true); setError(null)
    try { await store.lead.stop(); setConfirmStop(false) }
    catch (error) { refusal(error) }
    finally { stoppingRef.current = false; decisionLock.current = false; setStopping(false); input.current?.focus() }
  }
  useConversationTopBar(owner, { mark: <LeadAvatar name={name} size="header" />, place: label, placeTitle: `${label} · ${presence.word}`, placeMenu: close => <LeadStatusPanel close={close} controls={controls} />,
    state: <Text role="muted" data-slot="lead-presence">{presence.word}</Text>, tools: <Button variant="ghost" size="icon" title="Lead settings" aria-label="Lead settings" onClick={controls.openSettings}><SettingsIcon /></Button>, terminal: false, more: () => null, corner: sidebarPlacement(snapshot) !== 'column' }, active)
  // The run strip's clock: a minute is its smallest step, so it ticks twice a minute while a goal runs.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (!goalActive) return; const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [goalActive])
  useEffect(() => { if (active) void store.lead.readThread().catch(refusal) }, [active, store])
  useEffect(() => { if (active) void store.lead.readWakes().catch(() => {}) }, [active, state.revision, store])
  // Expiry is host-owned; a read at its boundary obtains the renewed plan card.
  useEffect(() => {
    if (!active || state.planConsentExpiresAt === null || state.wayOut === 'decide-plan' || state.thread && ['stopped', 'accepted', 'declined'].includes(state.thread.state)) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>, backoff = 1000
    const refresh = async (final = false) => {
      try { await store.lead.readThread() } catch (error) { refusal(error) }
      if (!final && !cancelled && store.lead.state.wayOut !== 'decide-plan' && store.lead.state.planConsentExpiresAt === state.planConsentExpiresAt) {
        const delay = backoff
        timer = setTimeout(() => void refresh(delay === 30000), delay); backoff = Math.min(backoff * 2, 30000)
      }
    }
    timer = setTimeout(refresh, Math.max(0, Math.min(state.planConsentExpiresAt - Date.now() + 50, 2147483647)))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, state.planConsentExpiresAt, state.wayOut, state.thread?.state, store])
  const send = async (text = goal) => {
    if (unavailable || inFlight.current || state.requestInFlight || !text.trim()) return
    inFlight.current = true; setSending(true); setError(null)
    try { await store.lead.send(text.trim(), crypto.randomUUID()); setGoal(current => current === text ? '' : current) }
    catch (error) { refusal(error) }
    finally { inFlight.current = false; setSending(false); input.current?.focus() }
  }
  const steer = async () => {
    if (inFlight.current || !goal.trim()) return
    inFlight.current = true; setSending(true); setError(null)
    try { await store.lead.steer(goal.trim()); setGoal('') }
    catch (error) { refusal(error) }
    finally { inFlight.current = false; setSending(false); input.current?.focus() }
  }
  const cards = state.thread?.cards ?? []
  const contract = state.thread?.contract ?? cards.find(card => card.type === 'plan')?.contract
  const renewal = state.planConsentExpiresAt !== null && cards.some(card => card.type === 'plan' && card.contractDigest === state.thread?.contract?.digest && JSON.stringify(card.contract) === JSON.stringify(state.thread?.contract))
  const requestPending = sending || state.requestInFlight
  // What the Lead is doing this second, as one quiet line at the end of the thread. A window that cannot trust its
  // projection says nothing; a plan on the table or a wait for the person is not work, and a stopped card speaks for itself.
  const phase = state.thread?.state, progress = state.progress, pr = state.thread?.pr, origin = state.thread?.origin, handback = state.thread?.handback
  const repairActive = phase === 'running' && handback?.stage === 'running' && pr?.branchOwner !== 'person'
  const live = state.error ? null
    : repairActive ? <TurnWorkLive data-slot="lead-live-line" data-kind="handback">{`Repairing ${handback.kind === 'checks' ? 'checks' : 'review comments'} · round ${handback.round}`}</TurnWorkLive>
    : phase === 'running' && progress ? <TurnWorkLive data-slot="lead-live-line" data-kind="running">{`Step ${progress.step} of ${progress.steps}${contract?.steps[progress.step - 1] ? ` · ${contract.steps[progress.step - 1]!.title}` : ''} · ${runsWords(progress.runs)}`}</TurnWorkLive>
    : (phase === 'draft' || phase === 'planning') && state.requestInFlight ? <TurnWorkLive data-slot="lead-live-line" data-kind="planning">Planning…</TurnWorkLive>
    : phase === 'stopped' && !cards.some(card => card.type === 'stopped') ? <TurnWorkLive settled data-slot="lead-live-line" data-kind="stopped">{STOPPED[state.thread?.budget?.stop?.reason ?? 'cancelled']}</TurnWorkLive>
    : null
  const openingJobs = !state.error && state.thread && !state.thread.messages.length && !state.thread.olderMessages && !state.thread.cards.length ? leadOpeningJobs(snapshot, state.thread.project?.path ?? null, pr) : []
  const entries = [...(state.thread?.messages ?? []).map(message => ({ revision: message.revision, kind: 'message' as const, message })),
    ...cards.map(card => ({ revision: state.thread?.cardPositions?.[card.id] ?? card.revision, kind: 'card' as const, card })),
    ...(state.thread?.decisions ?? []).map(decision => ({ revision: decision.position, kind: 'decided' as const, decision })),
    // A steer sits just after what the thread held when it was sent; one without a revision stays at the end.
    ...(state.steers ?? []).map((steer, index) => ({ revision: steer.after === undefined ? Infinity : steer.after + 0.5, kind: 'steer' as const, steer, index }))].sort((a, b) => a.revision - b.revision)
  // A Lead turn shows its face once, on its first line; the person's message starts the next turn.
  const faces = new Set<string>()
  for (let at = 0, open = false; at < entries.length; at++) {
    const entry = entries[at]!
    if (entry.kind !== 'message') continue
    if (entry.message.role === 'user') open = false
    else if (!open) { faces.add(entry.message.id); open = true }
  }
  const actionablePlan = entries.filter(entry => entry.kind === 'card' && entry.card.type === 'plan').at(-1)
  const scrollToPlan = () => {
    if (actionablePlan?.kind !== 'card') return
    const element = [...(thread.current?.querySelectorAll<HTMLElement>('[data-lead-card]') ?? [])].find(node => node.dataset.leadCard === actionablePlan.card.id)
    element?.scrollIntoView?.({ block: 'end' })
  }
  useEffect(() => { if (pinned.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight }, [active, state.revision])
  useEffect(() => { if (state.wayOut === 'decide-plan') scrollToPlan() }, [state.wayOut, actionablePlan?.kind === 'card' ? `${actionablePlan.card.id}:${actionablePlan.card.revision}` : null])
  const focusedDecision = useRef<string | null>(null)
  useEffect(() => {
    if (!active) { focusedDecision.current = null; return }
    if (!focus || focusedDecision.current === focus) return
    const element = [...(thread.current?.querySelectorAll<HTMLElement>('[data-lead-card]') ?? [])].find(node => node.dataset.leadCard === focus)
    if (!element) return
    focusedDecision.current = focus
    requestedDecisionFocus.current = focus; setSelectedDecision(focus)
    element.scrollIntoView?.({ block: 'end' }); focusDock(focus)
  }, [active, focus, state.revision])
  useEffect(() => {
    if (!active || !requestedDecisionFocus.current) return
    if (!cards.some(card => card.id === requestedDecisionFocus.current)) { requestedDecisionFocus.current = null; return }
    focusDock(requestedDecisionFocus.current)
  }, [active, selectedDecision, state.revision])
  const cardProps = {
    releasedBranch: pr,
    onPerform: (input: Parameters<typeof store.lead.perform>[0]) => store.lead.perform(input),
    focusCard: selectedDecision, decisionLock, decisionPending, setDecisionPending, expiry: state.planConsentExpiresAt, contract, budget: state.thread?.budget,
    onDecide: (decision: Parameters<typeof store.lead.decide>[0]) => { setError(null); return store.lead.decide(decision) }, onError: refusal, onSettled: () => input.current?.focus(),
    onChanges: () => store.openDestination({ kind: 'changes-review', root: state.thread?.project?.path ?? null, returnTo: { kind: 'conversation', session: null } }),
    onApprovals: (runId: string) => { void (async () => { try { const run = snapshot.flowExecutions.get(runId) ?? await store.readFlowExecution(runId); store.openGoal(run.goal) } catch (error) { refusal(error) } })() },
  }
  return <ConversationShell ref={shell}>
    <ConversationThread ref={thread} role="region" aria-label={`${label} thread`} onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24 }}>
      {entries.length || live || pr || openingJobs.length || name || state.wakes?.length ? <Page width="reading" gutter="none">
        <LeadWakeLedger wakes={state.wakes ?? []} />
        {name && <LeadNameIntro name={name} chosen={state.settings?.nameChosen === true} pending={choosingName || !!state.error || state.revision < 0} onChoose={async name => {
          if (choosingName) return
          setChoosingName(true)
          try { await store.lead.updateSettings({ name }) } catch (error) { refusal(error) } finally { setChoosingName(false) }
        }} />}
        <LeadOpening jobs={openingJobs} pending={unavailable || requestPending || state.revision < 0} onStart={text => void send(text)} />
        {state.thread?.olderMessages ? <Text as="p" role="muted">{state.thread.olderMessages} older messages remain in the journal.</Text> : null}
        {origin && <Text as="p" role="meta" data-slot="lead-origin">{origin.url && /^https?:\/\//i.test(origin.url) ? <Button variant="link" size="inline-link" onClick={() => openExternal(origin.url!)}>{`From: ${origin.event.replace(/-/g, ' ')} on ${origin.subject}`}</Button> : `From: ${origin.event.replace(/-/g, ' ')} on ${origin.subject}`}</Text>}
        {entries.map(entry => entry.kind === 'message'
          ? <LeadMessage key={`message:${entry.message.id}`} role={entry.message.role === 'user' ? 'user' : 'assistant'} name={label} lead={name} text={entry.message.text}
            proactive={entry.message.proactive} onAction={entry.message.proactive?.action === 'plan' && !actionablePlan || entry.message.proactive?.action === 'approvals' && !state.personActions.length ? undefined : action => { if (action === 'plan') scrollToPlan(); else if (action === 'changes') cardProps.onChanges(); else { const runId = state.personActions[0]?.runId; if (runId) cardProps.onApprovals(runId) } }} face={faces.has(entry.message.id)} />
          : entry.kind === 'steer' ? <LeadMessage key={`steer:${entry.steer.id}`} role="user" text={entry.steer.text}
            note={<Chip tone={entry.steer.state === 'acknowledged' ? 'neutral' : 'warning'} data-slot="lead-steer">{`Steer ${entry.index + 1} · ${entry.steer.state === 'acknowledged' ? 'Acknowledged' : 'Not taken'}`}</Chip>} />
          : entry.kind === 'decided' ? <LeadCards key={`decided:${entry.decision.card.id}:${entry.decision.card.revision}`} {...cardProps} cards={[]} decisions={[entry.decision]} placement="thread" />
          : <LeadCards key={`card:${entry.card.id}`} {...cardProps} cards={[entry.card]} placement="thread" />)}

        {pr && <div data-slot="lead-pr-status"><InlineParts>
          <Button variant="link" size="inline-link" title={pr.observedHead ?? pr.head} onClick={() => openExternal(`https://github.com/${pr.repository}/pull/${pr.number}`)}>{`#${pr.number}`}</Button>
          <Text role="meta">{pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : `Checks ${pr.check?.state ?? 'not confirmed'} · Review ${pr.review?.state?.replace(/-/g, ' ') ?? 'not confirmed'}`}</Text>
          <Chip tone="neutral">{pr.branchOwner === 'person' ? 'Your branch' : 'Automatic repairs'}</Chip>
        </InlineParts></div>}
        {(state.waitReason === 'lead-handback-limit' || state.waitReason === 'lead-repair-recovery-failed') && <LeadCards {...cardProps} cards={[]} waitReason={state.waitReason} placement="thread" />}
        {pr && state.thread?.project && <PullRequestRecord root={state.thread.project.path} reference={{ repo: pr.repository, number: pr.number }} branch={pr.branch} />}
        {live}
      </Page> : <ConversationEmptyState><LeadAvatar name={name} size="picker" mood={presence.mood} /><Text as="p" role="prose" align="center">{name ? `Hi, I'm ${label}. Tell me what you want done, and I'll plan it for your approval.` : 'Hi, tell me what you want done.'}</Text></ConversationEmptyState>}
    </ConversationThread>
    {active && <ConversationDock ref={dock}>
      <ConversationComposerFrame before={<ComposerNoticeStack>
          {unavailable && <Banner>{REFUSALS['lead-runtime-unsupported']}{state.settings?.unavailableReason ? <Text as="span" role="muted">{` ${state.settings.unavailableReason.charAt(0).toUpperCase()}${state.settings.unavailableReason.slice(1)}.`}</Text> : null}</Banner>}
          <LeadAway active={active} state={state} label={label} />
          {goalActive && <LeadSlot slot="lead-run-strip"><Banner mark={<LeadAvatar name={name} size="turn" />} actions={stopAction}>{phase === 'following' ? `Following #${pr?.number ?? ''}` : repairActive ? `Repairing ${handback.kind === 'checks' ? 'checks' : 'review comments'} · round ${handback.round}` : phase === 'running' ? `${label} is running 1 goal` : phase === 'awaiting-plan' ? 'A plan is waiting for you' : phase === 'waiting-for-user' ? `${label} is waiting for you` : `${label} is planning`}{state.progress?.since !== undefined ? ` · ${leadElapsed(now - state.progress.since)}` : ''}{phase === 'running' && leadWakeLine(state.presence) ? <Text as="span" role="muted">{` · ${leadWakeLine(state.presence)}`}</Text> : null}</Banner></LeadSlot>}
          {(error || state.error) && <Banner role="alert" tone="warning">{error ?? REFUSALS['lead-projection-failed']}</Banner>}
          {terminalWait && <Banner actions={canStop ? stopAction : undefined}>{WAITS[state.waitReason!].replace('{label}', label)}</Banner>}
          {state.waitReason === 'lead-renewal-blocked' && <Banner>{WAITS[state.waitReason]}</Banner>}
          {!unavailable && state.wayOut === 'resume' && state.waitReason !== 'lead-predecessor-unavailable' && state.waitReason !== 'lead-predecessor-unverifiable' && <Banner actions={<Button disabled={resuming} aria-busy={resuming} onClick={async () => { if (resuming) return; setResuming(true); setError(null); try { await store.lead.resume() } catch (error) { refusal(error) } finally { setResuming(false); input.current?.focus() } }}>Resume</Button>}>
            {state.waitReason ? WAITS[state.waitReason] ?? 'The Lead is waiting for you to continue.' : 'The Lead is waiting for you to continue.'}
          </Banner>}
          {state.wayOut === 'decide-plan' && (renewal
            ? <Banner>{`The earlier approval expired at ${formatLeadConsentTime(state.planConsentExpiresAt!)}.`}</Banner>
            : !cards.some(card => card.type === 'plan') && <Banner>The plan needs your decision before work continues.</Banner>)}
          <LeadCards {...cardProps} cards={cards} personActions={state.personActions} placement="dock" />
        </ComposerNoticeStack>} form={{ 'aria-label': 'Lead composer', onSubmit: event => { event.preventDefault(); if (!requestPending && goal.trim() && !state.error && state.revision >= 0) void send() } }}>
              <ComposerText disabled={unavailable} rows={1} ref={input} aria-label="Goal or message" placeholder={`Message ${label}…`} value={goal} onChange={event => setGoal(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!state.error && state.revision >= 0) void send() } }} />
              <ComposerTools>
                <ComposerTrack name="add">
                  <Popover title="Add" fullWidth drop="up" align="left" icons="all" label={<PlusIcon size={14} />}>
                    {close => <Menu close={close}>
                      <MenuItem icon={<AtIcon size={16} />} label="Mention a session or goal" shortcut="@" onSelect={() => { setGoal(goal.length > 0 && !goal.endsWith(' ') ? `${goal} @` : `${goal}@`); input.current?.focus() }} />
                      <MenuItem icon={<RouteIcon size={16} />} label="Steer the running worker" title="Sends your text to the worker mid-turn, without restarting it."
                        disabled={phase !== 'running' ? 'Only while a goal is running.' : !goal.trim() ? 'Type what to tell it first.' : requestPending}
                        onSelect={() => { close(); void steer() }} />
                      <MenuItem icon={<FolderIcon size={16} />} label={state.thread?.project ? `Project: ${state.thread.project.path.split('/').filter(Boolean).at(-1) ?? state.thread.project.path}` : 'Project'} title={state.thread?.project?.path} disabled="This desk works in one project." onSelect={() => {}} />
                    </Menu>}
                  </Popover>
                </ComposerTrack>
                <LeadLimits disabled={!!state.error || state.revision < 0} />
                <ComposerGap /><ComposerTrack name="send">
                  <ComposerSend type="submit" disabled={unavailable || requestPending || !goal.trim() || !!state.error || state.revision < 0} aria-label={requestPending ? 'Sending…' : goalActive ? 'Send to the running goal' : 'Send'} title={requestPending ? 'Sending…' : 'Send'} aria-busy={requestPending}>{requestPending ? <Spinner aria-hidden /> : <SendIcon />}</ComposerSend>
                </ComposerTrack>
              </ComposerTools>
      </ConversationComposerFrame>
    </ConversationDock>}
    {controls.dialog}
    {active && confirmStop && <ConfirmDialog title="Stop this goal?" confirmLabel="Stop goal" cancelLabel="Keep working" busy={stopping} onConfirm={() => void stop()} onCancel={() => setConfirmStop(false)}>
      <Text role="prose">Stops this goal and its running work. Files and worktrees are left as they are. You can send a new goal afterward.</Text>
    </ConfirmDialog>}
  </ConversationShell>
}
