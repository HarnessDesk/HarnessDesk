import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { MainPageInput } from '../app/main-page-entries'
import type { InsightReport, LedgerReport, RuntimeId, UsageReport } from '@harnessdesk/protocol'

import { prefsForUsage } from '../lib/accounts'
import { byUrgency, costClause, formatAge, runway } from '../lib/usage'
import { useSnapshot, useStore } from '../state/context'
import { Page, PageOptions, PageExplanation } from '../design'
import { DashboardBar } from '../panels/dashboard-bar'
import { useDestinationPage } from '../panels/destination-page'
import {
  DEFAULT_RANGE,
  reportNeedsAttention,
  silentAgentsOf,
  tintsForRoster,
  type Pivot,
} from './usage/shared'
import { OverviewView } from './usage/OverviewView'
import type { StripMetric } from './usage/OverviewStrip'
import { PlansView } from './usage/PlansView'
import { SpendView } from './usage/SpendView'
import { ActivityView } from './usage/ActivityView'
import { ProjectsView } from './usage/ProjectsView'
import type { HeatMetric, HourMetric } from '../lib/heat'
import type { HeatView } from './UsageActivity'

/**
 * Dashboard readings are decided by the usage libraries and supplied sources.
 * This retained body owns chart choices and fetch cancellation; destination
 * history owns its five views and account scope. Names come from presentation.
 */
export type DashboardView = 'overview' | 'plans' | 'spend' | 'activity' | 'projects'

