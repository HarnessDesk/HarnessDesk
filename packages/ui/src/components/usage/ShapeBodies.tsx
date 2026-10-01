import type { RuntimeInfo, UsageReport } from '@harnessdesk/protocol'
import { bindingLane } from '@harnessdesk/protocol'

import {
  feePerUnitOf,
  moneyRowOf,
  runwayDaysOf,
  SHAPE_LABEL,
  type PlanRow,
} from '../../lib/plans-table'
import { balanceSeries } from '../../lib/balance-series'
import { dayLabelWithYear } from '../../lib/ledger'
import { formatMoney } from '../../lib/usage'
import {
  ChartAxis,
  ChartCard,
  ChartFrame,
  DayColumns,
  Chip,
  Progress,
  Separator,
  Text,
  ToolbarGap,
  tintFor,
} from '../../design'
import { PlanFrame } from './PlanFrame'
import styles from './usage.module.css'

/**
 * The five shape bodies the table expands into, beside Windows (which reuses
 * `Card` verbatim — see `PlansTable.tsx`). Each composes `PlanFrame` with its
 * own content; none of them draw a header, a footer or a money row of their
 * own — that would be the appearance `PlanFrame` already owns, drawn twice.
 */

const ShapeChip = ({ shape }: { shape: PlanRow['shape'] }) =>
  shape === 'none' ? null : <Chip variant="outline" label={SHAPE_LABEL[shape]} tone="neutral" />

/** A figure in a lane's own unit, money formatted when the unit is money (review of #1069, N7). */
const laneAmount = (value: number, unit: string | undefined): string =>
  unit === 'usd' ? (formatMoney(value) ?? `${value}`) : `${value.toLocaleString()}${unit ? ` ${unit}` : ''}`

export const AllowanceBody = ({
  row,
  info,
  now,
  onRefresh,
}: {
  row: PlanRow
  info: RuntimeInfo | null
  now: number
  onRefresh: () => void
}) => {
  const report = row.report
  const lane = bindingLane(report.lanes)
  const planLanes = report.lanes.filter((one) => one.layer !== 'overage')
  const overageLanes = report.lanes.filter((one) => one.layer === 'overage')
  const overage = report.billing?.overage
  // The On-demand line restates the Overage lane when one is already drawn
  // below — "On-demand $5.00" over "Overage $5.00 of $20.00" said the same
  // spend twice (review of #1069, N7).
  const showOnDemandLine = overageLanes.length === 0
  const perUnit = feePerUnitOf(report.billing?.fee, lane)
  return (
    <PlanFrame
      report={report}
      info={info}
      shape={row.shape}
      shapeChip={<ShapeChip shape={row.shape} />}
      status={row.status}
      money={moneyRowOf(report, now)}
      footerAction={{ label: 'Refresh', onClick: onRefresh }}
    >
      <div className={styles.heroFigure}>
        <Text role="figure">
          {lane && lane.limit != null && lane.used != null
            ? laneAmount(Math.max(0, lane.limit - lane.used), lane.unit)
            : // No limit/used to report — a plain percent lane, Cursor's own
              // request-summary shape among them. This headline is the only
              // place this account's own figure appears at all (unlike the
              // table's Amount column, which sits beside its own % column and
              // reads the lane's label instead, `ownUnitOf`'s own rule) so it
              // keeps the number, in the vocabulary this card's headline
              // always uses: "left".
              row.left.percent !== null
              ? `${row.left.percent}% left`
              : '—'}
        </Text>
        {/* Only when the figure is a bare amount ("312") does the subtitle
            say what it is a remainder of ("of 500 left") — the headline
            above already says "left" itself for a plain percent lane, so a
            second, unconditional "left" here repeated the word on the same
            line for exactly the lanes with no `limit`/`used` to report
            (review of #1069, N6, round 2). */}
        <Text role="muted">
          {lane && lane.limit != null && lane.used != null ? `of ${laneAmount(lane.limit, lane.unit)} left` : ''}
        </Text>
        <ToolbarGap />
        {row.approxTurns !== '—' && <Chip label={`≈ ${row.approxTurns.replace('~', '')} turns`} tone="neutral" />}
      </div>

      <div className={styles.lanes}>
        <Separator />
        <LaneRow title="Plan" lanes={planLanes} />
        {showOnDemandLine && (
          <div className={styles.statLine}>
            <Text role="meta">On-demand</Text>
            <Text role="row" numeric>
              {!overage || !overage.enabled ? 'off' : (formatMoney(overage.spent ?? 0, overage.currency) ?? '—')}
            </Text>
          </div>
        )}
        {overageLanes.length > 0 && <LaneRow title="Overage" lanes={overageLanes} />}
      </div>

      <div className={styles.statLine}>
        <Text role="meta">Per turn</Text>
        <Text role="row" numeric>
          {report.turns?.unitsPerTurn != null ? `${report.turns.unitsPerTurn.toLocaleString()} ${lane?.unit ?? 'units'}` : '—'}
          {perUnit !== null ? ` · ${formatMoney(perUnit) ?? perUnit} a unit` : ''}
        </Text>
      </div>
    </PlanFrame>
  )
}

