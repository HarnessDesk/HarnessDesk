import { useState, type ComponentProps } from 'react'
import { DashboardPage } from '../components/Usage'
import { DestinationPageScope } from '../panels/destination-page'
export const DashboardTestPage = (props: Partial<ComponentProps<typeof DashboardPage>>) => {
  const [view,onView]=useState<'overview'|'plans'|'spend'|'activity'|'projects'>('overview')
  const [scope,onScope]=useState<ComponentProps<typeof DashboardPage>['scope']>(null)
  return <DestinationPageScope owner="destination:dashboard" active><DashboardPage view={view} onView={onView} scope={scope} onScope={onScope} {...props}/></DestinationPageScope>
}
