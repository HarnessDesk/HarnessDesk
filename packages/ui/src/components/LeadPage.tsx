import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type LeadControlRefusal, type LeadWindowProjection } from '@harnessdesk/protocol'
import { Banner, Button, LeadJournal, Text } from '../design'
import { DestinationBar, useDestinationActive } from '../panels/destination-page'
import { useSnapshot, useStore } from '../state/context'
import { LeadCards, leadDollars } from './LeadCards'
import { LeadSettings } from './LeadSettings'
import { Markdown } from './Markdown'

/** Closed refusal vocabulary; transport messages and typed codes never render. */
const REFUSALS: Record<LeadControlRefusal, string> = {
  'lead-unavailable': 'The Lead is unavailable.', 'lead-operation-refused': 'The Lead could not complete that action.',
  'lead-secret-refused': 'That content cannot be shared in the Lead thread.', 'lead-revision-stale': 'The Lead changed. Review the latest version and try again.',
  'lead-no-person-wait': 'There is no request to resume.', 'lead-plan-pending': 'Review the plan before continuing.',
  'lead-card-stale': 'This card changed. Review its latest revision.', 'lead-card-decided': 'This card already has a decision.',
  'lead-worker-approval': 'Open the worker approval to answer it.', 'lead-gate-changed': 'The result changed. Inspect the latest evidence.',
  'lead-gate-save-failed': 'The decision could not be saved. Try again.', 'lead-settings-combination': 'Save the key separately from other settings.',
  'lead-evidence-read-refused': 'The evidence could not be read. Try again.', 'lead-change-pending': 'Decide the pending settings card first.',
  'lead-card-too-large': 'This card is too large to display safely.', 'lead-projection-failed': 'The Lead could not be read. Try again.',
  'lead-key-missing': 'Add a provider key in Settings to continue.', 'lead-secret-in-thread': 'This key already appears in the thread. Use a different key.',
  'lead-thread-closed': 'This Lead thread has finished.', 'lead-budget-stopped': 'The Lead has reached a stopped allowance.',
  'lead-protection-unavailable': 'Encrypted key storage is unavailable.', 'lead-request-in-flight': 'Wait for the current request to finish.',
}
const WAITS: Record<NonNullable<LeadWindowProjection['waitReason']>, string> = {
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
  'lead-card-too-large': 'The decision card is too large to display safely.',
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
export const LeadPage = ({ initialSettingsOpen = false, initialGoal = '' }: { readonly initialSettingsOpen?: boolean; readonly initialGoal?: string }) => {
  const store = useStore(), snapshot = useSnapshot(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [goal, setGoal] = useState(initialGoal), [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen), [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false), [resuming, setResuming] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null), inFlight = useRef(false), thread = useRef<HTMLDivElement>(null)
  const refusal = (error: unknown) => {
    const value = error as { code?: string; wireCode?: string }
    setError(REFUSALS[(value?.wireCode ?? value?.code) as LeadControlRefusal] ?? 'The Lead could not complete that action.')
  }
  useEffect(() => { if (active) void store.lead.readThread().catch(refusal) }, [active, store])
  // Expiry is host-owned; a read at its boundary obtains the renewed plan card.
  useEffect(() => {
    if (!active || state.planConsentExpiresAt === null || state.wayOut === 'decide-plan') return
    const delay = state.planConsentExpiresAt - Date.now()
    const timer = setTimeout(() => { void store.lead.readThread().catch(refusal) }, Math.max(0, Math.min(delay, 2147483647)))
    return () => clearTimeout(timer)
  }, [active, state.planConsentExpiresAt, state.wayOut, store])
  useEffect(() => { if (!active) setSettingsOpen(false) }, [active])
  const send = async () => {
    if (inFlight.current || state.requestInFlight || !goal.trim()) return
    inFlight.current = true; setSending(true); setError(null)
    try { await store.lead.send(goal.trim(), crypto.randomUUID()); setGoal('') }
    catch (error) { refusal(error) }
    finally { inFlight.current = false; setSending(false); input.current?.focus() }
  }
  const cards = state.thread?.cards ?? []
  const contract = state.thread?.contract ?? cards.find(card => card.type === 'plan')?.contract
  const requestPending = sending || state.requestInFlight
  const entries = [...(state.thread?.messages ?? []).map(message => ({ revision: message.revision, kind: 'message' as const, message })),
    ...cards.map(card => ({ revision: state.thread?.cardPositions?.[card.id] ?? card.revision, kind: 'card' as const, card }))].sort((a, b) => a.revision - b.revision)
  return <>
    <DestinationBar place="Lead" />
    <LeadJournal onSettings={() => setSettingsOpen(true)} threadRef={thread} inputRef={input} text={goal} onText={setGoal} onSend={() => void send()}
      pending={requestPending} disabled={requestPending || !goal.trim() || !!state.error || state.revision < 0}
      allowances={!state.thread?.messages.some(message => message.role === 'user') && state.settings ? { dollars: leadDollars(state.settings.caps.usdMicros), rounds: state.settings.caps.rounds } : undefined}
      notices={<>
        {(error || state.error) && <Banner role="alert" tone="warning">{error ?? REFUSALS['lead-projection-failed']}</Banner>}
        {state.wayOut === 'resume' && <Banner actions={<Button disabled={resuming} aria-busy={resuming} onClick={async () => { if (resuming) return; setResuming(true); setError(null); try { await store.lead.resume() } catch (error) { refusal(error) } finally { setResuming(false); input.current?.focus() } }}>Resume</Button>}>
          {state.waitReason ? WAITS[state.waitReason] ?? 'The Lead is waiting for you to continue.' : 'The Lead is waiting for you to continue.'}
        </Banner>}
        {state.wayOut === 'decide-plan' && <Banner actions={<Button onClick={() => thread.current?.querySelector<HTMLElement>('[data-lead-card-type="plan"]')?.focus()}>Review plan</Button>}>The plan needs your decision before work continues.</Banner>}
      </>}>
        {state.thread?.olderMessages ? <Text as="p" role="muted">{state.thread.olderMessages} older messages remain in the journal.</Text> : null}
        {entries.length ? entries.map(entry => entry.kind === 'message'
          ? <article key={`message:${entry.message.id}`} aria-label={entry.message.role === 'user' ? 'You' : 'Lead'}><Text as="h2" role="row">{entry.message.role === 'user' ? 'You' : 'Lead'}</Text><Markdown text={entry.message.text} /></article>
          : <LeadCards key={`card:${entry.card.id}`} cards={[entry.card]} contract={contract} budget={state.thread?.budget} runtimes={snapshot.runtimes} onDecide={decision => { setError(null); return store.lead.decide(decision) }} onError={refusal} onSettled={() => input.current?.focus()}
            onChanges={() => store.openDestination({ kind: 'changes-review', root: state.thread?.project?.path ?? null, returnTo: { kind: 'conversation', session: null } })}
            onApprovals={runId => { void (async () => { try { const run = snapshot.flowExecutions.get(runId) ?? await store.readFlowExecution(runId); store.openGoal(run.goal) } catch (error) { refusal(error) } })() }} />)
          : <Text as="p" role="muted">Describe a goal. The Lead will propose a plan for your approval.</Text>}

    </LeadJournal>
    {active && settingsOpen && state.settings && <LeadSettings settings={state.settings} error={error} expiry={state.planConsentExpiresAt} update={value => { setError(null); return store.lead.updateSettings(value) }} onError={refusal} onClose={() => setSettingsOpen(false)} />}
  </>
}
