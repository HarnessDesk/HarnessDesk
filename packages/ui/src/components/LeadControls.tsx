import { useState, useSyncExternalStore } from 'react'
import type { LeadName } from '@harnessdesk/protocol'
import { ConfirmDialog, LeadAvatar, MenuItem, MenuNote, MenuSeparator, Text } from '../design'
import { leadPresence } from '../lib/lead-presence'
import { useStore } from '../state/context'
import { leadDollars } from './LeadCards'
import { leadRefusalText } from './lead-refusals'
import { RetryIcon, SettingsIcon, StopIcon, SwapIcon } from './Icons'
import { useLeadName } from './use-lead-name'
import styles from './Lead.module.css'

export const leadLabel = (name: LeadName | null) => name === 'lex' ? 'Lex' : name === 'dex' ? 'Dex' : 'Lead'

/** The Lead's name, its presence and the person's four controls, shared by the sidebar, the bar and the popover. */
export const useLeadControls = () => {
  const store = useStore(), name = useLeadName()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const presence = leadPresence(state), label = leadLabel(name)
  const other: LeadName = name === 'lex' ? 'dex' : 'lex'
  const [confirmPause, setConfirmPause] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const ready = state.revision >= 0 && !state.error
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await work(); return true } catch (failure) { setError(leadRefusalText(failure)); return false } finally { setBusy(false) }
  }
  const openSettings = () => store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } })
  const items = (close: () => void) => <>
    <MenuItem icon={<SwapIcon />} label={`Switch to ${leadLabel(other)}`} disabled={!ready || busy ? 'The Lead is not ready yet.' : false}
      onSelect={() => { close(); void run(() => store.lead.updateSettings({ name: other })) }} />
    <MenuItem icon={<StopIcon size={14} />} label={`Pause ${label}`} disabled={!presence.goalActive ? 'Nothing is running.' : busy}
      onSelect={() => { close(); setConfirmPause(true) }} />
    <MenuItem icon={<RetryIcon />} label={`Restart ${label}`} disabled={state.wayOut !== 'resume' ? 'Nothing is waiting to continue.' : busy}
      onSelect={() => { close(); void run(() => store.lead.resume()) }} />
    <MenuSeparator />
    <MenuItem icon={<SettingsIcon />} label="Lead settings" onSelect={() => { close(); openSettings() }} />
  </>
  const dialog = confirmPause ? <ConfirmDialog title={`Pause ${label}?`} confirmLabel={`Pause ${label}`} cancelLabel="Keep working" busy={busy}
    onConfirm={() => void run(() => store.lead.stop()).then(done => { if (done) setConfirmPause(false) })} onCancel={() => setConfirmPause(false)}>
    <Text role="prose">Stops this goal and its running work. Files and worktrees are left as they are. You can send a new goal afterward.</Text>
    {error && <Text role="prose" tone="warning">{error}</Text>}
  </ConfirmDialog> : null
  return { state, name, label, presence, items, dialog, error, openSettings }
}

/** The status popover: who, where they stand, what it cost, and the same four controls. The caller owns the controls so a confirm outlives the closed menu. */
export const LeadStatusPanel = ({ close, controls }: { readonly close: () => void; readonly controls: ReturnType<typeof useLeadControls> }) => {
  const { state, name, label, presence, items, error } = controls
  const budget = state.thread?.budget, progress = state.progress
  const spent = budget ? budget.leadUsdMicros + budget.workerUsdMicros : 0
  return <>
    <div data-slot="lead-status-head" className={styles.statusHead}>
      <LeadAvatar name={name} size="popover" mood={presence.mood} />
      <div className={styles.statusName}><Text role="subject">{label}</Text><Text role="muted">{presence.word}</Text></div>
    </div>
    <MenuNote>{[
      progress ? `Step ${progress.step} of ${progress.steps}` : presence.goalActive ? 'Planning' : 'No goal running',
      presence.needs ? `${presence.needs} need${presence.needs === 1 ? 's' : ''} you` : null,
      budget ? `${leadDollars(spent)} of ${leadDollars(budget.caps.usdMicros)} spent` : null,
    ].filter(Boolean).join(' · ')}</MenuNote>
    {error && <MenuNote tone="warning">{error}</MenuNote>}
    <MenuSeparator />
    {items(close)}
  </>
}
