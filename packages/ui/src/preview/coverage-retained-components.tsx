import { LeadAway } from '../components/LeadAway'
import { LeadCheck } from '../components/LeadCheck'
import { LeadStatusPanel, useLeadControls } from '../components/LeadControls'
import { PhoneAsk, PhoneSettingsSection } from '../components/PhoneSettings'
import { createLeadFixtureStore } from './frames-lead'
import { useMemo, useState } from 'react'
import type { TriggerBudgetState } from '@harnessdesk/protocol'
import { Menu, Section, Text } from '../design'
import { SeatFace } from '../components/AgentCards'
import { AgentRow } from '../components/AgentRoster'
import { ComposerOptionMenu, PermissionControl } from '../components/ComposerControls'
import { ShieldIcon } from '../components/Icons'
import { RunRoundCards } from '../components/RunRoundCards'
import { BudgetFooter } from '../components/TeamRoomPane'
import { runTimeline } from '../lib/run-timeline'
import { PaneProvider, StoreProvider } from '../state/context'
import { Dial, Frame } from './main'
import { PREVIEW_AGENTS, PREVIEW_SESSION_KEY } from './harness'
import { overviewInput } from './team-overview-fixture'

const comparison = overviewInput('comparison')
const recordedCards = runTimeline({ execution: comparison.run!.execution, cards: comparison.cards }).rows
  .filter(row => row.kind === 'card')
const now = Date.now()
const budget: TriggerBudgetState = {
  goal: 'coverage-team', startedAt: now - 30 * 60_000, deadline: now + 30 * 60_000,
  budget: { usd: 5, rounds: 3, hours: 1, withoutProgress: 2 }, spentMicros: 1_250_000,
  reservedMicros: 0, provenance: 'vendorMetered', closedRounds: [1], idleRounds: 0, stop: null,
}

const LeadStatusCoverage = () => <Menu close={() => {}}><LeadStatusPanel close={() => {}} controls={useLeadControls()} /></Menu>
const LeadAndPhoneCoverage = () => {
  const own = useMemo(() => {
    const fixture = createLeadFixtureStore('running'), snapshot = fixture.getSnapshot()
    localStorage.setItem('hd-lead-seen-v1', JSON.stringify({ at: Date.now() - 360_000, revision: 0, spent: 0 }))
    const teams = new Map(snapshot.teams), evidence = new Map(snapshot.boardEvidence)
    teams.set('coverage-check', { intents: [{ id: 1, role: 'implement', state: 'done' }] } as never)
    evidence.set('coverage-check', { checks: ['verify'], cards: [{ card: 2, facts: [{ record: { fact: { kind: 'review', verdict: 'approve', at: 'a'.repeat(40) } } }] }] } as never)
    Object.assign(snapshot, { teams, boardEvidence: evidence })
    const phone = { enabled: true, deskName: 'Demo desk', deskId: 'demo', port: 3000, devices: [], pending: [{ id: 'demo-phone', name: 'Jane Doe’s phone', requestedAt: Date.now() }] }
    const request = fixture.transport.request.bind(fixture.transport)
    fixture.transport.request = (async (method, params) => method === 'phone/state' ? phone : request(method, params)) as typeof fixture.transport.request
    fixture.phone.changed({ method: 'phone/changed', params: phone } as never)
    return fixture
  }, [])
  return <StoreProvider store={own}>
    <Section title="Lead status"><LeadStatusCoverage /><LeadAway active state={own.lead.state} label="Dex" />
      <LeadCheck room="coverage-check" needed revision={1} label="Dex" onError={() => {}} /></Section>
    <PhoneSettingsSection /><PhoneAsk />
  </StoreProvider>
}

/** State-specific exports stay inspectable even when the unified Work view uses compact rows. */
export const RetainedComponentsCoverage = () => {
  const [shown, setShown] = useState('off')
  const [selected, setSelected] = useState<string | null>(null)
  const [openedAgent, setOpenedAgent] = useState(false)
  return <Frame id="coverage-retained-components" title="Seats — saved rows, member options and recorded cards">
    <div className="flex flex-col gap-4 p-4">
      <Dial label="saved component state" value={shown} options={['off', 'recorded']} onChange={setShown} />
      {shown === 'recorded' && <>
      <Section title="Saved Agent and Seat" level="heading">
        <SeatFace name="Alpha" meta="Model A" description="The Seat that built the recorded attempt." />
        <AgentRow entry={PREVIEW_AGENTS[0]!} onOpen={() => setOpenedAgent(true)} />
        {openedAgent && <Text as="p">Code reviewer opened.</Text>}
      </Section>
      <Section title="Member permission menu" level="heading">
        <PaneProvider scope={{ paneId: 'coverage-member-options', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}>
          <Menu close={() => {}}>
            <ComposerOptionMenu label="Alpha" title="Alpha" icon={<ShieldIcon size={14} />} value="Read only">
              <PermissionControl />
            </ComposerOptionMenu>
          </Menu>
        </PaneProvider>
      </Section>
      <Section title="Recorded cards" level="heading">
        <RunRoundCards rows={recordedCards} attempts={[]} context={{ now, needsYou: false,
          seatNames: new Map(comparison.seats.map(seat => [seat.record.id, { name: seat.name, detail: 'Model A' }])),
          seatOfCard: card => recordedCards.find(row => row.card === card)?.seat ?? null,
          selectedRow: selected, onSelect: setSelected, doingOf: () => null }} />
      </Section>
      <Section title="Run budget" level="heading"><BudgetFooter state={budget} now={now} /></Section>
      <LeadAndPhoneCoverage />
      </>}
    </div>
  </Frame>
}
