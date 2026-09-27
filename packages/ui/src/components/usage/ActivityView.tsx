import type { LedgerReport, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import type { HeatMetric } from '../../lib/heat'
import { UsageActivity, type HeatView } from '../UsageActivity'

/** Activity: when it ran, full width — the heatmap alone, scoped like every other view. */
export const ActivityView = ({
  byId,
  scope,
  now,
  scanFinishedAt,
  yearLedger,
  heatView,
  onHeatViewChange,
  heatMetric,
  onHeatMetricChange,
}: {
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  scope: RuntimeId | null
  now: number
  scanFinishedAt: number | null | undefined
  /** Shared with Overview so switching between the two views keeps the toggles and issues no new request — see `Usage.tsx`. */
  yearLedger: LedgerReport | null
  heatView: HeatView
  onHeatViewChange: (view: HeatView) => void
  heatMetric: HeatMetric
  onHeatMetricChange: (metric: HeatMetric) => void
}) => (
  <UsageActivity
    byId={byId}
    scope={scope}
    now={now}
    scanFinishedAt={scanFinishedAt}
    report={yearLedger}
    view={heatView}
    onViewChange={onHeatViewChange}
    metric={heatMetric}
    onMetricChange={onHeatMetricChange}
  />
)
