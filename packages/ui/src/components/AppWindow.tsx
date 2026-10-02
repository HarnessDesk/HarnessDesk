import {
  AppWindowPage,
  AppWindowRail,
  AppWindowRailScroll,
  AppWindowRailTop,
  AppWindowSurface,
  Button,
  DialogPortal,
  DialogRoot,
  GroupLabel,
  Search,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  Text,
} from '../design'
import { createContext, useContext, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Clipped } from '../design'

import { ArrowLeftIcon } from './Icons'
import styles from './AppWindow.module.css'

/**
 * The app's second surface: a full window with a nav rail down its left side.
 *
 * Two places in HarnessDesk are somewhere you *go* rather than something you
 * answer — settings and usage — and both were drawn differently, one as a
 * window and one as a sheet floating over a dimmed app. A sheet says "answer
 * me and get out", which is exactly wrong for a screen you come to read; and
 * two shapes for the same kind of visit means learning the app twice. So the
 * chrome is one component and both wear it.
 *
 * The window's own traffic lights sit in the band above the rail, so the rail
 * starts below them and the top of the rail is draggable. It looks like a
 * window, while the canonical dialog owns its focus and modal lifecycle.
 */

/** Embedded catalogs show several windows together without taking the desk. */
export const AppWindowMode = createContext<'modal' | 'embedded'>('modal')

const moveWindowRailFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
  const target = event.target
  if (!(target instanceof HTMLButtonElement) || target.dataset.sidebar !== 'menu-button') return
  if (event.key === 'Enter' || event.key === ' ') {
    if (event.repeat) return
    event.preventDefault()
    target.click()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-sidebar="menu-button"]:not(:disabled)')]
  const index = rows.indexOf(target)
  if (index < 0 || rows.length < 2) return
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? rows.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
  event.preventDefault()
  rows[next]?.focus()
}

export const AppWindow = ({ label, children }: { label: string; children: ReactNode }) => {
  const embedded = useContext(AppWindowMode) === 'embedded'
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  return (
    <div ref={setHost}>
      <DialogRoot
        open
        modal={!embedded}
        disablePointerDismissal
        onOpenChange={(open, details) => {
          if (!open && details.reason === 'escape-key') {
            // The existing window stack answers after menus and before the
            // covered conversation/sidebar. Preserve that ordering while
            // Base UI owns modality, focus containment and focus return.
            details.cancel()
            details.allowPropagation()
          }
        }}
      >
        {host && (
          <DialogPortal container={host}>
            <AppWindowSurface
              ref={surface}
              className={styles.win}
              aria-label={label}
              modal={!embedded}
              aria-describedby={undefined}
              initialFocus={embedded ? false : surface}
              finalFocus={!embedded}
            >
              <div className={styles.winBody}>{children}</div>
            </AppWindowSurface>
          </DialogPortal>
        )}
      </DialogRoot>
    </div>
  )
}

export const WindowNav = ({
  onBack,
  search,
  children,
}: {
  onBack: () => void
  /** The rail's own filter, for a nav long enough to need one. */
  search?: {
    readonly value: string
    readonly placeholder: string
    readonly label: string
    readonly onChange: (value: string) => void
  }
  children: ReactNode
}) => (
  <AppWindowRail className={styles.winNav} data-hd-density="comfortable" aria-label="Window navigation" onKeyDown={moveWindowRailFocus}>
    <AppWindowRailTop className={`${styles.winNavTop} hd-drag`}>
      <Button type="button" variant="navigation" size="navigation" className={`${styles.backRow} hd-no-drag`} onClick={onBack}>
        <Text role="meta" ink="navigation" className={styles.backIcon}>
          <ArrowLeftIcon size={15} />
        </Text>
        Back to app
      </Button>
      {search && (
        <Search
          className={`${styles.winSearchLayout} hd-no-drag`}
          value={search.value}
          placeholder={search.placeholder}
          label={search.label}
          onChange={search.onChange}
        />
      )}
    </AppWindowRailTop>
    <AppWindowRailScroll className={styles.winNavScroll}>{children}</AppWindowRailScroll>
  </AppWindowRail>
)

