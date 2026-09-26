import { createElement, forwardRef, isValidElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type Ref } from 'react'

import { escapeSurface, onDismissOverlays, type DismissDetail } from '../../lib/overlays'
import {
  Popover as BasePopover,
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverTrigger,
} from '../ui/popover'
import { cn } from '@/lib/utils'

import { buttonVariants } from '../ui/button'

import styles from './Popover.module.css'

/* The contract itself is in `lib/overlays.ts`, free of React so that anything
   can take part in it; it is re-exported here because this is the module the
   app has always asked for it by name. */
export { DISMISS_OVERLAYS, dismissOverlays } from '../../lib/overlays'
export type { DismissDetail } from '../../lib/overlays'

/**
 * Closes this floating thing when something takes the screen.
 *
 * Every menu owes this, and a menu that does not is a panel drawn over a window
 * that cannot be clicked through it — the board's card menu, until it took part
 * (#214). The handler is read fresh each time, so a caller may write it inline.
 */
export const useDismissOverlays = (
  active: boolean,
  onDismiss: (detail: DismissDetail) => void,
): void => {
  const held = useRef(onDismiss)
  held.current = onDismiss
  useEffect(() => {
    if (!active) return
    return onDismissOverlays((detail) => held.current(detail))
  }, [active])
}

/**
 * Answers Escape while it is the surface on top.
 *
 * Orders screen-level surfaces after nested menus and dialogs have had the
 * key. AppWindow uses canonical dialog modality but explicitly delegates
 * Escape here, retaining the window stack's ordering and approval boundary.
 * Other dialogs consume Escape themselves; see `lib/overlays.ts`.
 */
export const useEscapeSurface = (active: boolean, close: () => void): void => {
  const held = useRef(close)
  held.current = close
  useEffect(() => {
    if (!active) return
    return escapeSurface(() => {
      held.current()
      return true
    })
  }, [active])
}

/**
 * A menu anchored to its trigger.
 *
 * Closes on outside click and on Escape, and returns focus to the trigger — the
 * baseline a menu has to meet to be usable from the keyboard.
 *
 * Base UI owns focus, outside press, Escape, collision handling and portal
 * placement. HarnessDesk keeps only the product policy: tone, layout and the
 * global "another surface took the window" dismissal event.
 */

/**
 * Does this node render any words of its own?
 *
 * Walks the tree rather than testing the top-level type, because a trigger's
 * label is nearly always a fragment — an icon and a span — and a fragment is
 * never a string however much text it contains. Elements are inspected through
 * their `children` prop; anything that is not a string, a number or a
 * container of those contributes nothing, which is the correct answer for an
 * icon.
 */
const hasText = (node: ReactNode): boolean => {
  if (node === null || node === undefined || typeof node === 'boolean') return false
  if (typeof node === 'string') return node.trim().length > 0
  if (typeof node === 'number') return true
  if (Array.isArray(node)) return node.some(hasText)
  if (isValidElement(node)) {
    return hasText((node.props as { children?: ReactNode }).children)
  }
  return false
}

