import { leadDisplayName } from '@harnessdesk/protocol'
import { useEffect, useSyncExternalStore } from 'react'
import { useSnapshot, useStore } from '../state/context'

const noLeadSubscription = () => () => {}

export const useLeadName = () => {
  const store = useStore(), snapshot = useSnapshot()
  const state = useSyncExternalStore(store.lead?.subscribe ?? noLeadSubscription, () => store.lead?.state ?? null)
  useEffect(() => { if (snapshot.leadAvailable && store.lead && store.lead.state.revision < 0) void store.lead.readSettings().catch(() => {}) }, [store, snapshot.leadAvailable])
  // With no folder there is no journal to name; a folder opening is the cue to read it, wherever the name is shown.
  const folders = snapshot.workspaces.length, projectMissing = state?.projectMissing === true
  useEffect(() => { if (snapshot.leadAvailable && projectMissing && folders) void store.lead?.readSettings().catch(() => {}) }, [store, snapshot.leadAvailable, projectMissing, folders])
  return state?.settings?.name ?? null
}

/** The Lead's name as the person chose it in settings ("Dex"), or null before it is read or with no Lead on this desk. */
export const useLeadLabel = (): string | null => {
  const name = useLeadName()
  return name ? leadDisplayName(name) : null
}

export const LEAD_NAME_CHOICES = [{ name: 'dex', label: leadDisplayName('dex') }, { name: 'lex', label: leadDisplayName('lex') }] as const