/** "29% of session left · 313 of 500 used" — left and used never share one scale (review of #1069, N6). */
const LaneRow = ({ title, lanes }: { title: string; lanes: UsageReport['lanes'] }) => {
  if (lanes.length === 0) return null
  return (
    <div className={styles.statLine}>
      <Text role="meta">{title}</Text>
      <Text role="row" numeric>
        {lanes
          .map((one) => {
            if (one.used == null || one.limit == null) return `${100 - one.usedPercent}% left`
            return `${laneAmount(one.used, one.unit)} of ${laneAmount(one.limit, one.unit)} used`
          })
          .join(' · ')}
      </Text>
    </div>
  )
}

export const BalanceBody = ({
  row,
  info,
  now,
  onRefresh,
}: {
  row: PlanRow
  info: RuntimeInfo | null
  now: number
  onRefresh: () => void
}) => {
  const report = row.report
  const balance = report.credits?.remaining ?? null
  const unit = report.credits?.unit ?? 'USD'
  const history = report.balanceHistory
  const historyDays = balanceSeries(history, now)
  const chartUnit = history?.unit ?? unit
  const formatBalance = (value: number): string =>
    chartUnit === 'USD' ? (formatMoney(value) ?? `${value}`) : `${value.toLocaleString()} ${chartUnit}`
  const historyBuckets = historyDays.map((day) => ({
    label: dayLabelWithYear(day.day),
    total: day.remaining,
    parts: [day.remaining],
    unknown: day.unknown,
  }))
  const historyCeiling = Math.max(0, ...historyDays.map((day) => day.remaining))
  const days = runwayDaysOf(report)
  const out = balance !== null && balance <= 0
  return (
    <PlanFrame
      report={report}
      info={info}
      shape={row.shape}
      shapeChip={<ShapeChip shape={row.shape} />}
      status={row.status}
      money={moneyRowOf(report, now)}
      footerAction={{ label: 'Refresh', onClick: onRefresh }}
    >
      <div className={styles.heroFigure}>
        <Text role="figure" tone={out ? 'danger' : undefined}>
          {balance === null ? '—' : unit === 'USD' ? (formatMoney(balance) ?? `${balance}`) : `${balance.toLocaleString()} ${unit}`}
        </Text>
        <Text role="muted">left</Text>
      </div>
      {out ? (
        <Text as="div" role="muted" tone="danger">Out — top up to continue.</Text>
      ) : (
        <>
          <div className={styles.statLine}>
            <Text role="meta">Runway</Text>
            <Text role="row" numeric>{days === null ? '—' : `${Math.round(days)}d`}</Text>
          </div>
          <div className={styles.statLine}>
            <Text role="meta">Rate</Text>
            <Text role="row" numeric>
              {days === null || balance === null ? '—' : `${formatMoney(balance / days) ?? '—'} a day`}
            </Text>
          </div>
        </>
      )}
      {history && history.points.length >= 2 ? (
        <ChartFrame aria-label="Balance history">
          <ChartCard>
            <DayColumns
              buckets={historyBuckets}
              series={[{ key: 'balance', label: 'Balance', tint: tintFor('balance') }]}
              format={formatBalance}
              label={`Balance per day for the last ${historyDays.length} days`}
              emptyLabel="No balance recorded"
              mode="line"
              today={historyBuckets.length - 1}
              axisTicks={[0, historyCeiling / 2, historyCeiling]}
            />
            <ChartAxis
              start={historyDays[0] ? dayLabelWithYear(historyDays[0].day) : ''}
              end={historyDays.at(-1) ? dayLabelWithYear(historyDays.at(-1)!.day) : ''}
            />
          </ChartCard>
        </ChartFrame>
      ) : (
        <Text as="div" role="meta">Balance history starts with the next reading</Text>
      )}
    </PlanFrame>
  )
}

