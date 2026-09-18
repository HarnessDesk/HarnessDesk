import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'

import { CheckIcon, ChevronIcon } from '../../components/Icons'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu'
import { SwitchShape } from '../ui/switch'
import { useDismissOverlays } from './Popover'

import styles from './Menu.module.css'

interface Scope {
  readonly close: () => void
}

const ScopeContext = createContext<Scope | null>(null)

const useScope = (): Scope => {
  const scope = useContext(ScopeContext)
  if (!scope) throw new Error('Menu rows must be rendered inside <Menu> or <ContextMenu>.')
  return scope
}

export const useMenuClose = (): (() => void) => useScope().close

const ROW_SELECTOR = '[role^="menuitem"]:not([disabled]),[role="switch"]:not([disabled])'

/** The rows a menu's arrows visit — Base UI's navigation stops on a disabled row too. */
const LEVEL_ROW = '[role^="menuitem"],[role="switch"]'

/** Where → lands in a flyout: its first row that is on — never a note or a label. */
const FIRST_ROW =
  '[role^="menuitem"]:not([disabled]):not([aria-disabled="true"]),[role="switch"]:not([disabled]):not([aria-disabled="true"])'

/**
 * A HarnessDesk menu level. Base UI owns item collection, roving focus,
 * selection, Escape and submenu coordination; this wrapper carries the
 * product-level close callback used by async actions.
 */
export const Menu = ({ close, onEscape, children }: { close: () => void; onEscape?: () => void; children: ReactNode }) => {
  const scope = useMemo<Scope>(() => ({ close }), [close])
  const level = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)

  // Popover is a separately reusable pattern, so its trigger is not the Base
  // Menu trigger. Bridge its first ArrowDown/ArrowUp into this open level; all
  // movement after that belongs to Base UI.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = level.current
      if (!panel || panel.contains(document.activeElement)) return
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const rows = [...panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
      const target = event.key === 'ArrowDown' ? rows[0] : rows[rows.length - 1]
      if (!target) return
      event.preventDefault()
      target.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div ref={host} className={styles.levelHost}>
      <DropdownMenu
        open
        onOpenChange={(open, details) => {
          // Item presses close through the typed row contract below; asking
          // the owner again would call the feature close callback twice.
          // Escape belongs to the composite itself, so bridge only that Base
          // UI reason to the surrounding Popover.
          if (!open && details.reason === 'escape-key') (onEscape ?? close)()
        }}
        modal={false}
      >
        <ScopeContext.Provider value={scope}>
          <DropdownMenuPortal container={host}>
            <DropdownMenuPositioner anchor={host} className={styles.embeddedPositioner}>
              <DropdownMenuPopup ref={level} className={styles.level} finalFocus={false}>
                {children}
              </DropdownMenuPopup>
            </DropdownMenuPositioner>
          </DropdownMenuPortal>
        </ScopeContext.Provider>
      </DropdownMenu>
    </div>
  )
}

export const MenuNote = ({ children }: { children: ReactNode }) => (
  <div className={styles.note}>{children}</div>
)

export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <div className={styles.label}>{children}</div>
)

export const MenuSeparator = () => <div className={styles.separator} role="separator" />

export const MenuItem = ({
  children,
  icon,
  label,
  hint,
  shortcut,
  value,
  title,
  badge,
  selected,
  current,
  expanded,
  danger,
  disabled,
  keepOpen,
  className,
  onSelect,
}: {
  /** Rich row anatomy still uses the canonical Base UI menu item behavior. */
  children?: ReactNode
  icon?: ReactNode
  label?: ReactNode
  hint?: ReactNode
  shortcut?: string
  value?: ReactNode
  title?: string
  badge?: string
  selected?: boolean
  /** Marks the app's current account/session independently of checked semantics. */
  current?: boolean
  /** Exposes a row-owned disclosure without surrendering menu keyboard behavior. */
  expanded?: boolean
  danger?: boolean
  disabled?: string | boolean
  keepOpen?: boolean
  className?: string
  onSelect: () => void
}) => {
  const scope = useScope()
  const reason = typeof disabled === 'string' ? disabled : undefined
  return (
    <DropdownMenuItem
      render={<button type="button" disabled={Boolean(disabled)} />}
      nativeButton
      className={`${styles.row}${className ? ` ${className}` : ''}`}
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      {...(selected === undefined ? {} : { 'aria-checked': selected })}
      {...(danger ? { 'data-danger': '' } : {})}
      {...(current ? { 'data-current': '' } : {})}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      disabled={Boolean(disabled)}
      title={reason ?? title}
      closeOnClick={!keepOpen}
      onClick={(event) => {
        ;(event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
        onSelect()
        if (!keepOpen) scope.close()
      }}
    >
      {children ?? (
        <>
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
            <span className={styles.check} aria-hidden="true">{selected && <CheckIcon size={15} />}</span>
          )}
        </>
      )}
    </DropdownMenuItem>
  )
}