/** Controlled retained Dashboard body. View and account scope belong to destination history. */
export const DashboardPage = ({ view, scope, onView, onScope, onSignIn, onOpenPlanSettings }: {
  readonly view: DashboardView; readonly scope: RuntimeId | null
  readonly onView: (view: DashboardView) => void; readonly onScope: (scope: RuntimeId | null) => void
  readonly onSignIn?: (runtime: RuntimeId) => void
  readonly onOpenPlanSettings?: (runtime: RuntimeId) => void
}) => {
  const { active } = useDestinationPage()
  const store = useStore()
  const snapshot = useSnapshot()
  const [now, setNow] = useState(() => Date.now())
  const [pivot, setPivot] = useState<Pivot>('runtime')
  const [range, setRange] = useState<number>(DEFAULT_RANGE)
  const [ledger, setLedger] = useState<LedgerReport | null>(null)
  /**
   * The previous period, read in one extra query for twice the range —
   * `days: range * 2`, capped at 365 by the host — and split in `lib/ledger`
   * rather than asked for separately: see the shell's own note in git
   * history for why a second `range`-sized query would not do.
   */
  const [wideLedger, setWideLedger] = useState<LedgerReport | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [insightRange, setInsightRange] = useState<{ root: string | null; days: number }>({ root: null, days: 30 })
  const [insightView, setInsightView] = useState<'goal' | 'agent'>('goal')
  /**
   * "When it ran"'s own query and toggles, owned here rather than by the
   * band itself: Overview and Activity each mount `UsageActivity`, and
   * before this every switch between them fired a fresh 365-day query and
   * reset the Year/By agent and Tokens/Cost toggles (review of #1057, item
   * 4). The two ledger effects above already make this shape; this is the
   * third.
   */
  const [yearLedger, setYearLedger] = useState<LedgerReport | null>(null)
  const [heatView, setHeatView] = useState<HeatView>('year')
  const [heatDayMetric, setHeatDayMetric] = useState<HeatMetric>('tokens')
  const [heatHourMetric, setHeatHourMetric] = useState<HourMetric>('tokens')
  /** The Overview strip's own chart toggle — see `OverviewStrip.tsx`. Owned here, not by the strip, the same reason `pivot` and `mode` are: it is one piece of state for a view that unmounts and remounts as the rail switches. */
  const [stripMetric, setStripMetric] = useState<StripMetric>('value')
  const [insightReport, setInsightReport] = useState<InsightReport | null>(null)
  const [insightProblem, setInsightProblem] = useState<string | null>(null)

  // Countdowns are the point of half this screen, so the clock has to move.
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (active) void store.loadUsage()
  }, [active, store])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => void store.refreshUsage(), 120_000)
    return () => window.clearInterval(timer)
  }, [active, store])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void store
      .ledger({ days: range, groupBy: pivot, ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [active, store, pivot, scope, range, snapshot.scan?.finishedAt])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void store
      .ledger({ days: Math.min(365, range * 2), groupBy: 'runtime', ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setWideLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [active, store, scope, range, snapshot.scan?.finishedAt])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void store
      .ledger({ days: 365, groupBy: 'runtime', ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setYearLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [active, store, scope, snapshot.scan?.finishedAt])

  const projectRoot = snapshot.workspace?.repo?.root ?? snapshot.workspace?.path ?? null
  // A range belongs to its project. Reset before its new read, rather than
  // querying the new project once with the previous project's shorter range.
  if (insightRange.root !== projectRoot) setInsightRange({ root: projectRoot, days: 30 })
  const insightDays = insightRange.root === projectRoot ? insightRange.days : 30

  // Project usage, loaded once per scope/root — not per `insightView` — so
  // switching Projects' own By Goal/By Agent toggle, or switching away and
  // back to Projects, issues no new read (review of #1057, item 4).
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setInsightReport(null)
    setInsightProblem(null)
    if (!projectRoot) return () => {
      cancelled = true
    }
    const to = Date.now()
    const from = to - insightDays * 86_400_000
    void store
      .readUsageInsight({ root: projectRoot, from, to, ...(scope ? { runtime: scope } : {}) })
      .then((next) => {
        if (!cancelled) setInsightReport(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setInsightProblem(error instanceof Error ? error.message : 'Recorded usage could not be read.')
      })
    return () => {
      cancelled = true
    }
  }, [active, store, projectRoot, scope, insightDays])

  const off = useMemo(() => new Set(snapshot.usageOff), [snapshot.usageOff])
  const tracked = useMemo(
    () => snapshot.runtimes.filter((info) => !off.has(info.id)),
    [snapshot.runtimes, off],
  )
  const untracked = useMemo(
    () => snapshot.runtimes.filter((info) => off.has(info.id)),
    [snapshot.runtimes, off],
  )

  // Scoping to an agent and then switching it off would leave the screen
  // showing one card that is not there any more.
  useEffect(() => {
    if (active && scope !== null && off.has(scope)) store.replaceDestination({ kind: 'dashboard', view, scope: null })
  }, [active, scope, off, view, store])

  const byId = useMemo(
    () => new Map(snapshot.runtimes.map((info) => [info.id, info] as const)),
    [snapshot.runtimes],
  )
  const nameOf = (id: RuntimeId): string => byId.get(id)?.presentation.name ?? 'Unavailable account'

  const agentTints = useMemo(() => tintsForRoster(snapshot.runtimes), [snapshot.runtimes])

  // Every registered agent gets a card, whether or not it reported anything.
  const everyReport = useMemo(() => {
    const metered = snapshot.usage.filter((report) => !off.has(report.runtime))
    const known = new Set(metered.map((report) => report.runtime))
    const silent: UsageReport[] = tracked
      .filter((info) => !known.has(info.id))
      .map((info) => ({
        runtime: info.id,
        account: null,
        plan: null,
        lanes: [],
        credits: null,
        spend: null,
        reached: null,
        source: { kind: 'runtime', label: 'no source available' },
        fetchedAt: now,
        staleAfterMs: Number.POSITIVE_INFINITY,
        error: null,
      }))
    return byUrgency([...metered, ...silent])
  }, [snapshot.usage, tracked, off, now])

  // Every view reads the same scope, applied here once.
  const reports = useMemo(
    () => (scope === null ? everyReport : everyReport.filter((report) => report.runtime === scope)),
    [everyReport, scope],
  )

  const attention = useMemo(
    () =>
      reports.filter((report) =>
        reportNeedsAttention(
          report,
          now,
          prefsForUsage(report.runtime, report.account, snapshot.accountsByRuntime, snapshot.accountPrefs),
        ),
      ),
    [reports, now, snapshot.accountsByRuntime, snapshot.accountPrefs],
  )

  const summary = useMemo(
    () => runway(reports, (report) => nameOf(report.runtime), now),
    // `nameOf` closes over the runtime map, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reports, byId, now],
  )

  /** Every tracked agent nobody has signed in — Plans lists each; Overview counts them. */
  const silent = useMemo(
    () => silentAgentsOf(tracked, snapshot),
    [tracked, snapshot],
  )

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await store.refreshUsage(scope ?? undefined)
    setRefreshing(false)
  }

  const oldest = snapshot.usage.reduce<number | null>(
    (at, report) => (at === null ? report.fetchedAt : Math.min(at, report.fetchedAt)),
    null,
  )

  const scoped = scope === null ? null : (byId.get(scope) ?? null)

  const borrowed = reports.find(
    (report) => report.lanes.length === 0 && (report.unverified?.lanes.length ?? 0) > 0,
  )
  // The whole-dashboard sentence is Overview's alone — every other view
  // already names itself in the rail and the title, so the same blurb under
  // all five read as a caption for a screen the reader was not looking at
  // (review of #1057, NIT 4). The borrowed-sign-in disclaimer is not that
  // sentence: it is a safety-relevant fact that varies per report, so it
  // earns its own one-liner (rule 9) on every view, not only Overview's.
  const overview = view === 'overview'
  const blurb = scoped
    ? borrowed?.unverified
      ? overview
        ? `One agent's plans, spend and history, read on this machine. Its plan figures are the ${borrowed.unverified.whose}'s, which may not be the account ${scoped.presentation.name} runs as.`
        : `Its plan figures are the ${borrowed.unverified.whose}'s, which may not be the account ${scoped.presentation.name} runs as.`
      : overview
        ? `One agent's plans, spend and history, read from ${scoped.presentation.name}'s own numbers on this machine.`
        : undefined
    : borrowed
      ? overview
        ? `What every plan has left, ${costClause(ledger?.provenance)}, and where it went, read from each agent’s own numbers on this machine. A card headed by another sign-in shows that sign-in’s.`
        : `A card headed by another sign-in shows that sign-in’s.`
      : overview
        ? `What every plan has left, ${costClause(ledger?.provenance)}, and where it went, read from each agent’s own numbers on this machine.`
        : undefined

  const scopeItems = [{ value: '', label: 'All accounts' }, ...[...new Set(everyReport.map(report => report.runtime))].map(id => ({
    value: String(id), label: byId.get(id)?.presentation.name ?? 'Unavailable account',
  }))]
  // An unavailable route keeps its identity until the user chooses a scope.
  if (scope !== null && !scopeItems.some(item => item.value === scope)) scopeItems.push({ value: scope, label: 'Unavailable account' })
  return <Page width="wide">
    <PageOptions title="Dashboard" choices={[{ id: 'scope', label: 'Scope the dashboard to one account', mode: 'menu',
      value: scope ?? '', items: scopeItems, change: value => onScope(value ? value as RuntimeId : null) }]}
      read={oldest === null ? null : `Read ${formatAge(oldest, now)}`}
      action={{ label: refreshing ? 'Refreshing…' : 'Refresh', disabled: refreshing, run: () => void refresh() }} />
    <DashboardBar view={view} attention={attention.length} changeView={onView} />
    {blurb && <PageExplanation>{blurb}</PageExplanation>}
          {view === 'overview' && (
            <OverviewView
              reports={reports}
              attention={attention}
              byId={byId}
              agentTints={agentTints}
              snapshot={snapshot}
              now={now}
              summary={summary}
              silent={silent}
              scope={scope}
              onGoToPlans={() => onView('plans')}
              onRefreshAccount={(runtime) => void store.refreshUsage(runtime)}
              onStopTracking={(runtime) => store.setUsageTracked(runtime, false)}
              ledger={ledger}
              wideLedger={wideLedger}
              range={range}
              mode={snapshot.spendChartMode}
              onModeChange={(next) => store.setSpendChartMode(next)}
              onScan={() => void store.scanUsage()}
              pivot={pivot}
              onPivotChange={setPivot}
              yearLedger={yearLedger}
              heatView={heatView}
              onHeatViewChange={setHeatView}
              heatDayMetric={heatDayMetric}
              onHeatDayMetricChange={setHeatDayMetric}
              heatHourMetric={heatHourMetric}
              onHeatHourMetricChange={setHeatHourMetric}
              stripMetric={stripMetric}
              onStripMetricChange={setStripMetric}
              onOpenPlan={(runtime) => store.askSettings('runtimes', String(runtime))}
            />
          )}

          {view === 'plans' && (
            <PlansView
              reports={reports}
              byId={byId}
              snapshot={snapshot}
              now={now}
              summary={summary}
              scoped={scoped}
              silent={silent}
              untracked={untracked}
              onSignIn={onSignIn}
              onRefreshAccount={(runtime) => void store.refreshUsage(runtime)}
              onStopTracking={(runtime) => store.setUsageTracked(runtime, false)}
              onTrack={(runtime) => store.setUsageTracked(runtime, true)}
              onOpenPlanSettings={onOpenPlanSettings ?? (() => {})}
            />
          )}

          {view === 'spend' && (
            <SpendView
              ledger={ledger}
              wideLedger={wideLedger}
              byId={byId}
              agentTints={agentTints}
              scan={snapshot.scan}
              now={now}
              range={range}
              onRangeChange={setRange}
              mode={snapshot.spendChartMode}
              onModeChange={(next) => store.setSpendChartMode(next)}
              onScan={() => void store.scanUsage()}
              pivot={pivot}
              onPivotChange={setPivot}
            />
          )}

          {view === 'activity' && (
            <ActivityView
              byId={byId}
              scope={scope}
              now={now}
              scanFinishedAt={snapshot.scan?.finishedAt}
              yearLedger={yearLedger}
              heatView={heatView}
              onHeatViewChange={setHeatView}
              heatDayMetric={heatDayMetric}
              onHeatDayMetricChange={setHeatDayMetric}
              heatHourMetric={heatHourMetric}
              onHeatHourMetricChange={setHeatHourMetric}
            />
          )}

          {view === 'projects' && (
            <ProjectsView
              root={projectRoot}
              scope={scope}
              insightView={insightView}
              onInsightViewChange={setInsightView}
              onGoal={(goal) => store.openGoal(goal)}
              insightReport={insightReport}
              insightProblem={insightProblem}
              rangeDays={insightDays}
              onRangeChange={days => setInsightRange({ root: projectRoot, days })}
            />
          )}
  </Page>
}

export const DashboardEntry = ({ page, visit, onSignIn }: MainPageInput) => {
  const store = useStore()
  return page.kind === 'dashboard' ? <DashboardPage view={page.view} scope={page.scope}
    onView={view => visit({ ...page, view })} onScope={scope => visit({ ...page, scope })}
    onSignIn={onSignIn} onOpenPlanSettings={runtime => store.askSettings('runtimes', String(runtime))} /> : null
}

// Re-exported so tests and other callers can keep reading `./Usage` for the
// pure helpers `lib/usage.ts` cannot own (they draw, rather than decide) —
// the implementations moved to `usage/shared.tsx` with the views that use them.
export {
  balanceOf,
  noteGlyph,
  noteOf,
  Ranked,
  rankedChange,
  stateOf,
  type Tone,
} from './usage/shared'
