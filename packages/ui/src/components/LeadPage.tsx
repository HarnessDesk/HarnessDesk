import { leadActivityLabel } from './lead-permission-labels'
import { PullRequestRecord } from './GitRecord'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LEAD_REQUEST_FAILURE_TEXT, leadWaitNeedsChange, leadWaitUnsent, type LeadMemoryCandidate, type LeadSettingsProposal, type LeadMessageRef, type LeadStopReason, type LeadWindowProjection } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, InlineParts, LeadSlot, LeadWorking, ConversationComposerFrame, ComposerNoticeStack, ComposerText, ComposerTools, ComposerGap, ComposerSend, ComposerTrack, ConversationShell, ConversationThread, ConversationDock, ConversationEmptyState, scrollThreadToEnd, threadFollowsEnd, LeadAvatar, LeadGreeting, Menu, MenuItem, Page, Popover, Spinner, Text, TurnWorkLive, useComposerHeightVar } from '../design'
import { openExternal } from '../lib/desktop'
import { leadWakeLine } from '../lib/lead-presence'
import { LeadNameIntro } from './LeadNameIntro'
import { LeadWakeLedger } from './LeadWakeLedger'
import { LeadOpening } from './LeadOpening'
import { leadOpeningJobs } from '../lib/lead-opening'
import { LeadAway, LeadRecap, useLeadAsks } from './LeadAway'
import { useDestinationPage, useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import { draftsOf, LEAD_DRAFT_KEY } from '../state/drafts'
import { LeadHostNotice, LeadMessage } from './LeadMessage'
import { LeadCards } from './LeadCards'
import { leadRepeatTaskFor } from '../lib/lead-repeat'
import { leadOriginText } from '../lib/lead-time'
import { LEAD_HANDBACK_LIMIT, LEAD_REPAIR_RECOVERY_FAILED } from './lead-wait-copy'
import { REFUSALS, leadRefusalText } from './lead-refusals'
import { useConversationTopBar } from './use-conversation-top-bar'
import { usePageRailHost, useWorkDetails } from '../panels/top-bar'
import { PageRailToggle } from '../panels/WorkTools'
import { LeadDetails } from './LeadDetails'
import { useShell } from '../panels/views'
import { AtIcon, FolderIcon, FolderOpenIcon, PlusIcon, RouteIcon, SendIcon, SettingsIcon, StopIcon } from './Icons'
import { LeadStatusPanel, useLeadControls } from './LeadControls'
import { pageRailOpen, sidebarPlacement } from '../state/workbench'
import { focusWhenDrawn } from '../lib/focus-when-drawn'
import { LEAD_WORK_LANDING, leadVisibleReminders } from './LeadWork'
import { formatLeadConsentTime } from './lead-consent-time'
import { LeadMemoryProposals, leadMemoryPlacement } from './LeadMemory'
import { LeadSettingsProposals } from './LeadSettingsProposals'
import { LeadRefs } from './LeadRefs'

const WAITS: Record<NonNullable<LeadWindowProjection['waitReason']>, string> = {
  ...LEAD_REQUEST_FAILURE_TEXT,
  'lead-predecessor-unavailable': "The previous step's result wasn't accepted, so the next step can't start. Message {label} to change the plan, or stop this goal.",
  'lead-predecessor-unverifiable': "HarnessDesk can't confirm what the previous step produced, so the next step won't start. Message {label} to change the plan, or stop this goal.",
  'lead-renewal-blocked': 'The plan could not be renewed because the pending request limit was reached.',
  'lead-disabled': '{label} was disabled.',
  'lead-key-changed': 'The provider key changed. Continue with the current key.',
  'lead-host-shutdown': 'The desk stopped while {label} was working.',
  'lead-ownership-withdrawn': '{label} no longer owns its previous run.',
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
  'lead-plan-refused': 'The proposed plan could not be offered. Send a message to change it or use an ordinary chat.',
  'lead-plan-unseatable': "An agent in the reviewed plan can't work within its required permissions. Choose another agent on the desk, or ask for an ordinary chat for this task.",
  'lead-plan-not-independent': "The reviewed plan needs a reviewer from a different provider. Add one on the desk, or ask for an ordinary chat for this task.",
  'lead-activity-failed': '{label} could not read the latest run activity.',
  'lead-subscription-failed': '{label} lost its run activity updates.',
  'lead-chat-effect-uncertain': 'The chat operation may have started. Inspect that chat on the desk, then start a new request when ready.',
  'lead-tools-refused': 'The requested desk operation was refused.',
  'lead-card-too-large': 'The request is too large to display safely.',
  'lead-worker-audit-failed': 'A worker approval may have run. Inspect its changes and revoke the uncertain saved rule before resuming. Restart first if saving failed.',
  'lead-budget-unknown': "HarnessDesk can't confirm what the workers have spent, so {label} won't make another request. Sending a message tries again.",
  'lead-run-not-started': 'The plan is approved, but no work has started. Sending a message also continues.',
  'lead-send-deadline': 'The request timed out. Sending a message also continues.',
  'lead-child-exited': '{label} stopped unexpectedly. Sending a message also continues.',
  'lead-child-exited-again': '{label} stopped again at the same step, so resuming would only repeat it. The desk log names the step. Sending a message tries again.',
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
  deadline: 'This goal was stopped at its deadline.',
}
const runsWords = (runs: number) => runs ? `${runs} ${runs === 1 ? 'run' : 'runs'}` : 'no runs yet'
/** An option's words as a typed answer matches them: case, spacing and end punctuation aside. */
const optionWords = (text: string) => text.normalize('NFKC').trim().replace(/[\s.!?。！？]+$/u, '').replace(/\s+/g, ' ').toLowerCase()
/** One empty list for every render, so a memo keyed on it holds (asks, a reply's refs). */
const NONE: readonly never[] = []
/** Elapsed time beside Stop: minutes under an hour, then hours and minutes. */
export const leadElapsed = (ms: number) => { const minutes = Math.max(0, Math.floor(ms / 60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` }

/**
 * What sits under one reply: the chats, Teams and work it names, then any memory or settings proposals it carries. A
 * reply with no refs is read for the work its words name (`text`), as the phone reads it (#2149).
 */
const leadMessageNote = (refs: readonly LeadMessageRef[] | undefined, proposals: readonly LeadMemoryCandidate[] | undefined, settings?: readonly LeadSettingsProposal[], text?: string) => {
  if (!refs?.length && !text?.trim() && !proposals?.length && !settings?.length) return undefined
  return <>{refs?.length || text?.trim() ? <LeadRefs refs={refs ?? NONE} text={text} /> : null}{proposals?.length ? <LeadMemoryProposals candidates={proposals} /> : null}{settings?.length ? <LeadSettingsProposals proposals={settings} /> : null}</>
}

export const LeadPage = ({ initialGoal = '', focus = null, nonce }: { readonly initialGoal?: string; readonly focus?: string | null; readonly nonce?: number }) => {
  const store = useStore(), snapshot = useSnapshot(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const unavailable = state.settings?.unavailable === 'runtime'
  // The box's words live with the store's drafts, so leaving the page and coming back finds
  // exactly what was left in it — and an emptied box is written as empty, never skipped (#2091).
  const drafts = draftsOf(store)
  const [goal, setGoal] = useState(() => initialGoal || drafts.live(LEAD_DRAFT_KEY)?.text || ''), [error, setError] = useState<string | null>(null)
  useEffect(() => { drafts.setLive(LEAD_DRAFT_KEY, { text: goal, attachments: [] }) }, [drafts, goal])
  // A refusal of words the person sent is about those words: emptying the box takes the warning with them.
  const refusedDraft = useRef(false)
  useEffect(() => { if (refusedDraft.current && !goal.trim()) { refusedDraft.current = false; setError(null) } }, [goal])
  const [confirmStop, setConfirmStop] = useState(false), [stopping, setStopping] = useState(false)
  const stoppingRef = useRef(false)
  const [choosingName, setChoosingName] = useState(false)
  const sendBaseline = useRef<string | null>(null)
  const [sending, setSending] = useState(false), [resuming, setResuming] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null), inFlight = useRef(false), thread = useRef<HTMLDivElement>(null)
  const decisionLock = useRef(false), [decisionPending, setDecisionPending] = useState<string | null>(null)
  const [selectedDecision, setSelectedDecision] = useState<string | null>(focus)
  const requestedDecisionFocus = useRef<string | null>(null)
  const focusDock = (id: string) => {
    const element = [...(shell.current?.querySelectorAll<HTMLElement>('[data-lead-decision]') ?? [])].find(node => node.dataset.leadDecision === id)?.querySelector<HTMLElement>('[data-slot="approval-card"]')
    if (element) { element.focus({ preventScroll: true }); requestedDecisionFocus.current = null }
  }
  // A missing folder is the store's state and the greeting's step, never a warning banner as well.
  const refusal = (error: unknown, typed = false) => { refusedDraft.current = false; if (!store.lead.state.projectMissing || leadRefusalText(error) !== REFUSALS['lead-project-missing']) setError(leadRefusalText(error, typed)) }
  const { owner } = useDestinationPage(), controls = useLeadControls(), { name, face, label, presence } = controls
  const shellActions = useShell()
  const shell = useRef<HTMLDivElement>(null), dock = useComposerHeightVar(shell)
  const terminalWait = state.waitReason === 'lead-predecessor-unavailable' || state.waitReason === 'lead-predecessor-unverifiable'
  const auditWait = state.waitReason === 'lead-worker-audit-failed' && !state.savedApprovals?.some(rule => rule.uncertain)
    ? 'A worker approval may have run. Resume after reviewing the changes. Restart first if saving failed.' : WAITS[state.waitReason!]?.replace(/\{label\}/g, label)
  const setupWait = leadWaitNeedsChange(state.waitReason) || state.waitReason === 'lead-worker-audit-failed' && state.wayOut !== 'resume'
  const canStop = !!state.thread && !['stopped', 'accepted', 'declined'].includes(state.thread.state) &&
    (!!state.thread.contract || !!state.thread.pr || state.requestInFlight || terminalWait)
  const goalActive = canStop && (!!state.thread?.contract || !!state.thread?.pr) && !terminalWait
  const stopAction = <Button variant="ghost" disabled={stopping || decisionPending !== null} onClick={() => setConfirmStop(true)}>Stop goal</Button>
  const stop = async () => {
    if (stoppingRef.current || decisionLock.current) return
    stoppingRef.current = true; decisionLock.current = true; setStopping(true); setError(null)
    try { await store.lead.stop(); setConfirmStop(false) }
    catch (error) { refusal(error) }
    finally { stoppingRef.current = false; decisionLock.current = false; setStopping(false); input.current?.focus() }
  }
  const railHosted = usePageRailHost()
  useConversationTopBar(owner, { mark: <LeadAvatar name={face} size="header" />, place: label, placeTitle: `${label} · ${presence.word}`, placeMenu: close => <LeadStatusPanel close={close} controls={controls} />,
    ...presence.quiet ? {} : { state: <Text role="muted" data-slot="lead-presence">{presence.word}</Text> }, tools: <>{(state.thread?.messages.length ?? 0) > 0 && <LeadRecap />}{railHosted && <PageRailToggle page="lead" />}<Button variant="ghost" size="icon" title="Lead settings" aria-label="Lead settings" onClick={controls.openSettings}><SettingsIcon /></Button></>, terminal: false, more: () => null, corner: sidebarPlacement(snapshot) !== 'column' }, active)
  useWorkDetails(owner, <LeadDetails />, active)
  // The run strip's clock: a minute is its smallest step, so it ticks twice a minute while a goal runs.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (!goalActive) return; const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [goalActive])
  useEffect(() => { if (active) void store.lead.readThread().catch(refusal) }, [active, store])
  // A desk without memory leaves the thread as it was; the notification keeps it current after this.
  useEffect(() => { if (active) void store.lead.readMemoryView().catch(() => {}) }, [active, store])
  useEffect(() => { if (active) void store.lead.readAutonomy().catch(() => {}) }, [active, store])
  // The host starts the Lead in the first folder opened, so a folder arriving is the cue to read again.
  const folders = snapshot.workspaces.length
  useEffect(() => { if (active && state.projectMissing && folders) void store.lead.readThread().catch(refusal) }, [active, store, state.projectMissing, folders])
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
  const send = async (text = goal, ask?: string) => {
    if (unavailable || inFlight.current || state.requestInFlight || !text.trim()) return
    inFlight.current = true; sendBaseline.current = [...store.lead.state.thread?.messages ?? []].reverse().find(message => message.role === 'user')?.id ?? null; setSending(true); setError(null)
    // The person's own message is followed to the bottom, like a session thread, wherever they had scrolled.
    if (thread.current) scrollThreadToEnd(thread.current)
    try { await store.lead.send(text.trim(), crypto.randomUUID(), ask); setGoal(current => current === text ? '' : current) }
    catch (error) { refusal(error, !ask); refusedDraft.current = !ask && text === goal }
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
  const sendDisabled = unavailable || requestPending || !!state.error || state.revision < 0
  const messages = state.thread?.messages ?? []
  // The Lead's proposals to keep, each under the reply it came with; Keep, Edit or No go to the same store Settings shows.
  const proposals = leadMemoryPlacement(messages, state.memory?.inbox ?? [])
  // The Lead's proposals to change a mode or a rule section, placed the same way; Apply or No answers them here or on a phone.
  const settingsProposals = leadMemoryPlacement(messages, (state.autonomy?.proposals ?? []).filter(proposal => proposal.state === 'pending'))
  const latestAsk = [...messages].reverse().find(message => message.role === 'assistant' && (message.ask || message.proactive?.options))
  const asks = new Map(useLeadAsks(state.away?.asks ?? NONE).map(ask => [ask.id, ask] as const))
  // A question is answered here when the person's next message is one of its options; other words leave it to the desk,
  // whose ask states say whether it is still open (#2173): the person writing about something else does not close it.
  const answers = new Map(messages.flatMap((message, index) => {
    const options = message.ask?.options ?? message.proactive?.options
    const next = options && messages.slice(index + 1).find(one => one.role === 'user')
    const option = next && options.find(one => optionWords(one.label) === optionWords(next.text))
    return option ? [[message.id, option.label] as const] : []
  }))
  // Live while it is the latest question, not answered, and open by the desk's record; before the desk has said, a
  // message of the person's after it settles it, as it always did.
  const askLive = (message: { readonly id: string; readonly revision: number }) => {
    if (message.id !== latestAsk?.id || answers.has(message.id)) return false
    const settled = asks.get(message.id)
    return settled ? settled.status === 'open' : !messages.some(one => one.role === 'user' && one.revision > message.revision)
  }
  // What the Lead is doing this second, as one quiet line at the end of the thread. A window that cannot trust its
  // projection says nothing; a plan on the table or a wait for the person is not work, and a stopped card speaks for itself.
  const phase = state.thread?.state, progress = state.progress, pr = state.thread?.pr, origin = state.thread?.origin, handback = state.thread?.handback
  const repairActive = phase === 'running' && handback?.stage === 'running' && pr?.branchOwner !== 'person'
  const live = state.error ? null
    : repairActive ? <TurnWorkLive data-slot="lead-live-line" data-kind="handback">{`Repairing ${handback.kind === 'checks' ? 'checks' : 'review comments'} · round ${handback.round}`}</TurnWorkLive>
    : phase === 'running' && progress ? <TurnWorkLive data-slot="lead-live-line" data-kind="running">{`Step ${progress.step} of ${progress.steps}${contract?.steps[progress.step - 1] ? ` · ${contract.steps[progress.step - 1]!.title}` : ''} · ${runsWords(progress.runs)}`}</TurnWorkLive>
    : phase === 'stopped' && !cards.some(card => card.type === 'stopped') ? <TurnWorkLive settled data-slot="lead-live-line" data-kind="stopped">{STOPPED[state.thread?.budget?.stop?.reason ?? 'cancelled']}</TurnWorkLive>
    : null
  const lastUser = [...messages].reverse().find(message => message.role === 'user')
  const firstReply = lastUser ? messages.find(message => message.role === 'assistant' && message.revision > lastUser.revision) : undefined
  const replyKey = `reply:${lastUser?.id ?? 'pending'}`
  const replyArrived = !!firstReply && (!sending || lastUser?.id !== sendBaseline.current)
  const working = !state.error && requestPending && state.wayOut !== 'decide-plan' &&
    !replyArrived && <LeadMessage key={firstReply ? 'pending' : replyKey} role="assistant" name={label} lead={name} face
      text="" working={<LeadWorking label={state.activity?.step ?? leadActivityLabel(state.activity?.method)} since={state.activity?.since} stopping={stopping} onStop={() => { if (goalActive) setConfirmStop(true); else void stop() }} />} />
  // A goal a trigger opened says where it came from on its own line in the thread (#2183); the origin line would repeat it.
  const originShown = !!origin && (state.thread?.messages ?? []).some(message => message.trigger?.source === origin.source && message.trigger.event === origin.event && message.trigger.subject === origin.subject)
  const openingJobs = !state.error && state.thread && !state.thread.messages.length && !state.thread.olderMessages && !state.thread.cards.length ? leadOpeningJobs(snapshot, state.thread.project?.path ?? null, pr) : []
  const entries = [...(state.thread?.messages ?? []).map(message => ({ revision: message.revision, kind: 'message' as const, message })),
    ...cards.map(card => ({ revision: state.thread?.cardPositions?.[card.id] ?? card.revision, kind: 'card' as const, card })),
    ...(state.thread?.decisions ?? []).map(decision => ({ revision: decision.position, kind: 'decided' as const, decision })),
    // A steer sits just after what the thread held when it was sent; one without a revision stays at the end.
    ...(state.steers ?? []).map((steer, index) => ({ revision: steer.after === undefined ? Infinity : steer.after + 0.5, kind: 'steer' as const, steer, index }))].sort((a, b) => a.revision - b.revision)
  // A Lead turn shows its face once, on its first line; the person's message, or a desk wake, starts the next turn.
  const faces = new Set<string>()
  for (let at = 0, open = false; at < entries.length; at++) {
    const entry = entries[at]!
    if (entry.kind !== 'message') continue
    if (entry.message.role === 'user' || entry.message.role === 'system') open = false
    else if (!open) { faces.add(entry.message.id); open = true }
  }
  const actionablePlan = entries.filter(entry => entry.kind === 'card' && entry.card.type === 'plan').at(-1)
  const scrollToPlan = () => {
    if (actionablePlan?.kind !== 'card') return
    const element = [...(thread.current?.querySelectorAll<HTMLElement>('[data-lead-card]') ?? [])].find(node => node.dataset.leadCard === actionablePlan.card.id)
    element?.scrollIntoView?.({ block: 'end' })
  }
  // The thread follows its own end as it grows; a new revision is followed here too, for a change no resize reports.
  useEffect(() => { if (thread.current && threadFollowsEnd(thread.current)) scrollThreadToEnd(thread.current) }, [active, state.revision])
  useEffect(() => { if (state.wayOut === 'decide-plan') scrollToPlan() }, [state.wayOut, actionablePlan?.kind === 'card' ? `${actionablePlan.card.id}:${actionablePlan.card.revision}` : null])
  const focusedDecision = useRef<string | null>(null)
  useEffect(() => {
    if (!active) { focusedDecision.current = null; return }
    const door = `${focus}:${nonce ?? ''}`
    if (!focus || focusedDecision.current === door) return
    const element = [...(thread.current?.querySelectorAll<HTMLElement>('[data-lead-card]') ?? [])].find(node => node.dataset.leadCard === focus)
    if (!element) return
    focusedDecision.current = door
    requestedDecisionFocus.current = focus; setSelectedDecision(focus)
    element.scrollIntoView?.({ block: 'end' }); focusDock(focus)
  }, [active, focus, nonce, state.revision])
  // A reminder's door is the Work list: the rail comes back if it was put away, and the reminder's row comes into view.
  const focusedReminder = useRef<string | null>(null)
  useEffect(() => {
    if (!active) { focusedReminder.current = null; return }
    const door = `${focus}:${nonce ?? ''}`
    if (!focus || !/^remind-\d+$/.test(focus) || focusedReminder.current === door) return
    // Once per click: the rail opens, and the row is focused when the rail's contents arrive.
    focusedReminder.current = door
    if (!pageRailOpen(store.getSnapshot().workbench, 'lead')) store.togglePageRail('lead')
    // A reminder cancelled or cleared since the door was drawn: the person lands on the Work card instead.
    const gone = () => { const work = store.lead.state.work; return !!work && !leadVisibleReminders(work).some(entry => entry.id === focus) }
    return focusWhenDrawn(`[data-work-reminder="${focus}"]`, () => {}, { fallback: [LEAD_WORK_LANDING], gone })
  }, [active, focus, nonce, store])
  useEffect(() => {
    if (!active || !requestedDecisionFocus.current) return
    if (!cards.some(card => card.id === requestedDecisionFocus.current)) { requestedDecisionFocus.current = null; return }
    focusDock(requestedDecisionFocus.current)
  }, [active, selectedDecision, state.revision])
  const cardProps = {
    releasedBranch: pr,
    knownContracts: [...cards, ...(state.thread?.decisions ?? []).map(decision => decision.card)].flatMap(card => card.type === 'plan' ? [card.contract] : []),
    onRuns: (scope: NonNullable<typeof contract>) => {
      const open = (id?: string) => store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: id ? `repeat:${id}` : 'lead-runs' } })
      void store.lead.readSchedule().then(schedule => {
        const task = leadRepeatTaskFor(schedule, scope, contract?.digest, origin)
        open(task?.id)
      }).catch(() => open())
    },
    onRaiseLimit: (logicalGoalId: string, caps: Parameters<typeof store.lead.raiseLimit>[1]) => store.lead.raiseLimit(logicalGoalId, caps),
    onPerform: (input: Parameters<typeof store.lead.perform>[0]) => store.lead.perform(input),
    focusCard: selectedDecision, decisionLock, decisionPending, setDecisionPending, expiry: state.planConsentExpiresAt, contract, budget: state.thread?.budget, goalClosed: phase === 'accepted' || phase === 'declined',
    onDecide: (decision: Parameters<typeof store.lead.decide>[0]) => { setError(null); return store.lead.decide(decision) }, onError: refusal, onSettled: () => input.current?.focus(),
    onChanges: () => store.openDestination({ kind: 'changes-review', root: state.thread?.project?.path ?? null, returnTo: { kind: 'conversation', session: null } }),
    onApprovals: (runId: string) => { void (async () => { try { const run = snapshot.flowExecutions.get(runId) ?? await store.readFlowExecution(runId); store.openGoal(run.goal) } catch (error) { refusal(error) } })() },
  }
  return <ConversationShell ref={shell}>
    <ConversationThread ref={thread} keepEnd role="region" aria-label={`${label} thread`}>
      {entries.length || working || live || pr || openingJobs.length || name && state.settings?.nameChosen !== true || state.wakes?.length || origin || state.thread?.olderMessages || state.savedApprovals?.length || state.revokedApprovals?.length || state.waitReason === 'lead-handback-limit' || state.waitReason === 'lead-repair-recovery-failed' ? <Page width="reading" gutter="none">
        {name && <LeadNameIntro name={name} chosen={state.settings?.nameChosen === true} pending={choosingName || !!state.error || state.revision < 0} onChoose={async name => {
          if (choosingName) return
          setChoosingName(true)
          try { await store.lead.updateSettings({ name }) } catch (error) { refusal(error) } finally { setChoosingName(false) }
        }} />}
        <LeadOpening jobs={openingJobs} pending={unavailable || requestPending || state.revision < 0} onStart={text => void send(text)} />
        {state.thread?.olderMessages ? <Text as="p" role="muted">{state.thread.olderMessages} older messages remain in the journal.</Text> : null}
        {origin && !originShown && <Text as="p" role="meta" data-slot="lead-origin">{origin.url && /^https?:\/\//i.test(origin.url) ? <Button variant="link" size="inline-link" onClick={() => openExternal(origin.url!)}>{leadOriginText(origin)}</Button> : leadOriginText(origin)}</Text>}
        {entries.map(entry => entry.kind === 'message'
          ? entry.message.role === 'notice' || entry.message.role === 'system' ? <LeadHostNotice key={`message:${entry.message.id}`} message={entry.message} /> : <LeadMessage key={entry.message.id === firstReply?.id ? replyKey : `message:${entry.message.id}`} role={entry.message.role === 'user' ? 'user' : 'assistant'} name={label} lead={name} text={entry.message.text}
            ask={entry.message.ask} settled={asks.get(entry.message.id)} proactive={entry.message.proactive} disabled={sendDisabled} picked={answers.get(entry.message.id)}
            onAnswer={askLive(entry.message) ? label => { if (!sendDisabled) void send(label, entry.message.id) } : undefined} onAction={entry.message.proactive?.action === 'plan' && !actionablePlan || entry.message.proactive?.action === 'approvals' && !state.personActions.length ? undefined : action => { if (action === 'plan') scrollToPlan(); else if (action === 'changes') cardProps.onChanges(); else { const runId = state.personActions[0]?.runId; if (runId) cardProps.onApprovals(runId) } }} face={faces.has(entry.message.id)}
            note={leadMessageNote(entry.message.refs, proposals.get(entry.message.id), settingsProposals.get(entry.message.id), entry.message.role === 'user' ? undefined : entry.message.text)} />
          : entry.kind === 'steer' ? <LeadMessage key={`steer:${entry.steer.id}`} role="user" text={entry.steer.text}
            note={<Chip variant="quiet" tone={entry.steer.state === 'acknowledged' ? 'neutral' : 'warning'} data-slot="lead-steer">{`Steer ${entry.index + 1} · ${entry.steer.state === 'acknowledged' ? 'Acknowledged' : 'Not taken'}`}</Chip>} />
          : entry.kind === 'decided' ? <LeadCards key={`decided:${entry.decision.card.id}:${entry.decision.card.revision}`} {...cardProps} cards={[]} decisions={[entry.decision]} placement="thread" />
          : <LeadCards key={`card:${entry.card.id}`} {...cardProps} cards={[entry.card]} placement="thread" />).concat(working ? [working] : [])}

        {(state.savedApprovals ?? []).filter(rule => rule.count > 0).map(rule => <LeadHostNotice key={`approval:${rule.id}`} message={{ version: 1, id: `approval:${rule.id}`, revision: state.revision, role: 'notice', text: `Allowed under your rule for this goal: ${rule.target} · ${rule.count} ${rule.count === 1 ? 'time' : 'times'}` }} />)}
        <LeadCards {...cardProps} cards={[]} savedApprovals={state.savedApprovals} revokedApprovals={state.revokedApprovals} onRevoke={input => store.lead.revokeApproval(input)} placement="thread" />
        {pr && <div data-slot="lead-pr-status"><InlineParts>
          <Button variant="link" size="inline-link" title={pr.observedHead ?? pr.head} onClick={() => openExternal(`https://github.com/${pr.repository}/pull/${pr.number}`)}>{`#${pr.number}`}</Button>
          <Text role="meta">{pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : `Checks ${pr.check?.state ?? 'not confirmed'} · Review ${pr.review?.state?.replace(/-/g, ' ') ?? 'not confirmed'}`}</Text>
          <Chip variant="quiet" tone="neutral">{pr.branchOwner === 'person' ? 'Your branch' : 'Automatic repairs'}</Chip>
        </InlineParts></div>}
        {(state.waitReason === 'lead-handback-limit' || state.waitReason === 'lead-repair-recovery-failed') && <LeadCards {...cardProps} cards={[]} waitReason={state.waitReason} placement="thread" />}
        {pr && state.thread?.project && <PullRequestRecord root={state.thread.project.path} reference={{ repo: pr.repository, number: pr.number }} branch={pr.branch} />}
        {/* The record of why the Lead woke: at the end, where its latest row happened, never above the conversation (#2149). */}
        <LeadWakeLedger wakes={state.wakes ?? []} />
        {working ? null : live}
      </Page> : <ConversationEmptyState><LeadGreeting avatar={<LeadAvatar name={face} size="picker" mood={presence.mood} />} title={face ? `Hi, I'm ${label}` : 'Hi there'}
        action={state.projectMissing ? <Button variant="outline" onClick={() => shellActions.chooseProject()}><FolderOpenIcon size={16} />Open folder…</Button> : undefined}>
        {state.projectMissing ? 'I work inside one project folder. Open one, then tell me what you want done.' : unavailable ? "I can't start on this desk yet. The note below says why." : "Tell me what you want done. I'll plan it, put agents on it and bring back the result."}
      </LeadGreeting></ConversationEmptyState>}
    </ConversationThread>
    {active && <ConversationDock ref={dock}>
      <ConversationComposerFrame before={<ComposerNoticeStack>
          {unavailable && <Banner>{REFUSALS['lead-runtime-unsupported']}{state.settings?.unavailableReason ? <Text as="span" role="muted">{` ${state.settings.unavailableReason.charAt(0).toUpperCase()}${state.settings.unavailableReason.slice(1)}.`}</Text> : null}</Banner>}
          <LeadAway active={active} state={state} label={label} />
          {goalActive && <LeadSlot slot="lead-run-strip"><Banner mark={<LeadAvatar name={name} size="turn" />} actions={stopAction}>{phase === 'following' ? `Following #${pr?.number ?? ''}` : repairActive ? `Repairing ${handback.kind === 'checks' ? 'checks' : 'review comments'} · round ${handback.round}` : phase === 'running' ? `${label} is running 1 goal` : phase === 'awaiting-plan' ? 'A plan is waiting for you' : phase === 'waiting-for-user' ? leadWaitUnsent(state.waitReason) ? `${label}'s last request was not sent` : `${label} is waiting for you` : `${label} is planning`}{state.progress?.since !== undefined ? ` · ${leadElapsed(now - state.progress.since)}` : ''}{phase === 'running' && leadWakeLine(state.presence) ? <Text as="span" role="muted">{` · ${leadWakeLine(state.presence)}`}</Text> : null}</Banner></LeadSlot>}
          {(error || state.error) && <Banner role="alert" tone="warning">{error ?? REFUSALS['lead-projection-failed']}</Banner>}
          {terminalWait && <Banner actions={canStop ? stopAction : undefined}>{WAITS[state.waitReason!].replaceAll('{label}', label)}</Banner>}
          {state.waitReason === 'lead-renewal-blocked' && <Banner>{WAITS[state.waitReason].replaceAll('{label}', label)}</Banner>}
          {setupWait && (state.wayOut !== 'decide-plan' || state.waitReason === 'lead-chat-effect-uncertain') && <Banner actions={state.waitReason === 'lead-chat-effect-uncertain' ? <Button disabled={stopping || decisionPending !== null} aria-busy={stopping} onClick={() => void stop()}>Start new request</Button> : undefined}>{auditWait}</Banner>}
          {!unavailable && !setupWait && state.wayOut === 'resume' && state.waitReason !== 'lead-predecessor-unavailable' && state.waitReason !== 'lead-predecessor-unverifiable' && <Banner actions={<Button disabled={resuming} aria-busy={resuming} onClick={async () => { if (resuming) return; setResuming(true); setError(null); try { await store.lead.resume() } catch (error) { refusal(error) } finally { setResuming(false); input.current?.focus() } }}>Resume</Button>}>
            {state.waitReason ? auditWait ?? `${label} is waiting for you to continue.` : `${label} is waiting for you to continue.`}
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
                <ComposerGap /><ComposerTrack name="send">
                  {state.requestInFlight && !goalActive
                    ? <ComposerSend type="button" disabled={stopping} aria-label="Stop reply" title="Stop this reply" onClick={() => void stop()}><StopIcon size={12} /></ComposerSend>
                    : <ComposerSend type="submit" disabled={sendDisabled || !goal.trim()} aria-label={requestPending ? 'Sending…' : goalActive ? 'Send to the running goal' : 'Send'} title={requestPending ? 'Sending…' : state.projectMissing ? 'Open a folder first' : 'Send'} aria-busy={requestPending}>{requestPending ? <Spinner aria-hidden /> : <SendIcon />}</ComposerSend>}
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
