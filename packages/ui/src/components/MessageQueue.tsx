import { useCallback, useRef, useState } from 'react'

import { useQueue, useSessionKey, useStore } from '../state/context'
import { noteKey, wrapContext } from '../lib/context-envelope'
import { describeQueued, queuedLabel } from '../lib/queue'
import {
  AlertIcon,
  CrossIcon,
  GripIcon,
  MoveDownIcon,
  MoveUpIcon,
  PencilIcon,
  QueueIcon,
} from './Icons'
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

  /** Takes a message back out of the queue and into the composer, whole. */
  const edit = useCallback(
    (id: string) => {
      const message = queue?.messages.find((entry) => entry.id === id)
      if (!message || !key) return
      const view = describeQueued(message.input)
      void store.unqueue(id, key)
      window.dispatchEvent(
        new CustomEvent('harnessdesk:compose', {
          detail: {
            text: view.text,
            replace: true,
            attachments: [
              ...view.attachments.map((attachment) => ({
                name: attachment.name,
                path: attachment.path,
                kind: attachment.kind === 'mention' ? ('file' as const) : attachment.kind,
              })),
              // Context that was already resolved comes back as a note chip
              // holding exactly what was queued. The provider cannot be asked
              // to resolve again — the chip is gone — and this message is the
              // one that was queued, not a fresh one: what it carried is what
              // it should still carry.
              ...view.context.map((block) => ({
                name: block.label,
                path: noteKey(block.label, block.text),
                kind: 'note' as const,
                text: wrapContext(block.label, block.text),
              })),
            ],
          },
        }),
      )
    },
    [key, queue, store],
  )

  /**
   * Dragging a message to a new place in the line.
   *
   * The order still belongs to the host — a drop is `moveQueued`, the same
   * request the arrows make — so two windows on one conversation cannot
   * disagree about what happens next. Nothing is reordered locally; the rows
   * redraw when the queue event comes back.
   *
   * The drag starts from the grip only. The row carries `draggable` because
   * the browser needs it there, but a drag that did not begin on the handle is
   * cancelled, so the message text stays selectable.
   *
   * Which message is moving lives in a ref, not in state: the drag events of
   * one gesture can arrive in a single task, and a handler reading state would
   * still be looking at the render before the drag began. State carries only
   * what is drawn.
   */
  const dragId = useRef<string | null>(null)
  const grabbed = useRef(false)
  const [drag, setDrag] = useState<{ id: string | null; over: number | null }>({
    id: null,
    over: null,
  })

  const drop = useCallback(
    (index: number) => {
      const moving = dragId.current
      if (moving) void store.moveQueued(moving, index, key ?? undefined)
      dragId.current = null
      grabbed.current = false
      setDrag({ id: null, over: null })
    },
    [key, store],
  )

  if (!queue || queue.messages.length === 0) return null
  const paused = queue.status === 'paused'
  const count = queue.messages.length

  /** Where a drop would land, so the list can show the gap before it happens. */
  const dropAt = drag.over !== null && drag.id !== null ? drag.over : null

  return (
    <div className={styles.queue} data-paused={paused ? '' : undefined}>
      <div className={styles.header}>
        {paused ? <AlertIcon className={styles.headerIcon} size={13} /> : <QueueIcon className={styles.headerIcon} size={13} />}
        <span className={styles.headerText}>
          {paused
            ? `${queue.reason ?? 'The turn did not finish.'} ${count} message${count === 1 ? '' : 's'} waiting.`
            : `${count} message${count === 1 ? '' : 's'} waiting — sent when this turn ends`}
        </span>
        {paused && (
          <button
            type="button"
            className={styles.action}
            onClick={() => void store.flushQueue(key ?? undefined)}
            title="Send the first waiting message now"
          >
            Send now
          </button>
        )}
        <button
          type="button"
          className={styles.action}
          onClick={() => void store.clearQueue(key ?? undefined)}
          title="Throw away everything waiting"
        >
          {count === 1 ? 'Discard' : 'Discard all'}
        </button>
      </div>
      <ol className={styles.list}>
        {queue.messages.map((message, index) => (
          <li
            key={message.id}
            className={styles.row}
            data-sending={message.state === 'sending' ? '' : undefined}
            data-dragging={drag.id === message.id ? '' : undefined}
            data-drop={dropAt === index && drag.id !== message.id ? '' : undefined}
            draggable={message.state === 'queued'}
            onDragStart={(event) => {
              if (!grabbed.current) {
                event.preventDefault()
                return
              }
              event.dataTransfer.effectAllowed = 'move'
              // Firefox refuses to start a drag with an empty data store.
              event.dataTransfer.setData('text/plain', message.id)
              dragId.current = message.id
              setDrag({ id: message.id, over: index })
            }}
            onDragEnd={() => {
              dragId.current = null
              grabbed.current = false
              setDrag({ id: null, over: null })
            }}
            onDragOver={(event) => {
              if (dragId.current === null) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDrag((state) => (state.over === index ? state : { ...state, over: index }))
            }}
            onDrop={(event) => {
              event.preventDefault()
              drop(index)
            }}
          >
            <span
              className={styles.grip}
              aria-hidden
              onMouseDown={() => {
                grabbed.current = true
              }}
            >
              <GripIcon size={12} />
            </span>
            <span className={styles.position} aria-hidden>
              {message.state === 'sending' ? <span className={styles.spinner} /> : index + 1}
            </span>
            <span className={styles.text} title={queuedLabel(message)}>
              {queuedLabel(message)}
            </span>
            <Carried message={message} />
            <When paused={paused} index={index} state={message.state} />
            {message.state === 'queued' && (
              <span className={styles.controls}>
                <button
                  type="button"
                  className={styles.control}
                  disabled={index === 0}
                  aria-label="Move up"
                  title="Send this one earlier"
                  onClick={() => void store.moveQueued(message.id, index - 1, key ?? undefined)}
                >
                  <MoveUpIcon size={13} />
                </button>
                <button
                  type="button"
                  className={styles.control}
                  disabled={index === count - 1}
                  aria-label="Move down"
                  title="Send this one later"
                  onClick={() => void store.moveQueued(message.id, index + 1, key ?? undefined)}
                >
                  <MoveDownIcon size={13} />
                </button>
                <button
                  type="button"
                  className={styles.control}
                  aria-label="Edit"
                  title="Put this back in the composer"
                  onClick={() => edit(message.id)}
                >
                  <PencilIcon size={13} />
                </button>
                <button
                  type="button"
                  className={styles.control}
                  aria-label="Remove"
                  title="Drop this message"
                  onClick={() => void store.unqueue(message.id, key ?? undefined)}
                >
                  <CrossIcon size={13} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
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
  if (paused) {
    return (
      <span className={styles.when} data-tone="held">
        held
      </span>
    )
  }
  if (index === 0) {
    return (
      <span className={styles.when} data-tone="next">
        next
      </span>
    )
  }
  if (index === 1) return <span className={styles.when}>then</span>
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
  return <span className={styles.carried}>{parts.join(' · ')}</span>
}
