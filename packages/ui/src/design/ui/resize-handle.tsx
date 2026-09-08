import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * The grip between two panes.
 *
 * shadcn's `resizable` wraps `react-resizable-panels`, and the audit named one
 * thing it has that this app does not: **you can resize with the keyboard**.
 * That is what is adopted here, and the library is not, for a reason worth
 * writing down rather than re-deciding later:
 *
 *   `react-resizable-panels` wants to own the sizes. In this app the sizes are
 *   the layout store's &mdash; they persist, they take part in the expand/zoom
 *   rule, and `layout.ts` holds the one-conversation-pane invariant. Handing
 *   sizing to a library means either two sources of truth or a controlled-mode
 *   adapter that is more code than the drag it replaces. So the handle becomes
 *   a component, the store stays the model, and `Panes` keeps its shape.
 *
 * What the keyboard gets, matching the ARIA separator pattern: arrows nudge by
 * a step, Shift-arrow by a coarse one, Home and End go to the extremes, and
 * Enter collapses to the nearest edge and back. `aria-valuenow` means a screen
 * reader can read the split out loud, which no amount of pointer handling gives
 * you.
 *
 * Presentation and input only &mdash; it reports a ratio and never stores one.
 */

const STEP = 0.02
const COARSE = 0.1

type ResizeHandleProps = Omit<React.ComponentProps<'div'>, 'onChange'> & {
  orientation: 'vertical' | 'horizontal'
  /** Where the split sits now, 0&ndash;1. */
  value: number
  /** Called with every new ratio, clamped by `min`/`max`. */
  onChange: (next: number) => void
  /** Called when a drag ends, for a store that only wants the final value. */
  onCommit?: (next: number) => void
  min?: number
  max?: number
  label?: string
  /**
   * Swap which arrow key grows the value.
   *
   * A seam's value is a size or a ratio, and for a panel anchored to the right
   * or bottom edge a *larger* value moves the seam toward the start of the
   * axis. Left alone, ArrowRight on the right panel's seam walked it left —
   * the arrow and the screen disagreeing, which is the one thing the ARIA
   * separator pattern asks a keyboard not to do.
   */
  invert?: boolean
}

const ResizeHandle = ({
  className,
  orientation,
  value,
  onChange,
  onCommit,
  min = 0.15,
  max = 0.85,
  label = 'Resize panes',
  invert = false,
  ...props
}: ResizeHandleProps) => {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))

  const nudge = (delta: number) => {
    const next = clamp(value + delta)
    onChange(next)
    onCommit?.(next)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const toStart = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const toEnd = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    // Which key grows the value, rather than which key points forward.
    const back = invert ? toEnd : toStart
    const forward = invert ? toStart : toEnd
    const step = event.shiftKey ? COARSE : STEP

    if (event.key === back) nudge(-step)
    else if (event.key === forward) nudge(step)
    else if (event.key === 'Home') nudge(min - value)
    else if (event.key === 'End') nudge(max - value)
    else if (event.key === 'Enter') {
      /* Collapse to whichever edge is nearer, and back out again from there
         &mdash; one key that both hides a pane and restores it. */
      const edge = value > (min + max) / 2 ? max : min
      nudge((value === min || value === max ? (min + max) / 2 : edge) - value)
    } else return

    event.preventDefault()
  }

  return (
    <div
      data-slot="resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      onKeyDown={onKeyDown}
      className={cn(
        'group/resize relative flex shrink-0 items-center justify-center',
        orientation === 'vertical' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
        className,
      )}
      {...props}
    >
      {/* The grip: invisible until the pointer is near, because a permanent
          handle between every pair of panes is furniture the reader is not
          looking at. It keeps its hit area either way.

          `data-dragging` is set on this element by whoever is driving the
          drag, without a render &mdash; see `lib/resizing.ts`. Without it the
          grip goes out the moment the pointer leaves the one-pixel line, which
          on a fast drag is immediately: the thing you are holding disappears
          while you are holding it. */}
      <span
        aria-hidden
        className={cn(
          'rounded-full bg-(--hd-border-strong) opacity-0 transition-opacity',
          'group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100',
          'group-data-[dragging]/resize:bg-(--hd-accent) group-data-[dragging]/resize:opacity-100',
          orientation === 'vertical' ? 'h-6 w-0.5' : 'h-0.5 w-6',
        )}
      />
    </div>
  )
}

export { ResizeHandle }
