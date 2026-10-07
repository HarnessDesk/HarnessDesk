import { useEffect, useState } from 'react'

import type { FlowPreview } from '@harnessdesk/protocol'

import { Banner, Button, CodeText, ConfirmDialog, Note, RefusedAction, Text } from '../design'
import { isRecord, RECORD_REASON } from '../lib/team-record'
import { useSnapshotSelector, useStore } from '../state/context'

/**
 * Running a finished or interrupted check again asks first, and asks the host:
 * its own preview binds the exact command, card, attempt and checkout, mints
 * the one token that starts it, and refuses — in its own sentence — a run that
 * has ended, a checkout that moved, cleanup still pending, or a Team that
 * cannot take work. This dialog shows the command verbatim and keeps its answer
 * disabled for as long as there is no token to redeem, so a refusal is read and
 * never pressed through.
 *
 * Every place that offers a check again opens this one dialog: the Run view's
 * timeline row and inspector (`RunAgain`), the board's *Run this check again…*,
 * and the stalled Run's *Review and run again…*.
 */
export const RetryCheck = ({ run, card, onClose, refusal = null }: { readonly run: string; readonly card: number; readonly onClose: () => void; readonly refusal?: string | null }) => {
  const store = useStore()
  const record = useSnapshotSelector(snapshot => isRecord(snapshot.goals.get(snapshot.flowExecutions.get(run)?.goal ?? '')))
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
    const snapshot = store.getSnapshot()
    if (!preview?.token || busy || refusal !== null || isRecord(snapshot.goals.get(snapshot.flowExecutions.get(run)?.goal ?? ''))) return
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
      pending={record || refusal !== null || !preview?.token}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      {(record || refusal !== null) && <Note>{record ? RECORD_REASON : refusal}</Note>}
      <Note>
        This runs the same command in the card’s checkout as it is now. Its previous output is kept;
        running it again is your explicit consent.
      </Note>
      {command && (
        <div className="flex flex-col gap-(--hd-space-2)">
          <CodeText as="code">{`${command.run} — in ${command.cwd}, ${command.timeout}s`}</CodeText>
        </div>
      )}
      {preview?.problems.map((one, index) => <Note key={index}>{one.text}</Note>)}
      {problem && <Banner tone="danger" title="This cannot be run again">{problem}</Banner>}
      {!preview && !problem && <Note>Checking whether this can still be run…</Note>}
    </ConfirmDialog>
  )
}

/**
 * *Run again…* for one check card, on a timeline row or in its inspector.
 *
 * `refusal` is what the Run and the check already say (`checkRetryRefusal`,
 * the host's own sentence), and anything else the host refuses is said in the
 * dialog this opens. For an actionable refusal the inspector keeps the control,
 * disabled, with the reason on screen. An ended Run or wrapped Team keeps
 * only the reason; a timeline row shows nothing, so a
 * settled Run does not repeat one sentence down every check row — the reason
 * is a click away in the inspector.
 */
export const RunAgain = ({ run, card, refusal, onRow = false, terminal = false }: {
  readonly run: string
  readonly card: number
  readonly refusal: string | null
  /** The Run has ended or its Team is wrapped; this check can never run here again. */
  readonly terminal?: boolean
  /** On a timeline row: a quiet link, and absent while refused. */
  readonly onRow?: boolean
}) => {
  const [asking, setAsking] = useState(false)
  const showAction = !terminal && !(onRow && refusal !== null)
  const ask = () => setAsking(true)
  const again = onRow
    ? <Button variant="link" size="xs" onClick={ask}>Run again…</Button>
    : <Button variant="outline" size="sm" className="self-start" onClick={ask}>Run again…</Button>
  return (
    <>
      {terminal && !onRow && refusal !== null && <Text role="meta" as="div" className="break-words [overflow-wrap:anywhere]">{refusal}</Text>}
      {showAction && (refusal === null ? again : (
        <div className="flex min-w-0 flex-col items-start gap-(--hd-space-1)">
          <RefusedAction reason={refusal}>{again}</RefusedAction>
          <Text role="meta" as="div" className="break-words [overflow-wrap:anywhere]">{refusal}</Text>
        </div>
      ))}
      {asking && <RetryCheck run={run} card={card} refusal={terminal ? refusal ?? 'This run has ended. Start a new run to run this check again.' : refusal} onClose={() => setAsking(false)} />}
    </>
  )
}
