import type { InsightReport, RuntimeId } from '@harnessdesk/protocol'

import { folderName } from '../../lib/projects'
import { PageOptions, Section } from '../../design'
import { InsightUsage } from '../InsightUsage'

const INSIGHT_OPTIONS = [
  { value: 'goal', label: 'By team' },
  { value: 'agent', label: 'By agent' },
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
  <Section title={`${insightView === 'goal' ? 'Team' : 'Agent'} usage${root ? ` in ${folderName(root)}` : ''}`} action={<PageOptions choices={[
    {id:'range',label:'Project usage range',value:String(rangeDays),items:[{value:'1',label:'Last 24 hours'},{value:'30',label:'Last 30 days'}],change:value=>onRangeChange(Number(value))},
    {id:'view',label:'Project usage view',value:insightView,items:INSIGHT_OPTIONS,change:value=>onInsightViewChange(value as 'goal' | 'agent')},
  ]} />}>
    <InsightUsage root={root} runtime={scope} view={insightView} onGoal={onGoal} report={insightReport} problem={insightProblem} rangeDays={rangeDays} onShorterRange={rangeDays === 1 ? undefined : () => onRangeChange(1)} />
  </Section>
)
