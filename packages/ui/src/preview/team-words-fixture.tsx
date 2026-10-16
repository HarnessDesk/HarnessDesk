import { createRoot } from 'react-dom/client'
import { type AgentItem, type GoalView, type Turn, turnId, runtimeId, sessionId, sessionKey } from '@harnessdesk/protocol'
import { GoalWrap } from '../components/GoalWrap'
import { TeamOverview } from '../components/TeamOverview'
import { TurnWork } from '../components/TurnWork'
import { ItemView } from '../components/Items'
import { RoomComposer } from '../components/RoomComposer'
import { teamOverview } from '../lib/team-overview'
import { runTimeline } from '../lib/run-timeline'
import { useTheme } from '../state/theme'
import { StoreProvider } from '../state/context'
import { shapeFixture } from './run-shapes-fixture'
import { PREVIEW_GOAL } from './goal-fixture'
import { previewStore } from './harness'

/** Completed comparison with identical attempt titles and an observed merge. */
export const teamWordsFixture = () => {
  const input = shapeFixture('comparison', 2)
  input.execution = { ...input.execution, state: 'settled', rounds: input.execution.rounds.map(round => ({ ...round, state: 'closed' })) }
  if (input.execution.document.format === 'agents') input.execution = { ...input.execution, document: { ...input.execution.document, flow: { ...input.execution.document.flow, roles: input.execution.document.flow.roles.map(role => role.kind === 'person' ? { ...role, review: true } : role) } } }
  const cards = input.cards.map(card => ({ ...card, title: card.id < 3 ? 'Improve the session store' : card.title, state: 'done' as const, outcome: card.id === 6 ? 'merged' : card.outcome }))
  input.cards = cards
  const evidence = { ...input.evidence!, cards: [...input.evidence!.cards, { card: 6, running: [], facts: [{ freshness: { state: 'fresh' as const }, by: null, record: { id: 'merged', observedAt: 1_800_000_000_000, round: 4, card: { board: input.execution.goal, id: 6 }, fact: { kind: 'review' as const, at: 'a'.repeat(40), verdict: 'merged', by: 'person' as never }, checkout: { cwd: '/repo/attempt-0', branch: 'attempt-a' } } }] }] }
  input.evidence = evidence
  const view: GoalView = { ...PREVIEW_GOAL, goal: { ...PREVIEW_GOAL.goal, id: input.execution.goal, sentence: 'Improve the session store', state: 'open', origin: { kind: 'flow', run: input.execution.id } }, board: { ...PREVIEW_GOAL.board, id: input.execution.goal, name: 'Improve the session store', messaging: false, intents: cards }, activity: 'ready-to-wrap', members: [] }
  const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
  const store = previewStore({ theme, goals: new Map([[view.goal.id, view]]), teams: new Map([[view.board.id, view.board]]), flowExecutions: new Map([[input.execution.id, input.execution]]), boardEvidence: new Map([[view.board.id, evidence]]) })
  const model = teamOverview({ team: view.goal.id, seats: [], cards, run: { execution: input.execution, startedAt: null }, report: null })
  return { input, view, store, model }
}

/** Mounted by the headless preview spec so the shared preview router stays untouched. */
export const mountTeamWordsPreview = (scene: 'run' | 'wrap') => {
  const { input, view, store, model } = teamWordsFixture()
  const failed = { id: 'test', type: 'command', command: 'pnpm test', cwd: '/repo', origin: 'agent', actions: [], status: 'failed', exitCode: 1, output: 'First run failed; fixed before committing.' } as unknown as AgentItem
  const turn: Turn = { id: turnId('attempt'), status: 'completed', durationMs: 42_000, items: [failed] }
  const node = document.createElement('div')
  document.getElementById('root')!.replaceChildren(node)
  const Theme = () => { useTheme(); return null }
  const peer = { runtime: runtimeId('codex'), sessionId: sessionId('attempt-a'), nickname: 'Writer', title: 'Improve the session store', agent: store.getSnapshot().runtimes[0]!.presentation.name, busy: false, here: true, inbound: 'accept' as const }
  const members = [{ key: sessionKey(peer.runtime, peer.sessionId), peer, brand: null, busy: false, canUseBoard: true, title: peer.title }]
  createRoot(node).render(<StoreProvider store={store}><Theme />{scene === 'wrap' ? <GoalWrap view={view} onClose={() => {}} /> : <div className="mx-auto max-w-3xl p-6" data-team-words>
    <TeamOverview model={model} timeline={runTimeline(input)} runName="Side by side" />
    <TurnWork turn={turn} work={turn.items} root="/repo" />
    <p>Verdict: committed</p>
    {['claim_work', 'check_conflicts'].map(tool => <ItemView key={tool} item={{ id: tool, type: 'toolCall', tool, source: { kind: 'mcp', server: 'harnessdesk' }, args: {}, status: 'completed' } as AgentItem} root="/repo" />)}
    <RoomComposer room={view.goal.id} members={members} messaging={false} onMessaging={async () => {}} onTrouble={() => {}} onPosted={() => {}} />
  </div>}</StoreProvider>)
}
