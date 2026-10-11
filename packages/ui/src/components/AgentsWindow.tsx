import { useEffect } from 'react'
import { Page, useEscapeSurface } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { DestinationPageScope, useDestinationPage } from '../panels/destination-page'
import { AgentsRosterSection } from './AgentRoster'

/** Agents is a retained destination; the shell owns its column and bar. */
export const AgentsWindow = ({ focus, onFocus, onClose }: {
  readonly focus: string | null
  readonly onFocus: (id: string | null) => void
  /** Temporary adapter for legacy callers, removed by destination integration. */
  readonly onClose?: () => void
}) => {
  useEscapeSurface(Boolean(onClose), onClose ?? (() => {}))
  const body = <AgentsDestination focus={focus} onFocus={onFocus} />
  return onClose ? <DestinationPageScope owner="agents" active>{body}</DestinationPageScope> : body
}
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
