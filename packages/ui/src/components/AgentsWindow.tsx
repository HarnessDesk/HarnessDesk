import { useEffect } from 'react'
import { Page } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { useDestinationPage } from '../panels/destination-page'
import { AgentsRosterSection } from './AgentRoster'

/** Agents is a retained destination; the shell owns its column and bar. */
export const AgentsWindow = (props: { readonly focus: string | null; readonly onFocus: (id: string | null) => void }) =>
  <AgentsDestination {...props} />
const AgentsDestination = ({ focus, onFocus }: {
  readonly focus: string | null; readonly onFocus: (id: string | null) => void
}) => {
  const store = useStore(), snapshot = useSnapshot()
  const { active } = useDestinationPage()
  useEffect(() => { if (active) void store.loadAgents() }, [active, store])
  const detail = focus !== null && (snapshot.agents ?? []).some(entry => entry.id === focus)
  return <Page width={detail ? 'reading' : 'wide'}>
    <AgentsRosterSection focus={focus} onFocus={onFocus} />
  </Page>
}
