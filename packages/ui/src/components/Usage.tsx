import { useEffect, useMemo, useState } from 'react'

import type { LedgerReport, RuntimeId, UsageReport } from '@harnessdesk/protocol'

import { prefsForUsage } from '../lib/accounts'
import { byUrgency, costClause, formatAge, runway } from '../lib/usage'
import { useSnapshot, useStore } from '../state/context'
import { AppWindow, WindowGroup, WindowNav, WindowNavItem, WindowPage } from './AppWindow'
import { ActivityIcon, CostIcon, GoalIcon, OverviewIcon, RetryIcon, UsageIcon } from './Icons'
import { Button, PageHead, Text, dismissOverlays, useEscapeSurface } from '../design'
import {
  DEFAULT_RANGE,
  ScopeControl,
  reportNeedsAttention,
  silentAgentsOf,
  tintsForRoster,
  type Pivot,
} from './usage/shared'
import { OverviewView } from './usage/OverviewView'
import { PlansView } from './usage/PlansView'
import { SpendView } from './usage/SpendView'
import { ActivityView } from './usage/ActivityView'
import { ProjectsView } from './usage/ProjectsView'
import styles from './Usage.module.css'

/**
 * Usage — what every plan has left, when it comes back, and what it cost.
 *
 * Design and rationale: `docs/usage-dashboard.md`. Everything true on this
 * screen is decided in `lib/usage.ts`, which is tested without a browser; this
 * file only loads the data every view needs and draws the shell around it —
 * the rail, the header, and the one view showing. It never picks the
 * headline lane itself, and it never names an agent — every name comes from
 * `RuntimeInfo.presentation`.
 *
 * The rail lists **views**, not accounts. It held one account per row for a
 * while, which duplicated the account list a click away, mixed units row to
 * row, and put a filter — "look at one account" — where navigation belongs.
 * The account is now a choice in every view's own header, made once and kept
 * across all five: `ScopeControl`, beside the title, in `usage/shared.tsx`.
 */

export type DashboardView = 'overview' | 'plans' | 'spend' | 'activity' | 'projects'

const VIEW_LABEL: Readonly<Record<DashboardView, string>> = {
  overview: 'Overview',
  plans: 'Plans',
  spend: 'Spend',
  activity: 'Activity',
  projects: 'Projects',
}

export const Usage = ({
  view = 'overview',
  scope = null,
  onView = () => undefined,
  onScope = () => undefined,
  onClose,
  onSignIn,
}: {
  /** The rail's own row, owned by the caller so any entry point can redirect it. */
  view?: DashboardView
  /** The account every band reads, or `null` for all of them. Owned by the caller, the way `view` is. */
  scope?: RuntimeId | null
  onView?: (view: DashboardView) => void
  onScope?: (scope: RuntimeId | null) => void
  onClose: () => void
  /** Opening the sign-in window from the agent that has nothing to report. */
  onSignIn?: (runtime: RuntimeId) => void
}) => {
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
  const [insightView, setInsightView] = useState<'goal' | 'agent'>('goal')

  useEffect(dismissOverlays, [])
  useEscapeSurface(true, onClose)

  // Countdowns are the point of half this screen, so the clock has to move.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void store.loadUsage()
  }, [store])

  useEffect(() => {
    const timer = window.setInterval(() => void store.refreshUsage(), 120_000)
    return () => window.clearInterval(timer)
  }, [store])

  useEffect(() => {
    let cancelled = false
    void store
      .ledger({ days: range, groupBy: pivot, ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [store, pivot, scope, range, snapshot.scan?.finishedAt])

  useEffect(() => {
    let cancelled = false
    void store
      .ledger({ days: Math.min(365, range * 2), groupBy: 'runtime', ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setWideLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [store, scope, range, snapshot.scan?.finishedAt])

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
    if (scope !== null && off.has(scope)) onScope(null)
  }, [scope, off, onScope])

  const byId = useMemo(
    () => new Map(snapshot.runtimes.map((info) => [info.id, info] as const)),
    [snapshot.runtimes],
  )
  const nameOf = (id: RuntimeId): string => byId.get(id)?.presentation.name ?? String(id)

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
  const blurb = scoped
    ? borrowed?.unverified
      ? `One agent's plans, spend and history, read on this machine. Its plan figures are the ${borrowed.unverified.whose}'s, which may not be the account ${scoped.presentation.name} runs as.`
      : `One agent's plans, spend and history, read from ${scoped.presentation.name}'s own numbers on this machine.`
    : borrowed
      ? `What every plan has left, ${costClause(ledger?.provenance)}, and where it went, read from each agent’s own numbers on this machine. A card headed by another sign-in shows that sign-in’s.`
      : `What every plan has left, ${costClause(ledger?.provenance)}, and where it went, read from each agent’s own numbers on this machine.`

  const scopeControl = (
    <ScopeControl everyReport={everyReport} byId={byId} scope={scope} onScope={onScope} />
  )

  return (
    <AppWindow label="Dashboard">
      <WindowNav onBack={onClose}>
        <WindowGroup label="Views">
          <WindowNavItem
            icon={<OverviewIcon size={14} />}
            label="Overview"
            selected={view === 'overview'}
            onClick={() => onView('overview')}
          />
          <WindowNavItem
            icon={<UsageIcon size={14} />}
            label="Plans"
            {...(attention.length > 0
              ? {
                  trail: (
                    <Text role="meta" tone="warning" numeric>
                      {attention.length} low
                    </Text>
                  ),
                }
              : {})}
            selected={view === 'plans'}
            onClick={() => onView('plans')}
          />
          <WindowNavItem
            icon={<CostIcon size={14} />}
            label="Spend"
            selected={view === 'spend'}
            onClick={() => onView('spend')}
          />
          <WindowNavItem
            icon={<ActivityIcon size={14} />}
            label="Activity"
            selected={view === 'activity'}
            onClick={() => onView('activity')}
          />
          <WindowNavItem
            icon={<GoalIcon size={14} />}
            label="Projects"
            selected={view === 'projects'}
            onClick={() => onView('projects')}
          />
        </WindowGroup>

        <div className={styles.navFoot}>
          {oldest !== null && <Text role="meta">Read {formatAge(oldest, now)}</Text>}
          <Button variant="secondary" size="sm" disabled={refreshing} onClick={() => void refresh()}>
            <RetryIcon size={13} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </WindowNav>

      <WindowPage wide>
        {/* The stat strip's slot: a later PR draws it here, above the page
            head. Nothing renders yet — no placeholder UI for a band that is
            not built. */}
        <PageHead
          title={scoped ? scoped.presentation.name : VIEW_LABEL[view]}
          blurb={blurb}
          actions={scopeControl}
        />

        <div className={styles.body}>
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
            <ActivityView byId={byId} scope={scope} now={now} scanFinishedAt={snapshot.scan?.finishedAt} />
          )}

          {view === 'projects' && (
            <ProjectsView
              root={snapshot.workspace?.repo?.root ?? snapshot.workspace?.path ?? null}
              scope={scope}
              insightView={insightView}
              onInsightViewChange={setInsightView}
              onGoal={(goal) => store.openGoal(goal)}
            />
          )}
        </div>
      </WindowPage>
    </AppWindow>
  )
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
