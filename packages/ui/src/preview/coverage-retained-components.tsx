import { LeadAway } from '../components/LeadAway'
import { LeadProactiveCard } from '../components/LeadCards'
import { LeadCheck } from '../components/LeadCheck'
import { LeadWork } from '../components/LeadWork'
import { LeadCheckpointNotice, LeadContextSection } from '../components/LeadCheckpoint'
import { MentionDecisionRows, type MentionTriageState } from '../components/MentionDecisions'
import { LeadStatusPanel, useLeadControls } from '../components/LeadControls'
import { PhoneAsk, PhoneSettingsSection } from '../components/PhoneSettings'
import { PromptLinkMarker } from '../components/PromptLinkMarker'
import { createLeadFixtureStore } from './frames-lead'
import { leadContextFacts, leadSceneProjection } from './lead-fixture'
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { TriggerBudgetState } from '@harnessdesk/protocol'
import { ComposerNoticeStack, Menu, Section, Text } from '../design'
import { SeatFace } from '../components/AgentCards'
import { AgentRow } from '../components/AgentRoster'
import { ComposerOptionMenu, PermissionControl } from '../components/ComposerControls'
import { ShieldIcon } from '../components/Icons'
import { RunRoundCards } from '../components/RunRoundCards'
import { BudgetFooter } from '../components/TeamRoomPane'
import { runTimeline } from '../lib/run-timeline'
import { PaneProvider, StoreProvider } from '../state/context'
import { Dial, Frame } from './main'
import { PREVIEW_AGENTS, PREVIEW_SESSION_KEY, previewStore } from './harness'
import { overviewInput } from './team-overview-fixture'
import { triggerDecisionsPage } from './intake-fixture'

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
    const fixture = createLeadFixtureStore('presence'), snapshot = fixture.getSnapshot()
    const teams = new Map(snapshot.teams), evidence = new Map(snapshot.boardEvidence)
    teams.set('coverage-check', { intents: [{ id: 1, role: 'implement', state: 'done' }] } as never)
    evidence.set('coverage-check', { checks: ['verify'], cards: [{ card: 2, facts: [{ record: { fact: { kind: 'review', verdict: 'approve', at: 'a'.repeat(40) } } }] }] } as never)
    Object.assign(snapshot, { teams, boardEvidence: evidence })
    const phone = { enabled: true, deskName: 'Demo desk', deskId: 'demo', port: 3000, devices: [], pending: [{ id: 'demo-phone', name: 'Jane Doe’s phone', requestedAt: Date.now() }] }
    const request = fixture.transport.request.bind(fixture.transport)
    // The conversation's facts as Settings shows them once the latest messages alone fill the Lead's room.
    fixture.transport.request = (async (method, params) => method === 'phone/state' ? phone : method === 'lead/context/read' ? { ...leadContextFacts, full: true }
      : request(method, params)) as typeof fixture.transport.request
    fixture.phone.changed({ method: 'phone/changed', params: phone } as never)
    fixture.lead.changed({ method: 'lead/changed', params: leadSceneProjection('presence') } as never)
    return fixture
  }, [])
  const lead = useSyncExternalStore(own.lead.subscribe, () => own.lead.state)
  return <StoreProvider store={own}>
    <Section title="Lead status"><LeadStatusCoverage /><LeadAway active state={lead} label="Dex" />
      <LeadProactiveCard report={{ finding: 'The review is ready.', caveat: 'Checks still need you.', ask: 'Open changes', action: 'changes' }} />
      <LeadCheck room="coverage-check" needed revision={1} label="Dex" onError={() => {}} />
      <LeadCheckpointNotice checkpoint={{ id: leadContextFacts.checkpoints[0]!.id }} /></Section>
    <LeadContextSection />
    <PhoneSettingsSection /><PhoneAsk />
  </StoreProvider>
}

/** The Lead's work list over the work-ledger fixture: one item in each stage's group, as the host would hand it over. */
const LeadWorkCoverage = () => {
  const own = useMemo(() => createLeadFixtureStore('work-ledger'), [])
  return <StoreProvider store={own}><Section title="Lead work"><LeadWork /></Section></StoreProvider>
}

/** A mention trigger's history as an expanded row shows it: the work thread and each decision with Re-evaluate. */
const MentionTriageCoverage = () => {
  const triage = useMemo<MentionTriageState>(() => ({
    page: triggerDecisionsPage(), problem: null, busy: false,
    reload: () => {}, setMode: async () => {}, reevaluate: async () => {},
  }), [])
  return <Section title="Mention triage" level="heading"><MentionDecisionRows triage={triage} /></Section>
}

/** A new chat's draft as a prompt link left it: the composer holds the link's words, so the mark shows what else it asked for. */
const PromptLinkCoverage = () => {
  const own = useMemo(() => previewStore({ promptLinkDraft: { text: 'Fix the flaky checkout test.', context: 'Pull request #42 · Flow review.' } }), [])
  return <StoreProvider store={own}><Section title="Prompt link draft" level="heading">
    <ComposerNoticeStack><PromptLinkMarker text="Fix the flaky checkout test." /></ComposerNoticeStack></Section></StoreProvider>
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
      <LeadWorkCoverage />
      <MentionTriageCoverage />
      <PromptLinkCoverage />
      </>}
    </div>
  </Frame>
}
