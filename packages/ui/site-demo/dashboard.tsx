import { memo, useMemo, useState } from 'react'
import { PlansView } from '../src/components/usage/PlansView'
import { ActivityView } from '../src/components/usage/ActivityView'
import { RANGES, Spend, tintsForRoster, type Pivot } from '../src/components/usage/shared'
import type { HeatView } from '../src/components/UsageActivity'
import type { HeatMetric, HourMetric } from '../src/lib/heat'
import { byUrgency, runway } from '../src/lib/usage'
import { SITE_NOW } from '../src/preview/site-stills-data'
import { sceneUsage, siteSceneLedger, sceneRuntime, sceneRuntimeInfo } from '../src/preview/site-scene-data'
import { previewStore } from '../src/preview/harness'
import { PaneColumn, Segmented } from '../src/design'
import type { LedgerReport } from '@harnessdesk/protocol'

export type DashboardStage = 'limits' | 'spend' | 'agents' | 'year'

/** Reuse the camera's synthetic year on the visitor's local calendar. */
export const dashboardData = (now = Date.now()) => {
  const delta = now - SITE_NOW
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const civilDay = (day: number) => {
    const date = new Date(day)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  }
  const snapDay = (day: number) => {
    const date = new Date(today)
    date.setDate(date.getDate() - Math.round((civilDay(SITE_NOW) - civilDay(day)) / 86_400_000))
    return date.getTime()
  }
  const usage = sceneUsage.map(report => ({ ...report, fetchedAt: report.fetchedAt + delta,
    lanes: report.lanes.map(lane => ({ ...lane, resetsAt: lane.resetsAt === null ? null : lane.resetsAt + delta })),
  }))
  const base = previewStore().getSnapshot()
  const runtimes = base.runtimes.filter(info => usage.some(report => report.runtime === sceneRuntime(info.id))).map(sceneRuntimeInfo)
  const accountsByRuntime = Object.fromEntries(runtimes.map(info => [info.id, {
    ...base.accountsByRuntime[info.id], signInMethods: [],
    accounts: usage.filter(report => report.runtime === info.id).map(report => ({ kind: 'oauth' as const, label: report.account!, email: report.account! })),
  }]))
  const store = previewStore({ ...base, runtimes, usage, accountsByRuntime })
  const ledgers = new Map<string, LedgerReport>()
  const ledger = (days: number, groupBy: Pivot): LedgerReport => {
    const key = `${days}:${groupBy}`
    const cached = ledgers.get(key)
    if (cached) return cached
    const report = siteSceneLedger(days, groupBy)
    const snapped = { ...report, scannedAt: report.scannedAt === null ? null : report.scannedAt + delta,
      daily: report.daily.map(day => ({ ...day, day: snapDay(day.day) })),
      coverage: { ...report.coverage, earliestDay: report.coverage.earliestDay == null ? report.coverage.earliestDay : snapDay(report.coverage.earliestDay) },
    }
    ledgers.set(key, snapped)
    return snapped
  }
  return { store, ledger, now }
}

/** The shipping Dashboard's bands, without its window shell or navigation rail. */
export const DashboardScene = memo(({ stage, data }: { stage: DashboardStage; data: ReturnType<typeof dashboardData> }) => {
  const snapshot = data.store.getSnapshot()
  const byId = useMemo(() => new Map(snapshot.runtimes.map(info => [info.id, info])), [snapshot.runtimes])
  const tints = useMemo(() => tintsForRoster(snapshot.runtimes), [snapshot.runtimes])
  const reports = useMemo(() => byUrgency(snapshot.usage), [snapshot.usage])
  const summary = useMemo(() => runway(reports, report => byId.get(report.runtime)!.presentation.name, data.now), [reports, byId, data.now])
  const [range, setRange] = useState(30)
  const [mode, setMode] = useState<'bars' | 'line'>('bars')
  const [heatView, setHeatView] = useState<HeatView>('year')
  const [dayMetric, setDayMetric] = useState<HeatMetric>('tokens')
  const [hourMetric, setHourMetric] = useState<HourMetric>('tokens')
  const ledger = useMemo(() => data.ledger(range, 'runtime'), [data, range])
  const wideLedger = useMemo(() => data.ledger(Math.min(365, range * 2), 'runtime'), [data, range])
  const yearLedger = useMemo(() => data.ledger(365, 'runtime'), [data])
  return <PaneColumn inset="reading" page className="site-dashboard" data-scene-stage={stage}>
    {stage === 'limits' ? <PlansView reports={reports} byId={byId} snapshot={snapshot} now={data.now} summary={summary}
      scoped={null} silent={[]} untracked={[]} onRefreshAccount={() => {}} onStopTracking={() => {}} onTrack={() => {}} onOpenPlanSettings={() => {}} />
      : stage === 'spend' ? <Spend ledger={ledger} wideLedger={wideLedger} byId={byId} tintOf={tints} scan={null}
        now={data.now} range={range} mode={mode} onModeChange={setMode} onScan={() => {}}
        rangeControl={<Segmented label="How far back" options={RANGES} value={String(range)} onChange={next => setRange(Number(next))} />} />
      : <ActivityView byId={byId} scope={null} now={data.now} scanFinishedAt={null} yearLedger={yearLedger}
        heatView={heatView} onHeatViewChange={setHeatView} heatDayMetric={dayMetric} onHeatDayMetricChange={setDayMetric}
        heatHourMetric={hourMetric} onHeatHourMetricChange={setHourMetric} />}
  </PaneColumn>
})
