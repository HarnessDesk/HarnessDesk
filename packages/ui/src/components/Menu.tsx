import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'

import { Switch } from '../design/primitives/Kit'
import { DISMISS_OVERLAYS } from './Popover'

import { CheckIcon, ChevronIcon } from './Icons'
import styles from './Menu.module.css'

/**
 * Menus with depth.
 *
 * A flat list is fine for four choices; it is not fine for "which model,
 * how hard it thinks, and whether it shows its reasoning" — three questions
 * that belong in one place but not on one level. Nor for everything that can
 * be done to a workspace. This is the one set of rows for both: a panel that
 * can be anchored to a trigger (`Popover`) or to a point (`ContextMenu`),
 * and rows that can open a further panel beside them.
 *
 * The rows know nothing about models or folders. They know: an action, a
 * choice among several, a switch, a heading, a note, a line, and a door to
 * another level. The menus that use them are written in those terms.
 *
 * Keyboard: arrows move within a level, → opens a submenu and ← closes it,
 * Escape closes the whole thing (the surface handles that), Enter and Space
 * take the row because the rows are buttons.
 */

interface Scope {
  /** Closes the whole menu, every level. */
  readonly close: () => void
  /** The submenu open at this level, so siblings can close it. */
  readonly openId: string | null
  readonly setOpenId: (id: string | null) => void
}

const ScopeContext = createContext<Scope | null>(null)

const useScope = (): Scope => {
  const scope = useContext(ScopeContext)
  if (!scope) throw new Error('Menu rows must be rendered inside <Menu>, <ContextMenu>, or <Submenu>.')
  return scope
}

/** Closes every level of the enclosing menu. */
export const useMenuClose = (): (() => void) => useScope().close

const ROW_SELECTOR = '[role^="menuitem"]:not([disabled]),[role="switch"]:not([disabled])'

/** Rows of *this* panel only — a flyout's rows belong to the flyout. */
const rowsOf = (panel: HTMLElement): HTMLElement[] =>
  [...panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(
    (row) => row.closest('[data-menu-panel]') === panel,
  )

/** Arrow-key movement within one level. */
const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
  const panel = (event.target as HTMLElement).closest<HTMLElement>('[data-menu-panel]')
  if (!panel || panel !== event.currentTarget) return
  const rows = rowsOf(panel)
  if (rows.length === 0) return
  event.preventDefault()
  const index = rows.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : event.key === 'ArrowDown'
          ? (index + 1) % rows.length
          : (index - 1 + rows.length) % rows.length
  rows[next]?.focus()
}

/**
 * One level's worth of rows. `Popover` owns the trigger and the panel; this
 * gives its children the scope they need. Stops pointer events from reaching
 * the document, so a click inside a fixed-positioned flyout is never read as
 * a click outside.
 */
export const Menu = ({ close, children }: { close: () => void; children: ReactNode }) => {
  const [openId, setOpenId] = useState<string | null>(null)
  const scope = useMemo<Scope>(() => ({ close, openId, setOpenId }), [close, openId])
  const level = useRef<HTMLDivElement>(null)

  // The trigger keeps focus when a Popover opens; ↓ and ↑ from there step
  // into the list, so the keyboard never has to find it with Tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = level.current
      if (!panel || panel.contains(document.activeElement)) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const rows = rowsOf(panel)
      const target = event.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1]
      if (!target) return
      event.preventDefault()
      target.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <ScopeContext.Provider value={scope}>
      <div ref={level} className={styles.level} data-menu-panel="" onKeyDown={onPanelKeyDown}>
        {children}
      </div>
    </ScopeContext.Provider>
  )
}

/** A short, muted line of prose — what a level is for, or a caveat. */
export const MenuNote = ({ children }: { children: ReactNode }) => (
  <div className={styles.note}>{children}</div>
)

/** A heading over a run of rows. */
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div className={styles.label}>{children}</div>
)

export const MenuSeparator = () => <div className={styles.separator} role="separator" />

/**
 * An action, or one of several choices. With `selected` defined the row is a
 * radio and wears its check at the end, where the eye lands after reading
 * the label — the way macOS and the agents' own menus draw it.
 */
