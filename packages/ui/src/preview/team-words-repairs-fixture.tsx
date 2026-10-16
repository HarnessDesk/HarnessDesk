import { createRoot } from 'react-dom/client'
import { encodeComparisonMerge } from '../lib/comparison-merge'
import { GoalWrap } from '../components/GoalWrap'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { StoreProvider, PaneProvider } from '../state/context'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { MountProvider } from '../panels/mount'
import { RunDockProvider } from '../panels/run-dock'
import { useTheme } from '../state/theme'
import { previewStore } from './harness'
import { teamWordsFixture } from './team-words-fixture'

/** Real person merge shape: durable handoff receipt, no synthetic review evidence. */
export const teamWordsRepairFixture = (chosen = 2) => {
  const original = teamWordsFixture()
  const previous = original.input.execution
  const execution = previous.document.format === 'agents' ? { ...previous, document: { ...previous.document,
    flow: { ...previous.document.flow, roles: previous.document.flow.roles.map(role => role.kind === 'person'
      ? { ...role, review: false, outcomes: ['merged'] } : role) },
  } } : previous
  const cards = original.input.cards.map(card => card.id === 6 ? { ...card, handoff: encodeComparisonMerge({
    version: 1, run: execution.id, card: chosen, revision: (chosen === 1 ? 'a' : 'b').repeat(40),
    commit: 'c'.repeat(40), branch: 'main', at: 1_800_000_000_000,
  }) } : card)
  const evidence = { ...original.input.evidence!, cards: original.input.evidence!.cards.filter(card => card.card !== 6) }
  const view = { ...original.view, board: { ...original.view.board, intents: cards } }
  const input = { ...original.input, execution, cards, evidence }
  const store = previewStore({ ...original.store.getSnapshot(), goals: new Map([[view.goal.id, view]]),
    teams: new Map([[view.board.id, view.board]]), boardEvidence: new Map([[view.board.id, evidence]]),
    flowExecutions: new Map([[execution.id, execution]]) })
  return { input, view, store }
}

/** Mount the production Overview caller as well as Wrap, on a synthetic desk. */
export const mountTeamWordsRepairPreview = (scene: 'overview' | 'wrap') => {
  const { view, store } = teamWordsRepairFixture()
  const node = document.createElement('div')
  document.getElementById('root')!.replaceChildren(node)
  const Theme = () => { useTheme(); return null }
  const scope = { area: 'main' as const, id: 'repair-preview', view: { kind: 'room' as const, room: view.goal.id } }
  createRoot(node).render(<StoreProvider store={store}><Theme />{scene === 'wrap'
    ? <GoalWrap view={view} onClose={() => {}} />
    : <TopBarProvider><RunDockProvider><MountProvider scope={scope}><PaneProvider scope={{ paneId: scope.id, view: scope.view, sessionKey: null }}>
      <TopBarOutlet owner={scope.id} fallback={{ place: view.goal.sentence, more: () => null }} />
      <TeamRoomPane room={view.goal.id} />
    </PaneProvider></MountProvider></RunDockProvider></TopBarProvider>}
  </StoreProvider>)
}
