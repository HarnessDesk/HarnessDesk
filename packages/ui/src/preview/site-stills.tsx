/** Content-only website cameras, composed from the shipped surfaces. */
import { useEffect, useMemo, useState } from 'react'
import { FlowInputFields, FlowPreviewSeats } from '../components/FlowStart'
import { HandoffSheet } from '../components/ComposerControls'
import { RunView } from '../components/RunView'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { TeamsWindow } from '../components/TeamsWindow'
import { Usage, type DashboardView } from '../components/Usage'
import { Bar, Button, Card, CardContent, Dialog, FormStack } from '../design'
import { runTimeline } from '../lib/run-timeline'
import { browserView } from '../state/layout'
import { mountedViews, replaceView } from '../state/workbench'
import { MountProvider } from '../panels/mount'
import { previewStore, PREVIEW_AGENTS, PREVIEW_ROOM } from './harness'
import { sideBySideStore, SIDE_BY_SIDE_KEYS } from './side-by-side-fixture'
import { teamsPageStore } from './teams-page-fixture'
import { SITE_BROWSER_URL, siteLedger, siteRun, siteUsage, siteStartPreview, siteClipRun } from './site-stills-data'

export const SITE_SCENES = ['teams-table', 'run-short', 'race-run', 'browser-tile', 'handoff-dialog', 'start-preview',
  'dash-plans', 'dash-hour', 'dash-year', 'dash-spend', 'dash-agents']

export const siteStillStore = (scene: string) => {
  if (scene === 'teams-table') {
    const own = teamsPageStore()
    if (!new URLSearchParams(window.location.search).has('site-clip')) return own
    return new Proxy(own, { get(target, key) {
      if (key === 'openTeamRoom') return async () => window.dispatchEvent(new CustomEvent('site-clip-stage', { detail: 1 }))
      // Opening the camera excerpt does not change the table's unread marks.
      if (key === 'markTeamSeen') return () => {}
      return Reflect.get(target, key)
    } })
  }
  if (scene === 'browser-tile') {
    const base = sideBySideStore({ browsers: true, noGoal: true })
    const snapshot = base.getSnapshot()
    const workbench = mountedViews(snapshot.workbench).reduce((current, { mounted }) => mounted.view.kind === 'browser' && mounted.view.profile === 'lane-alpha'
      ? replaceView(current, mounted.id, browserView(SITE_BROWSER_URL, 'lane-alpha')) : current, snapshot.workbench)
    const own = previewStore({ ...snapshot, workbench })
    own.teamPeers = base.teamPeers.bind(base)
    return own
  }
  const base = previewStore().getSnapshot()
  const usage = siteUsage()
  const accountsByRuntime = Object.fromEntries(base.runtimes.map(info => [info.id, {
    ...base.accountsByRuntime[info.id], signInMethods: [], accounts: usage.filter(report => report.runtime === info.id).map(report => ({ kind: 'oauth' as const, label: report.account!, email: report.account! })),
  }]))
  const own = previewStore({ ...base, usage, accountsByRuntime })
  own.ledger = async query => siteLedger(query)
  return own
}

const CompactRun = ({ race, stage }: { race: boolean; stage: number | null }) => {
  const input = useMemo(() => stage === null ? siteRun(race ? 'race' : 'review') : siteClipRun(race ? 'race' : 'review', stage), [race, stage])
  const names = new Map((race ? [[1, 'Alpha'], [2, 'Beta'], [5, 'Judge']] : [[1, 'Writer'], [2, 'Reviewer'], [3, 'Writer'], [4, 'Reviewer']]).map(([id, name]) => [`seat-${id}`, { name: String(name), detail: null }]))
  return <RunView execution={input.execution} model={runTimeline(input)} number={1} selectedRow={null} onSelect={() => {}} seatNames={names} />
}

const StartTop = ({ onBack }: { onBack?: () => void }) => {
  const preview = useMemo(() => siteStartPreview(), [])
  const roster = useMemo(() => new Map(PREVIEW_AGENTS.map(agent => [agent.id, agent])), [])
  const [vars, setVars] = useState({ brief: 'Bound the retry attempts and keep the final failure visible.', task: 'Retry the checkout call on a 502' })
  const [reading, setReading] = useState(false)
  const flow = preview.compiled.document.format === 'agents' ? preview.compiled.document.flow : null
  return <Card data-site-start><CardContent className="py-6"><FormStack>
    <FlowInputFields flow={flow} scope="site-start" vars={vars} onChange={(id, value) => setVars(current => ({ ...current, [id]: value }))} onReadingChange={setReading} />
    <FlowPreviewSeats preview={preview} roster={roster} />
    <Bar><Button disabled={reading || !preview.token}>Start</Button>{onBack && <Button variant="secondary" onClick={onBack}>Back to Teams</Button>}</Bar>
  </FormStack></CardContent></Card>
}

export const SiteStills = ({ scene }: { scene: string }) => {
  const clip = new URLSearchParams(window.location.search).has('site-clip')
  const [stage, setStage] = useState(0)
  const [view, setView] = useState<DashboardView>('plans')
  useEffect(() => {
    if (!clip) return
    const receive = (event: Event) => setStage((event as CustomEvent<number>).detail)
    window.addEventListener('site-clip-stage', receive)
    return () => window.removeEventListener('site-clip-stage', receive)
  }, [clip])
  if (scene === 'teams-table') return <><TeamsWindow onClose={() => {}} />{clip && stage === 1 &&
    <Dialog title="Start with a team" size="xl" onClose={() => setStage(0)}><StartTop onBack={() => setStage(0)} /></Dialog>}</>
  if (scene === 'run-short' || scene === 'race-run') return <CompactRun race={scene === 'race-run'} stage={clip ? stage : null} />
  if (scene === 'handoff-dialog') return <HandoffSheet from="Writer" to="Reviewer" onCancel={() => {}} onConfirm={() => {}} />
  if (scene === 'start-preview') return <div className="w-full max-w-2xl"><StartTop /></div>
  if (scene === 'browser-tile') return <MountProvider scope={{ area: 'main', id: 'site-browser', view: { kind: 'room', room: PREVIEW_ROOM,
    sideBySide: { tiles: SIDE_BY_SIDE_KEYS.slice(0, 1), focused: SIDE_BY_SIDE_KEYS[0], modes: { [SIDE_BY_SIDE_KEYS[0]!]: 'browser' } } } }}>
    <TeamRoomPane room={PREVIEW_ROOM} />
  </MountProvider>
  return <Usage view={clip ? view : scene === 'dash-plans' ? 'plans' : scene === 'dash-spend' || scene === 'dash-agents' ? 'spend' : 'activity'} onView={clip ? setView : undefined} onClose={() => {}} />
}
