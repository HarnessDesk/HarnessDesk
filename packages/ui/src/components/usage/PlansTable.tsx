import { useRef, useState } from 'react'

import type { RuntimeId, RuntimeInfo, UsagePreference } from '@harnessdesk/protocol'

import { usageReadingTone } from '../../lib/limits'
import {
  moneyRowOf,
  SHAPE_CHIP_LABEL,
  SHAPE_LABEL,
  STATUS_TONE,
  statusPresentation,
  type PlanRow,
  type RowShape,
  type ShapeCounts,
} from '../../lib/plans-table'
import {
  Button,
  Card as SurfaceCard,
  CardContent,
  Chip,
  EmptyState,
  Segmented,
  Progress,
  IconTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '../../design'
import { formatTokens } from '../../lib/context-usage'
import { accountActivitySummary, type AccountActivitySummary } from '../../lib/usage'
import { accountForUsage, defaultTint, runtimeAccountBadge } from '../../lib/accounts'
import type { AppSnapshot } from '../../state/store'
import { CaretIcon } from '../Icons'
import { RuntimeMark } from '../BrandIcons'
import { Card } from './shared'
import { AllowanceBody, BalanceBody, FreeBody, KeyBody } from './ShapeBodies'
import { MoneyRowView } from './PlanFrame'
import { entriesFromReports, NotReportingList } from './NotReporting'
import styles from './usage.module.css'

/**
 * The Plans table: shape filters above one table, one row per account, and
 * an expand-in-place into that account's own shape body.
 *
 * Design: `docs/usage-dashboard.md`, "The screen › Plans". One reading per
 * shape; the account's lanes, pace and money remain in its expanded detail.
 * The account cell is plain content and the trailing button owns disclosure.
 *
 * Built on `design/ui/table` — a real `<table>`, not a `Button` standing in
 * for a row (review of #1069, B8): a screen reader used to announce the
 * whole row as one long button name, with no column headers and a meter
 * nested inside it. Each row's trailing cell holds the disclosure control
 * (`aria-expanded`/`aria-controls`); the expanded body is a full-width row
 * of its own, `<TableCell colSpan>`.
 */

export type ShapeFilter = 'all' | RowShape

const SHAPE_FILTER_ORDER: readonly RowShape[] = ['windows', 'allowance', 'balance', 'metered', 'free', 'none']

export const ShapeFilters = ({
  counts,
  value,
  onChange,
}: {
  counts: ShapeCounts
  value: ShapeFilter
  onChange: (next: ShapeFilter) => void
}) => (
  <Segmented
    label="Filter accounts by shape"
    value={value}
    onChange={(next) => onChange(next as ShapeFilter)}
    options={[
      { value: 'all' as const, label: `All · ${counts.all}` },
      ...SHAPE_FILTER_ORDER.filter((shape) => counts[shape] > 0).map((shape) => ({ value: shape, label: `${SHAPE_CHIP_LABEL[shape]} · ${counts[shape]}` })),
    ]}
  />
)

// A not-reporting row has no shape to name — its own status chip already
// says "Not reporting"; this cell reads "—" rather than the same word twice
// beside it.
const ShapeChip = ({ shape }: { shape: RowShape }) =>
  shape === 'none' ? <Text role="muted">—</Text> : <Chip variant="outline" tone="neutral" label={SHAPE_LABEL[shape]} />

export const PlansTable = ({
  rows,
  byId,
  now,
  filter,
  preferenceFor,
  onRefreshAccount,
  onStopTracking,
  onOpenPlanSettings,
  initialExpanded = null,
  onSignIn,
  signInRuntimes,
  tintFor = defaultTint,
  snapshot = { accountsByRuntime: {}, accountPrefs: {} },
}: {
  /** Every row, already described and sorted — `planRows(...)`, computed once by the caller (review of #1069, B3) and never recomputed here. */
  rows: readonly PlanRow[]
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  now: number
  filter: ShapeFilter
  preferenceFor: (report: PlanRow['report']) => UsagePreference
  onRefreshAccount: (runtime: RuntimeId) => void
  onStopTracking: (runtime: RuntimeId) => void
  onOpenPlanSettings: (runtime: RuntimeId) => void
  /** Opens one row already expanded — the catalogue's own `row-expanded` case. */
  initialExpanded?: string | null
  onSignIn?: (runtime: RuntimeId) => void
  signInRuntimes?: ReadonlySet<RuntimeId>
  tintFor?: (runtime: RuntimeId, accountLabel: string | null) => import('../../design').Tint
  snapshot?: Pick<AppSnapshot, 'accountsByRuntime' | 'accountPrefs'>
}) => {
  const [expanded, setExpanded] = useState<string | null>(initialExpanded)
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const shown = filter === 'all' ? rows : rows.filter((row) => row.shape === filter)

  if (shown.length === 0) {
    return <EmptyState tight title="No account matches this filter" description="Try a different shape, or All." />
  }

  const collapse = (key: string): void => {
    setExpanded(null)
    buttonRefs.current.get(key)?.focus()
  }

  return (
    <SurfaceCard className={styles.plansTable} data-slot="plans-table">
      <Table containerClassName={styles.plansTableScroll}>
        <TableHeader>
          <TableRow>
            <TableHead className={styles.colAccount}>Account</TableHead>
            <TableHead className={styles.colStatus}>Status</TableHead>
            <TableHead className={styles.colLeft} numeric>Left</TableHead>
            <TableHead className={styles.colResets} collapseBelow="sm" numeric>Resets</TableHead>
            <TableHead className={styles.colDetails}><span className="sr-only">Details</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => {
            const info = byId.get(row.report.runtime) ?? null
            const account = accountForUsage(row.report.runtime, row.report.account, snapshot.accountsByRuntime)
            const badge = info && account ? runtimeAccountBadge(info, [...byId.values()], snapshot.accountsByRuntime, snapshot.accountPrefs, account) : undefined
            const isOpen = expanded === row.key
            const bodyId = `plans-row-body-${row.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
            const name = info?.presentation.name ?? String(row.report.runtime)
            const toggle = (): void => setExpanded(isOpen ? null : row.key)
            return (
              <TableRowGroup
                key={row.key}
                row={row}
                info={info}
                name={name}
                badge={badge}
                tint={tintFor(row.report.runtime, row.report.account)}
                onSignIn={onSignIn && signInRuntimes?.has(row.report.runtime) ? () => onSignIn(row.report.runtime) : undefined}
                bodyId={bodyId}
                isOpen={isOpen}
                onToggle={toggle}
                onCollapse={() => collapse(row.key)}
                buttonRef={(node) => {
                  if (node) buttonRefs.current.set(row.key, node)
                  else buttonRefs.current.delete(row.key)
                }}
                now={now}
                preference={preferenceFor(row.report)}
                onRefresh={() => onRefreshAccount(row.report.runtime)}
                onStopTracking={() => onStopTracking(row.report.runtime)}
                onOpenPlanSettings={() => onOpenPlanSettings(row.report.runtime)}
              />
            )
          })}
        </TableBody>
      </Table>
    </SurfaceCard>
  )
}

const shapeWords = (row: PlanRow): string => ({
  windows: `${row.view.hero?.title.toLowerCase() ?? 'plan'} window`,
  allowance: 'plan allowance', balance: 'prepaid balance', metered: 'metered key', free: 'free tier', none: 'plan usage unavailable',
})[row.shape]

const LeftCell = ({ row, name }: { row: PlanRow; name: string }) => {
  if (row.shape === 'free' || (row.shape === 'metered' && !row.report.billing?.budget)) return <Text role="muted">No limit</Text>
  if (row.shape === 'balance') return <div className="flex flex-col items-end">
    <Text role="value" numeric>{row.ownUnit.replace(/ balance$/, '')}</Text>
    {row.approxTurns !== '—' && <Text role="meta" numeric>≈ {row.approxTurns.replace(/^~/, '')} turns</Text>}
  </div>
  if (row.left.percent === null) return <Text role="meta">—</Text>
  return <div className={styles.plansReading}>
    <Progress value={row.left.percent} label={false} tone={statusPresentation(row.status).tone} aria-label={`${name} — what is left`} />
    <Text className={styles.plansPercent} role="value" numeric tone={usageReadingTone(STATUS_TONE[row.status])}>{Math.round(row.left.percent)}%</Text>
  </div>
}

const TableRowGroup = ({
  row,
  info,
  name,
  tint,
  badge,
  onSignIn,
  bodyId,
  isOpen,
  onToggle,
  onCollapse,
  buttonRef,
  now,
  preference,
  onRefresh,
  onStopTracking,
  onOpenPlanSettings,
}: {
  row: PlanRow
  info: RuntimeInfo | null
  name: string
  tint: import('../../design').Tint
  badge?: string
  onSignIn?: () => void
  bodyId: string
  isOpen: boolean
  onToggle: () => void
  onCollapse: () => void
  buttonRef: (node: HTMLButtonElement | null) => void
  now: number
  preference: UsagePreference
  onRefresh: () => void
  onStopTracking: () => void
  onOpenPlanSettings: () => void
}) => (
  <>
    <TableRow data-state={isOpen ? 'selected' : undefined}>
      <TableCell className={styles.colAccount} lead={info && <IconTile shape="face" badge={badge} {...(row.shape === 'metered' || row.shape === 'free' ? { tone: 'neutral' as const } : { tint })}><RuntimeMark runtime={info} /></IconTile>}>
        <span className={styles.plansName}>
          <Text role="subject" truncate>{row.report.account ?? name}</Text>
          <Text role="meta" truncate>{[row.report.account && name, shapeWords(row)].filter(Boolean).join(' · ')}</Text>
        </span>
      </TableCell>
      <TableCell className={styles.colStatus}>
        <Chip tone={statusPresentation(row.status).tone} label={statusPresentation(row.status).label} />
      </TableCell>
      <TableCell className={styles.colLeft} numeric>
        <LeftCell row={row} name={row.report.account ?? name} />
      </TableCell>
      <TableCell className={styles.colResets} collapseBelow="sm" numeric>
        <Text role="muted" numeric>{row.resets}</Text>
      </TableCell>
      <TableCell className={styles.colDetails} align="end">
        <Button ref={buttonRef} variant="ghost" size="icon-sm" aria-label={`Details for ${row.report.account ?? name}`} aria-expanded={isOpen} aria-controls={bodyId} onClick={onToggle} onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() }
          else if (event.key === 'Escape' && isOpen) { event.preventDefault(); onCollapse() }
        }}><CaretIcon className={isOpen ? 'rotate-180' : undefined} size={14} /></Button>
      </TableCell>
    </TableRow>
    {isOpen && (
      <TableRow>
        <TableCell
          id={bodyId}
          colSpan={5}
          variant="detail"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onCollapse()
            }
          }}
        >
          <ExpandedBody
            row={row}
            info={info}
            onSignIn={onSignIn}
            preference={preference}
            now={now}
            onRefresh={onRefresh}
            onStopTracking={onStopTracking}
            onOpenPlanSettings={onOpenPlanSettings}
          />
        </TableCell>
      </TableRow>
    )}
  </>
)

const ExpandedBody = ({
  onSignIn,
  row,
  info,
  preference,
  now,
  onRefresh,
  onStopTracking,
  onOpenPlanSettings,
}: {
  onSignIn?: () => void
  row: PlanRow
  info: RuntimeInfo | null
  preference: UsagePreference
  now: number
  onRefresh: () => void
  onStopTracking: () => void
  onOpenPlanSettings: () => void
}) => {
  const body = (() => {
    switch (row.shape) {
      case 'windows':
        // The existing card body, reused rather than redrawn — see `Card`'s own
        // `shapeChip`/`moneyRow` slots, added for exactly this frame.
        return (
          <Card
            report={row.raw}
            info={info}
            preference={preference}
            now={now}
            onRefresh={onRefresh}
            onStopTracking={onStopTracking}
            shapeChip={<ShapeChip shape={row.shape} />}
            moneyRow={<MoneyRowView money={moneyRowOf(row.report, now)} onOpenPlanSettings={onOpenPlanSettings} />}
          />
        )
      case 'allowance':
        return <AllowanceBody row={row} info={info} now={now} onRefresh={onRefresh} />
      case 'balance':
        return <BalanceBody row={row} info={info} now={now} onRefresh={onRefresh} />
      case 'metered':
        return <KeyBody row={row} info={info} now={now} onRefresh={onRefresh} onOpenPlanSettings={onOpenPlanSettings} />
      case 'free':
        return <FreeBody row={row} info={info} now={now} />
      case 'none':
        return info ? (
          <NotReportingList entries={entriesFromReports([row.report], new Map([[row.report.runtime, info]]), onRefresh).map(entry => onSignIn ? { ...entry, reason: 'Sign in to read plan usage. Recorded spend is kept.', fix: { label: `Sign in to ${info.presentation.name}`, onClick: onSignIn } } : entry)} />
        ) : null
    }
  })()

  const activity = row.report.accountActivity
  const summary = activity ? accountActivitySummary(activity, now) : null
  return (
    <>
      {body}
      {onSignIn && row.shape !== 'none' && <Button variant="outline" size="sm" onClick={onSignIn}>Sign in to {info?.presentation.name ?? 'the account'}</Button>}
      {summary && <AccountActivityBand summary={summary} />}
    </>
  )
}

export const AccountActivityBand = ({ summary }: { summary: AccountActivitySummary }) => (
  <SurfaceCard variant="muted" data-slot="account-activity">
    <CardContent className="flex flex-col gap-(--hd-space-2)">
      <Text
        role="meta"
        title="The account's own count across every machine; the figures above come from this machine's transcripts."
      >
        All machines
      </Text>
      <div className="flex flex-wrap items-baseline gap-x-(--hd-space-3) gap-y-(--hd-space-1-5)">
        {summary.last30 !== null && (
          <Text role="value" numeric>{formatTokens(summary.last30)} tokens · 30d</Text>
        )}
        {summary.streak !== null && (
          <Text role="value" numeric>{summary.streak}-day streak</Text>
        )}
        {summary.lifetime !== null && (
          <Text role="value" numeric>{formatTokens(summary.lifetime)} lifetime</Text>
        )}
      </div>
    </CardContent>
  </SurfaceCard>
)
