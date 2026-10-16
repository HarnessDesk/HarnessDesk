import {
  createContext,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from 'react'

import { CheckIcon, ChevronIcon } from '../../components/Icons'
import {
  DropdownMenu,
  DropdownMenuCheckboxControl,
  DropdownMenuItem,
  DropdownMenuPopup,
  DropdownMenuPortal,
  DropdownMenuPositioner,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubControl,
} from '../ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { floatingMotion } from '../ui/motion'
import { MenuRowContent, menuRowAttributes, useMenuPresentation, type MenuIcons } from '../ui/menu-row'
import { SwitchShape } from '../ui/switch'
import { inkTone, type Tone } from '../ui/tone'
import { useDismissOverlays } from './Popover'
import { Text, Chip } from './Settings'

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

/**
 * The rows a menu's arrows visit. A row disabled for a reason is one: it is
 * `aria-disabled`, not natively disabled, so it keeps the focus and its
 * reason can be read — Base UI's navigation stops on it too.
 */
const LEVEL_ROW = '[role^="menuitem"],[role="switch"]'

/**
 * A row the arrows pass by, by Base UI's own rule (`isListIndexDisabled`,
 * `isElementVisible`): one that cannot take the focus — natively disabled,
 * or not drawn.
 */
const passedOver = (element: HTMLElement): boolean => {
  if (element.closest('[hidden]')) return true
  if (element.matches(':disabled') || !element.isConnected) return true
  const style = getComputedStyle(element)
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true
  if (typeof element.checkVisibility === 'function') return !element.checkVisibility()
  return style.display === 'none' || style.display === 'contents'
}

const TAB_STOP =
  'a[href],area[href],button,input,select,textarea,summary,iframe,audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),[tabindex]'

/**
 * Where Tab goes on to from the end of `region`: the first element after
 * everything in it, in document order, that Tab stops at. A Base UI focus
 * guard is one — the browser stops on those too — and the popup it guards
 * then answers the Tab as its own.
 *
 * The browser's order, as far as a focus guard's next stop needs it: the
 * guard has no `tabindex` of its own to speak of (0), so what comes after it
 * is the next stop with none either, in document order. A positive `tabindex`
 * is a stop the browser visits before every one of those, so it is never
 * the one after a guard. Not modelled: a radio group, which the browser stops
 * on once, and a shadow tree.
 *
 * In this app the first stop found is always the Popover's own guard, which
 * every menu here sits in; the rest is for a host that has none.
 */
const nextTabStop = (region: Element): HTMLElement | null => {
  for (const candidate of region.ownerDocument.querySelectorAll<HTMLElement>(TAB_STOP)) {
    if (!(region.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
    if (region.contains(candidate) || candidate.closest('[inert]') || passedOver(candidate)) continue
    // An editing host takes Tab although its tabIndex reads -1, until one is set.
    const tabIndex = candidate.isContentEditable && !candidate.hasAttribute('tabindex') ? 0 : candidate.tabIndex
    if (tabIndex === 0) return candidate
  }
  return null
}

/**
 * Tab off the end of a level lands on the focus guard Base UI keeps after
 * it, whose work is to send the focus on to the menu's trigger. A level here
 * has none — its Popover, or a pointer, opened it — so the focus stayed on
 * the guard: an invisible span, in a menu still open. True when this focus
 * has come to rest there, and Base UI has sent it nowhere.
 */
const restsPastLevel = (event: ReactFocusEvent<HTMLElement>, level: HTMLElement | null): boolean =>
  event.target === level?.nextElementSibling &&
  event.target === document.activeElement &&
  event.target.hasAttribute('data-base-ui-focus-guard')

/**
 * Shift+Tab: Base UI closes a menu on it — a focus-out the key raises itself,
 * before any focus has moved — and gives the focus to the menu's trigger,
 * which a level here has not got either.
 */
const closedByShiftTab = (details: { reason: string; event: Event }): boolean =>
  details.reason === 'focus-out' && details.event.type === 'keydown'

/**
 * Where → lands in a flyout: its first row that is on — never a note or a
 * label, nor a row disabled for a reason. → goes in to choose; the arrows
 * inside still stop on those rows.
 */
const FIRST_ROW =
  '[role^="menuitem"]:not([disabled]):not([aria-disabled="true"]),[role="switch"]:not([disabled]):not([aria-disabled="true"])'

/**
 * A HarnessDesk menu level. Base UI owns item collection, roving focus,
 * selection, Escape and submenu coordination; this wrapper carries the
 * product-level close callback used by async actions.
 *
 * Tab and Shift+Tab leave a menu and close every level of it (WAI-ARIA APG,
 * menu pattern). The menu stands in the tab order just after its trigger,
 * where Base UI places a Popover: Tab moves on to what follows the trigger,
 * and Shift+Tab goes back to the trigger, as Escape does. A panel of plain
 * buttons in a menu keeps Tab for going from one to the next, and leaves by
 * it after the last.
 */
// A shared empty state keeps a menu readable when every contextual action
// is inapplicable. It carries no invented action or duplicate trigger label.
export const hasMenuContent = (content: ReactNode): boolean => {
  if (content === null || content === undefined || typeof content === 'boolean') return false
  if (Array.isArray(content)) return content.some(hasMenuContent)
  if (isValidElement<{children?:ReactNode}>(content) && content.type === Fragment) return hasMenuContent(content.props.children)
  return true
}

export const Menu = ({ close, onEscape, children }: { close: () => void; onEscape?: () => void; children: ReactNode }) => {
  const presentation = useMenuPresentation()
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
        {...presentation}
        open
        onOpenChange={(open, details) => {
          // Item presses close through the typed row contract below; asking
          // the owner again would call the feature close callback twice.
          // Escape belongs to the composite itself, so bridge only that Base
          // UI reason to the surrounding Popover — and Shift+Tab, on which
          // Base UI closes a menu for its trigger, here the Popover's.
          if (!open && (details.reason === 'escape-key' || closedByShiftTab(details))) (onEscape ?? close)()
        }}
        modal={false}
      >
        <ScopeContext.Provider value={scope}>
          <DropdownMenuPortal container={host}>
            {/* Base UI keeps children hidden until positioning resolves against this host anchor. */}
            <DropdownMenuPositioner
              anchor={host}
              style={{ position: 'static', inset: 'auto', transform: 'none' }}
              onFocus={(event) => {
                // From a flyout too: Base UI hands Tab on out of it to here.
                if (!restsPastLevel(event, level.current) || !host.current) return
                const next = nextTabStop(host.current)
                // Nothing follows it on the page: the focus leaves the guard
                // for the page.
                if (next) next.focus()
                else event.target.blur()
                // Inside a Popover the guard it lands on has closed the
                // Popover by now, and this asks for what is done. Anywhere
                // else nothing else would: Tab leaves the menu, and closes it.
                close()
              }}
            >
              <DropdownMenuPopup ref={level} className={styles.level} finalFocus={false}>
                {hasMenuContent(children) ? children : <MenuNote>No actions here.</MenuNote>}
              </DropdownMenuPopup>
            </DropdownMenuPositioner>
          </DropdownMenuPortal>
        </ScopeContext.Provider>
      </DropdownMenu>
    </div>
  )
}

export const MenuNote = ({ children, tone }: { children: ReactNode; tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }) =>
  <div data-menu-note="" data-tone={tone} className={tone && tone !== 'neutral' ? inkTone({ tone: tone === 'info' ? 'brand' : tone }) : undefined}>{children}</div>
export const MenuLabel = ({ children, size = 'default' }: { children: ReactNode; size?: 'default' | 'compact' }) => <div data-menu-group="" data-size={size}>{children}</div>

/** A stable account group whose heading shares the level's text edge. */
export const MenuAccountGroup = ({
  label,
  heading = true,
  children,
}: {
  label: string
  mark: ReactNode
  heading?: boolean
  children: ReactNode
}) => {
  const id = useId()
  return (
    <div {...(heading ? { role: 'group', 'aria-labelledby': id } : {})}>
      {heading && <div data-menu-group="" id={id}>{label}</div>}
      {children}
    </div>
  )
}

export const MenuSeparator = () => <div data-menu-separator="" role="separator" />

export interface MenuItemProps {
  readonly ref?: Ref<HTMLButtonElement>
  readonly icon?: ReactNode
  readonly label: ReactNode
  readonly hint?: ReactNode
  readonly shortcut?: string
  readonly value?: ReactNode
  readonly title?: string
  readonly badge?: ReactNode
  readonly trailing?: ReactNode
  readonly meter?: ReactNode
  readonly hintId?: string
  readonly selected?: boolean
  readonly teamPage?: string
  /** Marks the app's current account/session independently of checked semantics. */
  readonly current?: boolean
  /** Exposes a row-owned disclosure without surrendering menu keyboard behavior. */
  readonly expanded?: boolean
  readonly danger?: boolean
  readonly disabled?: string | boolean
  readonly keepOpen?: boolean
  readonly onSelect: () => void
  /** Pointer or keyboard intent, before the row is chosen. */
  readonly onHighlight?: () => void
}

export const MenuItem = ({
  ref,
  icon,
  label,
  hint,
  shortcut,
  value,
  title,
  badge,
  trailing,
  meter,
  hintId,
  selected,
  teamPage,
  current,
  expanded,
  danger,
  disabled,
  keepOpen,
  onSelect,
  onHighlight,
}: MenuItemProps) => {
  const scope = useScope()
  const reason = typeof disabled === 'string' ? disabled : disabled ? title : undefined
  const reasonId = useId()
  return (
    <DropdownMenuItem
      data-team-page={teamPage}
      ref={ref}
      render={<button type="button" disabled={Boolean(disabled)} />}
      nativeButton
      role={selected === undefined ? 'menuitem' : 'menuitemradio'}
      {...(selected === undefined ? {} : { 'aria-checked': selected })}
      {...(danger ? { 'data-danger': '' } : {})}
      {...(current ? { 'data-current': '', 'aria-current': true } : {})}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      {...(reason ? { 'aria-describedby': reasonId } : {})}
      label={label}
      icon={icon}
      hint={reason ?? hint}
      hintId={reason ? reasonId : hintId}
      badge={typeof badge === 'string' ? <Chip size="sm" tone="neutral">{badge}</Chip> : badge}
      meter={meter}
      trailing={trailing ?? <>{value}{shortcut}{selected !== undefined && <span aria-hidden="true" className="inline-flex">{selected && <CheckIcon size={16} />}</span>}</>}
      disabled={Boolean(disabled)}
      title={reason ?? title}
      closeOnClick={!keepOpen}
      onFocus={onHighlight}
      onPointerEnter={onHighlight}
      onClick={(event) => {
        ;(event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
        onSelect()
        if (!keepOpen) scope.close()
      }}
    />
  )
}

/**
 * The figure at an account row's trailing edge: what is left, or the one
 * word that says why there is nothing to show. A reading is a metered
 * percentage and draws numeric, tabular type; a word is a state — "Needs
 * sign-in" — and draws as ordinary prose.
 */
export interface MenuAccountFigure {
  readonly kind: 'reading' | 'word'
  readonly text: string
  readonly tone?: Tone
}

/** An account identity, badge and figure rendered by the canonical row. */
export const MenuAccountRow = ({
  mark,
  name,
  identity,
  tag,
  figure,
  current,
  expanded,
  keepOpen,
  onSelect,
}: {
  mark?: ReactNode
  name: ReactNode
  identity?: string
  /** The word that tells two rows sharing a name apart — a domain, an address. */
  tag?: ReactNode
  figure?: MenuAccountFigure
  current?: boolean
  expanded?: boolean
  keepOpen?: boolean
  onSelect: () => void
}) => (
  <MenuItem icon={mark} label={<span data-menu-account-name="" data-identity={identity} title={identity}>{name}</span>} badge={tag}
    value={figure ? <Text role={figure.kind === 'reading' ? 'muted' : 'meta'} tone={figure.tone} numeric={figure.kind === 'reading'}>{figure.text}</Text> : undefined} current={current} expanded={expanded} keepOpen={keepOpen} onSelect={onSelect} />
)

/** A switch stays open; Base UI supplies checkbox-menu keyboard semantics. */
export const MenuToggle = ({
  icon,
  label,
  hint,
  title,
  value,
  checked,
  disabled,
  onChange,
}: {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  title?: string
  value?: ReactNode
  checked: boolean
  disabled?: string | boolean
  onChange: (next: boolean) => void
}) => {
  const reason = typeof disabled === 'string' ? disabled : undefined
  const data = { icon, label, hint: reason ?? hint, trailing: <>{value}<SwitchShape checked={checked} size="sm" disabled={Boolean(disabled)} /></> }
  return (
    <DropdownMenuCheckboxControl
      data-slot="dropdown-menu-checkbox-item"
      render={<button type="button" disabled={Boolean(disabled)} />}
      nativeButton
      {...menuRowAttributes(data)}
      role="switch"
      checked={checked}
      disabled={Boolean(disabled)}
      title={reason ?? title}
      closeOnClick={false}
      onCheckedChange={(next) => onChange(next)}
    >
      <MenuRowContent {...data} />
    </DropdownMenuCheckboxControl>
  )
}

export const Submenu = ({
  icon,
  label,
  hint,
  value,
  disabled,
  width: _width,
  icons: childIcons = 'none',
  wide = true,
  children,
}: {
  icon?: ReactNode
  label: ReactNode
  hint?: ReactNode
  value?: ReactNode
  disabled?: string | boolean
  width?: number
  icons?: MenuIcons
  wide?: boolean
  children: ReactNode
}) => {
  const reason = typeof disabled === 'string' ? disabled : undefined
  const data = { icon, label, hint: reason ?? hint, trailing: <>{value}<ChevronIcon size={16} /></> }
  const row = useRef<HTMLButtonElement>(null)
  const flyout = useRef<HTMLDivElement | null>(null)
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
  // → steps onto the flyout's first row just after the commit that draws
  // it, in which Base UI lists its rows for ↑ and ↓ — and before a key
  // pressed after → can reach the row: waiting a frame, a slow machine let
  // that key in first, and it was lost.
  const land = useCallback((): boolean => {
    const rows = flyout.current?.querySelectorAll<HTMLElement>(FIRST_ROW) ?? []
    const first = [...rows].find((candidate) => !passedOver(candidate))
    if (!first) return false
    stepIn.current = false
    // A flyout that took the focus itself — a filter field — keeps it.
    if (document.activeElement === row.current) first.focus({ preventScroll: true })
    return true
  }, [])
  // The flyout is drawn a commit after it opens, its rows with it...
  const placeFlyout = useCallback(
    (node: HTMLDivElement | null) => {
      flyout.current = node
      if (!node || !stepIn.current) return
      queueMicrotask(() => {
        if (stepIn.current) land()
      })
    },
    [land],
  )
  // ...unless it opened again while still going, and is drawn already. Rows
  // that come later still are waited for, three frames at most.
  useLayoutEffect(() => {
    if (!open || !stepIn.current) return
    let frame = 0
    let waited = 0
    const retry = (): void => {
      if (!stepIn.current || land()) return
      if (waited++ < 3) frame = requestAnimationFrame(retry)
    }
    queueMicrotask(retry)
    return () => cancelAnimationFrame(frame)
  }, [open, land])
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
      <DropdownMenuSubControl
        data-slot="dropdown-menu-sub-trigger"
        ref={row}
        render={<button type="button" disabled={Boolean(disabled)} />}
        nativeButton
        {...menuRowAttributes(data)}
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
          // the event as it bubbles — the menu's, so the step is taken here,
          // by the menu's rule: the next row of this level that can take the
          // focus, round to the first as the menu loops. ↑ never opened the
          // flyout and is left to the menu.
          if (event.key !== 'ArrowDown') return
          ;(event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.()
          event.preventDefault()
          event.stopPropagation()
          const level = event.currentTarget.closest<HTMLElement>('[role="menu"]')
          const rows = level ? [...level.querySelectorAll<HTMLElement>(LEVEL_ROW)] : []
          const at = rows.indexOf(event.currentTarget)
          const onward = [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0))]
          onward.find((candidate) => !passedOver(candidate))?.focus()
        }}
      >
        <MenuRowContent {...data} />
      </DropdownMenuSubControl>
      {/* Beside its row, or over the menu at its row — never above or below
          it. With no room on either side Base UI turned the flyout onto the
          other axis, over the menu's other rows, and the way there crossed
          them: a hand resting at the row's far end set off along a safe
          triangle so thin for a short flyout that its first step fell
          outside it, and the row it crossed took the flyout's place. Kept to
          a side and slid into the window, the flyout lies across the row
          itself, and the pointer reaches it without leaving the row. */}
      <DropdownMenuSubContent
        ref={placeFlyout}
        icons={childIcons}
        wide={wide}
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
  icons = 'none',
  wide = false,
  at,
  label,
  onClose,
  children,
}: {
  icons?: MenuIcons
  wide?: boolean
  at: MenuPoint | null
  label: string
  onClose: () => void
  children: ReactNode
}) => {
  const panel = useRef<HTMLDivElement>(null)
  const positioner = useRef<HTMLDivElement>(null)
  const previous = useRef<HTMLElement | null>(null)
  const previousAt = useRef<MenuPoint | null>(null)
  if (at !== null && previousAt.current === null) {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  previousAt.current = at
  const scope = useMemo<Scope>(() => ({ close: onClose }), [onClose])
  // A context menu opens at a point, not from a place in the tab order. So
  // the keys that leave it — Escape, Tab, Shift+Tab — give the focus back to
  // what had it when it opened, as a dismissal that asks for it does; and
  // where that was nothing (the page), or can no longer take it, to nothing.
  const giveBack = (): void => {
    const held = document.activeElement
    if (!(held instanceof HTMLElement) || !positioner.current?.contains(held)) return
    if (previous.current?.isConnected) previous.current.focus({ preventScroll: true })
    if (document.activeElement === held) held.blur()
  }
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
    if (returnFocus === true) giveBack()
    onClose()
  })

  return (
    <DropdownMenu
      icons={icons}
      wide={wide}
      open={at !== null}
      onOpenChange={(open, details) => {
        if (open) return
        // A flyout is a separate floating root, so Base UI can report the
        // context menu's pointer leaving as its own dismissal while the
        // pointer is entering that child. Keep the owner open until the
        // child hands the pointer or focus back; the child's row still closes
        // the whole scope when it is selected.
        if (panel.current?.querySelector('[data-slot="dropdown-menu-sub-trigger"][aria-expanded="true"]')) return
        if (details.reason === 'escape-key' || closedByShiftTab(details)) giveBack()
        onClose()
      }}
      onOpenChangeComplete={(open) => {
        if (open) panel.current?.querySelector<HTMLElement>(ROW_SELECTOR)?.focus({ preventScroll: true })
      }}
      modal={false}
    >
      <ScopeContext.Provider value={scope}>
        <DropdownMenuPortal>
          <DropdownMenuPositioner
            ref={positioner}
            anchor={anchor}
            positionMethod="fixed"
            side="bottom"
            align="start"
            collisionPadding={8}
            className={styles.contextPositioner}
            onFocus={(event) => {
              if (!restsPastLevel(event, panel.current)) return
              giveBack()
              onClose()
            }}
          >
            <DropdownMenuPopup
              ref={panel}
              className={cn(styles.surface, floatingMotion)}
              data-popup-kind={wide ? 'wide-menu' : 'menu'}
              data-menu-icons={icons}
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
