import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type * as React from 'react'

import { GripIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'

/**
 * A list whose order is the person's to arrange.
 *
 * Order is shown by position and nothing else — never by a pair of "Move up /
 * Move down" buttons on every row, which cost three controls a row to say
 * what the row's place already says. There are three ways to move a row, and
 * each is the same request to whoever owns the order:
 *
 *   drag      from the handle, which appears on the row's hover (or its own
 *             focus). A drag that starts anywhere else is cancelled, so the
 *             row's text stays selectable. A line shows where it will land.
 *   keyboard  ⌥↑ / ⌥↓ from anywhere in the row — the handle is a tab stop
 *             that says so — one place at a time, focus staying with the row.
 *   remove    is not a move: it lives in the row's `⋯` menu or a hover ×,
 *             whichever the row already has.
 *
 * The owner keeps the order. Nothing here reorders locally: `onMove` is a
 * request, and the rows redraw when the owner answers with a new `ids`. That
 * is what lets a host-owned order (a queue two windows share) use this as
 * well as a local one. When the answer lands, the move is said out loud
 * (`aria-live`), because reordering is silent by nature — and a row that the
 * browser blurred on the way to its new place gets its focus back.
 *
 * `SortableAnnouncer` and `sortableMoveMessage` are the same announcement for
 * a list whose moves are made somewhere else — a menu's Move rows — so every
 * reorder in the app is spoken in the same words.
 */

const MOVE_KEYS = 'Alt+ArrowUp Alt+ArrowDown'

/** The one sentence a move is announced in. */
const sortableMoveMessage = (name: string, position: number, total: number): string =>
  `Moved ${name} to position ${position} of ${total}`

/** The shortcut words, for a menu row or a tooltip that names them. */
const SORTABLE_SHORTCUT = { up: '⌥↑', down: '⌥↓' } as const

type SortableOptions = {
  /** The order, as the owner last gave it. */
  readonly ids: readonly string[]
  /** Asks the owner to put `id` at `to`. */
  readonly onMove: (id: string, to: number) => void
  /** What a reader hears the row called. */
  readonly name: (id: string) => string
  /** A row that cannot move right now (one on its way out): no drag, no keys. */
  readonly movable?: (id: string) => boolean
}

type RowProps = Pick<
  React.LiHTMLAttributes<HTMLLIElement>,
  'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop' | 'onKeyDown'
> & { readonly dragging: boolean; readonly drop: boolean }

type HandleProps = {
  readonly ref: (node: HTMLButtonElement | null) => void
  readonly onPointerDown: () => void
  readonly onMouseDown: () => void
  readonly onPointerUp: () => void
  readonly 'aria-label': string
  readonly 'aria-keyshortcuts': string
  readonly title: string
  readonly disabled: boolean
}

const useSortable = ({ ids, onMove, name, movable = () => true }: SortableOptions) => {
  /*
   * Which row is moving lives in a ref, not in state: the drag events of one
   * gesture can arrive in a single task, and a handler reading state would
   * still see the render before the drag began. State carries only what is
   * drawn.
   */
  const dragId = useRef<string | null>(null)
  const grabbed = useRef(false)
  const [drag, setDrag] = useState<{ id: string | null; over: number | null }>({ id: null, over: null })
  const pending = useRef<{ id: string; from: number; refocus: boolean; order: string } | null>(null)
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const [announcement, setAnnouncement] = useState('')

  // The owner answered: say where the row went, and hand focus back to it if
  // the browser dropped it while the row changed places.
  useLayoutEffect(() => {
    const moved = pending.current
    // Nothing asked, or the owner has not answered yet.
    if (!moved || ids.join('\0') === moved.order) return
    pending.current = null
    const index = ids.indexOf(moved.id)
    // The owner answered with something else — refused, or moved another row.
    if (index === -1 || index === moved.from) return
    setAnnouncement(sortableMoveMessage(name(moved.id), index + 1, ids.length))
    if (!moved.refocus) return
    const handle = handles.current.get(moved.id)
    const active = document.activeElement
    if (handle && (active === null || active === document.body || !handle.isConnected || !handle.closest('li')?.contains(active))) {
      handle.focus()
    }
  }, [ids, name])

  const request = useCallback((id: string, to: number, refocus: boolean) => {
    const from = ids.indexOf(id)
    if (from === -1 || to === from) return
    pending.current = { id, from, refocus, order: ids.join('\0') }
    onMove(id, to)
  }, [ids, onMove])

  const end = (): void => {
    dragId.current = null
    grabbed.current = false
    setDrag({ id: null, over: null })
  }

  const row = (id: string, index: number): RowProps => {
    const canMove = movable(id)
    return {
      dragging: drag.id === id,
      drop: drag.id !== null && drag.id !== id && drag.over === index,
      draggable: canMove,
      onDragStart: (event) => {
        if (!canMove || !grabbed.current) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        // Firefox refuses to start a drag with an empty data store.
        event.dataTransfer.setData('text/plain', id)
        dragId.current = id
        setDrag({ id, over: index })
      },
      onDragEnd: end,
      onDragOver: (event) => {
        if (dragId.current === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDrag((state) => (state.over === index ? state : { ...state, over: index }))
      },
      onDrop: (event) => {
        event.preventDefault()
        const moving = dragId.current
        end()
        if (moving) request(moving, index, false)
      },
      onKeyDown: (event) => {
        if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        if (!canMove) return
        event.preventDefault()
        const to = event.key === 'ArrowUp' ? index - 1 : index + 1
        if (to < 0 || to >= ids.length) {
          setAnnouncement(`${name(id)} is already ${to < 0 ? 'first' : 'last'}`)
          return
        }
        request(id, to, true)
      },
    }
  }

  const handle = (id: string): HandleProps => ({
    ref: (node) => {
      if (node) handles.current.set(id, node)
      else handles.current.delete(id)
    },
    onPointerDown: () => { grabbed.current = true },
    onMouseDown: () => { grabbed.current = true },
    // A press that did not become a drag: a later drag from the text is not one.
    onPointerUp: () => { grabbed.current = false },
    'aria-label': `Move ${name(id)}`,
    'aria-keyshortcuts': MOVE_KEYS,
    title: `Drag to reorder, or ${SORTABLE_SHORTCUT.up} ${SORTABLE_SHORTCUT.down}`,
    // A row that cannot move keeps the handle's room, so the rows stay in
    // one column, and draws nothing a pointer or a Tab could land on.
    disabled: !movable(id),
  })

  return { row, handle, announcement }
}

/** Where a reorder is said out loud. Visually nothing. */
const SortableAnnouncer = ({ message }: { message: string }) => (
  <span data-slot="sortable-announcer" role="status" aria-live="polite" className="sr-only">
    {message}
  </span>
)

/** The list itself, and the one place its moves are announced. */
const SortableList = ({
  announcement,
  className,
  ...props
}: React.OlHTMLAttributes<HTMLOListElement> & { announcement: string }) => (
  <>
    <ol data-slot="sortable-list" className={cn('m-0 list-none p-0', className)} {...props} />
    <SortableAnnouncer message={announcement} />
  </>
)

/** One row: dimmed while it is the one being dragged, a line above it where a drop would land. */
const SortableRow = ({
  dragging = false,
  drop = false,
  className,
  ...props
}: React.LiHTMLAttributes<HTMLLIElement> & { dragging?: boolean; drop?: boolean }) => (
  <li
    data-slot="sortable-row"
    {...(dragging ? { 'data-dragging': '' } : {})}
    {...(drop ? { 'data-drop': '' } : {})}
    className={cn(
      'group/sortable-row relative data-[dragging]:opacity-40',
      "data-[drop]:before:absolute data-[drop]:before:top-[-1px] data-[drop]:before:right-2 data-[drop]:before:left-1 data-[drop]:before:h-0.5 data-[drop]:before:rounded-(--hd-radius-2xs) data-[drop]:before:bg-(--hd-primary) data-[drop]:before:content-['']",
      className,
    )}
    {...props}
  />
)

/**
 * The grip. A real button, so a keyboard reaches it and hears how to move the
 * row; drawn only while the row is under the pointer or the grip has focus,
 * because a column of grips at rest is a column of noise.
 */
const SortableHandle = ({
  className,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'ref'> & HandleProps) => (
  <button
    type="button"
    data-slot="sortable-handle"
    className={cn(
      'inline-grid h-(--hd-icon-target) w-3.5 shrink-0 cursor-grab place-items-center rounded-(--hd-radius-sm) border-0 bg-transparent p-0 text-(--hd-muted-foreground) opacity-0',
      'group-hover/sortable-row:opacity-100 focus-visible:opacity-100 active:cursor-grabbing disabled:invisible',
      className,
    )}
    {...props}
  >
    <GripIcon size={12} />
  </button>
)

export {
  SORTABLE_SHORTCUT,
  SortableAnnouncer,
  SortableHandle,
  SortableList,
  SortableRow,
  sortableMoveMessage,
  useSortable,
}
