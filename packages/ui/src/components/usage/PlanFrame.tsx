import type { ReactNode } from 'react'

import type { RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { cn } from '@/lib/utils'
import { paletteTone } from '../../lib/limits'
import { planLabel } from '../../lib/usage'
import { formatMoney } from '../../lib/usage'
import { STATUS_LABEL, STATUS_TONE, type MoneyRow, type RowShape, type RowStatus } from '../../lib/plans-table'
import { RuntimeMark } from '../BrandIcons'
import {
  Button,
  Card as SurfaceCard,
  CardContent,
  CardFooter,
  CardHeader,
  Chip,
  ToolbarGap,
  Text,
} from '../../design'
import styles from './usage.module.css'

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
  const agent = info?.presentation.name ?? String(report.runtime)
  const plan = planLabel(report.plan)
  return (
    <SurfaceCard as="article" className={styles.frame} data-shape={shape}>
      {/* See `shared.tsx`'s own `Card` for why this needs utilities rather
          than the CSS module's `display: flex` alone (review of #1069, N9). */}
      <CardHeader className={cn(styles.frameHead, 'flex items-center gap-(--hd-space-1-5)')}>
        {info && (
          <Text role="muted" className={styles.cardMark}>
            <RuntimeMark runtime={info} size={15} />
          </Text>
        )}
        <Text role="subject" truncate className={styles.cardName}>{report.account ?? agent}</Text>
        {report.account && <Text role="meta" truncate className={styles.cardAgent}>{agent}</Text>}
        <ToolbarGap />
        {shapeChip}
        {plan && <Chip label={plan} tone="neutral" />}
        <Chip tone={paletteTone(STATUS_TONE[status])} label={STATUS_LABEL[status]} />
      </CardHeader>

      <MoneyRowView money={money} onOpenPlanSettings={onOpenPlanSettings} />

      <CardContent className={styles.frameBody}>{children}</CardContent>

      <CardFooter className={styles.cardFoot}>
        <Text role="meta" truncate className={styles.cardSource}>{report.source.label}</Text>
        <ToolbarGap />
        {footerAction && (
          <Button variant="outline" size="sm" onClick={footerAction.onClick}>
            {footerAction.label}
          </Button>
        )}
      </CardFooter>
    </SurfaceCard>
  )
}

/**
 * "Value $31.00 · $20.00 a month · you set this" — or "Fee not set", a link
 * to the account's own Plan card rather than a figure.
 *
 * Paid — the fee prorated across the window, plus overage only when it
 * applies to this period — is `lib/paid.ts`'s own definition (#1068); this
 * row draws only what this PR itself decides: the window's own Value, never
 * unpriced as $0, and the fee exactly as it is set, or an invitation to set
 * one. Withheld entirely with neither a fee nor a priced window to show.
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
    <CardContent className={styles.frameMoney}>
      <Text role="meta">Value</Text>
      <Text role="value" numeric>{value}</Text>
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
    </CardContent>
  )
}
