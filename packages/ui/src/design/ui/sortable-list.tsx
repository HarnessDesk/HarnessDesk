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
 *             row's text stays selectable. A line shows where it will land:
 *             above the row under the pointer's upper half, below its lower
 *             half, and nowhere when the drop would change nothing.
 *             Items that are themselves the handle — a tab in a strip — ask
 *             for `grip: 'item'`.
 *   keyboard  ⌥↑ / ⌥↓ from anywhere in the row but a text field (⌥← / ⌥→
 *             along a `horizontal` strip), one place at a time, focus staying
 *             with the row. The handles are one tab stop for the list — ↑/↓
 *             walk between them — and Space or Enter on one picks its row up:
 *             ↑/↓ then carry it, Space or Enter puts it down, Escape puts it
 *             back where it was.
 *   menu      `move(id, to)`, for a row's own Move items: the same request,
 *             answered and announced the same way.
 *   remove    is not a move: it lives in the row's `⋯` menu or a hover ×,
 *             whichever the row already has.
 *
 * The owner keeps the order. Nothing here reorders locally: `onMove` is a
 * request, and the rows redraw when the owner answers with a new `ids`. That
 * is what lets a host-owned order (a queue two windows share) use this as
 * well as a local one. When the answer lands, the move is said out loud
 * (`aria-live`), because reordering is silent by nature. Focus stays on the
 * handle that moved: React moves the row's own node, and the engine keeps
 * focus on a node that is moved rather than removed (measured in the
 * browser spec), so nothing here has to put it back.
 *
 * `SortableAnnouncer` is where the sentence is said: the list renders it
 * beside itself (an `ol` holds only rows), so every reorder in the app is
 * spoken in the same words, from the same kind of region.
 */

/** The one sentence a move is announced in. */
const sortableMoveMessage = (name: string, position: number, total: number): string =>
  `Moved ${name} to position ${position} of ${total}`

/** A key that belongs to what is being typed in, not to the list. */
const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))

type SortableOptions = {
  /** The order, as the owner last gave it. */
  readonly ids: readonly string[]
  /** Asks the owner to put `id` at `to`. */
  readonly onMove: (id: string, to: number) => void
  /** What a reader hears the row called. */
  readonly name: (id: string) => string
  /** A row that cannot move right now (one on its way out, or a write in flight): no drag, no keys. */
  readonly movable?: (id: string) => boolean
  /** A strip reads ⌥← / ⌥→; a list reads ⌥↑ / ⌥↓. */
  readonly orientation?: 'vertical' | 'horizontal'
  /** Where a drag may start: the handle (a row with text in it), or the whole item (a tab). */
  readonly grip?: 'handle' | 'item'
  /** What to say when a move takes a row out of the order altogether. */
  readonly left?: (id: string) => string
}

/** Where a drop would land, drawn on the row it is beside. */
type DropEdge = 'before' | 'after'

type ItemProps = Pick<
  React.HTMLAttributes<HTMLElement>,
  'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop' | 'onKeyDown'
> & {
  readonly 'data-dragging'?: ''
  readonly 'data-drop'?: DropEdge
}

type HandleProps = {
  readonly ref: (node: HTMLButtonElement | null) => void
  readonly onPointerDown: () => void
  readonly onMouseDown: () => void
  readonly onPointerUp: () => void
  readonly onFocus: () => void
  readonly onBlur: (event: React.FocusEvent<HTMLButtonElement>) => void
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  readonly tabIndex: number
  readonly 'aria-label': string
  readonly 'aria-keyshortcuts': string
  readonly 'aria-pressed': boolean
  readonly title: string
  readonly disabled: boolean
}

