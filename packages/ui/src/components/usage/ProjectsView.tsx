import type { RuntimeId } from '@harnessdesk/protocol'

import { Segmented } from '../../design'
import { InsightUsage } from '../InsightUsage'
import { BandHead } from './shared'
import styles from '../Usage.module.css'

const INSIGHT_OPTIONS = [
  { value: 'goal', label: 'By Goal' },
  { value: 'agent', label: 'By Agent' },
] as const

/** Projects: project usage, by goal or by agent — unchanged from today. */
export const ProjectsView = ({
  root,
  scope,
  insightView,
  onInsightViewChange,
  onGoal,
}: {
  root: string | null
  scope: RuntimeId | null
  insightView: 'goal' | 'agent'
  onInsightViewChange: (view: 'goal' | 'agent') => void
  onGoal: (goal: string) => void
}) => (
  <section className={styles.band} aria-label="Project usage">
    <BandHead
      name="Project usage"
      action={
        <Segmented
          label="Project usage view"
          options={INSIGHT_OPTIONS}
          value={insightView}
          onChange={(next) => onInsightViewChange(next as 'goal' | 'agent')}
        />
      }
    />
    <InsightUsage root={root} runtime={scope} view={insightView} onGoal={onGoal} />
  </section>
)
