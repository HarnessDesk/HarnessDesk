import { useEffect, useSyncExternalStore } from 'react'
import { useSnapshot, useStore } from '../state/context'

export const useLeadName = () => {
  const store = useStore(), snapshot = useSnapshot()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  useEffect(() => { if (snapshot.leadAvailable && store.lead.state.revision < 0) void store.lead.readSettings().catch(() => {}) }, [store, snapshot.leadAvailable])
  return state.settings?.name ?? null
}
