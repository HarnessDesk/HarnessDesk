import type { LedgerReport, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'

import { Segmented } from '../../design'
import { BandHead, PIVOTS, RANGES, Ranked, Spend, type Pivot, type TintOf } from './shared'
import styles from '../Usage.module.css'

/**
 * Spend: what it cost, and where it went — full width, over 7, 30 or 90 days.
 *
 * Overview draws the same two bands as a bento for the quick read; this is
 * the page for sitting with them, so both take the full measure and the
 * range control that changes them both lives in this one header rather than
 * the shell's.
 */
export const SpendView = ({
  ledger,
  wideLedger,
  byId,
  agentTints,
  scan,
  now,
  range,
  onRangeChange,
  mode,
  onModeChange,
  onScan,
  pivot,
  onPivotChange,
}: {
  ledger: LedgerReport | null
  wideLedger: LedgerReport | null
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>
  agentTints: TintOf
  scan: { running: boolean; filesDone: number; filesTotal: number } | null
  now: number
  range: number
  onRangeChange: (range: number) => void
  mode: 'bars' | 'line'
  onModeChange: (mode: 'bars' | 'line') => void
  onScan: () => void
  pivot: Pivot
  onPivotChange: (pivot: Pivot) => void
}) => (
  <>
    <Spend
      ledger={ledger}
      wideLedger={wideLedger}
      byId={byId}
      tintOf={agentTints}
      scan={scan}
      now={now}
      range={range}
      mode={mode}
      onModeChange={onModeChange}
      onScan={onScan}
      rangeControl={
        <Segmented
          label="How far back"
          options={RANGES}
          value={String(range)}
          onChange={(next) => onRangeChange(Number(next))}
        />
      }
    />

    <section className={styles.band} aria-label="Where it went">
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
      />
    </section>
  </>
)