export const KeyBody = ({
  row,
  info,
  now,
  onRefresh,
  onOpenPlanSettings,
}: {
  row: PlanRow
  info: RuntimeInfo | null
  now: number
  onRefresh: () => void
  /** Opens this account's own Plan card in Settings — where a budget is actually set (review of #1069, B5). */
  onOpenPlanSettings: () => void
}) => {
  const report = row.report
  const budget = report.billing?.budget
  const spend = report.spend
  const spent = report.billing?.overage?.spent ?? spend?.windowCost ?? null
  return (
    <PlanFrame
      report={report}
      info={info}
      shape={row.shape}
      shapeChip={<ShapeChip shape={row.shape} />}
      status={row.status}
      money={moneyRowOf(report, now)}
      onOpenPlanSettings={onOpenPlanSettings}
      footerAction={{ label: budget ? 'Edit budget' : 'Set a budget', onClick: onOpenPlanSettings }}
    >
      <div className={styles.heroFigure}>
        <Text role="figure">{spent === null ? '—' : (formatMoney(spent, budget?.currency) ?? `${spent}`)}</Text>
        <Text role="muted">spent this month</Text>
      </div>
      {budget ? (
        <div className={styles.lanes}>
          <Separator />
          <Progress
            value={row.left.percent}
            measure="remaining"
            size="sm"
            aria-label={`Budget — what is left of ${formatMoney(budget.amount, budget.currency) ?? budget.amount}`}
          />
          {/* `row.left.percent` is null both with no budget (not this branch)
              and with a budget whose spend is unknown — "No budget set."
              used to print in the second case too, on an account that very
              much has one (review of #1069, N10). */}
          <Text role="meta">
            {row.left.percent === null ? 'Spend not known yet.' : `${Math.round(row.left.percent)}% of the budget left`}
          </Text>
        </div>
      ) : (
        <Text as="div" role="meta">No budget · Set a budget on this account's Plan card in Settings.</Text>
      )}
    </PlanFrame>
  )
}

export const FreeBody = ({ row, info, now }: { row: PlanRow; info: RuntimeInfo | null; now: number }) => {
  const report = row.report
  const turns = report.turns
  return (
    <PlanFrame
      report={report}
      info={info}
      shape={row.shape}
      shapeChip={<ShapeChip shape={row.shape} />}
      status={row.status}
      money={moneyRowOf(report, now)}
      footerAction={null}
    >
      <div className={styles.statLine}>
        <Text role="meta">Tokens this period</Text>
        <Text role="row" numeric>{row.ownUnit}</Text>
      </div>
      <div className={styles.statLine}>
        <Text role="meta">Turns</Text>
        <Text role="row" numeric>{turns ? turns.count.toLocaleString() : '—'}</Text>
      </div>
      {row.ownUnit === '—' && turns === null && <Text as="div" role="meta">Nothing recorded yet.</Text>}
    </PlanFrame>
  )
}
