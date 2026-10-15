import { useMemo } from 'react'
import { RunAgain } from '../components/RunAgain'
import { runFixture } from './run-view-fixture'
import { RaceStart } from '../components/RaceStart'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { PREVIEW_ROOM } from './harness'
import { teamStartStore } from './frames-team-start'
import { comparisonVerdictStore } from './comparison-verdict-fixture'
import { TeamFramePreview } from './TeamFramePreview'
import { TEAM_START_POLICIES } from './team-start-fixture'

/** Controlled reads and placeholder identities keep public evidence repeatable. */
export const RaceEntryFrames = () => {
  const scene = new URLSearchParams(location.search).get('race-entry')
  const store = useMemo(() => {
    if (scene === 'tiles') {
      const own = comparisonVerdictStore('person')
      const snapshot = own.getSnapshot()
      const team = snapshot.teams.get(PREVIEW_ROOM)!
      const board = { ...team, intents: team.intents.filter(card => card.role === 'competitor').map(card => ({ ...card, state: 'open' as const, outcome: null, note: null })) }
      const goal = snapshot.goals.get(PREVIEW_ROOM)!
      Object.assign(snapshot, { theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light',
        teams: new Map([[PREVIEW_ROOM, board]]), goals: new Map([[PREVIEW_ROOM, { ...goal, activity: 'working', board }]]),
        boardEvidence: new Map(), sessions: new Map([...snapshot.sessions].map(([key, session]) => [key, { ...session, turns: [] }])),
        flowExecutions: new Map([...snapshot.flowExecutions].map(([id, run]) => [id, { ...run, rounds: run.rounds.slice(0, 1).map(round => ({ ...round, state: 'running' })), document: run.document.format === 'agents'
          ? { ...run.document, flow: { ...run.document.flow, layout: TEAM_START_POLICIES.comparison.layout } } : run.document }])) })
      return own
    }
    const own = teamStartStore()
    if (scene !== 'loading' && !scene?.startsWith('again-')) return own
    return new Proxy(own, { get(target, key, receiver) {
      if (key === 'flowSource' && scene === 'loading') return () => new Promise<string>(() => {})
      if (key === 'flowExecutionSource') return () => scene === 'again-source' ? new Promise(() => {}) : Promise.resolve({ source: 'saved-flow', vars: {} })
      if (key === 'previewFlow') return () => new Promise(() => {})
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }, [scene])
  return <StoreProvider store={store}><RaceEntryScene scene={scene} /></StoreProvider>
}
const RaceEntryScene = ({ scene }: { readonly scene: string | null }) => {
  useTheme()
  return <div className="h-screen bg-background text-foreground">{scene === 'tiles'
    ? <TeamFramePreview room={PREVIEW_ROOM} view={{ kind: 'room', room: PREVIEW_ROOM }} />
    : scene?.startsWith('again-') ? <RunAgain execution={runFixture('stopped').execution} root="/work/storefront" sentence="Fix the cart total" onClose={() => {}} onStarted={() => {}} />
    : <RaceStart root="/work/storefront" task={scene === 'disabled' ? '' : 'Fix the cart total'} onClose={() => {}} />}</div>
}
