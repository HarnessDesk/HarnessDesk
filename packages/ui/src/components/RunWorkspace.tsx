import { useLayoutEffect, useState, type ComponentProps } from 'react'
import { Menu, MenuItem } from '../design'
import { runSeatCosts } from '../lib/run-cost'
import { useRunDock } from '../panels/run-dock'
import { useTopBarView } from '../panels/top-bar'
import { usePane, useStore } from '../state/context'
import { RunInspector, type RunInspectorProps } from './RunInspector'
import { RunView, type RunViewTab } from './RunView'
import styles from './RunWorkspace.module.css'

type WorkspaceProps = ComponentProps<typeof RunView> & { inspector: Omit<RunInspectorProps, 'selectedRow'> }

/** A mounted Run publishes inspection; only an explicit row selection opens Details. */
export const RunWorkspace = ({ inspector, ...view }: WorkspaceProps) => {
  const store = useStore()
  const dock = useRunDock()
  const owner = usePane()?.paneId ?? ''
  const [kept, keep] = useState<RunViewTab>('timeline')
  const tab = view.flow ? view.view ?? kept : 'timeline'
  const selectView = (next: RunViewTab) => { if (view.view === undefined) keep(next); view.onView?.(next) }
  useTopBarView(owner, {
    verb: { label: 'Stop run…', disabled: view.stopRefusal ?? (inspector.input.execution.state !== 'running'
      ? 'This Run is not running' : !view.onStop ? 'Stopping this Run is unavailable here' : false), run: () => view.onStop?.() },
    view: view.unified ? undefined : { label: tab === 'flow' ? 'Flow' : 'Timeline', content: close => <Menu close={close}>
      <MenuItem label="Timeline" selected={tab === 'timeline'} onSelect={() => { selectView('timeline'); close() }} />
      <MenuItem label="Flow" selected={tab === 'flow'} disabled={!view.flow && 'The recorded Flow is unavailable'} onSelect={() => { selectView('flow'); close() }} />
    </Menu> },
  })
  useLayoutEffect(() => dock?.publish(owner, { inspector: { ...inspector, selectedRow: view.selectedRow, onSelect: view.onSelect, doing: view.doing } }),
    [dock, owner, inspector, view.selectedRow, view.onSelect, view.doing])
  const { summary } = runSeatCosts(inspector.input.execution, inspector.seats)
  return <div data-slot="run-workspace" data-view={view.unified ? 'work' : tab} className={styles.workspace}>
    <RunView {...view} execution={inspector.input.execution} cost={summary === null ? 'Cost not recorded' : `Seat cost ${summary}`}
      view={tab} onView={selectView} stepsInput={inspector.input} attemptsRead={inspector.attemptsRead} faceTints={inspector.faceTints}
      onSelect={id => { view.onSelect(id); if (owner) store.chooseWorkTool('details', 'run-details') }}
      onDetails={() => { view.onSelect('run'); if (owner) store.chooseWorkTool('details', 'run-details') }}
      timelineDetail={!owner && view.selectedRow ? <RunInspector {...inspector} onSelect={view.onSelect} doing={view.doing} selectedRow={view.selectedRow} /> : undefined} />
  </div>
}