const useSortable = ({ ids, onMove, name, movable = () => true, orientation = 'vertical', grip = 'handle', left }: SortableOptions) => {
  const [back, on] = orientation === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  const keys = `Alt+${back} Alt+${on}`
  const shortcut = orientation === 'horizontal' ? '⌥← ⌥→' : '⌥↑ ⌥↓'
  /*
   * Which row is moving lives in a ref, not in state: the drag events of one
   * gesture can arrive in a single task, and a handler reading state would
   * still see the render before the drag began. State carries only what is
   * drawn.
   */
  const dragId = useRef<string | null>(null)
  const grabbed = useRef(false)
  const [drag, setDrag] = useState<{ id: string | null; slot: number | null }>({ id: null, slot: null })
  const pending = useRef<{ id: string; from: number; order: string } | null>(null)
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const [announcement, setAnnouncement] = useState('')
  /** The handle that is the list's one tab stop. */
  const [current, setCurrent] = useState<string | null>(null)
  /** A row picked up from the keyboard, and where it was when it was. */
  const [lifted, setLifted] = useState<{ id: string; from: number } | null>(null)

  /* The same sentence twice is not a change, and a live region only speaks
     changes: a second "already last" would be silent. A no-break space tells
     them apart without being heard. */
  const say = useCallback((text: string) => {
    setAnnouncement((was) => (was === text ? `${text} ` : text))
  }, [])

  // The owner answered: say where the row went.
  useLayoutEffect(() => {
    const moved = pending.current
    // Nothing asked, or the owner has not answered yet.
    if (!moved || ids.join('\0') === moved.order) return
    pending.current = null
    const index = ids.indexOf(moved.id)
    // Out of the order altogether: said, if the owner has words for it.
    if (index === -1) {
      if (moved.from !== -1 && left) say(left(moved.id))
      return
    }
    // The owner answered with something else — refused, or moved another row.
    if (index === moved.from) return
    say(sortableMoveMessage(name(moved.id), index + 1, ids.length))
  }, [ids, name, left, say])

  const request = useCallback((id: string, to: number) => {
    // A row not in the order yet may join it (a menu's Move on an unarranged item).
    const from = ids.indexOf(id)
    if (to === from) return
    pending.current = { id, from, order: ids.join('\0') }
    onMove(id, to)
  }, [ids, onMove])

  /** One place along, or a sentence saying there is no further to go. */
  const step = (id: string, index: number, by: -1 | 1): void => {
    const to = index + by
    if (to < 0 || to >= ids.length) {
      say(`${name(id)} is already ${to < 0 ? 'first' : 'last'}`)
      return
    }
    request(id, to)
  }

  const end = (): void => {
    dragId.current = null
    grabbed.current = false
    setDrag({ id: null, slot: null })
  }

  /** The slot a drop would fill, and whether filling it changes anything. */
  const moving = drag.id === null ? -1 : ids.indexOf(drag.id)
  const slot = drag.slot !== null && moving !== -1 && drag.slot !== moving && drag.slot !== moving + 1 ? drag.slot : null

  const row = (id: string, index: number): ItemProps => {
    const canMove = movable(id)
    const edge: DropEdge | null = slot === index ? 'before' : slot === ids.length && index === ids.length - 1 ? 'after' : null
    return {
      ...(drag.id === id ? { 'data-dragging': '' as const } : {}),
      ...(edge ? { 'data-drop': edge } : {}),
      draggable: canMove,
      onDragStart: (event) => {
        if (!canMove || (grip === 'handle' && !grabbed.current)) {
          event.preventDefault()
          return
        }
        event.dataTransfer.effectAllowed = 'move'
        // Firefox refuses to start a drag with an empty data store.
        event.dataTransfer.setData('text/plain', id)
        dragId.current = id
        setDrag({ id, slot: null })
      },
      onDragEnd: end,
      onDragOver: (event) => {
        if (dragId.current === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        // The pointer's half of the row says which side of it the drop lands.
        const box = event.currentTarget.getBoundingClientRect()
        const upper = orientation === 'horizontal'
          ? event.clientX < box.left + box.width / 2
          : event.clientY < box.top + box.height / 2
        const next = upper ? index : index + 1
        setDrag((state) => (state.slot === next ? state : { ...state, slot: next }))
      },
      onDrop: (event) => {
        event.preventDefault()
        const id = dragId.current
        const from = id === null ? -1 : ids.indexOf(id)
        const box = event.currentTarget.getBoundingClientRect()
        const upper = orientation === 'horizontal'
          ? event.clientX < box.left + box.width / 2
          : event.clientY < box.top + box.height / 2
        const into = upper ? index : index + 1
        end()
        // The slot is counted with the moving row still in place; the index
        // it ends at is counted without it.
        if (id !== null && from !== -1) request(id, into > from ? into - 1 : into)
      },
      onKeyDown: (event) => {
        if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
        if (event.key !== back && event.key !== on) return
        if (!canMove || editable(event.target)) return
        event.preventDefault()
        step(id, index, event.key === back ? -1 : 1)
      },
    }
  }

  const movableIds = ids.filter((id) => movable(id))
  const stop = current !== null && movableIds.includes(current) ? current : (movableIds[0] ?? null)

  const handle = (id: string): HandleProps => {
    const index = ids.indexOf(id)
    const up = lifted?.id === id
    return {
      ref: (node) => {
        if (node) handles.current.set(id, node)
        else handles.current.delete(id)
      },
      onPointerDown: () => { grabbed.current = true },
      onMouseDown: () => { grabbed.current = true },
      // A press that did not become a drag: a later drag from the text is not one.
      onPointerUp: () => { grabbed.current = false },
      onFocus: () => setCurrent(id),
      // Focus that goes somewhere on purpose puts a lifted row down where it
      // is. A row the browser blurred on its way to a new place stays up.
      onBlur: (event) => {
        if (up && event.relatedTarget !== null) setLifted(null)
      },
      onKeyDown: (event) => {
        if (event.altKey || event.metaKey || event.ctrlKey) return
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          if (up) {
            setLifted(null)
            say(`Dropped ${name(id)} at position ${index + 1} of ${ids.length}`)
          } else {
            setLifted({ id, from: index })
            say(`Picked up ${name(id)}, position ${index + 1} of ${ids.length}. Arrow keys move it, Space puts it down, Escape puts it back.`)
          }
          return
        }
        if (event.key === 'Escape' && up) {
          event.preventDefault()
          event.stopPropagation()
          setLifted(null)
          if (index !== lifted.from) request(id, lifted.from)
          else say(`${name(id)} is back at position ${index + 1} of ${ids.length}`)
          return
        }
        if (event.key !== back && event.key !== on) return
        event.preventDefault()
        const by = event.key === back ? -1 : 1
        if (up) {
          step(id, index, by)
          return
        }
        // Not lifted: the arrows walk the handles, the list's one tab stop.
        const at = movableIds.indexOf(id)
        const next = movableIds[at + by]
        if (next) handles.current.get(next)?.focus()
      },
      tabIndex: id === stop ? 0 : -1,
      'aria-label': `Move ${name(id)}`,
      'aria-keyshortcuts': keys,
      'aria-pressed': up,
      title: `Drag to reorder, or ${shortcut}. Space picks it up.`,
      // A row that cannot move keeps the handle's room, so the rows stay in
      // one column, and draws nothing a pointer or a Tab could land on.
      disabled: !movable(id),
    }
  }

  /** A move asked for from elsewhere — a menu's Move row — answered and said like any other. */
  const move = (id: string, to: number): void => request(id, to)

  return { row, handle, move, announcement, keys }
}

