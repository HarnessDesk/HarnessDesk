import { useMemo } from 'react'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { TeamFramePreview } from './TeamFramePreview'
import { overviewInput, overviewTeamStore } from './team-overview-fixture'
import { cardEvidence, checkView } from './evidence-fixture'
import '../panels/builtins'

/** The finished Team from #1674, with three synthetic completed jobs. */
export const FinishedBoardFrames = () => {
  useTheme()
  const store = useMemo(() => {
    const own = overviewTeamStore('done')
    const snapshot = own.getSnapshot()
    const room = 'overview-team'
    const intents = new URLSearchParams(location.search).has('empty') ? [] : overviewInput('done').cards
    const board = { ...snapshot.teams.get(room)!, intents }
    const goal = snapshot.goals.get(room)!
    Object.assign(snapshot, {
      teams: new Map(snapshot.teams).set(room, board),
      goals: new Map(snapshot.goals).set(room, { ...goal, board }),
      boardEvidence: new Map(snapshot.boardEvidence).set(room, { room, stamp: 1, checks: [], refused: [], unreadable: null,
        cards: intents.map(one => cardEvidence(one.id, [checkView({ card: one.id })])) }),
    })
    return own
  }, [])
  return <div data-frame-id="finished-board" className="h-screen bg-background text-foreground"><StoreProvider store={store}>
    <TeamFramePreview room="overview-team" view={{ kind: 'room', room: 'overview-team', framePage: 'board' }} railOpen={false} />
  </StoreProvider></div>
}
