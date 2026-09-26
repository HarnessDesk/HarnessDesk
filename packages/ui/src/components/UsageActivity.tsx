import { useEffect, useMemo, useState } from 'react'

import type { LedgerReport, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import {
  agentLevels,
  busiestDay,
  busiestWeekday,
  buildAgentRows,
  buildRecentDays,
  buildYearGrid,
  dayLabelLong,
  isUnpricedCost,
  leadingAgent,
  streaksFor,
  toGridCell,
  WEEKDAY_NAMES,
  yearLevels,
  type HeatCell,
  type HeatMetric,
} from '../lib/heat'
import { formatMoney } from '../lib/usage'
import { formatTokens } from '../lib/context-usage'
import { useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import {
  ChartCard,
  ChartFoot,
  ChartFrame,
  EmptyState,
  HeatGrid,
  HeatLegend,
  SectionHead,
  Segmented,
  Text,
  type HeatGridRow,
} from '../design'
import styles from './UsageActivity.module.css'

/**
 * "When it ran" — a calendar heatmap of the account's own activity, the year
 * at a glance rather than the money band's rolling window.
 *
 * It keeps its own ledger query, `{ days: 365, groupBy: 'runtime' }`, because
 * the question this band answers — *when* did the work happen — is on a
 * different clock from "what it cost": the money band's 7/30/90-day range
 * belongs to that band alone, and a heatmap of four weeks is not a calendar.
 * It still follows the rail's scope, like every band on this screen.
 *
 * The arithmetic — which day is "no record yet" rather than empty, where the
 * quartile breakpoints fall, the streaks, the busiest day — lives in
 * `lib/heat.ts` and is tested without a browser; this file only draws, the
 * rule the rest of the Dashboard keeps. `toGridCell` and `cellLabel` live
 * there too, so this band and the catalogue board's own chart-kit example
 * call the same code rather than keeping two copies that can quietly
 * disagree (review #990, item 4).
 */

type View = 'year' | 'agent'

const VIEWS = [
  { value: 'year', label: 'Year' },
  { value: 'agent', label: 'By agent' },
] as const

const METRICS = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
] as const

const AGENT_SPAN_DAYS = 91

export const UsageActivity = ({
  byId,
  scope,
  now,
  scanFinishedAt,
}: {
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  scope: RuntimeId | null
  now: number
  /**
   * Refetches the ledger once a scan finishes — the same signal the money
   * band above already refreshes on. Without it, opening the Dashboard
   * during the first scan left this band showing whatever partial (or
   * empty) report it queried at mount, while every other band on the
   * screen moved on (review #990, item 7).
   */
  scanFinishedAt?: number | null
}) => {
  const store = useStore()
  const [view, setView] = useState<View>('year')
  const [metric, setMetric] = useState<HeatMetric>('tokens')
  const [ledger, setLedger] = useState<LedgerReport | null>(null)

  useEffect(() => {
    let cancelled = false
    void store
      .ledger({ days: 365, groupBy: 'runtime', ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [store, scope, scanFinishedAt])

  const currency = ledger?.currency ?? 'USD'
  const format = (value: number): string => (metric === 'tokens' ? formatTokens(value) : (formatMoney(value, currency) ?? '—'))
  const nameOf = (id: RuntimeId): string => byId.get(id)?.presentation.name ?? String(id)
  // Skip the mark rather than draw one for a runtime `byId` has never heard
  // of: the earlier `as RuntimeInfo` cast built an object missing every
  // field the type promises `RuntimeMark` will find (review #990, item 16).
  const markOf = (id: RuntimeId): RuntimeInfo | undefined => byId.get(id)

  const year = useMemo(() => buildYearGrid(ledger, now), [ledger, now])
  const yearCells = useMemo(() => year.weeks.flatMap((week) => week.filter((cell): cell is HeatCell => cell !== null)), [year])

  const recentCells = useMemo(() => buildRecentDays(ledger, now, AGENT_SPAN_DAYS), [ledger, now])
  const agentRows = useMemo(() => buildAgentRows(recentCells, metric), [recentCells, metric])

  const inView = view === 'year' ? yearCells : recentCells
  // Year levels off the combined per-day totals; By agent has to level off
  // each agent's own cells instead, or a lighter agent's busiest day almost
  // never clears the heaviest agent's first quartile (review #990, item 4).
  const levelOf = useMemo(
    () => (view === 'year' ? yearLevels(yearCells, metric) : agentLevels(agentRows, metric)),
    [view, yearCells, agentRows, metric],
  )

  const streaks = useMemo(() => streaksFor(inView, metric), [inView, metric])
  const busiest = useMemo(() => busiestDay(inView, metric), [inView, metric])
  const busiestDow = useMemo(() => busiestWeekday(inView, metric), [inView, metric])
  const leader = useMemo(() => leadingAgent(yearCells, metric), [yearCells, metric])
  const total = useMemo(
    () => inView.reduce((sum, cell) => sum + (metric === 'tokens' ? cell.tokens : cell.cost), 0),
    [inView, metric],
  )
  const scannedCount = useMemo(() => inView.filter((cell) => cell.scanned).length, [inView])
  const activeCount = useMemo(
    () => inView.filter((cell) => (metric === 'tokens' ? cell.tokens : cell.cost) > 0).length,
    [inView, metric],
  )

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const todayKey = today.getTime()

  // The figure the facts card leads with. A scope nothing in it can be
  // priced reads `ledger.totalCost === null`, the same signal the money
  // band already keys "unpriced" off — not a `$0` that reads as a real,
  // priced total of nothing (review #990, item 6).
  const totalUnpriced = metric === 'cost' && ledger?.totalCost === null
  const totalLabel = totalUnpriced ? 'unpriced' : format(total)
  const somePartiallyUnpriced = metric === 'cost' && !totalUnpriced && (ledger?.coverage.unpriced ?? 0) > 0

  const rows: readonly HeatGridRow[] =
    view === 'year'
      ? WEEKDAY_NAMES.map((name, weekday) => ({
          key: name,
          // Mon, Wed, Fri only — a label on every row crowds a 53-column grid,
          // and Sun would make four unevenly-spaced labels rather than three.
          header: [0, 2, 4].includes(weekday) ? <Text role="meta">{name.slice(0, 3)}</Text> : undefined,
          cells: year.weeks.map((week) => {
            const cell = week[weekday]
            return cell ? toGridCell(cell, metric, levelOf, { currency, today: todayKey, nameOf }) : null
          }),
        }))
      : agentRows.map((row) => {
          const mark = markOf(row.runtime)
          return {
            key: String(row.runtime),
            header: (
              <span className="flex items-center gap-1.5">
                {mark && <RuntimeMark runtime={mark} size={13} />}
                <Text role="row">{nameOf(row.runtime)}</Text>
                <Text role="meta">{format(row.total)}</Text>
              </span>
            ),
            cells: row.cells.map((cell) =>
              toGridCell(cell, metric, levelOf, { currency, today: todayKey, rowKey: String(row.runtime), nameOf }),
            ),
          }
        })

  const columns = view === 'year' ? 53 : AGENT_SPAN_DAYS

  return (
    <section className={styles.band} aria-label="When it ran">
      <SectionHead
        level="heading"
        name="When it ran"
        description={busiestDow !== null ? `Busiest on ${WEEKDAY_NAMES[busiestDow]}s` : undefined}
        action={
          <>
            <Segmented label="Show by" options={VIEWS} value={view} onChange={(next) => setView(next as View)} />
            <Segmented label="Measure" options={METRICS} value={metric} onChange={(next) => setMetric(next as HeatMetric)} />
          </>
        }
      />

      <ChartFrame>
        <ChartCard className={styles.facts}>
          <div className={styles.fact}>
            <Text role="metric">{totalLabel}</Text>
            <Text role="meta">
              {view === 'year' ? 'this year' : 'last 13 weeks'}
              {somePartiallyUnpriced ? ' · some unpriced' : ''}
            </Text>
          </div>
          <div className={styles.fact}>
            <Text role="metric">{activeCount}</Text>
            <Text role="meta">active of {scannedCount} scanned</Text>
          </div>
          <div className={styles.fact}>
            <Text role="metric">{streaks.current} days</Text>
            <Text role="meta">streak · best {streaks.best}</Text>
          </div>
          <div className={styles.fact}>
            <Text role="metric">
              {busiest
                ? metric === 'cost' && isUnpricedCost(busiest)
                  ? 'unpriced'
                  : format(metric === 'tokens' ? busiest.tokens : busiest.cost)
                : '—'}
            </Text>
            <Text role="meta">{busiest ? dayLabelLong(busiest.day) : 'busiest day'}</Text>
          </div>
          {view === 'year' && (
            <div className={styles.fact}>
              <Text role="metric">{leader ? nameOf(leader) : '—'}</Text>
              <Text role="meta">did the most</Text>
            </div>
          )}
        </ChartCard>

        <ChartCard className={styles.plot}>
          {ledger === null ? (
            <EmptyState tight title="Reading the ledger" />
          ) : (
            <HeatGrid
              label={view === 'year' ? 'Tokens or cost per day, this year' : 'Tokens or cost per day, per agent, last 13 weeks'}
              rows={rows}
              columns={columns}
              columnLabels={
                view === 'year' ? year.monthLabels.map((entry) => ({ index: entry.week, label: entry.label })) : undefined
              }
            />
          )}
        </ChartCard>

        <ChartFoot>
          <HeatLegend levelTitle={(level) => levelTitle(level, metric)} />
        </ChartFoot>
      </ChartFrame>
    </section>
  )
}

const levelTitle = (level: number, metric: HeatMetric): string => {
  const noun = metric === 'tokens' ? 'tokens' : 'cost'
  if (level === 0) return `No ${noun}`
  return `Level ${level} of 4, by quartile`
}
