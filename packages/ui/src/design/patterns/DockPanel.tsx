import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'

import { CrossIcon } from '../../components/Icons'
import { beginResize, endResize, markDragging } from '../../lib/resizing'
import { cn } from '../../lib/utils'
import { ResizeHandle } from '../ui/resize-handle'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

/**
 * The furniture a docked panel wears, wherever it is docked.
 *
 * One component for the right panel, the bottom panel and the sidebar's lower
 * stack, because those three differ in exactly two ways — which edge they sit
 * against, and whether their size is a width or a height — and neither is a
 * reason for three implementations. Before this the app had a tab strip in
 * `Details`, a second one in the terminal dock, and a third in the browser
 * pane; each learned separately about close buttons, overflow and the active
 * state, and they never agreed about padding.
 *
 * The vocabulary is the one every IDE settled on, and it is worth being
 * explicit about which parts are load-bearing:
 *
 *   A tab per view.        Not a dropdown. The point of a second thing docked
 *                          in a panel is knowing it is there; a hidden tab is
 *                          a panel the reader has forgotten they left open.
 *                          Past what fits, the strip scrolls.
 *   Actions are the        Zoom, collapse and close act on the *panel*, not on
 *   panel's, not the       what is inside it. A view drawing its own expand
 *   view's.                button is a view that knows where it lives, which
 *                          is the coupling this whole system exists to remove.
 *   Collapsed keeps its    Collapsing hides the body and keeps the strip, so
 *   strip.                 the way back is where the way in was. Closing is
 *                          the other verb and takes the tab with it.
 *
 * Presentation and input only. Nothing here holds a size, an active id, or an
 * opinion about what may be docked where — those are `state/workbench.ts`'s,
 * and this draws what it is handed.
 */

export type PanelEdge = 'left' | 'right' | 'top' | 'bottom'

/**
 * Which side the panel's dividing rule is drawn on. `edge` names that side —
 * the right panel's rule is on its left, the bottom panel's is on its top —
 * because the rule is the seam with whatever the panel is beside.
 */
const RULE: Record<PanelEdge, string> = {
  left: 'border-l border-(--hd-border)',
  right: 'border-r border-(--hd-border)',
  top: 'border-t border-(--hd-border)',
  bottom: 'border-b border-(--hd-border)',
}

/**
 * The frame: a column with a rule on the edge it hugs, and its own ground.
 *
 * One component for the right panel, the bottom panel and the sidebar's lower
 * stack, because those three differ in exactly two ways — which edge they sit
 * against, and whether their size is a width or a height — and neither is a
 * reason for three implementations.
 */
export const DockPanel = ({
  edge,
  collapsed,
  className,
  ...props
}: React.ComponentProps<'section'> & { edge: PanelEdge; collapsed?: boolean }) => (
  <section
    data-slot="dock-panel"
    data-edge={edge}
    {...(collapsed ? { 'data-collapsed': '' } : {})}
    className={cn(
      'flex min-h-0 min-w-0 flex-col overflow-hidden bg-(--hd-card)',
      RULE[edge],
      className,
    )}
    {...props}
  />
)

/**
 * The strip: tabs on the left, the panel's own controls on the right.
 *
 * The controls act on the *panel*, never on what is inside it. A view drawing
 * its own expand button is a view that knows where it lives, which is the
 * coupling the whole panel system exists to remove.
 */
export const DockPanelBar = ({ className, ...props }: React.ComponentProps<'header'>) => (
  <header
    data-slot="dock-panel-bar"
    className={cn(
      /* The window's top row, shared with the conversation's header and every
         tool's — see `--hd-topbar-h`. A strip 14px shorter than the header
         beside it put a step in the one horizontal line the eye follows
         across the window. */
      'flex h-(--hd-bar-h) shrink-0 items-center gap-1 border-b border-(--hd-border) px-2',
      /* And a top row is a handle for the window, like every other one: the
         conversation's header, a tool's, the sidebar's title bar. This strip
         was the only chrome in the app that was not, so a room or a board in
         the middle drew a full-width bar under the traffic lights that could
         not be dragged — the window moved from the conversation header below
         it and from nowhere else. The tabs and the verbs opt back out; see
         `hd-no-drag` in `app.css`. */
      'hd-drag',
      /* A strip can be the row under the macOS window buttons — a panel zoomed
         to fill the window, a board in the middle with the sidebar away — so
         its left padding is the greater of its own and whatever room the shell
         says this box owes them. See `--titlebar-inset` in `app.css`. */
      'pl-[max(var(--hd-space-2),var(--titlebar-inset,0px))]',
      className,
    )}
    {...props}
  />
)

