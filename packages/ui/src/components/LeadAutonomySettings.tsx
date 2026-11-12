import { useEffect, useState, useSyncExternalStore } from 'react'
import { LEAD_AUTONOMY_KINDS, LEAD_AUTONOMY_LABELS, LEAD_RULE_TITLES, type LeadAutonomyChange, type LeadAutonomyKind, type LeadAutonomyMode, type LeadAutonomyView } from '@harnessdesk/protocol'
import { NativeSelect, Row, Rows, Section, Text } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { useStore } from '../state/context'
import { leadRefusalText } from './lead-refusals'
import { useLeadCalled } from './use-lead-name'

const MODES: readonly { readonly value: LeadAutonomyMode; readonly label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'observe', label: 'Observe' }, { value: 'act', label: 'Act' },
]
const HOUR = 3_600_000
const DEADLINES: readonly { readonly value: string; readonly label: string; readonly ms: number | null }[] = [
  { value: 'none', label: 'No deadline', ms: null }, { value: '1', label: 'In 1 hour', ms: HOUR }, { value: '4', label: 'In 4 hours', ms: 4 * HOUR }, { value: '24', label: 'In 24 hours', ms: 24 * HOUR },
]
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const MODE_LABEL = Object.fromEntries(MODES.map(one => [one.value, one.label])) as Record<LeadAutonomyMode, string>
/** One change in a line: what it was and what it became. A rules change names the section and version, never its words. */
const changeTitle = (change: LeadAutonomyChange): string => {
  if (change.what === 'mode') return `${LEAD_AUTONOMY_LABELS[change.kind].title}: ${MODE_LABEL[change.from]} → ${MODE_LABEL[change.to]}`
  if (change.what === 'rules') return `${LEAD_RULE_TITLES[change.section]}: ${change.how === 'reset' ? 'reset to default' : change.how === 'rollback' ? `version ${change.version} restored` : `version ${change.version} saved`}`
  return change.deadlineAt === null ? 'Goal deadline cleared' : `Goal deadline set for ${when(change.deadlineAt)}`
}

/**
 * Settings › Lead › Autonomy: what the Lead does without being asked, one row per kind. The host enforces each row at
 * the point it would act. Observe does nothing but write what it would have done, so a row can be trusted before it is
 * switched on.
 */
export const LeadAutonomySection = () => {
  const store = useStore(), active = useDestinationActive(), called = useLeadCalled()
  const lead = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const goal = lead.thread?.budget?.logicalGoalId, open = !!goal && !['accepted', 'declined', 'stopped'].includes(lead.thread?.state ?? '')
  const [read, setView] = useState<LeadAutonomyView | null>(null)
  // The store's copy is refreshed whenever the desk says autonomy changed, a rule section's save included, so Recent
  // changes shows a save made in the Rules dialog without the page being opened again (#2152).
  const view = lead.autonomy?.modes ? lead.autonomy : read
  const [pending, setPending] = useState<LeadAutonomyKind | null>(null), [error, setError] = useState<string | null>(null)
  useEffect(() => { if (active) void store.lead.readAutonomy().then(next => setView(next?.modes ? next : null), failure => setError(leadRefusalText(failure))) }, [active, store])
  const choose = async (kind: LeadAutonomyKind, mode: LeadAutonomyMode) => {
    setPending(kind); setError(null)
    try { const next = await store.lead.setAutonomy({ kind, mode }); if (next?.modes) setView(next) } catch (failure) { setError(leadRefusalText(failure)) } finally { setPending(null) }
  }
  const setDeadline = async (value: string) => {
    const ms = DEADLINES.find(one => one.value === value)?.ms ?? null
    setError(null)
    try { const next = await store.lead.setDeadline({ logicalGoalId: goal!, deadlineAt: ms === null ? null : Date.now() + ms }); if (next?.modes) setView(next) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  if (!view) return error ? <Section title="Autonomy"><Text role="muted">{error}</Text></Section> : null
  return <Section title="Autonomy">
    <Rows>
      {LEAD_AUTONOMY_KINDS.map(kind => <Row key={kind} title={LEAD_AUTONOMY_LABELS[kind].title} tooltip={LEAD_AUTONOMY_LABELS[kind].hint}
        control={<NativeSelect aria-label={LEAD_AUTONOMY_LABELS[kind].title} value={view.modes[kind]} disabled={pending === kind} onChange={event => void choose(kind, event.target.value as LeadAutonomyMode)}>
          {MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </NativeSelect>} />)}
    </Rows>
    {open && <Rows>
      <Row title="Goal deadline" tooltip={`At 80% of the time ${called} says so; at the deadline it starts no new round.`}
        control={<NativeSelect aria-label="Goal deadline" value={view.deadline ? 'set' : 'none'} onChange={event => void setDeadline(event.target.value)}>
          {view.deadline && <option value="set" disabled>{`Until ${when(view.deadline.deadlineAt)}`}</option>}
          {DEADLINES.map(one => <option key={one.value} value={one.value}>{one.label}</option>)}
        </NativeSelect>} />
    </Rows>}
    <Text role="muted">{`Observe records what ${called} would have done and does nothing.`}</Text>
    {view.observed.length > 0 && <Rows>
      {view.observed.slice(0, 3).map(item => <Row key={item.id} title={item.note} control={<Text role="meta">{when(item.at)}</Text>} />)}
    </Rows>}
    {(view.changes?.length ?? 0) > 0 && <>
      <Text role="muted">{`Recent changes. Only you change these; ${called} cannot.`}</Text>
      <Rows aria-label="Autonomy changes">
        {view.changes!.slice(0, 5).map(change => <Row key={`${change.at}-${changeTitle(change)}`} title={changeTitle(change)}
          desc={change.what !== 'deadline' && change.proposal ? `Applied from proposal ${change.proposal}` : undefined} control={<Text role="meta">{when(change.at)}</Text>} />)}
      </Rows>
    </>}
    {error && <Text role="muted">{error}</Text>}
  </Section>
}
