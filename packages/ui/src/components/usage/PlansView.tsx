import type { AppSnapshot } from '../../state/store'
import type { RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { prefsForUsage } from '../../lib/accounts'
import type { RunwaySummary } from '../../lib/usage'
import { Row, Rows, Button, SectionHead } from '../../design'
import { RuntimeMark } from '../BrandIcons'
import { BandHead, Card, Runway, AsleepAlert, type SilentAgent } from './shared'
import styles from './usage.module.css'

/**
 * Plans: every account, whether it will last, and what is missing.
 *
 * The page the rail used to be. Every account still gets a card — a table
 * replaces them in the next PR — and everything the old rail could do to an
 * account it does not report (track it again) or has never heard from
 * (sign it in) lives here now, as content rather than navigation.
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
}) => (
  <>
    <BandHead name="What is left" note={summary.headline ?? undefined} className={styles.firstBandHead} />
    <section className={styles.band} aria-label="What is left">
      <div className={styles.cards}>
        {reports.map((report) => (
          <Card
            key={`${report.runtime}:${report.account ?? ''}`}
            report={report}
            info={byId.get(report.runtime) ?? null}
            preference={prefsForUsage(report.runtime, report.account, snapshot.accountsByRuntime, snapshot.accountPrefs)}
            now={now}
            onRefresh={() => onRefreshAccount(report.runtime)}
            onStopTracking={() => onStopTracking(report.runtime)}
          />
        ))}
      </div>
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
              mark={<RuntimeMark runtime={info} size={15} />}
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

    {(() => {
      const scopedSilent = silent.filter((agent) => scoped === null || scoped.id === agent.info.id)
      return (
        scopedSilent.length > 0 && (
          <section className={styles.band} aria-label="Doesn't report usage">
            <SectionHead level="heading" name="Doesn’t report usage" />
            {scopedSilent.map((agent) => <AsleepAlert key={agent.info.id} silent={agent} onSignIn={onSignIn} />)}
          </section>
        )
      )
    })()}
  </>
)
