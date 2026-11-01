import type { DashboardView } from '../components/Usage'
import { Tabs, TabsList, TabsTrigger, Text } from '../design'
import { DestinationBar } from './destination-page'
const labels: Record<DashboardView, string> = {
  overview: 'Overview', plans: 'Plans', spend: 'Spend', activity: 'Activity', projects: 'Projects',
}
export const DashboardBar = ({ view, attention, changeView }: {
  readonly view: DashboardView; readonly attention: number; readonly changeView: (view: DashboardView) => void
}) => <>
  <DestinationBar place="Dashboard" />
  <Tabs value={view} onValueChange={value => changeView(value as DashboardView)}>
    <TabsList aria-label="Dashboard views" data-look="quiet">
      {(Object.keys(labels) as DashboardView[]).map(value => <TabsTrigger key={value} value={value}
        count={value === 'plans' && attention > 0 ? <Text role="meta" tone="warning">{attention} low</Text> : undefined}>{labels[value]}</TabsTrigger>)}
    </TabsList>
  </Tabs>
</>
