import { memo, useMemo, useState } from 'react'
import { PlansView } from '../src/components/usage/PlansView'
import { ActivityView } from '../src/components/usage/ActivityView'
import { BandHead, PIVOTS, RANGES, Ranked, Spend, tintsForRoster, type Pivot } from '../src/components/usage/shared'
import type { HeatView } from '../src/components/UsageActivity'
import type { HeatMetric, HourMetric } from '../src/lib/heat'
import { runway } from '../src/lib/usage'
import { SCENE_NOW, sceneUsage, siteSceneLedger, sceneRuntimes } from './dashboard-data'
import { previewStore } from '../src/preview/harness'
import { PaneColumn, Segmented } from '../src/design'
import type { LedgerReport } from '@harnessdesk/protocol'
import type { SceneName } from './scenes'

/** Shift the site's fictional history to the visitor's local calendar. */
export const dashboardData = (now = Date.now()) => {
  const delta = now - SCENE_NOW
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const civilDay = (day: number) => {
    const date = new Date(day)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  }
  const snapDay = (day: number) => {
    const date = new Date(today)
    date.setDate(date.getDate() - Math.round((civilDay(SCENE_NOW) - civilDay(day)) / 86_400_000))
    return date.getTime()
  }
  const weekdayShift = (today.getDay() - new Date(SCENE_NOW).getDay() + 7) % 7
  const usage = sceneUsage(now)
  const base = previewStore().getSnapshot()
  const runtimes = sceneRuntimes(base.runtimes[0]!)
  const accountsByRuntime = Object.fromEntries(runtimes.map(info => [info.id, {
    ...base.accountsByRuntime[info.id], signInMethods: [],
    accounts: usage.filter(report => report.runtime === info.id).map(report => ({ kind: 'oauth' as const, label: report.account ?? info.presentation.name, ...(report.account ? { email: report.account } : {}) })),
  }]))
  const store = previewStore({ ...base, runtimes, usage, accountsByRuntime, accountPrefs: {} })
  const ledgers = new Map<string, LedgerReport>()
  const ledger = (days: number, groupBy: Pivot): LedgerReport => {
    const key = `${days}:${groupBy}`
    const cached = ledgers.get(key)
    if (cached) return cached
    const report = siteSceneLedger(days, groupBy)
    const snapped = { ...report, scannedAt: report.scannedAt === null ? null : report.scannedAt + delta,
      daily: report.daily.map(day => ({ ...day, day: snapDay(day.day) })),
      hourly: report.hourly?.map(hour => ({ ...hour, weekday: (hour.weekday + weekdayShift) % 7 })),
      coverage: { ...report.coverage, earliestDay: report.coverage.earliestDay == null ? report.coverage.earliestDay : snapDay(report.coverage.earliestDay) },
    }
    ledgers.set(key, snapped)
    return snapped
  }
  return { store, ledger, now }
}

/** The shipping Dashboard's bands, without its window shell or navigation rail. */
export const DashboardScene = memo(({ data, view = 'dashboard' }: { data: ReturnType<typeof dashboardData>; view?: SceneName }) => {
  const snapshot = data.store.getSnapshot()
  const byId = useMemo(() => new Map(snapshot.runtimes.map(info => [info.id, info])), [snapshot.runtimes])
  const tints = useMemo(() => tintsForRoster(snapshot.runtimes), [snapshot.runtimes])
  const reports = snapshot.usage
  const summary = useMemo(() => runway(reports, report => byId.get(report.runtime)!.presentation.name, data.now), [reports, byId, data.now])
  const [range, setRange] = useState(30)
  const [pivot, setPivot] = useState<Pivot>('runtime')
  const [mode, setMode] = useState<'bars' | 'line'>('bars')
  const [heatView, setHeatView] = useState<HeatView>('year')
  const [dayMetric, setDayMetric] = useState<HeatMetric>('tokens')
  const [hourMetric, setHourMetric] = useState<HourMetric>('tokens')
  const ledger = useMemo(() => data.ledger(range, pivot), [data, range, pivot])
  const wideLedger = useMemo(() => data.ledger(Math.min(365, range * 2), pivot), [data, range, pivot])
  const yearLedger = useMemo(() => data.ledger(365, 'runtime'), [data])
  const spend = <Spend ledger={ledger} wideLedger={wideLedger} byId={byId} tintOf={tints} scan={null}
        now={data.now} range={range} mode={mode} onModeChange={setMode} onScan={() => {}} showFooter={false}
        rangeControl={<Segmented label="How far back" options={RANGES} value={String(range)} onChange={next => setRange(Number(next))} />} />
  const full = view === 'dashboard'
  return <PaneColumn inset="reading" page className={`site-dashboard${full ? '' : ' site-dashboard-focus'}`}
    style={full ? undefined : { padding: 'var(--hd-space-5)' }}>
    {full ? <div className="site-dashboard-spend">
      {spend}
      <section aria-label="Where it went" className="site-dashboard-breakdown">
        <BandHead name="Where it went" action={<Segmented label="Group spend by" options={PIVOTS} value={pivot} onChange={next => setPivot(next as Pivot)} />} />
        <Ranked ledger={ledger} wideLedger={wideLedger} pivot={pivot} range={range} now={data.now} byId={byId} tintOf={tints} compact />
      </section>
    </div> : view === 'dashboard-spend' ? spend : null}
    {(full || view === 'dashboard-limits') && <div className="site-dashboard-accounts">
      <PlansView reports={reports} byId={byId} snapshot={snapshot} now={data.now} summary={summary}
        scoped={null} silent={[]} untracked={[]} onSignIn={() => {}} onRefreshAccount={() => {}} onStopTracking={() => {}} onTrack={() => {}} onOpenPlanSettings={() => {}} />
    </div>}
    {(full || view === 'dashboard-activity') && <ActivityView byId={byId} scope={null} now={data.now} scanFinishedAt={null} yearLedger={yearLedger}
      heatView={heatView} onHeatViewChange={setHeatView} heatDayMetric={dayMetric} onHeatDayMetricChange={setDayMetric}
      heatHourMetric={hourMetric} onHeatHourMetricChange={setHourMetric} />}
  </PaneColumn>
})
