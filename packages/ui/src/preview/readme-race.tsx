/** The README's race: two Seats build the same brief Side by side, each in its own Browser, and the judge picks one. */
import { useEffect, useMemo, type ReactNode } from 'react'
import type { Session, SessionKey } from '@harnessdesk/protocol'
import { MountProvider } from '../panels/mount'
import { KeyboardHereContext, StoreProvider } from '../state/context'
import { browserView } from '../state/layout'
import { mountedViews, replaceView } from '../state/workbench'
import { useTheme } from '../state/theme'
import type { AppSnapshot, AppStore } from '../state/store'
import { comparisonVerdictStore } from './comparison-verdict-fixture'
import { PREVIEW_ROOM } from './harness'
import { README_RACE_RUNTIMES } from './readme-names'
import { SIDE_BY_SIDE_KEYS } from './side-by-side-fixture'
import { TeamFramePreview } from './TeamFramePreview'

/** Each Seat's lane serves its attempt on the lane's first port. */
export const README_RACE_URLS = { 'lane-alpha': 'http://localhost:30000/', 'lane-beta': 'http://localhost:30020/' } as const
const BRIEF = 'Build a one-file side-scrolling runner game.'
const ANSWERS = [
  'Neon Run is in index.html: a canvas loop, a jump on Space, spikes on a fixed course and a best score kept between runs.',
  'Fox Dash is in index.html: parallax hills, logs to jump, coins overhead, and a score that resets on a hit.',
]
const VERDICT = 'Neon Run plays smoothly, and its jump timing passes every check.'
const RUNTIMES = README_RACE_RUNTIMES
const MODELS = [{ id: 'model-a', displayName: 'High' }, { id: 'model-b', displayName: 'Opus' }, { id: 'model-c', displayName: 'Auto' }]

type Stage = 0 | 1 | 2 | 3
type Patchable = AppStore & { patch: (partial: Partial<AppSnapshot>) => void }

/** Who is still working at each stage: both, then only Beta, then neither while the judge reads, then the pick. */
const busyAt = (stage: Stage, index: number) => stage === 0 || (stage === 1 && index === 1) || (stage === 2 && index === 2)

const withStage = (base: AppSnapshot, picked: AppSnapshot, stage: Stage): Partial<AppSnapshot> => {
  const source = stage === 3 ? picked : base
  const sessions = new Map([...picked.sessions].map(([key, session]): [SessionKey, Session] => {
    const index = SIDE_BY_SIDE_KEYS.indexOf(key)
    if (index < 0 || index > 2) return [key, session]
    const busy = busyAt(stage, index)
    const turn = {
      id: `${key}-race`, status: busy ? 'inProgress' : 'completed',
      items: [
        { id: `${key}-race-u`, type: 'userMessage', content: [{ type: 'text', text: index === 2 ? 'Pick the better attempt.' : BRIEF }] },
        ...(busy ? [] : [{ id: `${key}-race-a`, type: 'assistantMessage', phase: 'final', text: index === 2 ? VERDICT : ANSWERS[index] }]),
      ],
    }
    return [key, { ...session, status: { type: busy ? 'active' as const : 'idle' as const }, settings: { ...session.settings, model: MODELS[index]!.id },
      turns: [turn] as unknown as typeof session.turns } as Session]
  }))
  return { sessions, teams: source.teams, goals: source.goals, flowExecutions: source.flowExecutions, boardEvidence: source.boardEvidence }
}

const raceStore = (): Patchable => {
  const picked = comparisonVerdictStore('combined') as Patchable
  const before = comparisonVerdictStore('before').getSnapshot()
  const snapshot = picked.getSnapshot()
  const workbench = mountedViews(snapshot.workbench).reduce((current, { mounted }) => {
    const profile = mounted.view.kind === 'browser' ? mounted.view.profile : undefined
    return profile && profile in README_RACE_URLS ? replaceView(current, mounted.id, browserView(README_RACE_URLS[profile as keyof typeof README_RACE_URLS], profile)) : current
  }, snapshot.workbench)
  /* The Board's cards keep their recorded attempt titles; name them for this brief. */
  const named = (snap: AppSnapshot): Pick<AppSnapshot, 'teams' | 'goals'> => {
    const rename = <T extends { intents: readonly { id: number; title: string; note?: string | null }[]; name?: string }>(team: T): T => ({ ...team, name: 'Runner game race',
      intents: team.intents.map(card => card.id <= 2 ? { ...card, title: BRIEF.replace(/\.$/, '') }
        : card.id === 5 && card.note ? { ...card, note: VERDICT } : card) })
    return {
      teams: new Map([...snap.teams].map(([id, team]) => [id, rename(team)])),
      goals: new Map([...snap.goals].map(([id, goal]) => [id, { ...goal, board: goal.board ? rename(goal.board) : goal.board,
        goal: { ...goal.goal, sentence: 'Runner game race' } }])),
    }
  }
  const pickedNamed = { ...snapshot, ...named(snapshot) }
  /* "Before" is recorded without browsers; keep this Team's checkouts so each tile keeps its lane. */
  const beforeNamed = { ...before, ...named(before), goals: new Map([...named(before).goals].map(([id, goal]) => [id, { ...goal, members: pickedNamed.goals.get(id)?.members ?? goal.members }])) }
  const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' as const : 'light' as const
  picked.patch({ theme, runtimes: RUNTIMES, models: MODELS.map(model => ({ ...snapshot.models[0]!, ...model, description: '' })), workbench,
    ...withStage(beforeNamed, pickedNamed, 0) })
  const peers = picked.teamPeers.bind(picked)
  return Object.assign(picked, {
    teamPeers: async () => (await peers(PREVIEW_ROOM)).map((peer, index) => ({ ...peer, agent: RUNTIMES[index]!.name, model: MODELS[index]!.displayName })),
    stage: (stage: Stage) => picked.patch(withStage(beforeNamed, pickedNamed, stage)),
  })
}

/** Inside the race's own store, so the page needs no outer provider and `?theme` reaches the tiles. */
const Themed = ({ children }: { children: ReactNode }) => { useTheme(); return children }

export const ReadmeRace = () => {
  const store = useMemo(() => raceStore(), [])
  useEffect(() => {
    const receive = (event: Event) => (store as unknown as { stage: (stage: Stage) => void }).stage((event as CustomEvent<Stage>).detail)
    window.addEventListener('readme-race-stage', receive)
    return () => window.removeEventListener('readme-race-stage', receive)
  }, [store])
  const tiles = SIDE_BY_SIDE_KEYS.slice(0, 2)
  const view = { kind: 'room' as const, room: PREVIEW_ROOM, sideBySide: { tiles, focused: tiles[0], modes: Object.fromEntries(tiles.map(key => [key, 'browser' as const])) } }
  return <div data-readme-race className="h-screen bg-background text-foreground">
    <StoreProvider store={store}>
      <MountProvider scope={{ area: 'main', id: 'team-room', view }}>
        <KeyboardHereContext.Provider value={false}>
          <Themed><TeamFramePreview room={PREVIEW_ROOM} view={view} railOpen={false} /></Themed>
        </KeyboardHereContext.Provider>
      </MountProvider>
    </StoreProvider>
  </div>
}
