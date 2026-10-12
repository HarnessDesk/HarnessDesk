import type { ReactNode } from 'react'

import type { RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { paidRatioCaption } from '../../lib/overview-strip'
import { planLabel } from '../../lib/usage'
import { formatMoney } from '../../lib/usage'
import { statusPresentation, type MoneyRow, type RowShape, type RowStatus } from '../../lib/plans-table'
import { RuntimeMark } from '../BrandIcons'
import {
  Button,
  Card as SurfaceCard,
  DashboardAccountHead, DashboardAccountBody, DashboardAccountFoot, DashboardMoney,
  Chip,
  Text,
} from '../../design'

/**
 * The frame every one of the six shape bodies sits in — the header, footer
 * and (where it applies) the money row that `docs/usage-dashboard.md`'s
 * "The screen › Plans" describes once rather than six times.
 *
 * `Windows` alone skips this: its body is the existing `Card`
 * (`shared.tsx`), which already carries an equivalent header and footer, and
 * the header's `shapeChip`/`moneyRow` slots on that component are exactly
 * these two pieces so the two never draw a header two different ways.
 */
export const PlanFrame = ({
  report,
  info,
  shape,
  shapeChip,
  status,
  money,
  footerAction,
  onOpenPlanSettings,
  children,
}: {
  report: UsageReport
  info: RuntimeInfo | null
  shape: RowShape
  shapeChip: ReactNode
  status: RowStatus
  money: MoneyRow | null
  footerAction: { label: string; onClick: () => void } | null
  /** Opens this account's own Plan card — the money row's "Fee not set" link reads it too. */
  onOpenPlanSettings?: () => void
  children: ReactNode
}) => {
  const agent = info?.presentation.name ?? 'Agent'
  const plan = planLabel(report.plan)
  return (
    <SurfaceCard as="article" data-shape={shape}>
      {/* The canonical card inset holds the recorded heading and its state. */}
      <DashboardAccountHead mark={info ? <RuntimeMark runtime={info} size={15} /> : undefined}
        name={report.account ?? agent} agent={report.account ? agent : undefined}
        states={<>{shapeChip}{plan && <Chip label={plan} tone="neutral" />}<Chip tone={statusPresentation(status).tone} label={statusPresentation(status).label} /></>} />

      <MoneyRowView money={money} onOpenPlanSettings={onOpenPlanSettings} />

      <DashboardAccountBody>{children}</DashboardAccountBody>

      <DashboardAccountFoot source={report.source.label} actions={footerAction ? <Button variant="outline" size="sm" onClick={footerAction.onClick}>{footerAction.label}</Button> : undefined} />
    </SurfaceCard>
  )
}

/**
 * Paid, Value, the Value÷Paid chip, and the plan's own fee — or "Fee not set",
 * a link to the account's own Plan card rather than a figure. Overage outside
 * the window sits beside Paid in its own currency. Withheld entirely with
 * neither a fee nor a priced window to show.
 */
export const MoneyRowView = ({
  money,
  onOpenPlanSettings,
}: {
  money: MoneyRow | null
  onOpenPlanSettings?: () => void
}) => {
  if (!money) return null
  const value = money.value === null ? 'unpriced' : (formatMoney(money.value, money.currency) ?? `${money.value}`)
  const fee = money.fee
  return (
    <DashboardMoney>
      {fee && money.paid !== null && (
        <>
          <Text role="meta">Paid</Text>
          <Text role="value" numeric>{formatMoney(money.paid, fee.currency) ?? `${money.paid}`}</Text>
          {money.overageAside !== null && (
            <Text role="meta">
              + {formatMoney(money.overageAside, money.overageAsideCurrency ?? fee.currency) ?? `${money.overageAside}`} overage this cycle
            </Text>
          )}
        </>
      )}
      <Text role="meta">Value</Text>
      <Text role="value" numeric>{value}</Text>
      {fee && money.ratio !== null && (
        <Chip label={paidRatioCaption(money.ratio)} tone={money.ratio < 1 ? 'warning' : 'neutral'} />
      )}
      <Text role="meta">Fee</Text>
      {fee ? (
        <Text role="value" numeric>
          {formatMoney(fee.amount, fee.currency) ?? fee.amount} a {fee.period}
          {money.feeIsUser ? ' · you set this' : ''}
        </Text>
      ) : onOpenPlanSettings ? (
        <Button variant="ghost" size="sm" onClick={onOpenPlanSettings}>
          Fee not set
        </Button>
      ) : (
        <Text role="value">Fee not set</Text>
      )}
    </DashboardMoney>
  )
}
