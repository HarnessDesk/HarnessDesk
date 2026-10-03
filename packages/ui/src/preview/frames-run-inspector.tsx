import { useMemo, useState } from 'react'
import { TeamRunView } from '../components/TeamRunView'
import { StoreProvider } from '../state/context'
import { RunWorkspace } from '../components/RunWorkspace'
import { runTimeline } from '../lib/run-timeline'
import { runFixture, runTeamStore } from './run-view-fixture'

export const RUN_INSPECTOR_STATES = ['run', 'card', 'check', 'person', 'findings', 'empty', 'pending', 'failed', 'narrow'] as const
export type InspectorScene = typeof RUN_INSPECTOR_STATES[number]
export const RunInspectorExample = ({ scene }: { scene: InspectorScene }) => {
  const source = runFixture(scene === 'person' ? 'person' : scene === 'empty' ? 'empty' : 'running')
  const input = { ...source, execution: { ...source.execution, base: { remote: 'origin', branch: 'main', at: 'abc123' } },
    cards: source.cards.map(card => ({ ...card, detail: 'Keep the retry bounded and the last failure visible.', handoff: card.id === 1 ? 'Added three attempts with a bounded backoff. The checkout test covers the last failure.' : card.id === 3 ? 'The retry loop needs a ceiling. Keep the last failure visible to the person.' : null, dependsOn: card.id === 3 ? [1] : [] })) }
  const initial = scene === 'card' ? 'card-3-3' : scene === 'check' ? 'check-2-2' : scene === 'person' ? 'person-4-4' : scene === 'findings' ? 'findings-3' : null
  const [selected, setSelected] = useState<string | null>(initial)
  return <RunWorkspace model={runTimeline(input)} number={1} selectedRow={selected} onSelect={setSelected}
    pending={scene === 'pending'} problem={scene === 'failed' ? 'Review details could not be read.' : null}
    inspector={{ input, publication: { round: 3, state: 'local', reason: 'Posting is off for this Team.', pr: null, cards: [3] },
      seats: [{ id: 'seat-0', name: 'Alpha', override: 'Balanced · Medium', cost: { unit: 'turns', value: 4, estimated: false }, onOpen: () => {} }, { id: 'seat-1', name: 'Beta', override: 'Careful · High', cost: { unit: 'money', value: 0.42, estimated: true }, onOpen: () => {} }],
    }} />
}
const RunInspectorTeamExample = () => {
  const store = useMemo(runTeamStore, [])
  const fixture = runFixture('complete')
  const [selected, setSelected] = useState<string | null>(null)
  return <StoreProvider store={store}><TeamRunView execution={fixture.execution} origin="Started by you" onOpenSeat={() => {}}
    model={runTimeline(fixture)} number={1} selectedRow={selected} onSelect={setSelected} /></StoreProvider>
}
export const RunInspectorBoard = () => <div className="flex flex-col gap-4">{RUN_INSPECTOR_STATES.map(scene =>
  <section key={scene} data-catalog-state={scene} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunInspectorExample scene={scene} /></section>)}<section data-catalog-state="team" className="flex h-144 flex-col"><RunInspectorTeamExample /></section></div>
export const RunInspectorFrames = () => <div className="flex flex-col gap-4 p-4">{RUN_INSPECTOR_STATES.map(scene =>
  <section key={scene} id={`run-inspector-${scene}`} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunInspectorExample scene={scene} /></section>)}<section id="run-inspector-team" className="flex h-144 flex-col"><RunInspectorTeamExample /></section></div>
