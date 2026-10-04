import { useState } from 'react'

import type { FlowExecution, FlowOperation } from '@harnessdesk/protocol'

import { Banner, Button } from '../design'
import { isRecord, RECORD_REASON } from '../lib/team-record'
import { useSnapshotSelector } from '../state/context'
import { RetryCheck } from './RetryCheck'

export interface FlowRunStatusProps {
  readonly execution: FlowExecution
}

/** The uncertain check operation a stall names, if that is why it is stalled. */
const uncertainCheck = (execution: FlowExecution): FlowOperation | null =>
  execution.state === 'stalled'
    ? execution.operations.find((one) => one.kind === 'check' && one.state === 'uncertain') ?? null
    : null

/**
 * A flow run's own recovery action, when it has one — reviewing and
 * re-consenting to an interrupted check, and a banner for a run still on the
 * old format. The run's own state used to draw a second chip here, under the
 * header's own — one row saying "Running" over another saying "Working",
 * never disagreeing, never adding a fact the header did not already carry.
 * The header now reads this run's own state directly (`TeamRoomPane`'s own
 * `roomRunState`), the room's chat carries the live line for whichever
 * member is on it, and the header's own meta line names the pinned revision
 * (`TeamRoomPane`'s `pinnedAt`) — so this component's only job left is the
 * one action and the one banner nothing else says.
 */
export const FlowRunStatus = ({ execution }: FlowRunStatusProps) => {
  const record = useSnapshotSelector(snapshot => isRecord(snapshot.goals.get(execution.goal)))
  const legacy = execution.document.format === 'legacy'
  const stalledCheck = uncertainCheck(execution)
  const [reviewing, setReviewing] = useState(false)

  if (!legacy && !stalledCheck) return null

  return (
    <div className="flex flex-col gap-(--hd-space-2)">
      {legacy && (
        <Banner tone="warning" title="This run uses the old format">
          It runs with its original answer routing and permissions.
        </Banner>
      )}
      {stalledCheck && (
        <>
          <Button variant="outline" size="sm" disabled={record} title={record ? RECORD_REASON : undefined} onClick={() => setReviewing(true)}>Review and run again…</Button>
          {reviewing && (
            <RetryCheck
              run={execution.id}
              card={stalledCheck.card!}
              onClose={() => setReviewing(false)}
            />
          )}
        </>
      )}
    </div>
  )
}
