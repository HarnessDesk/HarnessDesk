import { useEffect, useMemo, useState } from 'react'

import type { LedgerReport, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import {
  agentLevels,
  buildHourGrid,
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
  toHourGridCell,
  WEEKDAY_NAMES,
  yearLevels,
  type HeatCell,
  type HeatMetric,
  type HourMetric,
} from '../lib/heat'
import { formatMoney } from '../lib/usage'
import { formatTokens } from '../lib/context-usage'
import { agentCoverage } from '../lib/overview-strip'
import { useDestinationActive } from '../panels/destination-page'
import { useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import {
  ChartCard,
  ChartFoot,
  ChartFrame,
  EmptyState,
  HeatGrid,
  HeatLegend,
  Section, PageOptions, DashboardStats, DashboardAgentReading,
  Text,
  type HeatGridRow,
} from '../design'

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

export type HeatView = 'year' | 'agent' | 'hour'

const VIEWS = [
  { value: 'year', label: 'Last 12 months' },
  { value: 'agent', label: 'By agent' },
  { value: 'hour', label: 'By hour' },
] as const

const DAY_METRICS = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
] as const

const HOUR_METRICS = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'calls', label: 'Calls' },
] as const

const AGENT_SPAN_DAYS = 91

export const UsageActivity = ({
  byId,
  scope,
  now,
  scanFinishedAt,
  report: suppliedReport,
  view: viewProp,
  onViewChange: onViewChangeProp,
  dayMetric: dayMetricProp,
  onDayMetricChange: onDayMetricChangeProp,
  hourMetric: hourMetricProp,
  onHourMetricChange: onHourMetricChangeProp,
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
  /**
   * Supplied once by `Usage.tsx`, which owns this query beside its other two
   * ledger effects so Overview and Activity read one fetch instead of a
   * fresh 365-day query on every switch between them (review of #1057, item
   * 4). `undefined` — never passed — falls back to this band's own fetch,
   * which is what keeps a bare mount (a test, the catalogue) working.
   */
  report?: LedgerReport | null
  view?: HeatView
  onViewChange?: (view: HeatView) => void
  dayMetric?: HeatMetric
  onDayMetricChange?: (metric: HeatMetric) => void
  hourMetric?: HourMetric
  onHourMetricChange?: (metric: HourMetric) => void
}) => {
  const active = useDestinationActive()
  const store = useStore()
  const [ownView, setOwnView] = useState<HeatView>('year')
  const [ownDayMetric, setOwnDayMetric] = useState<HeatMetric>('tokens')
  const [ownHourMetric, setOwnHourMetric] = useState<HourMetric>('tokens')
  const [ownLedger, setOwnLedger] = useState<LedgerReport | null>(null)

  const view = viewProp ?? ownView
  const setView = onViewChangeProp ?? setOwnView
  const dayMetric = dayMetricProp ?? ownDayMetric
  const setDayMetric = onDayMetricChangeProp ?? setOwnDayMetric
  const hourMetric = hourMetricProp ?? ownHourMetric
  const setHourMetric = (next: string): void => {
    if (next === 'calls' || next === 'tokens') (onHourMetricChangeProp ?? setOwnHourMetric)(next)
  }
  const owned = suppliedReport === undefined

  useEffect(() => {
    if (!active || !owned) return
    let cancelled = false
    void store
      .ledger({ days: 365, groupBy: 'runtime', ...(scope ? { runtime: scope } : {}) })
      .then((report) => {
        if (!cancelled) setOwnLedger(report)
      })
    return () => {
      cancelled = true
    }
  }, [active, store, scope, scanFinishedAt, owned])

  const ledger = owned ? ownLedger : suppliedReport ?? null

  const currency = ledger?.currency ?? 'USD'
  const format = (value: number): string => (dayMetric === 'tokens' ? formatTokens(value) : (formatMoney(value, currency) ?? '—'))
  const nameOf = (id: RuntimeId): string => byId.get(id)?.presentation.name ?? String(id)
  // Skip the mark rather than draw one for a runtime `byId` has never heard
  // of: the earlier `as RuntimeInfo` cast built an object missing every
  // field the type promises `RuntimeMark` will find (review #990, item 16).
  const markOf = (id: RuntimeId): RuntimeInfo | undefined => byId.get(id)

  const year = useMemo(() => buildYearGrid(ledger, now), [ledger, now])
  const yearCells = useMemo(() => year.weeks.flatMap((week) => week.filter((cell): cell is HeatCell => cell !== null)), [year])

  const recentCells = useMemo(() => buildRecentDays(ledger, now, AGENT_SPAN_DAYS), [ledger, now])
  const agentRows = useMemo(() => buildAgentRows(recentCells, dayMetric), [recentCells, dayMetric])
  const hourGrid = useMemo(() => buildHourGrid(ledger, hourMetric), [ledger, hourMetric])
  const hourRows: readonly HeatGridRow[] = hourGrid.cells.map((cells, weekday) => ({
    key: WEEKDAY_NAMES[weekday] ?? String(weekday),
    header: [0, 2, 4].includes(weekday) ? <Text role="meta">{WEEKDAY_NAMES[weekday]?.slice(0, 3)}</Text> : undefined,
    cells: cells.map((cell) => toHourGridCell(cell, hourGrid.levelOf)),
  }))
  const hourColumnLabels = [0, 6, 12, 18].map((hour) => ({
    index: hour,
    label: hour === 0 ? '12a' : hour === 12 ? '12p' : `${hour % 12}${hour < 12 ? 'a' : 'p'}`,
  }))

  const inView = view === 'year' ? yearCells : recentCells
  // Year levels off the combined per-day totals; By agent has to level off
  // each agent's own cells instead, or a lighter agent's busiest day almost
  // never clears the heaviest agent's first quartile (review #990, item 4).
  const levelOf = useMemo(
    () => (view === 'year' ? yearLevels(yearCells, dayMetric) : agentLevels(agentRows, dayMetric)),
    [view, yearCells, agentRows, dayMetric],
  )

  const streaks = useMemo(() => streaksFor(inView, dayMetric), [inView, dayMetric])
  const busiest = useMemo(() => busiestDay(inView, dayMetric), [inView, dayMetric])
  const busiestDow = useMemo(() => busiestWeekday(inView, dayMetric), [inView, dayMetric])
  const leader = useMemo(() => leadingAgent(yearCells, dayMetric), [yearCells, dayMetric])
  const total = useMemo(
    () => inView.reduce((sum, cell) => sum + (dayMetric === 'tokens' ? cell.tokens : cell.cost), 0),
    [inView, dayMetric],
  )
  const scannedCount = useMemo(() => inView.filter((cell) => cell.scanned).length, [inView])
  const activeCount = useMemo(
    () => inView.filter((cell) => (dayMetric === 'tokens' ? cell.tokens : cell.cost) > 0).length,
    [inView, dayMetric],
  )

  const hourTotal = hourGrid.cells.flat().reduce((sum, cell) => sum + cell.value, 0)
  const busiestHour = hourGrid.cells.flat().reduce<(typeof hourGrid.cells)[number][number] | null>(
    (best, cell) => (cell.value > (best?.value ?? 0) ? cell : best), null,
  )
  const weekdayTotals = hourGrid.cells.map((row) => row.reduce((sum, cell) => sum + cell.value, 0))
  const busiestHourWeekday = weekdayTotals.some((value) => value > 0)
    ? weekdayTotals.indexOf(Math.max(...weekdayTotals))
    : null
  const hoursCoverage = agentCoverage(ledger?.coverage, ledger?.daily.map((entry) => entry.runtime) ?? [], 'hoursKnownFor')

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const todayKey = today.getTime()

  // The figure the facts card leads with. A scope nothing in it can be
  // priced reads `ledger.totalCost === null`, the same signal the money
  // band already keys "unpriced" off — not a `$0` that reads as a real,
  // priced total of nothing (review #990, item 6).
  const totalUnpriced = dayMetric === 'cost' && ledger?.totalCost === null
  const totalLabel = totalUnpriced ? 'unpriced' : format(total)
  const somePartiallyUnpriced = dayMetric === 'cost' && !totalUnpriced && (ledger?.coverage.unpriced ?? 0) > 0

  const rows: readonly HeatGridRow[] =
    view === 'year'
      ? WEEKDAY_NAMES.map((name, weekday) => ({
          key: name,
          // Mon, Wed, Fri only — a label on every row crowds a 53-column grid,
          // and Sun would make four unevenly-spaced labels rather than three.
          header: [0, 2, 4].includes(weekday) ? <Text role="meta">{name.slice(0, 3)}</Text> : undefined,
          cells: year.weeks.map((week) => {
            const cell = week[weekday]
            return cell ? toGridCell(cell, dayMetric, levelOf, { currency, today: todayKey, nameOf }) : null
          }),
        }))
      : agentRows.map((row) => {
          const mark = markOf(row.runtime)
          return {
            key: String(row.runtime),
            header: (
              <DashboardAgentReading mark={mark ? <RuntimeMark runtime={mark} size={13} /> : undefined} name={nameOf(row.runtime)} value={format(row.total)} />
            ),
            cells: row.cells.map((cell) =>
              toGridCell(cell, dayMetric, levelOf, { currency, today: todayKey, rowKey: String(row.runtime), nameOf }),
            ),
          }
        })

  const columns = view === 'year' ? 53 : AGENT_SPAN_DAYS

  return (
    <Section title="When it ran" description={view !== 'hour' && busiestDow !== null ? `Busiest on ${WEEKDAY_NAMES[busiestDow]}s` : undefined} action={<PageOptions choices={[
      {id:'view',label:'Show by',value:view,items:VIEWS,change:next=>setView(next as HeatView)},
      {id:'metric',label:'Measure',value:view === 'hour' ? hourMetric : dayMetric,items:view === 'hour' ? HOUR_METRICS : DAY_METRICS,change:next=>view === 'hour' ? setHourMetric(next) : setDayMetric(next as HeatMetric)},
    ]} />}>
      <ChartFrame>
        <ChartCard>
          <DashboardStats facts={view === 'hour' ? [
            {id:'total',label:hourMetric === 'calls' ? `${hourTotal === 1 ? 'call' : 'calls'} last 12 months` : 'tokens last 12 months',value:!hourGrid.available ? '—' : hourMetric === 'calls' ? hourTotal.toLocaleString() : formatTokens(hourTotal)},
            {id:'hour',label:'busiest hour',value:busiestHour ? `${WEEKDAY_NAMES[busiestHour.weekday]?.slice(0,3)} ${busiestHour.hour % 12 || 12} ${busiestHour.hour < 12 ? 'AM' : 'PM'}` : '—'},
            {id:'weekday',label:'busiest day of the week',value:busiestHourWeekday === null ? '—' : WEEKDAY_NAMES[busiestHourWeekday]},
          ] : [
            {id:'total',label:view === 'year' ? 'Last 12 months' : 'last 13 weeks',value:totalLabel,caption:somePartiallyUnpriced ? 'some unpriced' : undefined},
            {id:'active',label:'Active days',value:activeCount,caption:`${scannedCount} days scanned`},
            {id:'streak',label:`streak · best ${streaks.best}`,value:`${streaks.current} days`},
            {id:'busiest',label:busiest ? dayLabelLong(busiest.day) : 'busiest day',value:busiest ? dayMetric === 'cost' && isUnpricedCost(busiest) ? 'unpriced' : format(dayMetric === 'tokens' ? busiest.tokens : busiest.cost) : '—'},
            ...(view === 'year' ? [{id:'leader',label:'did the most',value:leader ? nameOf(leader) : '—'}] : []),
          ]} />
        </ChartCard>

        <ChartCard>
          {ledger === null ? (
            <EmptyState tight title="Reading the ledger" />
          ) : view === 'hour' && !hourGrid.available ? (
            <EmptyState tight title="No hours recorded yet" />
          ) : (
            <HeatGrid
              label={view === 'year' ? 'Tokens or cost per day, last 12 months' : view === 'agent' ? 'Tokens or cost per day, per agent, last 13 weeks' : 'Tokens or calls by local weekday and hour, last 12 months'}
              rows={view === 'hour' ? hourRows : rows}
              columns={view === 'hour' ? 24 : columns}
              columnLabels={
                view === 'year' ? year.monthLabels.map((entry) => ({ index: entry.week, label: entry.label })) : view === 'hour' ? hourColumnLabels : undefined
              }
            />
          )}
        </ChartCard>

        <ChartFoot>
          <HeatLegend
            levelTitle={(level) => levelTitle(level, view === 'hour' ? hourMetric : dayMetric)}
            showNotScanned={view !== 'hour' && inView.some(cell => !cell.scanned)}
          />
          {view === 'hour' && hoursCoverage.partial && hoursCoverage.known > 0 && (
            <Text role="meta">known for {hoursCoverage.known} of {hoursCoverage.total} agents</Text>
          )}
        </ChartFoot>
      </ChartFrame>
    </Section>
  )
}

const levelTitle = (level: number, metric: HeatMetric | 'calls'): string => {
  const noun = metric === 'tokens' ? 'tokens' : metric === 'calls' ? 'calls' : 'cost'
  if (level === 0) return `No ${noun}`
  return `Level ${level} of 4, by quartile`
}