export const MenuItem = ({
  icon,
  label,
  hint,
  shortcut,
  value,
  title,
  badge,
  selected,
  danger,
  disabled,
  keepOpen,
  onSelect,
}: {
  icon?: ReactNode
  label: ReactNode
  /**
   * A second line under the label — earned, not default. Three things earn
   * one: a consequence the label cannot carry ("files are left as they are"),
   * a fact that varies (a path, a count, a refusal), and a name that carries
   * no meaning of its own (a model's codename). Everything else — a paraphrase
   * of the verb, a description of a view one click away, a shortcut worth
   * knowing later — goes in `title`. A sentence identical on every row of a
   * group belongs to the group, as a `MenuNote`. docs/design.md.
   */
  hint?: ReactNode
  shortcut?: string
  /** A fact about the row, dimmed at its end — a branch's age, say. */
  value?: ReactNode
  /** What the row does, on hover: for rows whose label says enough on screen. */
  title?: string
  /** A small tag beside the label — "Default", say. */
  badge?: string
  /** Defined for a choice; undefined for an action. */
  selected?: boolean
  danger?: boolean
  /** Shown greyed with this reason as its hint. */
  disabled?: string | boolean
  /** For rows that change something the menu should go on showing. */
  keepOpen?: boolean
  onSelect: () => void
}) => {
  const scope = useScope()
  const reason = typeof disabled === 'string' ? disabled : undefined
  return (
    <button
      type="button"
      className={styles.row}
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      {...(selected === undefined ? {} : { 'aria-checked': selected })}
      {...(danger ? { 'data-danger': '' } : {})}
      disabled={Boolean(disabled)}
      title={reason ?? title}
      onPointerEnter={() => scope.setOpenId(null)}
      onClick={() => {
        onSelect()
        if (!keepOpen) scope.close()
      }}
    >
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <span className={styles.body}>
        <span className={styles.title}>
          {label}
          {badge && <span className={styles.badge}>{badge}</span>}
        </span>
        {(hint ?? reason) && <span className={styles.hint}>{hint ?? reason}</span>}
      </span>
      {value !== undefined && <span className={styles.value}>{value}</span>}
      {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
      {selected !== undefined && (
        <span className={styles.check} aria-hidden="true">
          {selected && <CheckIcon size={15} />}
        </span>
      )}
    </button>
  )
}

/** A switch. Flipping it leaves the menu open: a switch is not a decision to leave. */
export const MenuToggle = ({
  icon,
  label,
  hint,
  value,
  checked,
  disabled,
  onChange,
}: {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  /**
   * A fact about the row, dimmed before the switch — `MenuItem`'s own slot,
   * given to the toggle for the same reason it has one. A room's member is a
   * name, a conversation, *and* whether it is mid-turn, and joining the last
   * two into the hint with a middle dot is the sentence `docs/design.md`
   * exists to prevent.
   */
  value?: ReactNode
  checked: boolean
  disabled?: string | boolean
  onChange: (next: boolean) => void
}) => {
  const scope = useScope()
  const reason = typeof disabled === 'string' ? disabled : undefined
  return (
    <button
      type="button"
      className={styles.row}
      role="switch"
      aria-checked={checked}
      disabled={Boolean(disabled)}
      title={reason}
      onPointerEnter={() => scope.setOpenId(null)}
      onClick={() => onChange(!checked)}
    >
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <span className={styles.body}>
        <span className={styles.title}>{label}</span>
        {(hint ?? reason) && <span className={styles.hint}>{hint ?? reason}</span>}
      </span>
      {value !== undefined && <span className={styles.value}>{value}</span>}
      <Switch on={checked} small disabled={Boolean(disabled)} />
    </button>
  )
}

const HOVER_OPEN_MS = 110
const HOVER_CLOSE_MS = 220

/**
 * A row that opens another level beside it.
 *
 * The flyout is positioned in window coordinates from the row's rectangle —
 * to the right when there is room, to the left when there is not — and
 * stays a DOM descendant of the row, so the surface's outside-click test
 * still counts it as inside. It opens on hover after a beat and on click or
 * →, and closes when the pointer has left both the row and the flyout for
 * a beat, or when a sibling row is hovered.
 */
export const Submenu = ({
  icon,
  label,
  hint,
  value,
  disabled,
  width,
  children,
}: {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  /** The current answer, shown dimmed before the chevron. */
  value?: ReactNode
  disabled?: string | boolean
  /** Flyout width; the default suits a list of short choices. */
  width?: number
  children: ReactNode
}) => {
  const parent = useScope()
  const id = useId()
  const open = parent.openId === id
  const row = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const [childOpenId, setChildOpenId] = useState<string | null>(null)
  const reason = typeof disabled === 'string' ? disabled : undefined

  const later = useCallback((fn: () => void, ms: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(fn, ms)
  }, [])
  const cancel = useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  const show = useCallback((): void => {
    if (!disabled) parent.setOpenId(id)
  }, [disabled, id, parent])
  const hide = useCallback((): void => {
    if (parent.openId === id) parent.setOpenId(null)
  }, [id, parent])

  // Place the flyout before paint so it never flashes at the wrong spot.
  useLayoutEffect(() => {
    if (!open) return
    const el = panel.current
    const rect = row.current?.getBoundingClientRect()
    if (!el || !rect) return
    const margin = 8
    const gap = 4
    let left = rect.right + gap
    if (left + el.offsetWidth > window.innerWidth - margin) left = rect.left - gap - el.offsetWidth
    left = Math.max(margin, left)
    let top = rect.top - 4
    if (top + el.offsetHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - el.offsetHeight)
    }
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [open])

  const scope = useMemo<Scope>(
    () => ({ close: parent.close, openId: childOpenId, setOpenId: setChildOpenId }),
    [parent.close, childOpenId],
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowRight' && event.target === row.current) {
      event.preventDefault()
      show()
      // Focus lands on the first row once the flyout exists.
      window.requestAnimationFrame(() => {
        if (panel.current) rowsOf(panel.current)[0]?.focus()
      })
    } else if (event.key === 'ArrowLeft' && open && event.target !== row.current) {
      event.preventDefault()
      event.stopPropagation()
      hide()
      row.current?.focus()
    }
  }

  return (
    <div
      className={styles.submenu}
      onPointerEnter={() => {
        cancel()
        if (!open) later(show, HOVER_OPEN_MS)
      }}
      onPointerLeave={() => {
        cancel()
        later(hide, HOVER_CLOSE_MS)
      }}
      onKeyDown={onKeyDown}
    >
      <button
        ref={row}
        type="button"
        className={styles.row}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'data-open': '' } : {})}
        disabled={Boolean(disabled)}
        title={reason}
        onClick={() => {
          cancel()
          if (open) hide()
          else show()
        }}
      >
        {icon !== undefined && <span className={styles.icon}>{icon}</span>}
        <span className={styles.body}>
          <span className={styles.title}>{label}</span>
          {(hint ?? reason) && <span className={styles.hint}>{hint ?? reason}</span>}
        </span>
        {value !== undefined && <span className={styles.value}>{value}</span>}
        <ChevronIcon size={14} className={styles.chevron} />
      </button>
      {open && (
        <div
          ref={panel}
          className={styles.flyout}
          role="menu"
          data-menu-panel=""
          style={width ? { width } : undefined}
          onKeyDown={onPanelKeyDown}
        >
          <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
        </div>
      )}
    </div>
  )
}

