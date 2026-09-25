import { useEffect, useState } from 'react'

import type { FlowExecution, FlowOperation, FlowPreview } from '@harnessdesk/protocol'

import { Banner, Button, CodeText, ConfirmDialog, Note } from '../design'
import { useStore } from '../state/context'

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
 * `roomRunState`), and the room's chat carries the live line for whichever
 * member is on it — so this component's only job left is the one action and
 * the one banner nothing else says.
 */
export const FlowRunStatus = ({ execution }: FlowRunStatusProps) => {
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
          <Button variant="outline" size="sm" onClick={() => setReviewing(true)}>Review and run again…</Button>
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

const RetryCheck = ({ run, card, onClose }: { readonly run: string; readonly card: number; readonly onClose: () => void }) => {
  const store = useStore()
  const [preview, setPreview] = useState<FlowPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    store.previewFlowRetry(run, card).then(
      (next) => { if (live) setPreview(next) },
      (error: unknown) => { if (live) setProblem(error instanceof Error ? error.message : String(error)) },
    )
    return () => {
      live = false
    }
  }, [store, run, card])

  const command = preview?.commands[0]

  const confirm = async (): Promise<void> => {
    if (!preview?.token || busy) return
    setBusy(true)
    try {
      await store.retryFlowCheck(run, card, preview.token)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title="Run this check again?"
      confirmLabel="Run again"
      tone="default"
      busy={busy}
      pending={!preview && !problem}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <Note>
        The desk stopped after starting this check and cannot tell whether it finished. Its partial output is kept
        either way; running it again is your explicit consent.
      </Note>
      {command && (
        <div className="flex flex-col gap-(--hd-space-2)">
          <CodeText as="code">{`${command.run} — in ${command.cwd}, ${command.timeout}s`}</CodeText>
        </div>
      )}
      {problem && <Banner tone="danger" title="This cannot be run again">{problem}</Banner>}
      {!preview && !problem && <Note>Checking whether this can still be run…</Note>}
    </ConfirmDialog>
  )
}
