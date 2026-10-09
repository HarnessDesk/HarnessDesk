import type { InsightReport, RuntimeId } from '@harnessdesk/protocol'

import { Button, Segmented, Text } from '../../design'
import { InsightUsage } from '../InsightUsage'
import { BandHead } from './shared'
import styles from './usage.module.css'

const INSIGHT_OPTIONS = [
  { value: 'goal', label: 'By Team' },
  { value: 'agent', label: 'By Agent' },
] as const

/** Project accounting by Goal or Agent, with its own 30-day or 24-hour accounting range. */
export const ProjectsView = ({
  root,
  scope,
  insightView,
  onInsightViewChange,
  onGoal,
  insightReport,
  insightProblem,
  rangeDays,
  onRangeChange,
}: {
  root: string | null
  scope: RuntimeId | null
  insightView: 'goal' | 'agent'
  onInsightViewChange: (view: 'goal' | 'agent') => void
  onGoal: (goal: string) => void
  /** Loaded once per scope/root by `Usage.tsx` — see `InsightUsage`. */
  insightReport: InsightReport | null
  insightProblem: string | null
  rangeDays: number
  onRangeChange: (days: number) => void
}) => (
  <section className={styles.band} aria-label="Project usage">
    <BandHead
      name="Project usage"
      action={
        <div className="flex flex-wrap items-center gap-(--hd-space-2)">
          <Text role="meta">{rangeDays === 1 ? 'Last 24 hours' : 'Last 30 days'}</Text>
          {rangeDays === 1 && <Button variant="outline" size="sm" onClick={() => onRangeChange(30)}>Last 30 days</Button>}
        <Segmented
          label="Project usage view"
          options={INSIGHT_OPTIONS}
          value={insightView}
          onChange={(next) => onInsightViewChange(next as 'goal' | 'agent')}
        />
        </div>
      }
    />
    <InsightUsage root={root} runtime={scope} view={insightView} onGoal={onGoal} report={insightReport} problem={insightProblem} rangeDays={rangeDays} onShorterRange={rangeDays === 1 ? undefined : () => onRangeChange(1)} />
  </section>
)