export const Popover = ({
  label,
  title,
  drop = 'down',
  align = 'right',
  side,
  sideAlign,
  sideOffset = 6,
  tone = 'calm',
  fullWidth = false,
  panelWidth = 'content',
  triggerClassName,
  triggerVariant,
  triggerRef,
  onOpenChange,
  children,
}: {
  label: ReactNode
  title?: string
  /** Replaces the default trigger look, for a button that already has one. */
  triggerClassName?: string
  /**
   * A trigger that is a button of the system's own, drawn exactly as `Button`
   * draws that variant and size — its classes merged the way `Button` merges
   * them, so an outline keeps its edge. `triggerClassName` passes a class
   * through untouched, for the triggers that already carry a look of their own.
   */
  triggerVariant?: Parameters<typeof buttonVariants>[0]
  /** The trigger itself, for a caller that sends focus back to it. */
  triggerRef?: Ref<HTMLButtonElement>
  /** Fill a row or column instead of shrinking the trigger to its label. */
  fullWidth?: boolean
  /**
   * `trigger` draws the panel exactly as wide as the row that opened it, so a
   * menu opened from a full-width row reads as that row unfolding rather than
   * as a card set down beside it.
   */
  panelWidth?: 'content' | 'trigger'
  onOpenChange?: (open: boolean) => void
  /** Colours the trigger by risk, for controls where neutral would mislead. */
  tone?: 'calm' | 'warn' | 'alert'
  /** `up` for controls near the bottom of the window, like the composer. */
  drop?: 'up' | 'down'
  /** Places a popup beside its trigger when the owning surface needs that relationship. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'left' | 'right'
  /** Aligns along the chosen side; otherwise the existing left/right contract decides. */
  sideAlign?: 'start' | 'center' | 'end'
  /** Leaves room between the trigger and the floating surface. */
  sideOffset?: number
  children: (close: () => void) => ReactNode
}) => {
  const [open, setOpenState] = useState(false)
  // What the caller was last told, kept beside the state rather than read out
  // of an updater: an updater runs during render (twice, in StrictMode), and a
  // caller's `onOpenChange` sets the caller's own state — so telling it from
  // there updated one component while React was rendering another (#973).
  const told = useRef(false)
  const setOpen = (next: boolean): void => {
    setOpenState(next)
    if (next === told.current) return
    told.current = next
    onOpenChange?.(next)
  }
  const trigger = useRef<HTMLButtonElement>(null)
  const triggerId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const externalReturnFocus = useRef<boolean | null>(null)

  /*
    A dialog opening is also a way of leaving. Menus have to outrank the
    modal layer — one opened *inside* Settings must be on top of it — so a
    menu left open behind a dialog paints over it and cannot be clicked,
    which reads as a broken window. Nothing else dismisses it: a dialog
    opened from the keyboard is not a pointerdown and not an Escape.

    Asked to (`returnFocus`), a menu holding focus gives it to its trigger
    on the way out, as Escape does. The floating sidebar asks: it gives
    focus back, when it goes, to whatever had it when it came, and a row
    unmounted in between is nowhere to give it back to. Settings and Usage
    let their canonical dialog move focus into the window instead, without
    a menu cleanup focusing behind it.
    Focus held anywhere else stays put either way.
  */
  useDismissOverlays(open, ({ returnFocus }) => {
    externalReturnFocus.current = returnFocus === true
    if (returnFocus === true && panel.current?.contains(document.activeElement)) trigger.current?.focus()
    setOpen(false)
  })

  return (
    // `hd-no-drag` because menus live in the window's chrome — the conversation
    // header, a pane strip — and those are drag regions. A drag region eats the
    // press: the window moves and the button only fires when the pointer
    // happened not to travel, which reads as a control that works every other
    // time. app-region is a property of a box, and this anchor is the box.
    <BasePopover
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'escape-key') trigger.current?.focus()
        setOpen(next)
      }}
    >
      <div className={`${styles.anchor} hd-no-drag`} data-drop={drop} data-align={align} data-full-width={fullWidth || undefined}>
        <PopoverTrigger
          ref={(node: HTMLButtonElement | null) => {
            trigger.current = node
            if (typeof triggerRef === 'function') triggerRef(node)
            else if (triggerRef) triggerRef.current = node
          }}
          id={triggerId}
          className={triggerVariant ? cn(buttonVariants(triggerVariant)) : (triggerClassName ?? styles.trigger)}
          {...(open ? { 'data-open': '' } : {})}
          data-tone={tone}
          title={title}
        /* A glyph is not a name. When the trigger's content is an icon rather
           than words, the hover text becomes the accessible name — otherwise
           the control is announced as "button" and a screen reader user has no
           way to know what it opens. A trigger that already says something in
           text keeps saying it.

           "Says something in text" is the whole of the condition, and it used
           to be spelled `typeof label === 'string'` — which is true of a bare
           string and false of *every* fragment, including the ones that are
           mostly words. So the conversation header's branch chip, whose label
           is an icon plus `<span>feat/worktrees</span>`, was announced as
           `/Users/…/.claude/worktrees/worktree`: its own visible label
           replaced by a path. That is WCAG 2.5.3 — "click feat/worktrees"
           matches nothing — and it fails in the direction that matters,
           because the visible text is what a person says out loud. */
          {...(title === undefined || hasText(label) ? {} : { 'aria-label': title })}
        >
          {label}
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverPositioner
            positionMethod="fixed"
            side={side ?? (drop === 'up' ? 'top' : 'bottom')}
            align={sideAlign ?? (align === 'left' ? 'start' : 'end')}
            sideOffset={sideOffset}
            collisionPadding={8}
            /* A row unfolded may flip to the row's other side, never off to a
               third one: short of room it scrolls under `--available-height`,
               the way Base UI's own dropdowns do. */
            {...(panelWidth === 'trigger' ? { collisionAvoidance: { fallbackAxisSide: 'none' as const } } : {})}
            className={styles.positioner}
          >
            <PopoverPopup
              ref={panel}
              aria-labelledby={triggerId}
              className={styles.panel}
              data-width={panelWidth === 'trigger' ? 'trigger' : undefined}
              initialFocus={false}
              finalFocus={() => {
                const requested = externalReturnFocus.current
                externalReturnFocus.current = null
                return requested === false ? false : trigger.current
              }}
            >
              {children(() => setOpen(false))}
            </PopoverPopup>
          </PopoverPositioner>
        </PopoverPortal>
      </div>
    </BasePopover>
  )
}

export const PopoverGroupLabel = ({
  children,
  inset = true,
}: {
  children: ReactNode
  /** False when a containing row already owns the label's inset. */
  inset?: boolean
}) => (
  <div
    data-slot="group-label"
    data-inset={String(inset)}
    className={styles.groupLabel}
  >
    {children}
  </div>
)

/** The floating plate shared by anchored menus and inline trigger pickers. */
export const PopoverSurface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { limit?: 'trigger' }
>(({ className, limit, ...props }, ref) => (
  <div
    ref={ref}
    {...props}
    data-slot="popover-surface"
    {...(limit ? { 'data-limit': limit } : {})}
    className={`${styles.panel}${className ? ` ${className}` : ''}`}
  />
))
PopoverSurface.displayName = 'PopoverSurface'

export const PopoverOption = ({
  as = 'button',
  className,
  children,
  ...props
}: {
  as?: 'button' | 'div'
  className?: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement> & HTMLAttributes<HTMLDivElement>) => createElement(
  as,
  {
    ...props,
    ...(as === 'button' ? { type: props.type ?? 'button' } : {}),
    className: `${styles.option}${className ? ` ${className}` : ''}`,
  },
  children,
)

export const PopoverOptionMark = ({
  checked = false,
  children,
}: {
  checked?: boolean
  children?: ReactNode
}) => <span className={checked ? styles.optionCheck : styles.optionIcon}>{children}</span>

export const PopoverOptionBody = ({ children }: { children: ReactNode }) => (
  <span className={styles.optionBody}>{children}</span>
)

export const PopoverOptionLabel = ({ children }: { children: ReactNode }) => (
  <span className={styles.optionLabel}>{children}</span>
)

export const PopoverOptionHint = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={`${styles.optionHint}${className ? ` ${className}` : ''}`}>{children}</span>
)

export const PopoverOptionLive = ({ label = 'Live' }: { label?: string }) => (
  <span className={styles.optionLive} aria-label={label} />
)