/** A switch stays open; Base UI supplies checkbox-menu keyboard semantics. */
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
  value?: ReactNode
  checked: boolean
  disabled?: string | boolean
  onChange: (next: boolean) => void
}) => {
  const reason = typeof disabled === 'string' ? disabled : undefined
  return (
    <DropdownMenuCheckboxItem
      render={<button type="button" disabled={Boolean(disabled)} />}
      nativeButton
      className={styles.row}
      role="switch"
      checked={checked}
      disabled={Boolean(disabled)}
      title={reason}
      closeOnClick={false}
      onCheckedChange={(next) => onChange(next)}
    >
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <span className={styles.body}>
        <span className={styles.title}>{label}</span>
        {(hint ?? reason) && <span className={styles.hint}>{hint ?? reason}</span>}
      </span>
      {value !== undefined && <span className={styles.value}>{value}</span>}
      <SwitchShape checked={checked} size="sm" disabled={Boolean(disabled)} />
    </DropdownMenuCheckboxItem>
  )
}

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
  value?: ReactNode
  disabled?: string | boolean
  width?: number
  children: ReactNode
}) => {
  const reason = typeof disabled === 'string' ? disabled : undefined
  const row = useRef<HTMLButtonElement>(null)
  const flyout = useRef<HTMLDivElement>(null)
  const closedBy = useRef<string | null>(null)
  const [open, setOpen] = useState(false)
  const stepIn = useRef(false)
  /*
    A level here is a Base UI `Menu.Root` with no `Menu.Trigger` — the
    Popover, or a pointer, opens it — and Base UI 1.7 names a root menu's
    node in its floating tree only through its trigger. So a flyout is filed
    with no parent, and cannot tell its own menu from anywhere else.

    That matters the moment the pointer leaves this row, which it must do to
    reach the flyout: Base UI answers a row losing the pointer by focusing the
    menu itself, and the flyout read that as focus leaving for somewhere
    unrelated and closed. It closed before the pointer could arrive, so a
    choice in it could not be taken with the mouse at all.

    While its flyout is open the row keeps the focus instead — the way a
    native menu keeps a submenu's row lit — and the flyout closes when the
    pointer takes another row, leaves the flyout's reach, or a key says so.
    If the pointer wandered off without taking another row, the reset the
    row skipped is made once the flyout has gone, so no row stays lit that
    nothing is pointing at.

    The missing parent costs the keys their meaning too. Base UI asks a
    flyout's parent which way it runs to know which arrow opens the flyout;
    with no parent to ask it counts both, so ↓ opened the flyout instead of
    moving on — no row below it could be reached — and → opened it without
    stepping in. ↑ and ↓ are left to the menu the row is in, and → steps onto
    the flyout's first row once it has one. Escape from inside the flyout
    hands focus back to the row before Base UI makes the closing flyout
    inert: left to fall out of it, focus landed on the Popover's own panel,
    which takes back focus that drops to the page, and the row was lost.
  */
  useEffect(() => {
    if (!open || !stepIn.current) return
    stepIn.current = false
    let frame = 0
    let waited = 0
    const land = (): void => {
      const first = flyout.current?.querySelector<HTMLElement>(FIRST_ROW)
      if (!first) {
        if (waited++ < 3) frame = requestAnimationFrame(land)
        return
      }
      // A flyout that took the focus itself — a filter field — keeps it.
      if (document.activeElement === row.current) first.focus({ preventScroll: true })
    }
    land()
    return () => cancelAnimationFrame(frame)
  }, [open])
  return (
    <DropdownMenuSub
      onOpenChange={(next, details) => {
        setOpen(next)
        closedBy.current = next ? null : details.reason
        stepIn.current = next && details.reason === 'list-navigation'
        if (!next && details.reason === 'escape-key') {
          const element = row.current
          if (element && document.activeElement !== element) element.focus({ preventScroll: true })
        }
      }}
      onOpenChangeComplete={(opened) => {
        const element = row.current
        if (opened || closedBy.current !== 'trigger-hover' || !element) return
        if (element === document.activeElement && !element.matches(':hover')) {
          element.closest<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true })
        }
      }}
    >
      <DropdownMenuSubTrigger
        ref={row}
        render={<button type="button" disabled={Boolean(disabled)} />}
        nativeButton
        className={styles.row}
        disabled={Boolean(disabled)}
        title={reason}
        openOnHover
        delay={110}
        closeDelay={220}
        onPointerLeave={(event) => {
          if (!event.currentTarget.hasAttribute('data-popup-open')) return
          ;(event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
        }}
        onKeyDown={(event) => {
          // ↓ is the menu's key, not a way into the flyout. Base UI's own
          // handler for it is skipped, and with it — the skip is carried on
          // the event as it bubbles — the menu's, so the step is taken here:
          // the next row of this level, round to the first as the menu loops.
          // ↑ never opened the flyout and is left to the menu.
          if (event.key !== 'ArrowDown') return
          ;(event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
          const level = event.currentTarget.closest<HTMLElement>('[role="menu"]')
          const rows = level ? [...level.querySelectorAll<HTMLElement>(LEVEL_ROW)] : []
          const next = rows[(rows.indexOf(event.currentTarget) + 1) % rows.length]
          if (!next) return
          event.preventDefault()
          event.stopPropagation()
          next.focus()
        }}
      >
        {icon !== undefined && <span className={styles.icon}>{icon}</span>}
        <span className={styles.body}>
          <span className={styles.title}>{label}</span>
          {(hint ?? reason) && <span className={styles.hint}>{hint ?? reason}</span>}
        </span>
        {value !== undefined && <span className={styles.value}>{value}</span>}
        <ChevronIcon size={14} className={styles.chevron} />
      </DropdownMenuSubTrigger>
      {/* Beside its row, or over the menu at its row — never above or below
          it. With no room on either side Base UI turned the flyout onto the
          other axis, over the menu's other rows, and the way there crossed
          them: a hand resting at the row's far end set off along a safe
          triangle so thin for a short flyout that its first step fell
          outside it, and the row it crossed took the flyout's place. Kept to
          a side and slid into the window, the flyout lies across the row
          itself, and the pointer reaches it without leaving the row. */}
      <DropdownMenuSubContent
        ref={flyout}
        className={styles.flyout}
        style={width ? { width } : undefined}
        collisionAvoidance={{ fallbackAxisSide: 'none' }}
        sticky
      >
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export interface MenuPoint {
  readonly x: number
  readonly y: number
}

export const useContextMenu = (): {
  readonly at: MenuPoint | null
  readonly open: (event: ReactMouseEvent) => void
  readonly close: () => void
} => {
  const [at, setAt] = useState<MenuPoint | null>(null)
  const open = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
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
  const previous = useRef<HTMLElement | null>(null)
  const previousAt = useRef<MenuPoint | null>(null)
  if (at !== null && previousAt.current === null) {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  previousAt.current = at
  const scope = useMemo<Scope>(() => ({ close: onClose }), [onClose])
  const anchor = useMemo(() => at == null ? null : ({
    getBoundingClientRect: () => ({
      x: at.x,
      y: at.y,
      left: at.x,
      top: at.y,
      right: at.x,
      bottom: at.y,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }),
  }), [at])

  useEffect(() => {
    if (!at) return
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [at, onClose])

  useDismissOverlays(at !== null, ({ returnFocus }) => {
    if (returnFocus === true && panel.current?.contains(document.activeElement)) {
      previous.current?.focus({ preventScroll: true })
    }
    onClose()
  })

  return (
    <DropdownMenu
      open={at !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      onOpenChangeComplete={(open) => {
        if (open) panel.current?.querySelector<HTMLElement>(ROW_SELECTOR)?.focus({ preventScroll: true })
      }}
      modal={false}
    >
      <ScopeContext.Provider value={scope}>
        <DropdownMenuPortal>
          <DropdownMenuPositioner
            anchor={anchor}
            positionMethod="fixed"
            side="bottom"
            align="start"
            collisionPadding={8}
            className={styles.contextPositioner}
          >
            <DropdownMenuPopup
              ref={panel}
              className={styles.surface}
              aria-label={label}
              finalFocus={false}
              onContextMenu={(event) => event.preventDefault()}
            >
              {children}
            </DropdownMenuPopup>
          </DropdownMenuPositioner>
        </DropdownMenuPortal>
      </ScopeContext.Provider>
    </DropdownMenu>
  )
}
