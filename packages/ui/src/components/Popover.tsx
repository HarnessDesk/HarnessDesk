import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { escapeSurface, onDismissOverlays, type DismissDetail } from '../lib/overlays'

import styles from './Popover.module.css'

/* The contract itself is in `lib/overlays.ts`, free of React so that anything
   can take part in it; it is re-exported here because this is the module the
   app has always asked for it by name. */
export { DISMISS_OVERLAYS, dismissOverlays } from '../lib/overlays'
export type { DismissDetail } from '../lib/overlays'

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
 * For a surface that is neither a `Dialog` nor a menu: the two app windows, and
 * anything else that takes the screen without going through either. `Dialog`
 * answers on the window in the capture phase and stops the event dead, so it
 * still outranks this; a menu spends the key on `document` and is heard first.
 * What this settles is the order among the surfaces that are left — see
 * `lib/overlays.ts`.
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
 * The panel is fixed-positioned from the trigger's rectangle rather than
 * absolutely within it: a menu that inherits its ancestor's overflow gets
 * clipped at the sidebar edge, and one positioned in page coordinates can be
 * clamped to the window instead.
 *
 * It is also rendered into the document body rather than beside the trigger.
 * A fixed panel still takes its *intrinsic* width from the column it sits in,
 * so the sidebar's menus came out as wide as the sidebar — a 160px list of
 * words holding a 270px slab open. At the body it is as wide as its own
 * longest row, which is what every menu on the platform does.
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
  tone = 'calm',
  triggerClassName,
  onOpenChange,
  children,
}: {
  label: ReactNode
  title?: string
  /** Replaces the default trigger look, for a button that already has one. */
  triggerClassName?: string
  onOpenChange?: (open: boolean) => void
  /** Colours the trigger by risk, for controls where neutral would mislead. */
  tone?: 'calm' | 'warn' | 'alert'
  /** `up` for controls near the bottom of the window, like the composer. */
  drop?: 'up' | 'down'
  align?: 'left' | 'right'
  children: (close: () => void) => ReactNode
}) => {
  const [open, setOpenState] = useState(false)
  const setOpen = (next: boolean | ((value: boolean) => boolean)): void => {
    setOpenState((value) => {
      const resolved = typeof next === 'function' ? next(value) : next
      if (resolved !== value) onOpenChange?.(resolved)
      return resolved
    })
  }
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // Before paint, place the panel in window coordinates and keep it on-screen.
  useLayoutEffect(() => {
    if (!open) return
    const el = panel.current
    const anchorRect = trigger.current?.getBoundingClientRect()
    if (!el || !anchorRect) return
    const margin = 8
    let left = align === 'left' ? anchorRect.left : anchorRect.right - el.offsetWidth
    left = Math.min(left, window.innerWidth - el.offsetWidth - margin)
    left = Math.max(left, margin)
    el.style.left = `${left}px`
    if (drop === 'up') {
      el.style.bottom = `${window.innerHeight - anchorRect.top + 6}px`
      el.style.maxHeight = `${Math.max(120, anchorRect.top - 6 - margin)}px`
    } else {
      let top = anchorRect.bottom + 6
      /*
        The room is the window's, not a number. A fixed ceiling scrolled the
        browser pane's fourteen-row settings menu at 400px with half the
        window empty beneath it, and the rows past the fold — the ones that
        keep cookies and clear them — were found only by people who noticed
        the scrollbar. The panel takes what is below the trigger, slides up
        when that is not enough, and scrolls only when the window itself is
        too short for it.
      */
      el.style.maxHeight = ''
      if (top + el.offsetHeight > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - margin - el.offsetHeight)
      }
      el.style.top = `${top}px`
      el.style.maxHeight = `${Math.max(120, window.innerHeight - margin - top)}px`
    }
  }, [open, drop, align])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      // The panel is no longer inside the anchor, so it has to be asked too.
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Spent here, and said so: whatever this menu opened over — a sidebar
      // floating over a narrow window — hears that the key was taken, and one
      // press closes one thing.
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

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
    do not — they take no focus of their own, and focus handed to a trigger
    behind them answered Enter by opening the menu again, above the window.
    Focus held anywhere else stays put either way.
  */
  useDismissOverlays(open, ({ returnFocus }) => {
    if (returnFocus === true && panel.current?.contains(document.activeElement)) trigger.current?.focus()
    setOpen(false)
  })

  return (
    // `hd-no-drag` because menus live in the window's chrome — the conversation
    // header, a pane strip — and those are drag regions. A drag region eats the
    // press: the window moves and the button only fires when the pointer
    // happened not to travel, which reads as a control that works every other
    // time. app-region is a property of a box, and this anchor is the box.
    <div className={`${styles.anchor} hd-no-drag`} ref={anchor} data-drop={drop} data-align={align}>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName ?? styles.trigger}
        {...(open ? { 'data-open': '' } : {})}
        data-tone={tone}
        aria-haspopup="menu"
        aria-expanded={open}
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
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div className={styles.panel} role="menu" ref={panel}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  )
}

export { styles as popoverStyles }
