import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { UserContent } from '@harnessdesk/protocol'

import { useQueue, useSessionKey, useStore } from '../state/context'
import { noteKey, splitContext, wrapContext } from '../lib/context-envelope'
import { describeQueued, queuedLabel } from '../lib/queue'
import {
  Alert,
  Button,
  ComposerChip,
  SortableAnnouncer,
  SortableHandle,
  Spinner,
  Text,
  Textarea,
  Toolbar,
  ToolbarGap,
  sortableItemClass,
  useSortable,
} from '../design'
import { AlertIcon, CrossIcon, PencilIcon, QueueIcon } from './Icons'
import styles from './MessageQueue.module.css'

/**
 * What the user has waiting for this conversation.
 *
 * Above the composer rather than at the tail of the transcript: the queue is
 * *the draft's* future, not the conversation's past, and a strip that scrolls
 * away is a strip that gets forgotten with three messages in it. It sits with
 * the goal and the running jobs for the same reason — ambient state about the
 * conversation, always on screen, never in the way when empty.
 *
 * The host owns the order and the delivery; every control here is a request,
 * and the rows redraw from the `session/queue` event that answers it. That is
 * what keeps two windows on the same conversation from disagreeing.
 */
export const MessageQueue = () => {
  const store = useStore()
  const key = useSessionKey()
  const queue = useQueue()
  const messages = queue?.messages ?? []
  const [editing, setEditing] = useState<{
    readonly id: string
    readonly text: string
    readonly input: readonly UserContent[]
    readonly key: typeof key
    readonly attemptId: number
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const previouslyEditing = useRef<string | null>(null)
  const nextEditAttempt = useRef(0)
  const recoveredEdits = useRef(new Set<string>())

  const recoverEdit = useCallback((id: string, attemptId: number, text: string, input: readonly UserContent[], detail: string, originKey: typeof key) => {
    if (!originKey) return
    const recoveryId = `${originKey}:${attemptId}`
    if (recoveredEdits.current.has(recoveryId)) return
    recoveredEdits.current.add(recoveryId)
    const editedInput = withEditedText(input, text)
    const view = describeQueued(editedInput)
    store.addRecoverableDraft(originKey, {
      sourceId: id,
      text: view.text,
      attachments: [
        ...view.attachments.map((attachment) => ({
          name: attachment.name,
          path: attachment.path,
          kind: attachment.kind === 'mention' ? 'file' as const : attachment.kind,
        })),
        ...view.context.map((block) => ({
          name: block.label,
          path: noteKey(block.label, block.text),
          kind: 'note' as const,
          text: wrapContext(block.label, block.text),
        })),
      ],
      detail,
    })
  }, [key, store])

  useLayoutEffect(() => {
    if (!editing || messages.some((message) => message.id === editing.id)) return
    recoverEdit(
      editing.id,
      editing.attemptId,
      editing.text,
      editing.input,
      'Your edit wasn’t saved — the original was already sent. Restore it to the composer.',
      editing.key,
    )
    setEditing(null)
  }, [editing, messages, recoverEdit])

  useLayoutEffect(() => {
    const previous = previouslyEditing.current
    previouslyEditing.current = editing?.id ?? null
    if (previous && !editing) {
      const row = [...document.querySelectorAll<HTMLElement>('[data-queue-id]')]
        .find((element) => element.dataset.queueId === previous)
      row?.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.focus()
    }
  }, [editing])

  const cancelEdit = useCallback(() => {
    setEditing(null)
  }, [])

  const saveEdit = useCallback(async (id: string, input: Parameters<typeof describeQueued>[0]) => {
    if (!editing || editing.id !== id || saving) return
    setSaving(true)
    const editedInput = withEditedText(input, editing.text)
    try {
      await store.updateQueued(id, editedInput, editing.key ?? undefined)
      setEditing(null)
    } catch (error) {
      recoverEdit(id, editing.attemptId, editing.text, editing.input,
        `Could not save the queued edit: ${error instanceof Error ? error.message : String(error)} Restore it to the composer.`, editing.key)
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }, [editing, key, recoverEdit, saving, store])

  /**
   * Arranging the line: a drag from the handle, or ⌥↑ / ⌥↓ from anywhere in
   * the row (`useSortable`).
   *
   * The order still belongs to the host — every move is `moveQueued` — so two
   * windows on one conversation cannot disagree about what happens next.
   * Nothing is reordered locally; the rows redraw when the queue event comes
   * back, and the move is announced when it lands.
   */
  const sortable = useSortable({
    ids: messages.map((message) => message.id),
    onMove: (id, to) => void store.moveQueued(id, to, key ?? undefined),
    name: (id) => {
      const message = messages.find((entry) => entry.id === id)
      return message ? `“${queuedLabel(message)}”` : 'the message'
    },
    movable: (id) => messages.find((entry) => entry.id === id)?.state === 'queued',
  })

  if (!queue || queue.messages.length === 0) return null
  const paused = queue.status === 'paused'
  const count = queue.messages.length

  /*
    The queue is a notice about this conversation, standing where the goal
    does — so it is drawn as one: the soft alert, on the muted ground behind a
    strong hairline, that turns to the warning tone while it is held. Its head
    is a toolbar and its list the sortable list, both set on the alert's own
    inset. A row takes no hover ground: pressing it does nothing, and a row
    that lights up promises that it would (`ListRow`'s rule). Its actions
    are the sortable item's to reveal, with the pointer or the focus.
  */
  return (
    <Alert
      variant="soft"
      tone={paused ? 'warning' : 'neutral'}
      data-queue={paused ? 'paused' : 'waiting'}
      className={`${styles.queue} flex-col items-stretch gap-1.5`}
    >
      <Toolbar className="flex-nowrap">
        <Text role="meta" {...(paused ? { tone: 'warning' as const } : { ink: 'muted' as const })}>
          {paused ? <AlertIcon size={13} /> : <QueueIcon size={13} />}
        </Text>
        <Text role="meta" ink={paused ? 'primary' : 'secondary'} className={styles.headerText}>
          {paused
            ? `${queue.reason ?? 'The turn did not finish.'} ${count} message${count === 1 ? '' : 's'} waiting.`
            : `${count} message${count === 1 ? '' : 's'} waiting — sent when this turn ends`}
        </Text>
        <ToolbarGap />
        {paused && (
          <Button
            variant="quiet" size="sm" className={styles.action}
            onClick={() => void store.flushQueue(key ?? undefined)}
            title="Send the first waiting message now"
          >
            Send now
          </Button>
        )}
        <Button
          variant="quiet" size="sm" className={styles.action}
          onClick={() => void store.clearQueue(key ?? undefined)}
          title="Throw away everything waiting"
        >
          {count === 1 ? 'Discard' : 'Discard all'}
        </Button>
      </Toolbar>
      <ol aria-label="Waiting messages" className="flex flex-col gap-0.5">
        {queue.messages.map((message, index) => (
          <li
            key={message.id}
            data-slot="sortable-row"
            data-queue-id={message.id}
            {...(message.state === 'sending' ? { 'data-sending': '' } : {})}
            {...sortable.row(message.id, index)}
            className={`${sortableItemClass()} flex items-start gap-2`}
          >
            <SortableHandle {...sortable.handle(message.id)} />
            <Text role="meta" className={styles.position} aria-hidden>
              {message.state === 'sending' ? <Spinner size="sm" tone="brand" /> : index + 1}
            </Text>
            {editing?.id === message.id ? (
              <QueueMessageEditor
                text={editing.text}
                message={message}
                pending={saving}
                onText={(text) => setEditing({ ...editing, text })}
                onSave={() => void saveEdit(message.id, message.input)}
                onCancel={cancelEdit}
              />
            ) : (
              <>
                <Text role="navigation" ink={message.state === 'sending' ? 'muted' : 'primary'} className={styles.text} title={queuedLabel(message)}>
                  {queuedLabel(message)}
                </Text>
                <Carried message={message} />
              </>
            )}
            <When paused={paused} index={index} state={message.state} />
            {message.state === 'queued' && editing?.id !== message.id && (
              <span data-slot="sortable-actions" className="flex shrink-0 items-center gap-px">
                <Button
                  type="button"
                  variant="ghost" size="icon-sm"
                  aria-label="Edit"
                  title={editing ? 'Save or cancel the current edit first' : 'Edit this waiting message in its row'}
                  disabled={Boolean(editing) || saving}
                  onClick={() => setEditing({ id: message.id, text: describeQueued(message.input).text, input: message.input, key, attemptId: ++nextEditAttempt.current })}
                >
                  <PencilIcon size={13} />
                </Button>
                <Button
                  type="button"
                  variant="ghost" size="icon-sm"
                  aria-label="Remove"
                  title="Drop this message"
                  onClick={() => void store.unqueue(message.id, key ?? undefined)}
                >
                  <CrossIcon size={13} />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
      <SortableAnnouncer message={sortable.announcement} />
    </Alert>
  )
}

const QueueMessageEditor = ({
  text,
  message,
  pending,
  onText,
  onSave,
  onCancel,
}: {
  text: string
  message: Parameters<typeof queuedLabel>[0]
  pending: boolean
  onText(text: string): void
  onSave(): void
  onCancel(): void
}) => {
  const view = describeQueued(message.input)
  const empty = text.trim().length === 0 && view.attachments.length === 0 && view.context.length === 0
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <Textarea
        autoFocus
        aria-label="Edit queued message"
        variant="inline"
        controlSize="compact"
        rows={Math.max(2, Math.min(5, text.split('\n').length))}
        value={text}
        disabled={pending}
        onChange={(event) => onText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            if (!empty) onSave()
          }
        }}
      />
      {(view.attachments.length > 0 || view.context.length > 0) && (
        <span role="group" aria-label="Carried with this message" className="flex flex-wrap gap-1">
          {view.attachments.map((attachment, index) => (
            <ComposerChip key={`${attachment.kind}-${attachment.path}-${index}`} title={attachment.path}>
              {attachment.name}
            </ComposerChip>
          ))}
          {view.context.map((block, index) => (
            <ComposerChip key={`${block.label}-${index}`} title={block.text}>
              {block.label}
            </ComposerChip>
          ))}
        </span>
      )}
      <span className="flex items-center justify-end gap-1">
        <Button type="button" variant="quiet" size="sm" disabled={pending} onClick={onCancel}>Cancel</Button>
        <Button type="button" variant="quiet" size="sm" disabled={pending || empty} title={empty ? 'Remove this message instead of saving it empty' : undefined} onClick={onSave}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </span>
    </span>
  )
}

/** Keep resolved context and every non-text part while replacing only what was typed. */
const withEditedText = (input: readonly UserContent[], text: string): readonly UserContent[] => {
  const context = input.flatMap((part) => part.type === 'text' ? splitContext(part.text).injections : [])
  const replacement = [
    ...context.map((block) => wrapContext(block.label, block.text)),
    text,
  ].filter((part) => part.length > 0).join('\n\n')
  let inserted = false
  const output: UserContent[] = []
  for (const part of input) {
    if (part.type !== 'text') {
      output.push(part)
    } else if (!inserted) {
      if (replacement.length > 0) output.push({ type: 'text', text: replacement })
      inserted = true
    }
  }
  return inserted ? output : replacement.length > 0 ? [{ type: 'text', text: replacement }, ...input] : [...input]
}

/**
 * When this one goes, not merely that it is waiting.
 *
 * Three messages in a list are an order; the question a person actually has is
 * which one runs next and whether any of them will run at all. A held queue
 * that still counts 1, 2, 3 reads as imminent when nothing is moving.
 */
const When = ({
  paused,
  index,
  state,
}: {
  paused: boolean
  index: number
  state: string
}) => {
  if (state === 'sending') return null
  if (paused) return <Text role="meta">held</Text>
  if (index === 0) return <Text role="meta" tone="brand">next</Text>
  if (index === 1) return <Text role="meta">then</Text>
  return null
}

/** What rides with a queued message beyond its words, counted rather than listed. */
const Carried = ({ message }: { message: Parameters<typeof queuedLabel>[0] }) => {
  const view = describeQueued(message.input)
  const parts: string[] = []
  const images = view.attachments.filter((entry) => entry.kind === 'image').length
  const files = view.attachments.length - images
  if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`)
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`)
  if (view.context.length > 0) parts.push(`${view.context.length} context`)
  if (parts.length === 0) return null
  return <Text role="meta">{parts.join(' · ')}</Text>
}
