import { useMemo, useRef, useState } from 'react'

import type { GoalReceipt, GoalView, WrapChoices, WrapPreview } from '@harnessdesk/protocol'

import { Button, Dialog, Field, FormStack, Input, NativeSelect, Note, Row, Rows, Textarea } from '../design'
import { isRecord, RECORD_REASON } from '../lib/team-record'
import { goalRunOf } from '../lib/goal-run'
import { wrapDraft, type WrapDraft } from '../lib/wrap-draft'
import { useSnapshot, useStore } from '../state/context'
import { GoalReceipt as GoalReceiptView } from './GoalReceipt'

export type { WrapDraft } from '../lib/wrap-draft'

export const choicesOf = (draft: WrapDraft): WrapChoices | null => {
  if (!draft.summary.trim()) return null
  const cards: { id: number; resolution: 'finished' | 'dropped'; reason: string | null }[] = []
  for (const [id, choice] of draft.cards) {
    if (choice.resolution === null || (choice.resolution === 'dropped' && !choice.reason.trim())) return null
    cards.push({ id, resolution: choice.resolution, reason: choice.resolution === 'dropped' ? choice.reason.trim() : null })
  }
  return { summary: draft.summary.trim(), cards }
}

export const GoalWrap = ({ view, onClose }: { readonly view: GoalView; readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const initial = useMemo(() => wrapDraft(view, goalRunOf(view.goal.id, view, snapshot.flowExecutions), snapshot.boardEvidence.get(view.board.id)), [view, snapshot.flowExecutions, snapshot.boardEvidence])
  /* A Run that ends wraps its Team too, even under a person who has the receipt open for review: wrapping a Team that
     is wrapped is not a decision left to make, so the question stays and says so (#1317). `view` is the live Goal. */
  const record = isRecord(view)
  const [edited, setDraft] = useState<{ summary: string | null; cards: WrapDraft['cards'] }>({ summary: null, cards: new Map() })
  /* Each default follows readable Run facts until the person edits that field. */
  const draft = useMemo<WrapDraft>(() => ({
    summary: edited.summary ?? initial.summary,
    cards: new Map(view.board.intents.map((intent) => [intent.id, edited.cards.get(intent.id) ?? initial.cards.get(intent.id)!])),
  }), [edited, view.board.intents, initial.summary, initial.cards])
  const [preview, setPreview] = useState<WrapPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [problem, setProblem] = useState<string | null>(null)
  const choices = choicesOf(draft)

  const changeCard = (id: number, patch: Partial<{ resolution: 'finished' | 'dropped' | null; reason: string }>): void => {
    const cards = new Map(edited.cards)
    const intent = view.board.intents.find((one) => one.id === id)
    cards.set(id, { ...(draft.cards.get(id) ?? (intent ? initial.cards.get(intent.id)! : { resolution: null, reason: '' })), ...patch })
    setDraft({ ...edited, cards })
    setPreview(null)
  }
  const review = async (): Promise<void> => {
    if (!choices || pending.current || record) return
    pending.current = true
    setBusy(true); setProblem(null)
    try { setPreview(await store.previewGoalWrap(view.goal.id, choices)) }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The desk could not preview this receipt.') }
    finally { pending.current = false; setBusy(false) }
  }
  const commit = async (): Promise<void> => {
    if (!preview || !choices || pending.current || record) return
    pending.current = true
    setBusy(true); setProblem(null)
    try {
      await store.wrapGoal(view.goal.id, preview.stamp, choices)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The desk did not wrap this Team.'
      setProblem(message)
      setPreview(null)
    } finally { pending.current = false; setBusy(false) }
  }

  return (
    <Dialog
      title={preview ? 'Review receipt' : 'Wrap this Team'}
      size="lg"
      onClose={onClose}
      footer={preview ? (
        <>
          <Button disabled={busy || record} title={record ? RECORD_REASON : undefined} onClick={() => void commit()}>Wrap Team</Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>Edit</Button>
        </>
      ) : (
        <>
          <Button disabled={!choices || busy || record} title={record ? RECORD_REASON : undefined} onClick={() => void review()}>Review receipt</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      {preview ? <GoalReceiptView receipt={preview.receipt} root={view.goal.root} /> : (
        <FormStack>
          <Field label="What finished">
            {(control) => <Textarea {...control} aria-label="What finished" autoFocus value={draft.summary} onChange={(event) => { setDraft({ ...edited, summary: event.target.value }); setPreview(null) }} />}
          </Field>
          <Rows>
            {view.board.intents.map((intent) => {
              const choice = draft.cards.get(intent.id)!
              return (
                <Row
                  key={intent.id}
                  title={`#${intent.id} · ${intent.title}`}
                  desc={choice.resolution === 'dropped' ? (
                    <Input aria-label={`Reason for dropping ${intent.title}`} value={choice.reason} onChange={(event) => changeCard(intent.id, { reason: event.target.value })} />
                  ) : undefined}
                  control={
                    <NativeSelect value={choice.resolution ?? ''} aria-label={`Disposition for #${intent.id} · ${intent.title}`} onChange={(event) => changeCard(intent.id, { resolution: event.target.value === '' ? null : event.target.value as 'finished' | 'dropped' })}>
                      <option value="">Choose…</option>
                      <option value="finished">Finished</option>
                      <option value="dropped">{initial.notKept.has(intent.id) ? 'Not kept' : 'Dropped'}</option>
                    </NativeSelect>
                  }
                />
              )
            })}
          </Rows>
        </FormStack>
      )}
      {/* Not while this dialog's own wrap is in flight: the host says the Team is wrapped a moment before it answers,
          and that is this question being answered, not a different one. */}
      {record && !busy ? <Note>{RECORD_REASON}</Note> : null}
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </Dialog>
  )
}
