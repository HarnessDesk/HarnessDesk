import { useEffect, useState } from 'react'

import type { FlowExecution, FlowOperation, FlowPreview, FlowStartTarget } from '@harnessdesk/protocol'

import { Banner, Button, Chip, CodeText, ConfirmDialog, Note, Text } from '../design'
import { shortSha } from '../lib/evidence'
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
 * The pinned revision a review run works at, in the words its own target
 * already carries — "branch feature at a1b2c3d" — since nowhere else shows
 * `FlowExecution.target` or the `Goal.at` it comes from. The diff kind's own
 * label already names both ends of the range, so the short head is not
 * repeated after it.
 */
const targetWords = (target: FlowStartTarget): string => {
  const head = target.head && target.kind !== 'diff' ? shortSha(target.head) : null
  return head ? `Reviews ${target.label} at ${head}` : `Reviews ${target.label}`
}

const activityWords = (execution: FlowExecution): { readonly label: string; readonly tone: 'neutral' | 'warning' | 'success' | 'danger' } => {
  if (execution.state === 'settled') return { label: 'Settled', tone: 'success' }
  if (execution.state === 'stopped') return { label: 'Stopped', tone: 'neutral' }
  if (execution.state === 'stalled') return { label: uncertainCheck(execution) ? 'Interrupted' : 'Waiting for a person', tone: 'warning' }
  const last = execution.rounds.at(-1)
  if (last?.state === 'waiting-evidence') return { label: 'Waiting for evidence', tone: 'warning' }
  const role = execution.document.format === 'agents' ? execution.document.flow.roles.find((one) => one.id === last?.role) : null
  if (role?.kind === 'person') return { label: 'Waiting for a person', tone: 'warning' }
  return { label: 'Running', tone: 'neutral' }
}

/**
 * A flow run's own status strip: the Goal header's state vocabulary, plus
 * the one recovery action a run itself ever needs — reviewing and
 * re-consenting to an interrupted check. Every other action (Stop, seat
 * records, evidence detail) stays where the Goal header and phase 4's own
 * components already put it; this does not duplicate them.
 */
export const FlowRunStatus = ({ execution }: FlowRunStatusProps) => {
  const activity = activityWords(execution)
  const legacy = execution.document.format === 'legacy'
  const stalledCheck = uncertainCheck(execution)
  const [reviewing, setReviewing] = useState(false)

  return (
    <div className="flex flex-col gap-(--hd-space-2)">
      <div className="flex items-center gap-(--hd-space-2)">
        <Chip tone={activity.tone}>{activity.label}</Chip>
        {execution.reason && <Text role="muted">{execution.reason}</Text>}
      </div>
      {execution.target && <Text role="muted">{targetWords(execution.target)}</Text>}
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
