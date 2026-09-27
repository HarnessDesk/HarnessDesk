import { useMemo, type ReactNode } from 'react'

import type { LedgerReport, RuntimeId, UsageReport } from '@harnessdesk/protocol'

import { agentCoverage, cacheHitRate, paidPerTurn, paidRatio, perDay, tokenSplitCaption } from '../../lib/overview-strip'
import { paidSummary, periodBounds } from '../../lib/paid'
import { previousPeriod, stackDailyMetric, type ChartMetric } from '../../lib/ledger'
import { formatTokens } from '../../lib/context-usage'
import { formatMoney, provenanceLabel } from '../../lib/usage'
import { Button, ChartCard, ChartFrame, ChartTitle, Chip, Delta, Separator, Text } from '../../design'
import styles from './usage.module.css'

/** Which day-series the toggle picks — see `stackDailyMetric`'s own `ChartMetric`. */
export type StripMetric = Exclude<ChartMetric, 'cost'> | 'value'

/** `StripMetric` in `ChartMetric` terms — the only place the naming differs. */
export const stripChartMetric = (metric: StripMetric): ChartMetric => (metric === 'value' ? 'cost' : metric)

/**
 * The Overview strip — Paid, Value, Turns and Tokens for the same window the
 * Spend chart below draws.
 *
 * Design: `docs/usage-dashboard.md`, "The Overview strip". One bordered
 * object (`ChartFrame`/`ChartCard`, the same matted card the money chart
 * sits in), four cells on hairlines (`Separator`). Paid is a plain figure
 * with a caption that may link to Settings; Value, Turns and Tokens are each
 * a `Button` with `aria-pressed` that also switches the chart underneath —
 * clicking Turns is both "read the number" and "now the chart plots turns
 * per day". Every number here is read off `LedgerReport`/`UsageReport`
 * already loaded for the money band; nothing on this component issues a
 * query of its own.
 *
 * `size="pattern"` on every `Button` here is deliberate: that size carries
 * none of the primitive's own box (height, padding, radius — see
 * `design/ui/button.tsx`'s own comment on it), so this cell's shape is
 * exactly the same flex column every other cell uses, laid out with the
 * design system's layout utilities rather than a second box the button
 * would otherwise impose.
 */
