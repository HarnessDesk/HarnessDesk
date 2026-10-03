import { useState, type ComponentProps } from 'react'
import { BackLink, Button } from '../design'
import { RunInspector, type RunInspectorProps } from './RunInspector'
import { RunView } from './RunView'
import styles from './RunWorkspace.module.css'

/** Responsive geometry belongs to the containing pane, not the window. */
export const RunWorkspace = ({ inspector, ...view }: ComponentProps<typeof RunView> & { inspector: Omit<RunInspectorProps, 'selectedRow'> }) => {
  const [detail, setDetail] = useState(false)
  return <div data-slot="run-workspace" data-detail={detail || undefined} className={styles.workspace}>
    <div className={styles.timeline}>
      <div className={styles.summary}><Button variant="link" size="inline-link" onClick={() => { view.onSelect('run'); setDetail(true) }}>Run details</Button></div>
      <RunView {...view} onSelect={id => { view.onSelect(id); setDetail(true) }} />
    </div>
    <div className={styles.detail}>
      <div className={styles.back}><BackLink to="Run timeline" onClick={() => setDetail(false)} /></div>
      <RunInspector {...inspector} selectedRow={view.selectedRow} />
    </div>
  </div>
}
