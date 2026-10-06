import { useCallback, useMemo, useState } from 'react'

import type { AppSnapshot } from '../../state/store'
import type { RuntimeId, RuntimeInfo, UsagePreference, UsageReport } from '@harnessdesk/protocol'

import { accountForUsage, accountKey, defaultTint, prefsForUsage, tintOf } from '../../lib/accounts'
import type { RunwaySummary } from '../../lib/usage'
import { planRows, shapeCountsOf } from '../../lib/plans-table'
import { Row, Rows, Button, SectionHead } from '../../design'
import { RuntimeMark } from '../BrandIcons'
import { BandHead, Runway, type SilentAgent } from './shared'
import { PlansTable, ShapeFilters, type ShapeFilter } from './PlansTable'
import { entriesFromSilent, NotReportingList } from './NotReporting'
import styles from './usage.module.css'

/**
 * Plans: every account, whether it will last, and what is missing.
 *
 * The page the rail used to be. One table, sorted by what is left, replaces
 * the card grid — a row expands in place into the account's own shape body
 * (`PlanFrame.tsx`/`ShapeBodies.tsx`), the shape filters above it are the page-per-shape idea without
 * extra pages, and everything the old rail could do to an account it does not
 * report (track it again) or has never heard from (sign it in) still lives
 * here, as content rather than navigation.
 */
export const PlansView = ({
  reports,
  byId,
  snapshot,
  now,
  summary,
  scoped,
  silent,
  untracked,
  onSignIn,
  onRefreshAccount,
  onStopTracking,
  onTrack,
  onOpenPlanSettings,
}: {
  reports: readonly UsageReport[]
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  snapshot: Pick<AppSnapshot, 'accountsByRuntime' | 'accountPrefs'>
  now: number
  summary: RunwaySummary
  /** The one account the header is scoped to, or null for every one. */
  scoped: RuntimeInfo | null
  silent: readonly SilentAgent[]
  untracked: readonly RuntimeInfo[]
  onSignIn?: (runtime: RuntimeId) => void
  onRefreshAccount: (runtime: RuntimeId) => void
  onStopTracking: (runtime: RuntimeId) => void
  onTrack: (runtime: RuntimeId) => void
  /** Opens an account's own Plan card in Settings — the Key body's "Set a budget", the money row's "Fee not set" (review of #1069, B5). */
  onOpenPlanSettings: (runtime: RuntimeId) => void
}) => {
  const [filter, setFilter] = useState<ShapeFilter>('all')
  // A stable function identity, so `planRows` below does not recompute on
  // every render — it used to be a fresh closure each time, which meant a
  // new array from `planRows` (and everything derived from it) on every
  // render whether or not the snapshot it reads had changed (review of
  // #1069, N12).
  const preferenceFor = useCallback(
    (report: UsageReport): UsagePreference =>
      prefsForUsage(report.runtime, report.account, snapshot.accountsByRuntime, snapshot.accountPrefs) ?? {},
    [snapshot.accountsByRuntime, snapshot.accountPrefs],
  )

  // Computed once, from the same drawn reports the rows themselves read —
  // the filter counts and the row list used to read the raw reports a
  // second time, which could disagree with what the table actually drew for
  // a borrowed (unverified) sign-in (review of #1069, B3).
  const rows = useMemo(() => planRows(reports, now, preferenceFor), [reports, now, preferenceFor])

  const represented = new Set(rows.map(row => row.report.runtime))
  const scopedSilent = silent.filter((agent) => (scoped === null || scoped.id === agent.info.id) && !represented.has(agent.info.id))
  const counts = useMemo(
    () => shapeCountsOf(rows.map((row) => row.shape), scopedSilent.length),
    [rows, scopedSilent.length],
  )
  if (filter !== 'all' && counts[filter] === 0) setFilter('all')

  // A report whose own shape is `'none'` already has a row in the table,
  // which expands into this same list (`PlansTable`'s `ExpandedBody`) — so
  // this band lists only the agents that never even answered
  // `runtime/account`, never a report a second time under two headings.
  const notReportingEntries = entriesFromSilent(scopedSilent, onSignIn)

  return (
    <>
      <BandHead
        name="What is left"
        note={summary.headline ?? undefined}
        className={styles.firstBandHead}
        action={
          <div className={styles.shapeFiltersWrap}>
            <ShapeFilters counts={counts} value={filter} onChange={setFilter} />
          </div>
        }
      />
      <section className={styles.band} aria-label="What is left">
        <PlansTable
          rows={rows}
          snapshot={snapshot}
          onSignIn={onSignIn}
          signInRuntimes={new Set(silent.map(agent => agent.info.id))}
          tintFor={(runtime, accountLabel) => {
            const account = accountForUsage(runtime, accountLabel, snapshot.accountsByRuntime)
            return account ? tintOf(accountKey(runtime, account), snapshot.accountPrefs) : defaultTint(runtime)
          }}
          byId={byId}
          now={now}
          filter={filter}
          preferenceFor={preferenceFor}
          onRefreshAccount={onRefreshAccount}
          onStopTracking={onStopTracking}
          onOpenPlanSettings={onOpenPlanSettings}
        />
        <NotReportingList entries={notReportingEntries} />
      </section>

      {/* Only when the header is scoped to one account: see `Runway`. Its own
          lanes decide whether it draws anything at all, so an agent with no
          plottable window costs no heading. */}
      {scoped && (
        <Runway
          reports={reports}
          now={now}
          accountsByRuntime={snapshot.accountsByRuntime}
          accountPrefs={snapshot.accountPrefs}
        />
      )}

      {untracked.length > 0 && (
        <section className={styles.band} aria-label="Not tracked">
          <SectionHead level="heading" name="Not tracked" />
          <Rows>
            {untracked.map((info) => (
              <Row
                key={info.id}
                mark={<RuntimeMark runtime={info} size={16} />}
                title={info.presentation.name}
                desc="Nothing is asked of it. What it already spent is still counted."
                control={
                  <Button variant="outline" size="sm" onClick={() => onTrack(info.id)}>
                    Track
                  </Button>
                }
              />
            ))}
          </Rows>
        </section>
      )}
    </>
  )
}