/** Where a reorder is said out loud. Visually nothing. */
const SortableAnnouncer = ({ message }: { message: string }) => (
  <span data-slot="sortable-announcer" role="status" aria-live="polite" className="sr-only">
    {message}
  </span>
)

/**
 * How any item of a sortable order draws its part in a move — a row in a
 * list, a tab in a strip: dimmed while it is the one being dragged, and a
 * line on the side a drop would land. One drawing, whatever the item is.
 */
const sortableItemClass = (orientation: 'vertical' | 'horizontal' = 'vertical'): string =>
  cn(
    'group/sortable-row relative data-[dragging]:opacity-40',
    "data-[drop]:before:absolute data-[drop]:before:rounded-(--hd-radius-2xs) data-[drop]:before:bg-(--hd-primary) data-[drop]:before:content-['']",
    orientation === 'vertical'
      ? 'data-[drop]:before:right-2 data-[drop]:before:left-1 data-[drop]:before:h-0.5 data-[drop=before]:before:-top-px data-[drop=after]:before:-bottom-px'
      : 'data-[drop]:before:top-1 data-[drop]:before:bottom-1 data-[drop]:before:w-0.5 data-[drop=before]:before:-left-px data-[drop=after]:before:-right-px',
  )

/**
 * The grip. A real button, so a keyboard reaches it and hears how to move the
 * row; drawn only while the row is under the pointer or the grip has focus,
 * because a column of grips at rest is a column of noise. Pressed while its
 * row is picked up.
 */
const SortableHandle = ({
  className,
  ...props
}: React.ComponentProps<'button'>) => (
  <button
    type="button"
    data-slot="sortable-handle"
    className={cn(
      'inline-grid h-(--hd-icon-target) w-3.5 shrink-0 cursor-grab place-items-center rounded-(--hd-radius-sm) border-0 bg-transparent p-0 text-(--hd-muted-foreground) opacity-0',
      'group-hover/sortable-row:opacity-100 focus-visible:opacity-100 aria-pressed:opacity-100 aria-pressed:text-(--hd-primary) active:cursor-grabbing disabled:invisible',
      className,
    )}
    {...props}
  >
    <GripIcon size={12} />
  </button>
)

export { SortableAnnouncer, SortableHandle, sortableItemClass, useSortable }
