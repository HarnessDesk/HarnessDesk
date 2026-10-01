import type { LedgerReport, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import type { HeatMetric, HourMetric } from '../../lib/heat'
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
  heatDayMetric,
  onHeatDayMetricChange,
  heatHourMetric,
  onHeatHourMetricChange,
}: {
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  scope: RuntimeId | null
  now: number
  scanFinishedAt: number | null | undefined
  /** Shared with Overview so switching between the two views keeps the toggles and issues no new request — see `Usage.tsx`. */
  yearLedger: LedgerReport | null
  heatView: HeatView
  onHeatViewChange: (view: HeatView) => void
  heatDayMetric: HeatMetric
  onHeatDayMetricChange: (metric: HeatMetric) => void
  heatHourMetric: HourMetric
  onHeatHourMetricChange: (metric: HourMetric) => void
}) => (
  <UsageActivity
    byId={byId}
    scope={scope}
    now={now}
    scanFinishedAt={scanFinishedAt}
    report={yearLedger}
    view={heatView}
    onViewChange={onHeatViewChange}
    dayMetric={heatDayMetric}
    onDayMetricChange={onHeatDayMetricChange}
    hourMetric={heatHourMetric}
    onHourMetricChange={onHeatHourMetricChange}
  />
)
