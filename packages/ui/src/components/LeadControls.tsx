import { useState, useSyncExternalStore } from 'react'
import { leadNoSpendLimit, type LeadName } from '@harnessdesk/protocol'
import { ConfirmDialog, LeadAvatar, LeadIdentity, MenuItem, MenuNote, MenuSeparator, Text } from '../design'
import { leadPresence, leadReadingWords, leadWakeLine } from '../lib/lead-presence'
import { useStore } from '../state/context'
import { leadDollars } from './LeadCards'
import { leadRefusalText } from './lead-refusals'
import { CompactIcon, RetryIcon, SettingsIcon, StopIcon, SwapIcon } from './Icons'
import { useLeadName } from './use-lead-name'

export const leadLabel = (name: LeadName | null) => name === 'lex' ? 'Lex' : name === 'dex' ? 'Dex' : 'Lead'
/** A Lead journal starts as Dex. Before a folder is open there is no journal, so the name it will have is that one. */
const LEAD_FIRST_NAME: LeadName = 'dex'

/** The Lead's name, its presence and the person's controls, shared by the sidebar, the bar and the popover. */
export const useLeadControls = () => {
  const store = useStore(), name = useLeadName()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  // `name` is the stored setting and gates what reads it; `face` is who the page shows, the journal's first name until one exists.
  const face = name ?? (state.projectMissing ? LEAD_FIRST_NAME : null)
  const presence = leadPresence(state), label = leadLabel(face)
  const other: LeadName = face === 'lex' ? 'dex' : 'lex'
  const [confirmPause, setConfirmPause] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ready = state.revision >= 0 && !state.error
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await work(); return true } catch (failure) { setError(leadRefusalText(failure)); return false } finally { setBusy(false) }
  }
  const openSettings = () => store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } })
  const items = (close: () => void) => <>
    <MenuItem icon={<SwapIcon />} label={`Switch to ${leadLabel(other)}`} disabled={state.projectMissing ? 'Open a folder first.' : !ready || busy ? 'The Lead is not ready yet.' : false}
      onSelect={() => { close(); void run(() => store.lead.updateSettings({ name: other })) }} />
    <MenuItem icon={<StopIcon size={14} />} label={`Pause ${label}`} disabled={!presence.goalActive ? 'Nothing is running.' : busy}
      onSelect={() => { close(); setConfirmPause(true) }} />
    <MenuItem icon={<RetryIcon />} label={`Restart ${label}`} disabled={state.settings?.unavailable ? 'No runtime on this desk can run the Lead.' : state.wayOut !== 'resume' || state.waitReason === 'lead-chat-effect-uncertain' ? 'Nothing is waiting to continue.' : busy}
      onSelect={() => { close(); void run(() => store.lead.resume()) }} />
    <MenuItem icon={<CompactIcon size={14} />} label="Summarise now" title="Replaces the earlier conversation with a summary, so the Lead has room again."
      disabled={state.projectMissing ? 'Open a folder first.' : !ready || state.settings?.unavailable ? 'The Lead is not ready yet.' : state.requestInFlight ? 'Wait for the current request to finish.' : busy}
      onSelect={() => { close(); void run(() => store.lead.compactContext()) }} />
    <MenuSeparator />
    <MenuItem icon={<SettingsIcon />} label="Lead settings" onSelect={() => { close(); openSettings() }} />
  </>
  const dialog = confirmPause ? <ConfirmDialog title={`Pause ${label}?`} confirmLabel={`Pause ${label}`} cancelLabel="Keep working" busy={busy}
    onConfirm={() => void run(() => store.lead.stop()).then(done => { if (done) setConfirmPause(false) })} onCancel={() => setConfirmPause(false)}>
    <Text role="prose">Stops this goal and its running work. Files and worktrees are left as they are. You can send a new goal afterward.</Text>
    {error && <Text role="prose" tone="warning">{error}</Text>}
  </ConfirmDialog> : null
  return { state, name, face, label, presence, items, dialog, error, openSettings }
}

/** The status popover: who, where they stand, what it cost, and the same controls. The caller owns the controls so a confirm outlives the closed menu. */
export const LeadStatusPanel = ({ close, controls }: { readonly close: () => void; readonly controls: ReturnType<typeof useLeadControls> }) => {
  const { state, face, label, presence, items, error } = controls
  const budget = state.thread?.budget, progress = state.progress
  const spent = budget ? budget.leadUsdMicros + budget.workerUsdMicros : 0
  return <>
    <LeadIdentity avatar={<LeadAvatar name={face} size="popover" mood={presence.mood} />} name={label} word={presence.word} />
    <MenuNote>{[
      progress ? `Step ${progress.step} of ${progress.steps}` : presence.goalActive ? 'Planning' : 'No goal running',
      presence.needs ? `${presence.needs} need${presence.needs === 1 ? 's' : ''} you` : null,
      budget ? leadNoSpendLimit(budget.caps.usdMicros) ? `${leadDollars(spent)} spent` : `${leadDollars(spent)} of ${leadDollars(budget.caps.usdMicros)} spent` : null,
    ].filter(Boolean).join(' · ')}</MenuNote>
    {presence.goalActive && state.presence && <MenuNote>{[...leadReadingWords(state.presence), leadWakeLine(state.presence)].filter(Boolean).join(' · ')}</MenuNote>}
    {error && <MenuNote tone="warning">{error}</MenuNote>}
    <MenuSeparator />
    {items(close)}
  </>
}