export const WindowGroup = ({ label, children }: { label: string; children: ReactNode }) => (
  <SidebarGroup className={styles.winGroup}>
    <GroupLabel>{label}</GroupLabel>
    <SidebarGroupContent>
      {children}
    </SidebarGroupContent>
  </SidebarGroup>
)

export const WindowNavItem = ({
  icon,
  label,
  count,
  trail,
  selected,
  onClick,
}: {
  icon: ReactNode
  label: ReactNode
  count?: number
  /** Anything after the count — a readiness dot, say. */
  trail?: ReactNode
  selected: boolean
  onClick: () => void
}) => (
  <SidebarMenu>
    <SidebarMenuItem trailingMarks={Number(count !== undefined) + Number(Boolean(trail)) as 0 | 1 | 2}>
      <SidebarMenuButton
        icon={<Text role="meta" ink="navigation">{icon}</Text>}
        label={<Text role="navigation">{label}</Text>}
        trailingOverlay={count !== undefined || Boolean(trail)}
        labelTrailingContent={count !== undefined || Boolean(trail)}
        isActive={selected}
        aria-current={selected ? 'page' : undefined}
        onClick={onClick}
      />
      {count !== undefined && (
        <SidebarMenuBadge className={`${styles.winNavBadge} ${trail ? styles.winNavCountBadgeWithTrail : ''}`}>
          <Text role="meta" ink="navigation" numeric className={styles.winNavCount}>{count}</Text>
        </SidebarMenuBadge>
      )}
      {trail && <SidebarMenuBadge className={styles.winNavBadge}>{trail}</SidebarMenuBadge>}
    </SidebarMenuItem>
  </SidebarMenu>
)

/**
 * You, at the top of the rail.
 *
 * A Mac's own settings open on the person they belong to, and so does this
 * window: whose settings these are, then the pages. It is a row like the rest
 * — it selects its page and wears the same selection — with a face where the
 * others have an icon, and it is first because it is where a sign-in will
 * land once there is an account to sign in to. The face and the name are the
 * caller's; this window knows nothing about who you are.
 */
export const WindowNavIdentity = ({
  face,
  name,
  selected,
  onClick,
}: {
  face: ReactNode
  name: ReactNode
  selected: boolean
  onClick: () => void
}) => (
  <SidebarMenu>
    <SidebarMenuItem className={styles.winIdentity}>
      <SidebarMenuButton
        icon={face}
        iconSize="lg"
        label={<Clipped className="block min-w-0 flex-1 truncate" title={typeof name === 'string' ? name : undefined}><Text role="row">{name}</Text></Clipped>}
        isActive={selected}
        aria-current={selected ? 'page' : undefined}
        onClick={onClick}
      />
    </SidebarMenuItem>
  </SidebarMenu>
)

export const WindowNavEmpty = ({ children }: { children: ReactNode }) => (
  <Text as="div" role="muted" ink="navigation" className={styles.winNavEmpty}>{children}</Text>
)

export const WindowNavCount = ({ children, title }: { children: ReactNode; title?: string }) => (
  <Text role="meta" ink="navigation" numeric className={styles.winNavCount} title={title}>{children}</Text>
)

export const WindowNavStateMark = ({ children }: { children: ReactNode }) => (
  <span className={styles.winNavDot}>{children}</span>
)

/**
 * The page beside the rail: one scroller, one centred measure.
 *
 * `wide` is for a page of instruments rather than a page of prose. The default
 * measure is set for sentences — a settings description that ran the width of
 * a maximised window would be unreadable — but a row of usage cards squeezed
 * into a reading measure wraps its own footers, which is worse than a long
 * line.
 */
export const WindowPage = ({ wide, children }: { wide?: boolean; children: ReactNode }) => (
  <AppWindowPage className={styles.page} data-hd-density="comfortable">
    <div className={styles.pageInner} {...(wide ? { 'data-wide': '' } : {})}>
      {children}
    </div>
  </AppWindowPage>
)
