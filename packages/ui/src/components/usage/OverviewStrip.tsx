import { useMemo, type ReactNode } from 'react'

import type { LedgerReport, RuntimeId, UsageReport } from '@harnessdesk/protocol'

import {
  agentCoverage,
  cacheHitRate,
  ledgerRuntimeIds,
  paidPerTurn,
  paidRatio,
  paidRatioCaption,
  paidScopeMatchesLedger,
  perDay,
  tokenCoverage,
  tokenSplitCaption,
} from '../../lib/overview-strip'
import { cycleStartFromLanes, paidSummary, periodBounds } from '../../lib/paid'
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
 * with a caption that may link to Settings and has no delta of its own —
 * there is no billing history yet to compare a past Paid against, so any
 * change would only be measuring today's fee applied to the past. Value,
 * Turns and Tokens are each a `Button` with `aria-pressed` that also
 * switches the chart underneath — clicking Turns is both "read the number"
 * and "now the chart plots turns per day". Every number here is read off
 * `LedgerReport`/`UsageReport` already loaded for the money band; nothing on
 * this component issues a query of its own.
 *
 * The three cells are `size="panel"` — `h-auto w-full p-4 whitespace-normal`,
 * a named `Button` size meant for exactly this shape (a bigger, auto-height
 * tile), not the `pattern` escape hatch: `pattern` leaves a control's whole
 * box to a design-system pattern's own stylesheet, which
 * `script/ui-architecture.mjs`'s `screen-pattern-button` rule refuses from a
 * screen for precisely that reason — a screen picks a named size, or
 * composes an existing pattern, but never reaches for the size that assumes
 * it *is* one. The caption's own inline link is `size="content"` instead
 * (`h-auto p-0 whitespace-normal`), the named size for a button with no box
 * of its own at all. `items-start` on each button overrides the box's own
 * `items-center` (`design/ui/button.tsx`'s `BOX`), so all four cells —
 * Paid included — read left-aligned rather than the buttons centring their
 * content against Paid's own flush-left text.
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

  const billingOf = (report: UsageReport) => ({
    billing: report.billing,
    cycleStart: cycleStartFromLanes(report.lanes),
  })
  const currentPaid = useMemo(
    () => paidSummary(reports.map(billingOf), start, end, ledger?.currency ?? null),
    [reports, start, end, ledger?.currency],
  )

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

  const turnsCoverage = useMemo(() => agentCoverage(ledger?.coverage, ledgerRuntimeIds(ledger)), [ledger])
  const tokensCoverage = useMemo(() => tokenCoverage(ledger), [ledger])
  const cacheHit = cacheHitRate(ledger?.totals)

  // Value's ratio and Turns' per-turn price only mean what they claim when
  // Paid covers the same scope Value and Turns do — see
  // `paidScopeMatchesLedger`'s own doc comment. Otherwise they fall back to
  // a plain per-day average and the coverage caption, rather than dividing
  // numbers that answer different questions.
  const scopeMatches = paidScopeMatchesLedger(currentPaid, ledger?.currency ?? null)
  const ratio = scopeMatches ? paidRatio(currentCost, currentPaid.amount) : null
  const perTurn = scopeMatches ? paidPerTurn(currentPaid.amount, currentTurns) : null

  const missingFeeReport = useMemo(
    () => reports.find((report) => paidSummary([billingOf(report)], start, end).amount === null),
    [reports, start, end],
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
  if (currentPaid.overageAside !== null && currentPaid.currency !== null) {
    paidCaption.push(
      <span key="overage">+ {formatMoney(currentPaid.overageAside, currentPaid.currency)} overage this cycle</span>,
    )
  }
  for (const other of currentPaid.otherCurrencyTotals) {
    paidCaption.push(<span key={`other-${other.currency}`}>+ {formatMoney(other.amount, other.currency)}</span>)
  }
  for (const other of currentPaid.otherCurrencyOverageAsides) {
    paidCaption.push(
      <span key={`overage-${other.currency}`}>
        + {formatMoney(other.amount, other.currency)} overage this cycle
      </span>,
    )
  }

  return (
    <ChartFrame className={styles.strip} aria-label="What it cost, in brief">
      <ChartCard className={styles.stripRow}>
        <div className={styles.stripCell}>
          <Text role="meta">Paid</Text>
          <div className={styles.stripFigureLine}>
            <ChartTitle figure>
              {currentPaid.amount === null ? '—' : formatMoney(currentPaid.amount, currentPaid.currency ?? 'USD')}
            </ChartTitle>
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

        <div role="group" aria-label="Chart measure" className="contents">
          <Button
            size="panel"
            variant="quiet"
            className={`${styles.stripCell} items-start text-left`}
            aria-pressed={metric === 'value'}
            title="Value — switch the chart below to cost per day"
            onClick={() => onMetricChange('value')}
          >
            <Text role="meta">{ledger ? provenanceLabel(ledger) : 'Value'}</Text>
            <div className={styles.stripFigureLine}>
              <ChartTitle figure>
                {ledger === null ? '—' : ledger.totalCost === null ? 'unpriced' : formatMoney(ledger.totalCost, ledger.currency)}
              </ChartTitle>
              {valueChange !== null && <Delta value={Math.round(valueChange)} better="down" tone="neutral" />}
            </div>
            <Text
              role="meta"
              tone={ratio === null ? undefined : ratio >= 1 ? 'neutral' : 'warning'}
              className={styles.stripCaption}
            >
              {ratio !== null
                ? paidRatioCaption(ratio)
                : currentCost !== null
                  ? `${formatMoney(perDay(currentCost, range) ?? 0, ledger?.currency ?? 'USD')} a day`
                  : ''}
            </Text>
          </Button>

          <Separator orientation="vertical" className={`h-auto! self-stretch ${styles.stripDivider}`} />

          <Button
            size="panel"
            variant="quiet"
            className={`${styles.stripCell} items-start text-left`}
            aria-pressed={metric === 'turns'}
            title="Turns — switch the chart below to turns per day"
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
                : turnsCoverage.partial
                  ? `known for ${turnsCoverage.known} of ${turnsCoverage.total} agents`
                  : ''}
            </Text>
          </Button>

          <Separator orientation="vertical" className={`h-auto! self-stretch ${styles.stripDivider}`} />

          <Button
            size="panel"
            variant="quiet"
            className={`${styles.stripCell} items-start text-left`}
            aria-pressed={metric === 'tokens'}
            title="Tokens — switch the chart below to tokens per day"
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
              {tokensCoverage.partial
                ? `known for ${tokensCoverage.known} of ${tokensCoverage.total} agents`
                : (tokenSplitCaption(ledger?.totals) ?? '')}
            </Text>
          </Button>
        </div>
      </ChartCard>
    </ChartFrame>
  )
}

/** A caption's own actionable half — plain text everywhere else, an inline link only where it does something. */
const CaptionLink = ({ onClick, children }: { onClick?: () => void; children: ReactNode }) =>
  onClick ? (
    // `chip` is the size that pairs the caption's type step with the target
    // floor (`min-h-(--hd-target-min)`); a bare caption-height link sat under
    // it at 15px (target-floor.spec).
    <Button variant="link" size="chip" onClick={onClick}>
      {children}
    </Button>
  ) : (
    <>{children}</>
  )
