import { Chip, CodeText, MenuPresentation, MenuListboxOption, MiddleTruncate, PopoverGroupLabel, PopoverSurface } from '../design'
import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

import { CheckIcon } from './Icons'

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
  /** A refused pick remains visible, with the reason in the row. */
  readonly disabled?: string
}

export const TriggerMenu = ({
  title,
  items,
  activeIndex,
  onHover,
  onPick,
  emptyLabel,
  anchor,
  onDismiss,
}: {
  title?: string
  items: readonly TriggerItem[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (item: TriggerItem) => void
  emptyLabel?: string
  anchor?: RefObject<HTMLElement | null>
  onDismiss?: () => void
}): ReactNode => {
  const container = useRef<HTMLDivElement>(null)

  // Keep the highlighted row visible when arrow keys move past the fold.
  useEffect(() => {
    const active = container.current?.querySelector('[data-selected]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <MenuPresentation icons="none" wide>
      <PopoverSurface anchor={anchor} onDismiss={onDismiss} ref={container} role="listbox" limit="trigger">
        {title && <PopoverGroupLabel>{title}</PopoverGroupLabel>}
        {items.length === 0 && <div data-menu-note="">{emptyLabel ?? 'No matches'}</div>}
        {items.map((item, index) => {
          const data = {
            label: item.pathStyle ? <MiddleTruncate>{item.name}</MiddleTruncate> : item.mono ? <CodeText size="inherit">{item.name}</CodeText> : item.name,
            hint: item.disabled ?? (item.pathStyle ? item.hint : undefined),
            trailing: item.selected ? <CheckIcon size={16} /> : undefined,
            badge: item.badge ? <Chip size="sm" tone={item.badgeTone === 'live' ? 'success' : item.badgeTone === 'warn' ? 'warning' : item.badgeTone === 'muted' ? 'neutral' : 'brand'}>{item.badge}</Chip> : undefined,
          }
          return <MenuListboxOption key={item.id} data={data}
            aria-selected={index === activeIndex}
            disabled={Boolean(item.disabled)} aria-disabled={Boolean(item.disabled)}
            title={item.disabled ?? (!item.pathStyle ? item.hint : undefined)}
            data-selected={index === activeIndex ? '' : undefined}
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => { if (!item.disabled) onPick(item) }} />
        })}
      </PopoverSurface>
    </MenuPresentation>
  )
}
