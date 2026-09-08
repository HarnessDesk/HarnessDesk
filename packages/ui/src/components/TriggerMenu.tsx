import { useEffect, useRef, type ReactNode } from 'react'

import { CheckIcon, FileIcon, SessionIcon, SlashIcon, SparkIcon } from './Icons'
import styles from './TriggerMenu.module.css'

/**
 * The menu behind `/` and `@`, and the chooser commands open.
 *
 * One component for all three because they are the same interaction: a filtered
 * list, arrow keys, Enter to take the highlighted row. Splitting them produced
 * three subtly different keyboard behaviours in the version before this.
 */

export interface TriggerItem {
  readonly id: string
  readonly name: string
  readonly hint?: string
  readonly badge?: string
  /**
   * What the badge is saying. `accent` is the default — the kind of a thing.
   * `live` is a state changing under the reader (a member mid-turn), `warn` a
   * caution about picking it at all, `muted` a plain fact that is neither — a
   * room member whose conversation is not open, which is ordinary and reaches
   * the reader anyway. One pill in four inks rather than four pills, because
   * they never appear together on one row.
   */
  readonly badgeTone?: 'accent' | 'live' | 'warn' | 'muted'
  readonly selected?: boolean
  readonly mono?: boolean
  readonly pathStyle?: boolean
  /**
   * The row's own glyph, when the kinds below cannot say it — an agent's brand
   * mark for a room's members. Given rather than derived, because a brand is
   * the caller's fact and this menu must not learn about runtimes.
   */
  readonly mark?: ReactNode
}

export const TriggerMenu = ({
  title,
  items,
  activeIndex,
  onHover,
  onPick,
  emptyLabel,
}: {
  title?: string
  items: readonly TriggerItem[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (item: TriggerItem) => void
  emptyLabel?: string
}): ReactNode => {
  const container = useRef<HTMLDivElement>(null)

  // Keep the highlighted row visible when arrow keys move past the fold.
  useEffect(() => {
    const active = container.current?.querySelector('[data-selected]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className={styles.menu} ref={container} role="listbox">
      {title && <div className={styles.header}>{title}</div>}
      {items.length === 0 && <div className={styles.empty}>{emptyLabel ?? 'No matches'}</div>}
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={styles.row}
          {...(index === activeIndex ? { 'data-selected': '' } : {})}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(item)}
        >
          <span className={styles.check}>{item.selected && <CheckIcon size={13} />}</span>
          {item.mark ? (
            <span className={styles.mark}>{item.mark}</span>
          ) : item.pathStyle ? (
            <FileIcon size={13} />
          ) : item.badge === 'skill' ? (
            <SparkIcon size={13} />
          ) : item.badge === 'session' ? (
            <SessionIcon size={13} />
          ) : item.mono && item.name.startsWith('/') ? (
            <SlashIcon size={13} />
          ) : null}
          <span className={`${styles.name} ${item.mono ? styles.nameMono : ''}`}>{item.name}</span>
          {item.hint && (
            <span className={`${styles.hint} ${item.pathStyle ? styles.hintPath : ''}`}>
              {item.hint}
            </span>
          )}
          {item.badge && (
            <span
              className={styles.badge}
              {...(item.badgeTone && item.badgeTone !== 'accent' ? { 'data-tone': item.badgeTone } : {})}
            >
              {item.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
