import { Button, DialogPopup, DialogPortal, DialogRoot, Search } from '../design'
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
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
            <DialogPopup
              ref={surface}
              className={styles.win}
              aria-label={label}
              aria-modal={embedded ? undefined : true}
              aria-describedby={undefined}
              initialFocus={embedded ? false : surface}
              finalFocus={!embedded}
            >
              <div className={styles.winBody}>{children}</div>
            </DialogPopup>
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
  <nav className={styles.winNav} data-hd-density="comfortable">
    <div className={`${styles.winNavTop} hd-drag`}>
      <Button type="button" variant="navigation" size="navigation" className={`${styles.backRow} hd-no-drag`} onClick={onBack}>
        <span className={styles.backIcon}>
          <ArrowLeftIcon size={15} />
        </span>
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
    </div>
    <div className={styles.winNavScroll}>{children}</div>
  </nav>
)

export const WindowGroup = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={styles.winGroup}>
    <div className={styles.winGroupLabel}>{label}</div>
    {children}
  </div>
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
  <Button
    type="button"
    variant="navigation" size="navigation" className={styles.winNavItem}
    {...(selected ? { 'data-selected': '' } : {})}
    onClick={onClick}
  >
    <span className={styles.winNavIcon}>{icon}</span>
    {/* A nav is a list of equal rows, so the label takes what is left and cuts
        rather than wrapping the row to two lines. The runtime names some of
        these — "Skills & commands" is Claude's and Cursor's word — so the
        longest one is not ours to choose. */}
    <span className={styles.winNavLabel}>{label}</span>
    {count !== undefined && <span className={styles.winNavCount}>{count}</span>}
    {trail}
  </Button>
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
  <Button
    type="button"
    variant="navigation" size="navigation" className={`${styles.winNavItem} ${styles.winIdentity}`}
    {...(selected ? { 'data-selected': '' } : {})}
    onClick={onClick}
  >
    {face}
    <Clipped className={`${styles.winNavLabel} ${styles.winIdentityLabel}`}>{name}</Clipped>
  </Button>
)

export const WindowNavEmpty = ({ children }: { children: ReactNode }) => (
  <div className={styles.winNavEmpty}>{children}</div>
)

export const WindowNavCount = ({ children, title }: { children: ReactNode; title?: string }) => (
  <span className={styles.winNavCount} title={title}>{children}</span>
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
  <div className={styles.page} data-hd-density="comfortable">
    <div className={styles.pageInner} {...(wide ? { 'data-wide': '' } : {})}>
      {children}
    </div>
  </div>
)
