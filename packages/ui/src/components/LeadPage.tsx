import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type LeadWindowProjection } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, ConversationComposerFrame, ComposerNoticeStack, ComposerText, ComposerTools, ComposerGap, ComposerSend, ComposerTrack, ConversationShell, ConversationThread, ConversationDock, ConversationEmptyState, LeadAvatar, Page, Spinner, Text, TurnWorkLive, useComposerHeightVar } from '../design'
import { useDestinationPage, useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import { LeadMessage } from './LeadMessage'
import { LeadCards, leadDollars } from './LeadCards'
import { LeadCheck } from './LeadCheck'
import { REFUSALS, leadRefusalText } from './lead-refusals'
import { useConversationTopBar } from './use-conversation-top-bar'
import { SettingsIcon, SendIcon, StopIcon } from './Icons'
import { useLeadName } from './use-lead-name'
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
  'lead-result-awaiting-person': 'The result is waiting for your decision.',
  'lead-result-revisions-exhausted': 'The result reached its revision limit.',
  'lead-start-binding-failed': 'The run could not be linked to the approved plan.',
  'lead-plan-refused': 'The proposed plan could not be offered.',
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
const runsWords = (runs: number) => runs ? `${runs} ${runs === 1 ? 'run' : 'runs'}` : 'no runs yet'
export const LeadPage = ({ initialGoal = '', focus = null }: { readonly initialGoal?: string; readonly focus?: string | null }) => {
  const store = useStore(), snapshot = useSnapshot(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [goal, setGoal] = useState(initialGoal), [error, setError] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false), [stopping, setStopping] = useState(false)
  const stoppingRef = useRef(false)
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
  const { owner } = useDestinationPage(), name = useLeadName(), label = name === 'lex' ? 'Lex' : name === 'dex' ? 'Dex' : 'Lead'
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
  useConversationTopBar(owner, { place: label, tools: <Button variant="ghost" size="icon" title="Lead settings" aria-label="Lead settings" onClick={() => store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } })}><SettingsIcon /></Button>, terminal: false, more: () => null, corner: sidebarPlacement(snapshot) !== 'column' }, active)
  useEffect(() => { if (active) void store.lead.readThread().catch(refusal) }, [active, store])
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
  const send = async () => {
    if (inFlight.current || state.requestInFlight || !goal.trim()) return
    inFlight.current = true; setSending(true); setError(null)
    try { await store.lead.send(goal.trim(), crypto.randomUUID()); setGoal('') }
    catch (error) { refusal(error) }
    finally { inFlight.current = false; setSending(false); input.current?.focus() }
  }
  const cards = state.thread?.cards ?? []
  const contract = state.thread?.contract ?? cards.find(card => card.type === 'plan')?.contract
  const renewal = state.planConsentExpiresAt !== null && cards.some(card => card.type === 'plan' && card.contractDigest === state.thread?.contract?.digest && JSON.stringify(card.contract) === JSON.stringify(state.thread?.contract))
  const requestPending = sending || state.requestInFlight
  // What the Lead is doing this second, as one quiet line at the end of the thread. A window that cannot trust its
  // projection says nothing; a plan on the table or a wait for the person is not work, and a stopped card speaks for itself.
  const phase = state.thread?.state, progress = state.progress
  const live = state.error ? null
    : phase === 'running' && progress ? <TurnWorkLive data-slot="lead-live-line" data-kind="running">{`Step ${progress.step} of ${progress.steps}${contract?.steps[progress.step - 1] ? ` · ${contract.steps[progress.step - 1]!.title}` : ''} · ${runsWords(progress.runs)}`}</TurnWorkLive>
    : (phase === 'draft' || phase === 'planning') && state.requestInFlight ? <TurnWorkLive data-slot="lead-live-line" data-kind="planning">Planning…</TurnWorkLive>
    : phase === 'stopped' && !cards.some(card => card.type === 'stopped') ? <TurnWorkLive settled data-slot="lead-live-line" data-kind="stopped">This goal was stopped.</TurnWorkLive>
    : null
  const entries = [...(state.thread?.messages ?? []).map(message => ({ revision: message.revision, kind: 'message' as const, message })),
    ...cards.map(card => ({ revision: state.thread?.cardPositions?.[card.id] ?? card.revision, kind: 'card' as const, card })),
    ...(state.thread?.decisions ?? []).map(decision => ({ revision: decision.position, kind: 'decided' as const, decision }))].sort((a, b) => a.revision - b.revision)
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
    focusCard: selectedDecision, decisionLock, decisionPending, setDecisionPending, expiry: state.planConsentExpiresAt, contract, budget: state.thread?.budget,
    onDecide: (decision: Parameters<typeof store.lead.decide>[0]) => { setError(null); return store.lead.decide(decision) }, onError: refusal, onSettled: () => input.current?.focus(),
    onChanges: () => store.openDestination({ kind: 'changes-review', root: state.thread?.project?.path ?? null, returnTo: { kind: 'conversation', session: null } }),
    onApprovals: (runId: string) => { void (async () => { try { const run = snapshot.flowExecutions.get(runId) ?? await store.readFlowExecution(runId); store.openGoal(run.goal) } catch (error) { refusal(error) } })() },
  }
  return <ConversationShell ref={shell}>
    <ConversationThread ref={thread} role="region" aria-label={`${label} thread`} onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24 }}>
      {entries.length || live ? <Page width="reading" gutter="none">
        {state.thread?.olderMessages ? <Text as="p" role="muted">{state.thread.olderMessages} older messages remain in the journal.</Text> : null}
        {entries.map(entry => entry.kind === 'message'
          ? <LeadMessage key={`message:${entry.message.id}`} role={entry.message.role === 'user' ? 'user' : 'assistant'} name={label} text={entry.message.text} />
          : entry.kind === 'decided' ? <LeadCards key={`decided:${entry.decision.card.id}:${entry.decision.card.revision}`} {...cardProps} cards={[]} decisions={[entry.decision]} placement="thread" />
          : <LeadCards key={`card:${entry.card.id}`} {...cardProps} cards={[entry.card]} placement="thread" />)}
        {live}
      </Page> : <ConversationEmptyState><LeadAvatar name={name} size="lg" /><Text as="p" role="prose" align="center">{name ? `Hi, I'm ${label}. Tell me what you want done, and I'll plan it for your approval.` : 'Hi, tell me what you want done.'}</Text></ConversationEmptyState>}
    </ConversationThread>
    {active && <ConversationDock ref={dock}>
      <ConversationComposerFrame before={<ComposerNoticeStack>
          {(error || state.error) && <Banner role="alert" tone="warning">{error ?? REFUSALS['lead-projection-failed']}</Banner>}
          {terminalWait && <Banner actions={canStop ? stopAction : undefined}>{WAITS[state.waitReason!].replace('{label}', label)}</Banner>}
          {state.waitReason === 'lead-renewal-blocked' && <Banner>{WAITS[state.waitReason]}</Banner>}
          {state.wayOut === 'resume' && state.waitReason !== 'lead-predecessor-unavailable' && state.waitReason !== 'lead-predecessor-unverifiable' && <Banner actions={<Button disabled={resuming} aria-busy={resuming} onClick={async () => { if (resuming) return; setResuming(true); setError(null); try { await store.lead.resume() } catch (error) { refusal(error) } finally { setResuming(false); input.current?.focus() } }}>Resume</Button>}>
            {state.waitReason ? WAITS[state.waitReason] ?? 'The Lead is waiting for you to continue.' : 'The Lead is waiting for you to continue.'}
          </Banner>}
          {state.wayOut === 'decide-plan' && (renewal
            ? <Banner>{`The earlier approval expired at ${formatLeadConsentTime(state.planConsentExpiresAt!)}.`}</Banner>
            : !cards.some(card => card.type === 'plan') && <Banner>The plan needs your decision before work continues.</Banner>)}
          {state.team && state.thread?.state === 'running' && <LeadCheck room={state.team} needed={!!contract?.assertions.some(assertion => assertion.kind === 'check')} revision={state.revision} label={label} onError={refusal} />}
          <LeadCards {...cardProps} cards={cards} placement="dock" />
        </ComposerNoticeStack>} form={{ 'aria-label': 'Lead composer', onSubmit: event => { event.preventDefault(); if (!requestPending && goal.trim() && !state.error && state.revision >= 0) void send() } }}>
              <ComposerText rows={1} ref={input} aria-label="Goal or message" placeholder={`Message ${label}…`} value={goal} onChange={event => setGoal(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!state.error && state.revision >= 0) void send() } }} />
              <ComposerTools>
                {!state.thread?.messages.some(message => message.role === 'user') && state.settings && <><Chip tone="neutral">{leadDollars(state.settings.caps.usdMicros)}</Chip><Chip tone="neutral">{state.settings.caps.rounds} rounds</Chip></>}
                <ComposerGap /><ComposerTrack name="send" contentSized={goalActive && !!goal.trim()}>
                  {(!goalActive || goal.trim()) && <ComposerSend type="submit" disabled={requestPending || !goal.trim() || !!state.error || state.revision < 0} aria-label={requestPending ? 'Sending…' : 'Send'} title={requestPending ? 'Sending…' : 'Send'} aria-busy={requestPending}>{requestPending ? <Spinner aria-hidden /> : <SendIcon />}</ComposerSend>}
                  {goalActive && <ComposerSend type="button" aria-label="Stop" title="Stop goal" disabled={stopping || decisionPending !== null} onClick={() => setConfirmStop(true)}><StopIcon size={12} /></ComposerSend>}
                </ComposerTrack>
              </ComposerTools>
      </ConversationComposerFrame>
    </ConversationDock>}
    {active && confirmStop && <ConfirmDialog title="Stop this goal?" confirmLabel="Stop goal" cancelLabel="Keep working" busy={stopping} onConfirm={() => void stop()} onCancel={() => setConfirmStop(false)}>
      <Text role="prose">Stops this goal and its running work. Files and worktrees are left as they are. You can send a new goal afterward.</Text>
    </ConfirmDialog>}
  </ConversationShell>
}