export const OverviewStrip = ({
  reports,
  ledger,
  wideLedger,
  range,
  now,
  metric,
  onMetricChange,
  onOpenPlan,
}: {
  /** Every account in scope — already filtered by the header's account scope. */
  reports: readonly UsageReport[]
  ledger: LedgerReport | null
  /** Twice `range`'s window, for the previous-period comparison — the same query `Spend` reads. */
  wideLedger: LedgerReport | null
  range: number
  now: number
  metric: StripMetric
  onMetricChange: (metric: StripMetric) => void
  onOpenPlan: (runtime: RuntimeId) => void
}) => {
  const { start, end } = useMemo(() => periodBounds(range, now), [range, now])
  const previousBounds = useMemo(() => {
    const prevEnd = new Date(start)
    prevEnd.setDate(prevEnd.getDate() - 1)
    return periodBounds(range, prevEnd.getTime())
  }, [start, range])

  const billingOf = (report: UsageReport) => ({ billing: report.billing })
  const currentPaid = useMemo(() => paidSummary(reports.map(billingOf), start, end, now), [reports, start, end, now])
  const previousPaid = useMemo(
    () => paidSummary(reports.map(billingOf), previousBounds.start, previousBounds.end, previousBounds.end),
    [reports, previousBounds],
  )
  const paidChange =
    currentPaid.amount !== null && previousPaid.amount !== null && previousPaid.amount !== 0
      ? ((currentPaid.amount - previousPaid.amount) / previousPaid.amount) * 100
      : null

  const currentCost = ledger?.totalCost ?? null
  const costPrevious = useMemo(
    () => previousPeriod(stackDailyMetric(wideLedger, now, 'cost'), range, currentCost ?? 0),
    [wideLedger, now, range, currentCost],
  )
  const valueChange = currentCost !== null && costPrevious.complete ? costPrevious.change : null

  const currentTurns = ledger?.totals?.turns ?? null
  const turnsPrevious = useMemo(
    () => previousPeriod(stackDailyMetric(wideLedger, now, 'turns'), range, currentTurns ?? 0),
    [wideLedger, now, range, currentTurns],
  )
  const turnsChange = currentTurns !== null && turnsPrevious.complete ? turnsPrevious.change : null

  const currentTokens = ledger?.totalTokens ?? null
  const tokensPrevious = useMemo(
    () => previousPeriod(stackDailyMetric(wideLedger, now, 'tokens'), range, currentTokens ?? 0),
    [wideLedger, now, range, currentTokens],
  )
  const tokensChange = currentTokens !== null && tokensPrevious.complete ? tokensPrevious.change : null

  const coverage = useMemo(
    () => agentCoverage(ledger?.coverage, reports.map((report) => report.runtime)),
    [ledger, reports],
  )
  const cacheHit = cacheHitRate(ledger?.totals)
  const ratio = paidRatio(currentCost, currentPaid.amount)
  const perTurn = paidPerTurn(currentPaid.amount, currentTurns)
  const missingFeeReport = useMemo(
    () => reports.find((report) => paidSummary([billingOf(report)], start, end, now).amount === null),
    [reports, start, end, now],
  )

  const linkFor = (runtime: RuntimeId | undefined): (() => void) | undefined =>
    runtime !== undefined ? () => onOpenPlan(runtime) : undefined

  const paidCaption: ReactNode[] = []
  if (currentPaid.missingFeeCount > 0) {
    paidCaption.push(
      <CaptionLink key="missing" onClick={linkFor(missingFeeReport?.runtime)}>
        fee not set for {currentPaid.missingFeeCount}
      </CaptionLink>,
    )
  }
  if (currentPaid.otherCurrencies) paidCaption.push(<span key="other">+ other currencies</span>)

  return (
    <ChartFrame className={styles.strip} aria-label="What it cost, in brief">
      <ChartCard className={styles.stripRow}>
        <div className={styles.stripCell}>
          <Text role="meta">Paid</Text>
          <div className={styles.stripFigureLine}>
            <ChartTitle figure>
              {currentPaid.amount === null ? '—' : formatMoney(currentPaid.amount, currentPaid.currency ?? 'USD')}
            </ChartTitle>
            {paidChange !== null && <Delta value={Math.round(paidChange)} better="down" />}
          </div>
          {currentPaid.amount === null ? (
            <Text role="meta" className={styles.stripCaption}>
              <CaptionLink onClick={linkFor(reports[0]?.runtime)}>Set plan prices</CaptionLink>
            </Text>
          ) : (
            paidCaption.length > 0 && (
              <Text role="meta" className={styles.stripCaption}>
                {paidCaption}
              </Text>
            )
          )}
        </div>

        <Separator orientation="vertical" className={`h-auto! self-stretch ${styles.stripDivider}`} />

        <Button
          size="pattern"
          variant="quiet"
          className={styles.stripCell}
          aria-pressed={metric === 'value'}
          aria-label="Value — switch the chart below to cost per day"
          onClick={() => onMetricChange('value')}
        >
          <Text role="meta">{ledger ? provenanceLabel(ledger) : 'Value'}</Text>
          <div className={styles.stripFigureLine}>
            <ChartTitle figure>
              {ledger === null ? '—' : ledger.totalCost === null ? 'unpriced' : formatMoney(ledger.totalCost, ledger.currency)}
            </ChartTitle>
            {valueChange !== null && <Delta value={Math.round(valueChange)} better="down" tone="neutral" />}
          </div>
          <Text role="meta" tone={ratio !== null && ratio >= 1 ? 'success' : undefined} className={styles.stripCaption}>
            {ratio !== null
              ? `${ratio.toFixed(1)}× paid`
              : currentCost !== null
                ? `${formatMoney(perDay(currentCost, range) ?? 0, ledger?.currency ?? 'USD')} a day`
                : ''}
          </Text>
        </Button>

        <Separator orientation="vertical" className={`h-auto! self-stretch ${styles.stripDivider}`} />

        <Button
          size="pattern"
          variant="quiet"
          className={styles.stripCell}
          aria-pressed={metric === 'turns'}
          aria-label="Turns — switch the chart below to turns per day"
          onClick={() => onMetricChange('turns')}
        >
          <Text role="meta">Turns</Text>
          <div className={styles.stripFigureLine}>
            <ChartTitle figure>{currentTurns !== null ? currentTurns.toLocaleString() : '—'}</ChartTitle>
            {turnsChange !== null && <Delta value={Math.round(turnsChange)} better="down" tone="neutral" />}
          </div>
          <Text role="meta" className={styles.stripCaption}>
            {perTurn !== null
              ? `${formatMoney(perTurn, currentPaid.currency ?? 'USD')} paid a turn`
              : coverage.partial
                ? `known for ${coverage.known} of ${coverage.total} agents`
                : ''}
          </Text>
        </Button>

        <Separator orientation="vertical" className={`h-auto! self-stretch ${styles.stripDivider}`} />

        <Button
          size="pattern"
          variant="quiet"
          className={styles.stripCell}
          aria-pressed={metric === 'tokens'}
          aria-label="Tokens — switch the chart below to tokens per day"
          onClick={() => onMetricChange('tokens')}
        >
          <Text role="meta">Tokens</Text>
          <div className={styles.stripFigureLine}>
            <ChartTitle figure>{currentTokens !== null ? formatTokens(currentTokens) : '—'}</ChartTitle>
            {cacheHit !== null && (
              <Chip size="sm" tone="neutral">
                {Math.round(cacheHit)}% cached
              </Chip>
            )}
            {tokensChange !== null && <Delta value={Math.round(tokensChange)} better="down" tone="neutral" />}
          </div>
          <Text role="meta" className={styles.stripCaption}>
            {coverage.partial
              ? `known for ${coverage.known} of ${coverage.total} agents`
              : (tokenSplitCaption(ledger?.totals) ?? '')}
          </Text>
        </Button>
      </ChartCard>
    </ChartFrame>
  )
}

/** A caption's own actionable half — plain text everywhere else, an inline link only where it does something. */
const CaptionLink = ({ onClick, children }: { onClick?: () => void; children: ReactNode }) =>
  onClick ? (
    <Button variant="link" size="pattern" onClick={onClick}>
      {children}
    </Button>
  ) : (
    <>{children}</>
  )
