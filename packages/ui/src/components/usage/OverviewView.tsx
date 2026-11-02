import type { AppSnapshot } from '../../state/store'
import type { LedgerReport, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { prefsForUsage } from '../../lib/accounts'
import type { HeatMetric, HourMetric } from '../../lib/heat'
import { drawnReport, reportNeedsAttention, rightNow, type RunwaySummary } from '../../lib/usage'
import { Button, PageOptions, Text, Section, DashboardColumns, DashboardAccounts } from '../../design'
import { UsageActivity, type HeatView } from '../UsageActivity'
import { Card, PIVOTS, Ranked, Spend, type Pivot, type SilentAgent, type TintOf } from './shared'
import { OverviewStrip, stripChartMetric, type StripMetric } from './OverviewStrip'

/**
 * Overview: the whole story on one screen.
 *
 * Every reporting account's remaining limits, what it cost beside where it
 * went, and when it ran. Plans keeps the full table and expanded details.
 */
export const OverviewView = ({
  reports,
  byId,
  agentTints,
  snapshot,
  now,
  summary,
  silent,
  scope,
  onGoToPlans,
  onRefreshAccount,
  onStopTracking,
  ledger,
  wideLedger,
  range,
  mode,
  onModeChange,
  onScan,
  pivot,
  onPivotChange,
  yearLedger,
  heatView,
  onHeatViewChange,
  heatDayMetric,
  onHeatDayMetricChange,
  heatHourMetric,
  onHeatHourMetricChange,
  stripMetric,
  onStripMetricChange,
  onOpenPlan,
}: {
  reports: readonly UsageReport[]
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  agentTints: TintOf
  snapshot: Pick<AppSnapshot, 'accountsByRuntime' | 'accountPrefs' | 'scan'>
  now: number
  summary: RunwaySummary
  silent: readonly SilentAgent[]
  /** Followed by "When it ran", the way every other band on this screen already does. */
  scope: RuntimeId | null
  onGoToPlans: () => void
  onRefreshAccount: (runtime: RuntimeId) => void
  onStopTracking: (runtime: RuntimeId) => void
  ledger: LedgerReport | null
  wideLedger: LedgerReport | null
  range: number
  mode: 'bars' | 'line'
  onModeChange: (mode: 'bars' | 'line') => void
  onScan: () => void
  pivot: Pivot
  onPivotChange: (pivot: Pivot) => void
  /** "When it ran"'s own query and toggles, owned by `Usage.tsx` and shared with Activity — see `UsageActivity`. */
  yearLedger: LedgerReport | null
  heatView: HeatView
  onHeatViewChange: (view: HeatView) => void
  heatDayMetric: HeatMetric
  onHeatDayMetricChange: (metric: HeatMetric) => void
  heatHourMetric: HourMetric
  onHeatHourMetricChange: (metric: HourMetric) => void
  /** The strip's own chart toggle — see `OverviewStrip.tsx`. */
  stripMetric: StripMetric
  onStripMetricChange: (metric: StripMetric) => void
  /** "fee not set" / "Set plan prices" — the strip's own link into Settings › Agents. */
  onOpenPlan: (runtime: RuntimeId) => void
}) => {
  const scopedSilent = silent.filter((agent) => scope === null || scope === agent.info.id)
  // Limits can also arrive from a host meter for a runtime whose own
  // capabilities.metered is false. The report is the normalized answer;
  // neither a backend id nor the attention threshold decides membership.
  const remaining = reports.filter(report => {
    const drawn = drawnReport(report)
    return drawn.lanes.some(lane => !lane.placeholder) || drawn.credits != null || reportNeedsAttention(report, now)
  })
  // Which agent to start on, across every agent; scoped to one, there is no
  // choice to make and the page's own headline stands.
  const startOn = scope === null
    ? rightNow(reports, (report) => byId.get(report.runtime)?.presentation.name ?? 'Runtime', now)
    : null
  return (
    <>
      <OverviewStrip
        reports={reports}
        ledger={ledger}
        wideLedger={wideLedger}
        range={range}
        now={now}
        metric={stripMetric}
        onMetricChange={onStripMetricChange}
        onOpenPlan={onOpenPlan}
      />

      <Section level="heading" title="What is left" description={startOn ?? summary.headline ?? undefined}>
        {remaining.length > 0 ? (
          <DashboardAccounts accounts={remaining.map((report) => (
              <Card
                key={`${report.runtime}:${report.account ?? ''}`}
                report={report}
                info={byId.get(report.runtime) ?? null}
                preference={prefsForUsage(report.runtime, report.account, snapshot.accountsByRuntime, snapshot.accountPrefs)}
                now={now}
                onRefresh={() => onRefreshAccount(report.runtime)}
                onStopTracking={() => onStopTracking(report.runtime)}
              />
            ))} />
        ) : <Text role="muted">No limits reported yet.</Text>}
        <>
          <Button variant="link" size="content" onClick={onGoToPlans}>
            See all in Plans
          </Button>
          {summary.metered > 0 && scopedSilent.length > 0 && (
            <Text role="meta">
              {scopedSilent.length} {scopedSilent.length === 1 ? 'runtime doesn’t' : 'runtimes don’t'} report usage
            </Text>
          )}
        </>
      </Section>

      <DashboardColumns primary={
          <Spend
            ledger={ledger}
            wideLedger={wideLedger}
            byId={byId}
            tintOf={agentTints}
            scan={snapshot.scan}
            now={now}
            range={range}
            mode={mode}
            onModeChange={onModeChange}
            onScan={onScan}
            metric={stripChartMetric(stripMetric)}
          />
        } secondary={<Section level="heading" title="Where it went" action={
              <PageOptions choices={[{id:'pivot',label:'Group spend by',value:pivot,items:PIVOTS,change:next=>onPivotChange(next as Pivot)}]} />
            }>
          <Ranked
            ledger={ledger}
            wideLedger={wideLedger}
            pivot={pivot}
            range={range}
            now={now}
            byId={byId}
            tintOf={agentTints}
            compact
          />
        </Section>} />

      <UsageActivity
        byId={byId}
        scope={scope}
        now={now}
        scanFinishedAt={snapshot.scan?.finishedAt}
        report={yearLedger}
        view={heatView}
        onViewChange={onHeatViewChange}
        dayMetric={heatDayMetric}
        onDayMetricChange={onHeatDayMetricChange}
        hourMetric={heatHourMetric}
        onHourMetricChange={onHeatHourMetricChange}
      />
    </>
  )
}
