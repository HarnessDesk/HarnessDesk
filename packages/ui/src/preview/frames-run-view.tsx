import { useMemo, useState } from 'react'
import { RunView } from '../components/RunView'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { StoreProvider } from '../state/context'
import { RUN_VIEW_STATES, runModel, runTeamStore, type RunScene } from './run-view-fixture'

export const RunExample = ({ scene }: { scene: RunScene }) => {
  const [selected, setSelected] = useState<string | null>(null)
  return <RunView model={runModel(scene)} number={1} selectedRow={selected} onSelect={setSelected}
    doing={new Map([['seat-0', 'Editing src/checkout/retry.ts']])}
    pending={scene === 'pending'} problem={scene === 'failed' ? 'Check evidence is unavailable.' : null} />
}
export const RunViewBoard = () => <div className="flex flex-col gap-4">{RUN_VIEW_STATES.map(scene =>
  <section key={scene} data-catalog-state={scene} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunExample scene={scene} /></section>)}</div>
export const RunViewFrames = () => {
  const store = useMemo(runTeamStore, [])
  return <div className="flex flex-col gap-4 p-4">{RUN_VIEW_STATES.map(scene =>
    <section key={scene} id={`run-view-${scene}`} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunExample scene={scene} /></section>)}
    <section id="run-view-team" className="h-144"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
  </div>
}
