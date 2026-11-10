import { useEffect, useState, useSyncExternalStore } from 'react'
import type { LeadBriefSettings } from '@harnessdesk/protocol'
import { Input, Row, Rows, Section, Switch, Text } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { useStore } from '../state/context'
import { leadRefusalText } from './lead-refusals'

/** Settings › Lead › Morning brief: one digest a day at a time you choose, off until you ask, held back during quiet hours. */
export const LeadBriefSettingsSection = ({ label }: { readonly label: string }) => {
  const store = useStore(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [brief, setBrief] = useState<LeadBriefSettings | null>(null)
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  // The brief is shared with the phone; a change made there arrives with the next presence read.
  const shared = state.away?.brief
  useEffect(() => { if (active) void store.lead.readBrief().then(setBrief, failure => setError(leadRefusalText(failure))) }, [active, store, shared?.enabled, shared?.at])
  const save = async (update: { readonly enabled?: boolean; readonly at?: string }) => {
    setPending(true); setError(null)
    try { setBrief(await store.lead.updateBrief(update)) } catch (failure) { setError(leadRefusalText(failure)) } finally { setPending(false) }
  }
  if (!brief) return error ? <Section title="Morning brief"><Text role="muted">{error}</Text></Section> : null
  return <Section title="Morning brief">
    <Rows>
      <Row title={`Daily brief from ${label}`} desc="What finished, what waits for you and what stopped, once a day. It never arrives during quiet hours."
        control={<Switch aria-label="Morning brief" checked={brief.enabled} disabled={pending} onCheckedChange={enabled => void save({ enabled })} />} />
      {brief.enabled && <Row title="Time" control={<Input aria-label="Morning brief time" type="time" value={brief.at} disabled={pending} onChange={event => { if (/^\d\d:\d\d$/.test(event.target.value)) void save({ at: event.target.value }) }} />} />}
    </Rows>
    {error && <Text role="muted">{error}</Text>}
  </Section>
}
