import { useRunDock } from '../panels/run-dock'
import { usePane, useSnapshotSelector, useStore } from '../state/context'
import { dockViews, rightPanelOverlays, stacks } from '../state/workbench'
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
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
  const lifecycle = useRef(0)
  const producer = useRef({})
  const show = (kind: 'run-details' | 'run-steps', allowOverlay = false) => {
    const workbench = store.getSnapshot().workbench
    const area = (['right', 'bottom', 'sidebar'] as const).find(area => dockViews(workbench[area]).some(one => one.view.kind === kind)) ?? 'right'
    store.showViewIn(area, { kind })
    const after = store.getSnapshot()
    if (!allowOverlay && area === 'right' && rightPanelOverlays(after.workbench, after.windowWidth)) store.togglePanel('right')
  }
  useLayoutEffect(() => {
    if (!focused) return
    const before = store.getSnapshot().workbench
    const areas = ['right', 'bottom', 'sidebar'] as const
    const entries = areas.flatMap(area => dockViews(before[area]))
    const hasRunView = entries.some(one => one.view.kind === 'run-details' || one.view.kind === 'run-steps')
    if (hasRunView) {
      const area = areas.find(one => dockViews(before[one]).some(entry => entry.view.kind === 'run-details' || entry.view.kind === 'run-steps'))!
      const active = stacks(before[area].root).flatMap(stack => stack.active ? [stack.active] : [])
      const collapsed = before[area].collapsed
      const collapsedOnLeave = dock.takeCollapsedOnLeave(owner)
      for (const kind of ['run-details', 'run-steps'] as const) {
        if (!entries.some(one => one.view.kind === kind)) store.showViewIn(area, { kind })
      }
      for (const id of active) store.activateView(area, id)
      const nowCollapsed = store.getSnapshot().workbench[area].collapsed
      if (collapsedOnLeave ? nowCollapsed : collapsed !== nowCollapsed) store.togglePanel(area)
    } else {
      const active = stacks(before.right.root).flatMap(stack => stack.active ? [stack.active] : [])[0]
      dock.rememberReturnTab(owner, active ? { area: 'right', id: active } : null)
      for (const kind of ['run-details', 'run-steps'] as const) store.showViewIn('right', { kind })
      show(tab === 'flow' ? 'run-steps' : 'run-details')
    }
  }, [store, inspector.input.execution.id, focused])
  useLayoutEffect(() => {
    const generation = ++lifecycle.current
    return () => queueMicrotask(() => {
      // StrictMode replays effect cleanup/setup without leaving this Run. Let
      // that setup invalidate its queued cleanup before it can collapse a dock.
      if (lifecycle.current !== generation || (owner && store.getSnapshot().workbench.main.focused !== owner) ||
        (dock.getSnapshot().has(owner) && !dock.isPublishedBy(owner, producer.current))) return
      const workbench = store.getSnapshot().workbench
      for (const area of ['right', 'bottom', 'sidebar'] as const) {
        const entries = dockViews(workbench[area])
        const runEntries = entries.filter(one => one.view.kind === 'run-details' || one.view.kind === 'run-steps')
        if (runEntries.length === 0) continue
        const hasOtherViews = entries.some(one => one.view.kind !== 'run-details' && one.view.kind !== 'run-steps')
        if (hasOtherViews) {
          const remembered = dock.getReturnTab(owner)
          const current = stacks(workbench[area].root).flatMap(stack => stack.active ? [stack.active] : [])
            .find(id => entries.some(one => one.id === id && one.view.kind !== 'run-details' && one.view.kind !== 'run-steps'))
          const restore = remembered?.area === area && entries.some(one => one.id === remembered.id && one.view.kind !== 'run-details' && one.view.kind !== 'run-steps')
            ? remembered.id
            : current
          for (const entry of runEntries) store.closeView(entry.id)
          if (restore) store.activateView(area, restore)
          dock.clearReturnTab(owner)
          continue
        }
        if (!workbench[area].collapsed) {
          store.togglePanel(area)
          dock.markCollapsedOnLeave(owner)
        }
      }
    })
  }, [store, dock, owner])
  useLayoutEffect(() => dock.publish(owner, {
    inspector: { ...inspector, selectedRow: view.selectedRow },
    steps: { input: inspector.input, attemptsRead: inspector.attemptsRead, selectedRow: view.selectedRow, faces: view.faces, faceTints: inspector.faceTints,
      selectedStep: view.selectedRow?.startsWith('step:') ? view.selectedRow.slice(5) : null,
      onSelect: view.onSelect, onSelectStep: id => view.onSelect(`step:${id}`) },
  }, producer.current), [dock, owner, inspector, view.selectedRow, view.faces, view.onSelect])
  return <div data-slot="run-workspace" className="flex min-h-0 min-w-0 flex-1">
    <RunView {...view} view={tab} onDetails={() => { view.onSelect('run'); show('run-details', true) }}
      onView={next => { if (view.view === undefined) keep(next); view.onView?.(next); show(next === 'flow' ? 'run-steps' : 'run-details') }}
      onSelect={id => { view.onSelect(id); show('run-details', true) }} />
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
