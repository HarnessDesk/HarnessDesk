import { useCallback, useEffect, useState } from 'react'

import type { AgentEntry, TriggerArmPreview, TriggerDefinition, TriggerView } from '@harnessdesk/protocol'

import { Banner, Button, ConfirmDialog, KeyValue, KeyValueRow, Note, NoteList } from '../design'
import {
  triggerAgainLabel, triggerBudgetWords, triggerCommentWords, triggerGroupingWords, triggerProblemPlace, triggerSentence,
} from '../lib/intake'
import { shortPath } from '../lib/paths'
import { useSnapshot, useStore } from '../state/context'
import { FlowPreviewReport } from './FlowStart'

export interface TriggerArmProps {
  readonly root: string
  readonly id: string
  readonly onClose: () => void
  readonly onArmed: (view: TriggerView) => void
}

const AGAIN_WORDS = (definition: TriggerDefinition): string =>
  definition.again === null
    ? 'Records the fact and needs a person — no new round opens on its own.'
    : `Stops the work on the old one and opens a new round: ${definition.again.title}.`

const FORK_WORDS = (definition: TriggerDefinition): string =>
  definition.forks === 'allow'
    ? 'Allowed — read-only, and no command runs against a fork’s contents.'
    : 'Never — a pull request from another repository opens nothing.'

/**
 * The exact arming decision, frozen at the moment this preview was read.
 *
 * `ConfirmDialog`'s non-accidental behaviour is deliberate here, not
 * inherited from a nearby dialog by habit: arming lets a machine do
 * unattended work later, so it must not close on a stray click and must not
 * be confirmable by a Return that landed before anyone read it.
 */
export const TriggerArm = ({ root, id, onClose, onArmed }: TriggerArmProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [preview, setPreview] = useState<TriggerArmPreview | null>(null)
  const [roster, setRoster] = useState<ReadonlyMap<string, AgentEntry>>(new Map())
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback((): void => {
    setPreview(null)
    setProblem(null)
    store.previewTrigger(root, id).then(
      (next) => setPreview(next),
      (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    )
  }, [store, root, id])

  useEffect(() => {
    load()
    store.agentsIn(root).then(
      (list) => setRoster(new Map(list.map((entry) => [entry.id, entry]))),
      () => {
        // A roster this call could not read leaves names as bare Agent ids, below.
      },
    )
  }, [load, root, store])

  const errors = preview?.problems ?? []
  const flowDocument = preview?.flow?.compiled.document ?? null
  const flowPolicy = flowDocument?.format === 'agents' ? flowDocument.flow : null
  const flowErrors = (preview?.flow?.problems ?? []).filter((one) => one.level === 'error')
  const flowWarnings = (preview?.flow?.problems ?? []).filter((one) => one.level === 'warning')
  const armable = preview !== null && preview.token !== null
  const againLabel = preview?.definition ? triggerAgainLabel(preview.definition.on.kind) : null

  const arm = async (): Promise<void> => {
    if (!preview || preview.token === null || busy) return
    setBusy(true)
    try {
      const view = await store.armTrigger(root, id, preview.token)
      onArmed(view)
    } catch (error) {
      // A stale token or a source that changed under it: the preview stays
      // up so the person can read what changed, never a silent re-arm.
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title="Arm this trigger"
      confirmLabel={busy ? 'Arming…' : 'Arm'}
      cancelLabel="Cancel"
      busy={busy}
      pending={!armable}
      onConfirm={() => void arm()}
      onCancel={onClose}
    >
      <Note>This runs while you are away. Commands shown here run with your authority.</Note>

      {problem && (
        <Banner tone="danger" title="This could not be armed">
          {problem}
          <Button variant="outline" size="sm" onClick={load}>Review changes</Button>
        </Banner>
      )}

      {preview && errors.length > 0 && (
        <Banner tone="danger" title="This will not arm yet">
          <NoteList>
            {errors.map((one) => (
              <li key={`${one.at}-${one.text}`}>
                <span title={one.at}>{triggerProblemPlace(one.at)}</span>: {one.text} {one.fix}
              </li>
            ))}
          </NoteList>
        </Banner>
      )}

      {preview && flowErrors.length > 0 && (
        <Banner tone="danger" title="Its flow will not run yet">
          <NoteList>
            {flowErrors.map((one) => (
              <li key={`${one.at}-${one.text}`}>
                <span title={one.at}>{triggerProblemPlace(`flow.${one.at}`)}</span>: {one.text}
              </li>
            ))}
          </NoteList>
        </Banner>
      )}

      {preview && preview.definition && (
        <>
          <KeyValue>
            <KeyValueRow label="Source">{shortPath(preview.sourcePath, snapshot.home)}</KeyValueRow>
            {preview.workingCopyChanged && (
              <KeyValueRow label="Working copy">
                Changed since committed — only what is committed is armed.
              </KeyValueRow>
            )}
            <KeyValueRow label="Declares">{triggerSentence(preview.definition)}</KeyValueRow>
            {preview.repository && <KeyValueRow label="Repository">{preview.repository}</KeyValueRow>}
            <KeyValueRow label="Goals">{triggerGroupingWords(preview.definition.goal)}</KeyValueRow>
            {againLabel && <KeyValueRow label={againLabel}>{AGAIN_WORDS(preview.definition)}</KeyValueRow>}
            {preview.definition.from && (
              <KeyValueRow label="Comments that fire it">
                {triggerCommentWords(preview.definition.from)} Posts this desk makes never fire it.
              </KeyValueRow>
            )}
            {preview.definition.on.kind === 'pull-request' && (
              <KeyValueRow label="Forks">{FORK_WORDS(preview.definition)}</KeyValueRow>
            )}
            <KeyValueRow label="Concurrency">
              {preview.definition.concurrency === 1 ? 'One open Goal at a time' : `Up to ${preview.definition.concurrency} open Goals at once`}
            </KeyValueRow>
            <KeyValueRow label="Budget">{triggerBudgetWords(preview.definition.budget)}</KeyValueRow>
            <KeyValueRow label="Daily cap">
              Arming reserves this Goal’s whole budget against today’s cap the moment it opens, in Settings › Triggers on this Mac.
            </KeyValueRow>
          </KeyValue>
          {preview.definition.from === 'anyone' && (
            <Note tone="warn">Anyone who can comment on this repository will start unattended work.</Note>
          )}
          <Note tone="warn">
            Stops when reported spend reaches the limit. Work already running can cost more before it stops.
          </Note>
        </>
      )}

      {preview?.flow && (
        <FlowPreviewReport preview={preview.flow} flow={flowPolicy} warnings={flowWarnings} roster={roster} />
      )}

      {preview?.definition?.forks === 'allow' && (
        <Note>A pull request from a fork is reviewed read-only; no command runs against its contents.</Note>
      )}

      {preview && preview.token === null && errors.length === 0 && flowErrors.length === 0 && (
        <Banner tone="warning" title="This preview has expired">
          Review it again before arming.
          <Button variant="outline" size="sm" onClick={load}>Review again</Button>
        </Banner>
      )}
    </ConfirmDialog>
  )
}