/**
 * Keeps the tab a panel is actually showing inside the strip.
 *
 * "Past what fits, the strip scrolls" is only half a promise: the browser
 * scrolls a *newly mounted* tab into view and never touches the strip again,
 * so bringing an existing tab forward — from the View menu, from the palette,
 * from a neighbour closing — switched the body and left the strip where it
 * was. With six tabs in a 460px panel that means every tab on screen reads
 * unselected while the panel shows a seventh, and the way back to it is a
 * horizontal scrollbar that is not drawn.
 *
 * `scrollLeft` rather than `scrollIntoView`: the latter is free to scroll every
 * scrollable ancestor, and the ancestors here are the panel body and the
 * window.
 */
const useTabInView = (value: string | null): RefObject<HTMLDivElement | null> => {
  const list = useRef<HTMLDivElement>(null)

  const show = useCallback(() => {
    const box = list.current
    /* `aria-selected`, read off the live DOM rather than off Base UI's docs —
       this build spells the *styling* hook `data-active`, and a selector that
       guesses wrong here fails silently and permanently. */
    const tab = box?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!box || !tab) return
    const strip = box.getBoundingClientRect()
    const at = tab.getBoundingClientRect()
    /* Round-trip through the rects rather than `offsetLeft`, so a tab inside
       the draggable span each one is wrapped in is still measured against the
       strip it has to fit in. */
    if (at.left < strip.left) box.scrollLeft += at.left - strip.left
    else if (at.right > strip.right) box.scrollLeft += at.right - strip.right
  }, [])

  useLayoutEffect(show, [show, value])

  /* And when the panel is narrowed, which walks the same tab off the edge
     without the active one ever changing. */
  useEffect(() => {
    const box = list.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(show)
    observer.observe(box)
    return () => observer.disconnect()
  }, [show])

  return list
}

/**
 * The tabs.
 *
 * Base UI's tabs underneath, so the roving focus, the arrow keys and the
 * `aria-controls` wiring are the platform's rather than three hand-rolled
 * copies. `variant="line"` with the indicator suppressed: the strip already
 * sits on a rule, and a second line under the active tab is one line too many
 * at this height.
 */
export const DockPanelTabs = ({
  value,
  onValueChange,
  className,
  children,
  label,
}: {
  value: string | null
  onValueChange: (next: string) => void
  className?: string
  children: ReactNode
  label: string
}) => {
  const list = useTabInView(value)
  return (
  <Tabs
    value={value ?? ''}
    onValueChange={(next) => onValueChange(String(next))}
    className="min-w-0 flex-1 gap-0"
  >
    <TabsList
      ref={list}
      variant="line"
      data-slot="dock-panel-tabs"
      aria-label={label}
      /*
       * The height goes on the list, not on the tab.
       *
       * `TabsTrigger` carries `group-data-[orientation=horizontal]/tabs:h-[calc(100%-1px)]`
       * — a variant-prefixed height, which `tailwind-merge` will not dedupe
       * against a plain `h-…` on the trigger, so setting one there silently
       * loses. The tab fills the list; the list is what has a height. Three
       * attempts at a taller tab went nowhere before this was read.
       */
      className={cn('h-(--hd-control-h) w-full justify-start gap-0.5 overflow-x-auto', className)}
    >
      {children}
    </TabsList>
  </Tabs>
  )
}

/**
 * One tab, and the ✕ welded to it rather than inside it.
 *
 * A button inside a button is invalid markup and browsers resolve it by
 * dropping one of them — usually the one that was wanted. So the close control
 * is a sibling pulled back over the tab's own padding: it looks attached, it is
 * separately reachable by keyboard, and the tab's own click never has to guess
 * which of the two it was meant for.
 *
 * Every tab says its name, truncated rather than hidden. The Details column
 * this replaces showed the name only for the active tab, and that was right
 * for a 360px column carrying four fixed tabs — but a panel can be the width
 * of the window, and a row of anonymous glyphs in nine hundred pixels is a
 * puzzle, not a saving.
 */
