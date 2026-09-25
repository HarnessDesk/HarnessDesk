import { useMemo, useRef, useState } from 'react'

import type { GoalReceipt, GoalView, WrapChoices, WrapPreview } from '@harnessdesk/protocol'

import { Button, Dialog, Field, FormStack, Input, NativeSelect, Note, Row, Rows, Textarea } from '../design'
import { useStore } from '../state/context'
import { GoalReceipt as GoalReceiptView } from './GoalReceipt'

export type WrapDraft = {
  readonly summary: string
  readonly cards: ReadonlyMap<number, { readonly resolution: 'finished' | 'dropped' | null; readonly reason: string }>
}

export const choicesOf = (draft: WrapDraft): WrapChoices | null => {
  if (!draft.summary.trim()) return null
  const cards: { id: number; resolution: 'finished' | 'dropped'; reason: string | null }[] = []
  for (const [id, choice] of draft.cards) {
    if (choice.resolution === null || (choice.resolution === 'dropped' && !choice.reason.trim())) return null
    cards.push({ id, resolution: choice.resolution, reason: choice.resolution === 'dropped' ? choice.reason.trim() : null })
  }
  return { summary: draft.summary.trim(), cards }
}

type Card = GoalView['board']['intents'][number]

/** What a card starts as in the draft: finished when done, dropped (with its note) when abandoned, else unchosen. */
const firstChoice = (intent: Card): { readonly resolution: 'finished' | 'dropped' | null; readonly reason: string } => ({
  resolution: intent.state === 'done' ? 'finished' : intent.state === 'abandoned' ? 'dropped' : null,
  reason: intent.state === 'abandoned' ? (intent.note ?? '') : '',
})

export const GoalWrap = ({ view, onClose }: { readonly view: GoalView; readonly onClose: () => void }) => {
  const store = useStore()
  const [edited, setDraft] = useState<WrapDraft>(() => ({ summary: '', cards: new Map(view.board.intents.map((intent) => [intent.id, firstChoice(intent)])) }))
  /* The cards are the Goal's as they are now: one added while this is open —
     the wrap is refused as unreviewed then — is one more to choose for, and
     one gone from the board is no longer asked about. */
  const draft = useMemo<WrapDraft>(() => ({
    summary: edited.summary,
    cards: new Map(view.board.intents.map((intent) => [intent.id, edited.cards.get(intent.id) ?? firstChoice(intent)])),
  }), [edited, view.board.intents])
  const [preview, setPreview] = useState<WrapPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [problem, setProblem] = useState<string | null>(null)
  const choices = choicesOf(draft)

  const changeCard = (id: number, patch: Partial<{ resolution: 'finished' | 'dropped' | null; reason: string }>): void => {
    const cards = new Map(draft.cards)
    const intent = view.board.intents.find((one) => one.id === id)
    cards.set(id, { ...(cards.get(id) ?? (intent ? firstChoice(intent) : { resolution: null, reason: '' })), ...patch })
    setDraft({ ...draft, cards })
    setPreview(null)
  }
  const review = async (): Promise<void> => {
    if (!choices || pending.current) return
    pending.current = true
    setBusy(true); setProblem(null)
    try { setPreview(await store.previewGoalWrap(view.goal.id, choices)) }
    catch (error) { setProblem(error instanceof Error ? error.message : 'The desk could not preview this receipt.') }
    finally { pending.current = false; setBusy(false) }
  }
  const commit = async (): Promise<void> => {
    if (!preview || !choices || pending.current) return
    pending.current = true
    setBusy(true); setProblem(null)
    try {
      await store.wrapGoal(view.goal.id, preview.stamp, choices)
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The desk did not wrap this Goal.'
      setProblem(message)
      setPreview(null)
    } finally { pending.current = false; setBusy(false) }
  }

  return (
    <Dialog
      title={preview ? 'Review receipt' : 'Wrap this Goal'}
      size="lg"
      onClose={onClose}
      footer={preview ? (
        <>
          <Button disabled={busy} onClick={() => void commit()}>Wrap Goal</Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>Edit</Button>
        </>
      ) : (
        <>
          <Button disabled={!choices || busy} onClick={() => void review()}>Review receipt</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      {preview ? <GoalReceiptView receipt={preview.receipt} root={view.goal.root} /> : (
        <FormStack>
          <Field label="What finished">
            {(control) => <Textarea {...control} aria-label="What finished" autoFocus value={draft.summary} onChange={(event) => { setDraft({ ...draft, summary: event.target.value }); setPreview(null) }} />}
          </Field>
          <Rows>
            {view.board.intents.map((intent) => {
              const choice = draft.cards.get(intent.id) ?? firstChoice(intent)
              return (
                <Row
                  key={intent.id}
                  title={`#${intent.id} · ${intent.title}`}
                  desc={choice.resolution === 'dropped' ? (
                    <Input aria-label={`Reason for dropping ${intent.title}`} value={choice.reason} onChange={(event) => changeCard(intent.id, { reason: event.target.value })} />
                  ) : undefined}
                  control={
                    <NativeSelect value={choice.resolution ?? ''} aria-label={`Disposition for ${intent.title}`} onChange={(event) => changeCard(intent.id, { resolution: event.target.value === '' ? null : event.target.value as 'finished' | 'dropped' })}>
                      <option value="">Choose…</option>
                      <option value="finished">Finished</option>
                      <option value="dropped">Dropped</option>
                    </NativeSelect>
                  }
                />
              )
            })}
          </Rows>
        </FormStack>
      )}
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </Dialog>
  )
}
