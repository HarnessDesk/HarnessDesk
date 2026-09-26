import { useEffect, useMemo, useState } from 'react'

import type { LedgerReport, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import {
  busiestDay,
  busiestWeekday,
  buildAgentRows,
  buildRecentDays,
  buildYearGrid,
  dayLabelLong,
  isUnpricedCost,
  leadingAgent,
  quartileLevels,
  streaksFor,
  WEEKDAY_NAMES,
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
  type HeatGridCell,
  type HeatGridRow,
  type HeatGridTooltip,
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
 * The arithmetic — which day is "not scanned" rather than empty, where the
 * quartile breakpoints fall, the streaks, the busiest day — lives in
 * `lib/heat.ts` and is tested without a browser; this file only draws, the
 * rule the rest of the Dashboard keeps.
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
}: {
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  scope: RuntimeId | null
  now: number
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
  }, [store, scope])

  const currency = ledger?.currency ?? 'USD'
  const format = (value: number): string => (metric === 'tokens' ? formatTokens(value) : (formatMoney(value, currency) ?? '—'))
  const nameOf = (id: RuntimeId): string => byId.get(id)?.presentation.name ?? String(id)
  const markOf = (id: RuntimeId): RuntimeInfo => byId.get(id) ?? ({ id, presentation: { name: String(id) } } as RuntimeInfo)

  const year = useMemo(() => buildYearGrid(ledger, now), [ledger, now])
  const yearCells = useMemo(() => year.weeks.flatMap((week) => week.filter((cell): cell is HeatCell => cell !== null)), [year])

  const recentCells = useMemo(() => buildRecentDays(ledger, now, AGENT_SPAN_DAYS), [ledger, now])
  const agentRows = useMemo(() => buildAgentRows(recentCells, metric), [recentCells, metric])

  const inView = view === 'year' ? yearCells : recentCells
  const levelOf = useMemo(
    () => quartileLevels(inView.map((cell) => (metric === 'tokens' ? cell.tokens : cell.cost))),
    [inView, metric],
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

  const cellLabel = (cell: HeatCell): string => {
    if (!cell.scanned) return `${dayLabelLong(cell.day)}: not scanned`
    if (metric === 'cost' && isUnpricedCost(cell)) return `${dayLabelLong(cell.day)}: usage recorded, not priced`
    const value = metric === 'tokens' ? cell.tokens : cell.cost
    if (value <= 0) return `${dayLabelLong(cell.day)}: nothing`
    return `${dayLabelLong(cell.day)}: ${formatTokens(cell.tokens)} tokens, ${formatMoney(cell.cost, currency) ?? 'unpriced'}`
  }

  const toGridCell = (cell: HeatCell): HeatGridCell => {
    const value = metric === 'tokens' ? cell.tokens : cell.cost
    const notScanned = !cell.scanned || (metric === 'cost' && isUnpricedCost(cell))
    const parts = [...cell.parts].sort((a, b) => (metric === 'tokens' ? b.tokens - a.tokens : b.cost - a.cost))
    const top = parts.slice(0, 3)
    const rest = parts.length - top.length

    const tooltip: HeatGridTooltip | undefined =
      cell.scanned && !notScanned && value > 0
        ? {
            title: dayLabelLong(cell.day),
            rows: top.map((part) => ({
              key: String(part.runtime),
              label: nameOf(part.runtime),
              value: metric === 'tokens' ? formatTokens(part.tokens) : (formatMoney(part.cost, currency) ?? '—'),
            })),
            more: rest > 0 ? rest : undefined,
            footer: { label: 'Total', value: `${formatTokens(cell.tokens)} tokens · ${formatMoney(cell.cost, currency) ?? '—'}` },
          }
        : notScanned
          ? { title: dayLabelLong(cell.day), note: cellLabel(cell).split(': ')[1] ?? cellLabel(cell) }
          : undefined

    return {
      key: String(cell.day),
      level: notScanned ? 0 : levelOf(value),
      state: notScanned ? 'not-scanned' : value > 0 ? 'filled' : 'empty',
      today: cell.day === todayKey,
      ariaLabel: cellLabel(cell),
      tooltip,
    }
  }

  const rows: readonly HeatGridRow[] =
    view === 'year'
      ? WEEKDAY_NAMES.map((name, weekday) => ({
          key: name,
          header: weekday % 2 === 0 ? <Text role="meta">{name.slice(0, 3)}</Text> : undefined,
          cells: year.weeks.map((week) => {
            const cell = week[weekday]
            return cell ? toGridCell(cell) : null
          }),
        }))
      : agentRows.map((row) => ({
          key: String(row.runtime),
          header: (
            <span className="flex items-center gap-1.5">
              <RuntimeMark runtime={markOf(row.runtime)} size={13} />
              <Text role="row">{nameOf(row.runtime)}</Text>
              <Text role="meta">{format(row.total)}</Text>
            </span>
          ),
          cells: row.cells.map((cell) => toGridCell(cell)),
        }))

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
            <Text role="metric">{format(total)}</Text>
            <Text role="meta">{view === 'year' ? 'this year' : 'last 13 weeks'}</Text>
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
            <Text role="metric">{busiest ? format(metric === 'tokens' ? busiest.tokens : busiest.cost) : '—'}</Text>
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