export const DockPanelTab = ({
  value,
  icon,
  onClose,
  label,
  live,
  className,
  ...props
}: Omit<React.ComponentProps<typeof TabsTrigger>, 'children'> & {
  value: string
  icon?: ReactNode
  label: string
  onClose?: () => void
  /**
   * The view has something going on — a task still running. The tab wears a
   * small dot after its name, so a panel that is collapsed or showing another
   * tab still says there is something in here to look at.
   */
  live?: boolean
}) => (
  /* Out of the strip's drag region, and the *tab* rather than the tab list:
     the list is `w-full`, so no-dragging it would hand the whole strip back
     and leave the window with no handle at all. Past the last tab the strip
     is empty space and stays a handle, which is where a person grabs a window
     anyway. A tab is also the thing you drag to another dock — HTML5 drag and
     drop does not survive inside an app-region drag rect. */
  <span className="group/tab hd-no-drag flex shrink-0 items-center">
    <TabsTrigger
      data-slot="dock-panel-tab"
      value={value}
      title={live ? `${label} — something is still running` : label}
      aria-label={live ? `${label}, something is still running` : label}
      {...(live ? { 'data-live': '' } : {})}
      className={cn(
        /* One glyph size across this row. The tab's mark, its ✕ and the
           panel's verbs beside them were 16, 12 and 13 — three sizes in one
           strip, which reads as a wobble rather than as three things. The
           mark's size is passed by the caller, because `Icons` sets a width
           attribute that a utility class was not beating. */
        /*
         * The app's one tab height — 26px, which is what `ToolPanes .tab` uses
         * for the browser's own strip, because a 14px label needs a 21px line.
         * A status chip stays 22: it carries 12px text and is not a tab.
         *
         * The variant prefix is not decoration. `TabsTrigger` sets
         * `group-data-[orientation=horizontal]/tabs:h-[calc(100%-1px)]`, and
         * `tailwind-merge` only dedupes two classes that carry the *same*
         * variant — so a plain `h-…` here loses silently, which it did three
         * times before this was read rather than guessed at.
         */
        'peer/tab group-data-[orientation=horizontal]/tabs:h-(--hd-control-h) flex-none gap-1.5 px-2 text-(--hd-text-sm)',
        'text-(--hd-secondary-foreground) hover:bg-(--hd-hover)',
        /*
         * A document tab, not a section tab: the active one is a filled pill,
         * the way the browser's own strip and the terminal's have always drawn
         * theirs. An underline is for switching between views *of one thing*;
         * these tabs switch between different things, and the browser sitting
         * directly underneath with pills of its own made the mismatch plain.
         *
         * Both the fill and the suppressed underline carry the base's own
         * variant prefix, because `tailwind-merge` only dedupes classes whose
         * variants match — without it the library's
         * `group-data-[variant=line]/tabs-list:data-active:after:opacity-100`
         * wins and the underline comes back.
         */
        'group-data-[variant=line]/tabs-list:data-active:bg-(--hd-selected)',
        'data-active:font-medium data-active:text-(--hd-foreground)',
        'group-data-[variant=line]/tabs-list:data-active:after:opacity-0',
        '[&_svg]:shrink-0',
        onClose && 'pr-5',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="max-w-40 truncate">{label}</span>
      {live && (
        <span
          aria-hidden
          data-slot="dock-panel-tab-live"
          className="size-1.5 shrink-0 rounded-full bg-(--hd-success)"
        />
      )}
    </TabsTrigger>
    {onClose && (
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        /* The click stops here. It used to bubble to the tab list, which read
           it as "select this tab" and activated the very view being undocked —
           a close that first brought forward what it was closing. */
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        /*
         * A press on the ✕ must never become a drag, and `mousedown` is the
         * only place that can stop one.
         *
         * The caller wraps every tab in a `draggable` span so it can be pulled
         * to another dock, and a gesture beginning on a non-draggable
         * descendant takes the nearest draggable *ancestor* as its source node.
         * Two earlier attempts here were both dead code, and both looked
         * verified:
         *
         *   `onDragStart` on this button — `dragstart` is fired AT the source
         *   node, so a descendant is never on its path and the handler cannot
         *   run. "Proved" by dispatching a synthetic `dragstart` at the button.
         *
         *   `event.target.closest(…)` on the wrapper — `event.target` there IS
         *   the wrapper, and `closest` walks *up*, so it can never find a
         *   descendant. "Proved" by a probe that overwrote `event.target`.
         *
         * Preventing the default action of `mousedown` is what actually stops
         * the browser starting a drag from this point, and it leaves `click`
         * alone: a click is synthesised from the press/release pair regardless.
         * It also drops focus-on-press, which is why the ✕ still reveals itself
         * on `focus-visible` for anyone reaching it by keyboard.
         */
        data-slot="dock-panel-tab-close"
        draggable={false}
        onMouseDown={(event) => {
          event.preventDefault()
        }}
        /*
         * Revealed by its own tab, not by the panel. `group/tab` was declared
         * on the trigger and never read by anything; the reveal hung off
         * `group/panel`, so pointing anywhere in the panel lit up every tab's
         * ✕ at once and pointing at a tab in a panel you were not over lit
         * none. The active tab keeps its ✕ shown unconditionally — that is the
         * tab you are looking at, and every tabbed interface on this machine
         * offers to close it without being asked twice.
         *
         * `group-hover/panel` is gone rather than kept as a wider reveal: with
         * it here the paragraph above was a description of what the code did
         * not do, since one pointer anywhere in the panel still lit every ✕.
         */
        /*
         * `relative` is load-bearing, and its absence is the whole bug.
         *
         * The ✕ is pulled back over the tab's own right padding with `-ml-5`,
         * and `TabsTrigger` is `position: relative` (it needs to be — the
         * underline is an `::after` on it). A positioned element paints above
         * a static one whatever the DOM order, so the trigger covered all 16px
         * of this button and `elementFromPoint` at its centre returned the tab.
         * It was painted, focusable and keyboard-operable, and no pointer could
         * ever reach it: the ✕ did nothing when clicked. Positioning it puts it
         * back on top, where being the later sibling wins.
         */
        className="relative -ml-5 inline-flex size-4 items-center justify-center rounded-(--hd-radius-sm) text-(--hd-muted-foreground) opacity-0 hover:bg-(--hd-hover) hover:text-(--hd-foreground) focus-visible:opacity-100 peer-data-active/tab:opacity-100 group-hover/tab:opacity-100 [&_svg]:size-3.5"
      >
        <CrossIcon />
      </button>
    )}
  </span>
)

/** Where the panel's own verbs sit: move, expand, collapse. */
export const DockPanelActions = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="dock-panel-actions"
    /* Out of the strip's drag region. A drag region eats the press: the window
       slides and the button fires only when the pointer happened not to move,
       which reads as a control that works every other time. */
    className={cn('hd-no-drag flex shrink-0 items-center gap-0.5', className)}
    {...props}
  />
)

/**
 * The box the mounted views are drawn into.
 *
 * Every one of them stays mounted and the ones not on screen are hidden rather
 * than unmounted — a diff's scroll position, a shell's screen and a page's
 * history all survive a change of tab that way.
 */
export const DockPanelBody = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="dock-panel-body"
    className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', className)}
    {...props}
  />
)