export interface MenuPoint {
  readonly x: number
  readonly y: number
}

/**
 * The state behind a right-click menu: where it was asked for, or nowhere.
 * `open` is the `onContextMenu` handler.
 */
export const useContextMenu = (): {
  readonly at: MenuPoint | null
  readonly open: (event: ReactMouseEvent) => void
  readonly close: () => void
} => {
  const [at, setAt] = useState<MenuPoint | null>(null)
  const open = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    // A keyboard "click" carries no pointer position; the menu drops from
    // the control's corner instead, where a keyboard user expects it.
    if (event.clientX === 0 && event.clientY === 0) {
      const rect = event.currentTarget.getBoundingClientRect()
      setAt({ x: rect.left, y: rect.bottom + 4 })
      return
    }
    setAt({ x: event.clientX, y: event.clientY })
  }, [])
  const close = useCallback((): void => setAt(null), [])
  return { at, open, close }
}

/**
 * A menu at a point — the answer to a right-click. Closes on a click
 * anywhere else, on Escape, and when the window changes size or loses focus:
 * a menu left floating over a resized layout points at nothing.
 */
export const ContextMenu = ({
  at,
  label,
  onClose,
  children,
}: {
  at: MenuPoint | null
  label: string
  onClose: () => void
  children: ReactNode
}) => {
  const panel = useRef<HTMLDivElement>(null)
  // What had focus before the menu took it — see the dismissal below.
  const previous = useRef<HTMLElement | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const scope = useMemo<Scope>(() => ({ close: onClose, openId, setOpenId }), [onClose, openId])

  useLayoutEffect(() => {
    if (!at) return
    const el = panel.current
    if (!el) return
    const margin = 8
    let left = at.x
    if (left + el.offsetWidth > window.innerWidth - margin) left = Math.max(margin, at.x - el.offsetWidth)
    let top = at.y
    if (top + el.offsetHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - el.offsetHeight)
    }
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    // The first row takes focus so the keyboard works from the first key,
    // once what had it is noted.
    if (!el.contains(document.activeElement)) {
      previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    rowsOf(el)[0]?.focus({ preventScroll: true })
  }, [at])

  useEffect(() => {
    if (!at) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!panel.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    /*
      Asked to (`returnFocus`), a menu holding focus gives it back on its way
      out. This one opens at a point, not from a trigger, so it gives focus to
      whatever had it before the menu took it: the floating sidebar keeps what
      had focus as the place to come back to, and a row unmounted in between
      is nowhere.
    */
    const onDismiss = (event: Event): void => {
      const asked = (event as CustomEvent<{ readonly returnFocus?: boolean } | null>).detail?.returnFocus === true
      if (asked && panel.current?.contains(document.activeElement)) previous.current?.focus({ preventScroll: true })
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener(DISMISS_OVERLAYS, onDismiss)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener(DISMISS_OVERLAYS, onDismiss)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [at, onClose])

  if (!at) return null
  return (
    <div
      ref={panel}
      className={styles.surface}
      role="menu"
      aria-label={label}
      data-menu-panel=""
      onKeyDown={onPanelKeyDown}
      // A right-click on the menu itself must not open a second one.
      onContextMenu={(event) => event.preventDefault()}
    >
      <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
    </div>
  )
}
