import { useMemo, useState } from 'react'
import { RunFlow } from '../components/RunFlow'
import { RunView, type RunViewTab } from '../components/RunView'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { TeamRunView } from '../components/TeamRunView'
import { StoreProvider } from '../state/context'
import { RUN_VIEW_STATES, runFixture, runModel, runTeamStore, type RunScene } from './run-view-fixture'

/** One store for every example on a page: *Open the file* reads the catalogue through it, as the app does. */
let shared: ReturnType<typeof runTeamStore> | undefined
const sharedStore = () => (shared ??= runTeamStore())

export const RunExample = ({ scene }: { scene: RunScene }) => {
  const [selected, setSelected] = useState<string | null>(null)
  const execution = useMemo(() => runFixture(scene).execution, [scene])
  return <StoreProvider store={sharedStore()}><RunView model={runModel(scene)} number={1} selectedRow={selected} onSelect={setSelected}
    doing={new Map([['seat-0', 'Editing src/checkout/retry.ts']])}
    pending={scene === 'pending'} problem={scene === 'failed' ? 'Check evidence is unavailable.' : null}
    flow={<RunFlow execution={execution} root="/repo" seats={[]} />} /></StoreProvider>
}
/** The Run as the app mounts it: the timeline with the inspector beside it, and the Flow when it is chosen. */
export const RunWorkspaceExample = ({ scene = 'running', view: first = 'timeline' }: { scene?: RunScene; view?: RunViewTab }) => {
  const source = useMemo(() => runFixture(scene), [scene])
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<RunViewTab>(first)
  return <StoreProvider store={sharedStore()}><TeamRunView execution={source.execution} origin="Started by you" onOpenSeat={() => {}}
    model={runModel(scene)} number={1} selectedRow={selected} onSelect={setSelected}
    drawFlow view={view} onView={setView} /></StoreProvider>
}
export const RunViewBoard = () => <div className="flex flex-col gap-4">{RUN_VIEW_STATES.map(scene =>
  <section key={scene} data-catalog-state={scene} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunExample scene={scene} /></section>)}
  <section data-catalog-state="flow" className="flex h-144 flex-col"><RunWorkspaceExample view="flow" /></section></div>
export const RunViewFrames = () => {
  const store = useMemo(runTeamStore, [])
  return <div className="flex flex-col gap-4 p-4">{RUN_VIEW_STATES.map(scene =>
    <section key={scene} id={`run-view-${scene}`} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><RunExample scene={scene} /></section>)}
    <section id="run-view-flow" className="flex h-144 flex-col"><RunWorkspaceExample view="flow" /></section>
    <section id="run-view-team" className="h-144"><StoreProvider store={store}><TeamRoomPane room="overview-team" /></StoreProvider></section>
  </div>
}