/**
 * The seam between two areas, in pixels.
 *
 * `ResizeHandle` speaks fractions, because that is what a split between two
 * documents is. A dock is not that: it holds rows and lines, and 12% of a
 * 3440px display is a different panel than 12% of a laptop. So the size stays
 * in pixels and the handle is driven through a normalised value — one
 * component, two ways of measuring, and the keyboard, the ARIA values and the
 * grip come along for free.
 *
 * The drag is measured as a delta from where the pointer went down rather than
 * against the frame's box. A delta needs no parent rectangle, so a seam can be
 * dropped anywhere in a layout without also being told what it is inside — and
 * it stays correct while the thing it is resizing is what is moving. It also
 * means the seam never jumps out from under the pointer at the moment you take
 * hold of it: you keep the pixel you grabbed, wherever in the hit area it was.
 *
 * Nothing here is React state. The live size goes out through `onResize` on
 * every frame, and where it lands — `AreaSeam`, in the workbench — that is a
 * custom property written straight to the DOM. `onCommit` is handed the value
 * the gesture ended on, read back from a ref rather than from the `size` prop:
 * a caller that does not re-render mid-drag has been passing this component
 * the *committed* size all along, and committing that put the panel straight
 * back where it started.
 */
export const PanelSeam = ({
  orientation,
  size,
  min,
  max,
  /** +1 when dragging toward the end grows the panel, -1 when it shrinks it. */
  direction,
  onResize,
  onCommit,
  onCancel,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onChange'> & {
  orientation: 'vertical' | 'horizontal'
  size: number
  min: number
  max: number
  direction: 1 | -1
  onResize: (next: number) => void
  onCommit?: (next: number) => void
  /**
   * The gesture was abandoned — cancelled, or the seam went away under the
   * pointer. Whoever is painting the live size has to put it back.
   *
   * `onCommit` cannot stand in for this. A caller that drags a CSS property
   * rather than React state has drawn a size nothing else knows about, and on
   * a cancel there is no commit to overwrite it: without this the panel keeps
   * whatever width the abandoned drag last reached, while the store still says
   * the old one.
   */
  onCancel?: () => void
  label: string
}) => {
  const from = useRef<{ readonly at: number; readonly size: number } | null>(null)
  const clamp = useCallback((next: number) => Math.min(max, Math.max(min, next)), [min, max])
  const span = max - min

  /** Where the gesture is now — the number `onCommit` will be handed. */
  const live = useRef(size)

  const captured = useRef<{ readonly node: HTMLDivElement; readonly pointer: number } | null>(null)

  const push = useCallback(
    (next: number) => {
      live.current = next
      onResize(next)
    },
    [onResize],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      captured.current = { node: event.currentTarget, pointer: event.pointerId }
      markDragging(event.currentTarget, true)
      beginResize(orientation)
      live.current = size
      from.current = { at: orientation === 'vertical' ? event.clientX : event.clientY, size }
    },
    [orientation, size],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = from.current
      if (!start) return
      const now = orientation === 'vertical' ? event.clientX : event.clientY
      push(clamp(start.size + (now - start.at) * direction))
    },
    [orientation, direction, clamp, push],
  )

  /**
   * The end of a gesture, however it ended, and only once.
   *
   * The guard is the whole point. `stop` is now reached from four directions —
   * pointer up, pointer cancel, `lostpointercapture`, and the seam unmounting
   * under the pointer — and two of those fire for the *same* gesture:
   * releasing the capture ourselves raises `lostpointercapture` a moment
   * later. Without the early return that second call would hand back a
   * suppression this drag never took, unbalancing the window's resize flag for
   * whatever drag came next.
   */
  const stop = useCallback(
    (commit: boolean) => {
      if (from.current === null) return
      from.current = null
      // Released explicitly rather than left to the browser's own cleanup: a
      // capture that outlives the drag is a handle that keeps eating pointer
      // events, and "it works because the platform tidies up" is a thing that
      // stops being true.
      const held = captured.current
      if (held?.node.hasPointerCapture(held.pointer)) held.node.releasePointerCapture(held.pointer)
      markDragging(held?.node, false)
      captured.current = null
      endResize()
      if (commit) onCommit?.(live.current)
      else onCancel?.()
    },
    [onCommit, onCancel],
  )

  /*
   * A seam can be taken off the screen mid-drag — a pane closed by a shortcut,
   * a panel zoomed, a view moved to another edge. The pointer events that
   * would have ended the gesture go to an element that no longer exists, so
   * the teardown has to be owed to the unmount as well. Without this the
   * window keeps `data-hd-resizing` for the rest of the session: no
   * transitions anywhere, a cursor stuck on `col-resize`, nothing selectable,
   * and every `<iframe>` and `<webview>` inert.
   */
  const onUnmount = useRef(stop)
  onUnmount.current = stop
  useEffect(() => () => onUnmount.current(false), [])

  return (
    <ResizeHandle
      data-slot="panel-seam"
      orientation={orientation}
      label={label}
      /* Normalised, so the handle's arrows, Home/End and screen-reader values
         all work in the same units it already understands. */
      value={span === 0 ? 0 : (size - min) / span}
      min={0}
      max={1}
      onChange={(ratio) => push(clamp(min + ratio * span))}
      /* The keyboard's own commit. Without it an arrow key moved the preview
         and nothing else — the nudge was drawn and then forgotten, so a panel
         resized from the keyboard snapped back at the next render. */
      onCommit={() => onCommit?.(live.current)}
      /* `direction` says which way the panel grows, and the keyboard has to
         agree with the screen: on the right and bottom panels a larger size
         moves the seam *toward* the start, so ArrowRight there would have
         walked the seam left. The handle flips its own mapping instead of
         each caller second-guessing the arrow keys. */
      invert={direction === -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => stop(true)}
      onPointerCancel={() => stop(false)}
      /* Capture can end without either of those: the browser drops it when the
         captured node is removed, and some inputs surrender it on their own.
         That path used to leave the drag running forever. */
      onLostPointerCapture={() => stop(true)}
      className={cn(
        'z-10 bg-(--hd-border) transition-colors hover:bg-(--hd-accent) data-[dragging]:bg-(--hd-accent)',
        orientation === 'vertical' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        /* The visible line is a hair; the hit area is a finger. Without the
           pseudo-element a 1px seam is a target nobody can hit twice. */
        'after:absolute after:content-[""]',
        orientation === 'vertical' ? 'after:inset-y-0 after:-inset-x-1' : 'after:inset-x-0 after:-inset-y-1',
        className,
      )}
      {...props}
    />
  )
}
