import { useState, type ComponentProps } from 'react'
import { BackLink } from '../design'
import { RunInspector, type RunInspectorProps } from './RunInspector'
import { RunView, type RunViewTab } from './RunView'
import styles from './RunWorkspace.module.css'

/** Responsive geometry belongs to the containing pane, not the window. */
export const RunWorkspace = ({ inspector, ...view }: ComponentProps<typeof RunView> & { inspector: Omit<RunInspectorProps, 'selectedRow'> }) => {
  const [detail, setDetail] = useState(false)
  const [kept, keep] = useState<RunViewTab>('timeline')
  // The Flow is a drawing of the whole Run, so it has the pane to itself: the inspector explains a row of
  // the timeline, and on the Flow tab there is no row on show. A caller that chooses the tab is followed.
  const tab: RunViewTab = view.flow ? view.view ?? kept : 'timeline'
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
