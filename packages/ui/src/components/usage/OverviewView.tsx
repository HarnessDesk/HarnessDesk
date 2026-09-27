import type { AppSnapshot } from '../../state/store'
import type { LedgerReport, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { prefsForUsage } from '../../lib/accounts'
import type { RunwaySummary } from '../../lib/usage'
import { Button, Segmented, Text } from '../../design'
import { UsageActivity } from '../UsageActivity'
import { BandHead, Card, PIVOTS, Ranked, Spend, type Pivot, type SilentAgent, type TintOf } from './shared'
import styles from '../Usage.module.css'

/**
 * Overview: the whole story on one screen.
 *
 * An accounts summary limited to what needs looking at, a bento of what it
 * cost beside where it went, and when it ran. Everything else — every
 * account's own card, the burn-downs, the full account rail this page used
 * to be — is a click away on the view that is about it, never duplicated
 * here: Overview triages, it does not replace.
 */
export const OverviewView = ({
  attention,
  byId,
  agentTints,
  snapshot,
  now,
  summary,
  silent,
  onGoToPlans,
  onRefreshAccount,
  onStopTracking,
  ledger,
  wideLedger,
  range,
  mode,
  onModeChange,
  onScan,
  pivot,
  onPivotChange,
}: {
  reports: readonly UsageReport[]
  attention: readonly UsageReport[]
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  agentTints: TintOf
  snapshot: Pick<AppSnapshot, 'accountsByRuntime' | 'accountPrefs' | 'scan'>
  now: number
  summary: RunwaySummary
  silent: readonly SilentAgent[]
  onGoToPlans: () => void
  onRefreshAccount: (runtime: RuntimeId) => void
  onStopTracking: (runtime: RuntimeId) => void
  ledger: LedgerReport | null
  wideLedger: LedgerReport | null
  range: number
  mode: 'bars' | 'line'
  onModeChange: (mode: 'bars' | 'line') => void
  onScan: () => void
  pivot: Pivot
  onPivotChange: (pivot: Pivot) => void
}) => (
  <>
    <BandHead name="What is left" note={summary.headline ?? undefined} className={styles.firstBandHead} />
    <section className={styles.band} aria-label="What is left">
      {attention.length > 0 ? (
        <div className={styles.cards}>
          {attention.map((report) => (
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
      ) : (
        <Text role="muted">Nothing is spent or low right now.</Text>
      )}
      <div className={styles.overviewFoot}>
        <Button variant="ghost" size="sm" onClick={onGoToPlans}>
          See all in Plans
        </Button>
        {silent.length > 0 && (
          <Text role="meta">
            {silent.length} {silent.length === 1 ? 'agent doesn’t' : 'agents don’t'} report usage
          </Text>
        )}
      </div>
    </section>

    <div className={styles.bento}>
      <div className={styles.bentoMain}>
        <Spend
          ledger={ledger}
          wideLedger={wideLedger}
          byId={byId}
          tintOf={agentTints}
          scan={snapshot.scan}
          now={now}
          range={range}
          mode={mode}
          onModeChange={onModeChange}
          onScan={onScan}
        />
      </div>
      <div className={styles.bentoSide}>
        <BandHead
          name="Where it went"
          action={
            <Segmented
              label="Group spend by"
              options={PIVOTS}
              value={pivot}
              onChange={(next) => onPivotChange(next as Pivot)}
            />
          }
        />
        <Ranked
          ledger={ledger}
          wideLedger={wideLedger}
          pivot={pivot}
          range={range}
          now={now}
          byId={byId}
          tintOf={agentTints}
          compact
        />
      </div>
    </div>

    <UsageActivity byId={byId} scope={null} now={now} scanFinishedAt={snapshot.scan?.finishedAt} />
  </>
)
