import { Button, Chip, CodeText, PopoverGroupLabel, PopoverSurface, Text } from '../design'
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
    <PopoverSurface className={styles.menu} ref={container} role="listbox" limit="trigger">
      {title && <PopoverGroupLabel>{title}</PopoverGroupLabel>}
      {items.length === 0 && <div className="hd-empty-line">{emptyLabel ?? 'No matches'}</div>}
      {items.map((item, index) => (
        <Button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex} variant="navigation" size="navigation" className={styles.row}
          {...(index === activeIndex ? { 'data-selected': '' } : {})}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(item)}
        >
          <Text role="meta" tone="brand" className={styles.check}>{item.selected && <CheckIcon size={13} />}</Text>
          {item.mark ? (
            <Text role="meta" ink="secondary" className={styles.mark}>{item.mark}</Text>
          ) : item.pathStyle ? (
            <FileIcon size={13} />
          ) : item.badge === 'skill' ? (
            <SparkIcon size={13} />
          ) : item.badge === 'session' ? (
            <SessionIcon size={13} />
          ) : item.mono && item.name.startsWith('/') ? (
            <SlashIcon size={13} />
          ) : null}
          <Text role="row" className={styles.name}>
            {item.mono ? <CodeText size="inherit">{item.name}</CodeText> : item.name}
          </Text>
          {item.hint && (
            <Text role="muted" {...(item.pathStyle ? { truncateFrom: 'start' as const } : { truncate: true })} className={styles.hint}>
              {item.pathStyle ? <CodeText size="inherit">{item.hint}</CodeText> : item.hint}
            </Text>
          )}
          {item.badge && (
            <Chip
              size="sm"
              tone={item.badgeTone === 'live'
                ? 'success'
                : item.badgeTone === 'warn'
                  ? 'warning'
                  : item.badgeTone === 'muted'
                    ? 'neutral'
                    : 'brand'}
            >
              {item.badge}
            </Chip>
          )}
        </Button>
      ))}
    </PopoverSurface>
  )
}
