import { useRef, useState } from 'react'

import type { RuntimeId, RuntimeInfo, UsagePreference } from '@harnessdesk/protocol'

import { paletteTone, usageReadingTone } from '../../lib/limits'
import {
  moneyRowOf,
  SHAPE_CHIP_LABEL,
  SHAPE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type PlanRow,
  type RowShape,
  type ShapeCounts,
} from '../../lib/plans-table'
import {
  Button,
  Card as SurfaceCard,
  Chip,
  EmptyState,
  Segmented,
  SegmentMeter,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '../../design'
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
 * Design: `docs/usage-dashboard.md`, "The screen › Plans". The table's own
 * row is deliberately thin — mark, name, the two chips, the bar, and four
 * short columns — because the account's own story (the lanes, the pace, the
 * money) belongs to the shape body it expands into, not to a row that would
 * otherwise try to say all of it in one line.
 *
 * Built on `design/ui/table` — a real `<table>`, not a `Button` standing in
 * for a row (review of #1069, B8): a screen reader used to announce the
 * whole row as one long button name, with no column headers and a meter
 * nested inside it. Each row's first cell holds the disclosure control
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
      { value: 'all' as const, label: `All ${counts.all}` },
      ...SHAPE_FILTER_ORDER.map((shape) => ({ value: shape, label: `${SHAPE_CHIP_LABEL[shape]} ${counts[shape]}` })),
    ]}
  />
)

const ShapeChip = ({ shape }: { shape: RowShape }) =>
  shape === 'none' ? null : <Chip variant="outline" tone="neutral" label={SHAPE_LABEL[shape]} />

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
            <TableHead className={styles.colShape}>Shape</TableHead>
            <TableHead className={styles.colStatus}>Status</TableHead>
            <TableHead className={styles.colLeft}>Left</TableHead>
            <TableHead className={styles.colPercent} align="end">%</TableHead>
            <TableHead className={styles.colAmount} align="end">Amount</TableHead>
            <TableHead className={styles.colTurns} align="end">≈ Turns</TableHead>
            <TableHead className={styles.colResets} align="end">Resets</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => {
            const info = byId.get(row.report.runtime) ?? null
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

const TableRowGroup = ({
  row,
  info,
  name,
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
    <TableRow interactive data-state={isOpen ? 'selected' : undefined}>
      <TableCell className={styles.colAccount}>
        <Button
          ref={buttonRef}
          variant="row"
          size="table-row"
          className={`${styles.plansDisclosure} flex w-full items-center gap-(--hd-space-1-5)`}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={onToggle}
          onKeyDown={(event) => {
            // Enter/Space are a native button's own activation keys, but
            // nothing here should depend on exactly how the underlying
            // primitive wires its own keyboard activation, so this answers
            // them explicitly too — the same rule the row kept before B8.
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onToggle()
            } else if (event.key === 'Escape' && isOpen) {
              event.preventDefault()
              onCollapse()
            }
          }}
        >
          <span className={styles.rankMark}>{info && <RuntimeMark runtime={info} size={15} />}</span>
          <span className={styles.plansName}>
            <Text role="subject" truncate>{row.report.account ?? name}</Text>
            {row.report.account && <Text role="meta" truncate>{name}</Text>}
          </span>
        </Button>
      </TableCell>
      <TableCell className={styles.colShape}><ShapeChip shape={row.shape} /></TableCell>
      <TableCell className={styles.colStatus}>
        <Chip tone={paletteTone(STATUS_TONE[row.status])} label={STATUS_LABEL[row.status]} />
      </TableCell>
      <TableCell className={styles.colLeft}>
        <SegmentMeter
          className={styles.plansBar}
          percent={row.left.percent}
          tone={paletteTone(STATUS_TONE[row.status])}
          segments={16}
          label={`${row.report.account ?? name} — what is left`}
        />
      </TableCell>
      <TableCell className={styles.colPercent} align="end">
        <Text role="value" numeric tone={usageReadingTone(STATUS_TONE[row.status])}>
          {row.left.percent === null ? '—' : `${Math.round(row.left.percent)}%`}
        </Text>
      </TableCell>
      <TableCell className={styles.colAmount} align="end">
        <Text role="muted" truncate title={row.ownUnit}>{row.ownUnit}</Text>
      </TableCell>
      <TableCell className={styles.colTurns} align="end">
        <Text role="muted" numeric>{row.approxTurns}</Text>
      </TableCell>
      <TableCell className={styles.colResets} align="end">
        <Text role="muted">{row.resets}</Text>
      </TableCell>
    </TableRow>
    {isOpen && (
      <TableRow>
        <TableCell
          id={bodyId}
          colSpan={8}
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
  row,
  info,
  preference,
  now,
  onRefresh,
  onStopTracking,
  onOpenPlanSettings,
}: {
  row: PlanRow
  info: RuntimeInfo | null
  preference: UsagePreference
  now: number
  onRefresh: () => void
  onStopTracking: () => void
  onOpenPlanSettings: () => void
}) => {
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
          moneyRow={<MoneyRowView money={moneyRowOf(row.report)} onOpenPlanSettings={onOpenPlanSettings} />}
        />
      )
    case 'allowance':
      return <AllowanceBody row={row} info={info} onRefresh={onRefresh} />
    case 'balance':
      return <BalanceBody row={row} info={info} onRefresh={onRefresh} />
    case 'metered':
      return <KeyBody row={row} info={info} onRefresh={onRefresh} onOpenPlanSettings={onOpenPlanSettings} />
    case 'free':
      return <FreeBody row={row} info={info} />
    case 'none':
      return info ? (
        <NotReportingList entries={entriesFromReports([row.report], new Map([[row.report.runtime, info]]), onRefresh)} />
      ) : null
  }
}
