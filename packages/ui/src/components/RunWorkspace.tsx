import { useRunDock } from '../panels/run-dock'
import { usePane, useSnapshotSelector, useStore } from '../state/context'
import { dockViews } from '../state/workbench'
import { useLayoutEffect, useState, type ComponentProps } from 'react'
import { BackLink } from '../design'
import { RunInspector, type RunInspectorProps } from './RunInspector'
import { RunView, type RunViewTab } from './RunView'
import styles from './RunWorkspace.module.css'

type WorkspaceProps = ComponentProps<typeof RunView> & { inspector: Omit<RunInspectorProps, 'selectedRow'> }

const DockedRunWorkspace = ({ inspector, ...view }: WorkspaceProps) => {
  const store = useStore()
  const dock = useRunDock()!
  const owner = usePane()?.paneId ?? ''
  const focused = useSnapshotSelector(snapshot => !owner || snapshot.workbench.main.focused === owner)
  const [kept, keep] = useState<RunViewTab>('timeline')
  const tab = view.flow ? view.view ?? kept : 'timeline'
  const show = (kind: 'run-details' | 'run-steps') => {
    const workbench = store.getSnapshot().workbench
    const area = (['right', 'bottom', 'sidebar'] as const).find(area => dockViews(workbench[area]).some(one => one.view.kind === kind)) ?? 'right'
    store.showViewIn(area, { kind })
  }
  useLayoutEffect(() => {
    if (!focused) return
    const before = store.getSnapshot().workbench
    const entries = (['right', 'bottom', 'sidebar'] as const).flatMap(area => dockViews(before[area]))
    for (const kind of ['run-details', 'run-steps'] as const) {
      if (!entries.some(one => one.view.kind === kind)) store.showViewIn('right', { kind })
    }
    if (!entries.some(one => one.view.kind === 'run-details' || one.view.kind === 'run-steps')) {
      show(tab === 'flow' ? 'run-steps' : 'run-details')
      if (store.getSnapshot().windowWidth < 720) store.togglePanel('right')
    }
  }, [store, inspector.input.execution.id, focused])
  useLayoutEffect(() => dock.publish(owner, {
    inspector: { ...inspector, selectedRow: view.selectedRow },
    steps: { input: inspector.input, selectedRow: view.selectedRow, faces: view.faces,
      selectedStep: view.selectedRow?.startsWith('step:') ? view.selectedRow.slice(5) : null,
      onSelect: view.onSelect, onSelectStep: id => view.onSelect(`step:${id}`) },
  }), [dock, owner, inspector, view.selectedRow, view.faces, view.onSelect])
  return <div data-slot="run-workspace" className="flex min-h-0 min-w-0 flex-1">
    <RunView {...view} view={tab} onDetails={() => { view.onSelect('run'); show('run-details') }}
      onView={next => { if (view.view === undefined) keep(next); view.onView?.(next); show(next === 'flow' ? 'run-steps' : 'run-details') }}
      onSelect={id => { view.onSelect(id); show('run-details') }} />
  </div>
}

/** Standalone catalogue examples have no workbench; their existing responsive frame stays local to the rig. */
export const RunWorkspace = ({ inspector, ...view }: WorkspaceProps) => {
  const dock = useRunDock()
  const [detail, setDetail] = useState(false)
  const [kept, keep] = useState<RunViewTab>('timeline')
  // The Flow is a drawing of the whole Run, so it has the pane to itself: the inspector explains a row of
  // the timeline, and on the Flow tab there is no row on show. A caller that chooses the tab is followed.
  const tab: RunViewTab = view.flow ? view.view ?? kept : 'timeline'
  // In the app, inspectors are sibling views owned by the workbench.
  if (dock) return <DockedRunWorkspace {...view} inspector={inspector} />
  const timeline = tab === 'timeline'
  return <div data-slot="run-workspace" data-detail={(detail && timeline) || undefined} className={styles.workspace}>
    <div className={styles.timeline}>
      <RunView {...view} onDetails={() => { view.onSelect('run'); setDetail(true) }} view={tab} onView={next => { if (view.view === undefined) keep(next); view.onView?.(next) }}
        onSelect={id => { view.onSelect(id); setDetail(true) }} />
    </div>
    {timeline && <div className={styles.detail}>
      <div className={styles.back}><BackLink to="Run timeline" onClick={() => setDetail(false)} /></div>
      <RunInspector {...inspector} selectedRow={view.selectedRow} />
    </div>}
  </div>
}
