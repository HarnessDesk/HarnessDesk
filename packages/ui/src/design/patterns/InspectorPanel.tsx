import { createElement, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { Button, buttonVariants } from '../ui/button'
import { ChangeStats } from './Change'
import { Chip, Dot, Search, Text } from './Settings'

/**
 * The anatomy shared by the right-hand inspectors.
 *
 * Changes, Activity, Agents and background tasks are different lists inside
 * the same piece of furniture: a bar, rows that state one event or object,
 * and a quiet facts line. Owning those roles here means a selected row stays
 * a fill, a running mark stays the same dot, and the list's labels cannot
 * drift back into a fifth spelling.
 */

const PanelFrame = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <div data-slot="inspector-panel" data-testid={testId} className="flex h-full min-w-0 flex-col">
    {children}
  </div>
)

const PanelTools = ({ children }: { children: ReactNode }) => (
  <div
    data-slot="inspector-tools"
    className="flex h-(--hd-bar-h) shrink-0 items-center gap-(--hd-bar-gap) border-b border-(--hd-border) px-(--hd-bar-pad)"
  >
    {children}
  </div>
)

const PanelBody = ({ children }: { children: ReactNode }) => (
  <div data-slot="inspector-body" className="min-h-0 flex-1 overflow-y-auto p-2">
    {children}
  </div>
)

const PanelFooter = ({ left, right }: { left: ReactNode; right: ReactNode }) => (
  <div
    data-slot="inspector-footer"
    className="flex h-(--hd-bar-h) shrink-0 items-center gap-(--hd-bar-gap) border-t border-(--hd-border) px-(--hd-bar-pad) text-xs leading-(--hd-line-xs) text-(--hd-muted-foreground)"
  >
    {left}<span className="flex-1" />{right}
  </div>
)

/** A count on the left, and a fact about the whole group on the right. */
const GroupLine = ({ left, right }: { left: ReactNode; right?: ReactNode }) => (
  <div data-slot="inspector-group" className="flex items-center gap-2 px-2 pt-2 pb-1">
    <Text role="muted" ink="secondary">{left}</Text>
    <span className="flex-1" />
    {right != null && <Text role="meta">{right}</Text>}
  </div>
)

const DayLabel = ({ children }: { children: ReactNode }) => (
  <div
    data-slot="inspector-day"
    className="px-2 pt-2.5 pb-1 text-sm leading-(--hd-line-sm) text-(--hd-secondary-foreground)"
  >
    {children}
  </div>
)

const PanelEmpty = ({ children }: { children: ReactNode }) => (
  <p data-slot="inspector-empty" className="m-0 px-2.5 py-6 text-center text-sm leading-(--hd-line-sm) text-(--hd-muted-foreground)">
    {children}
  </p>
)

const PanelRow = ({
  mark,
  title,
  sub,
  ask,
  meta,
  trail,
  subPath,
  tall,
  selected,
  tooltip,
  onClick,
}: {
  mark?: ReactNode
  title: ReactNode
  sub?: ReactNode
  ask?: ReactNode
  meta?: ReactNode
  trail?: ReactNode
  subPath?: boolean
  tall?: boolean
  selected?: boolean
  tooltip?: string
  onClick?: () => void
}) => {
  const content = (
    <>
      {mark ? (
        <span
          data-slot="inspector-row-mark"
          className={cn('inline-grid shrink-0 place-items-center text-(--hd-muted-foreground)', (tall || ask || meta) && 'mt-px')}
        >
          {mark}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <Text role="navigation" truncate className="flex items-center gap-2">{title}</Text>
        {sub ? (
          <Text
            role="meta"
            truncate
            className={cn('mt-px', subPath && 'text-left [direction:rtl] [unicode-bidi:plaintext]')}
          >
            {sub}
          </Text>
        ) : null}
        {ask ? <Text role="meta" ink="secondary" className="mt-px line-clamp-2">{ask}</Text> : null}
        {meta ? <Text role="meta" numeric className="mt-1">{meta}</Text> : null}
      </span>
      {trail}
    </>
  )
  const className = cn(
    buttonVariants({ variant: 'row', size: 'row' }),
    'w-full',
    (tall || ask || meta) && 'items-start py-2',
  )
  const attrs = {
    'data-slot': 'inspector-row',
    ...(selected ? { 'data-selected': '' } : {}),
    ...(tooltip ? { title: tooltip } : {}),
  }

  return onClick ? (
    <Button variant="row" size="row" className={className} onClick={onClick} {...attrs}>
      {content}
    </Button>
  ) : (
    <div className={className} {...attrs}>{content}</div>
  )
}

const Counts = ({ added, removed }: { added: number; removed: number }) => (
  <ChangeStats added={added} removed={removed} />
)

const RowTime = ({ children }: { children: ReactNode }) => (
  <Text role="meta" numeric className="shrink-0">{children}</Text>
)

const RunDot = () => <Dot state="signin" pulse aria-label="Running" />

const PanelFilter = ({
  value,
  placeholder,
  onChange,
}: {
  value: string
  placeholder: string
  onChange: (next: string) => void
}) => (
  <Search
    className="min-w-0 flex-1"
    value={value}
    placeholder={placeholder}
    label={placeholder}
    onChange={onChange}
  />
)

const PanelPill = ({
  as = 'button',
  children,
  ...props
}: {
  as?: 'button' | 'span'
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement> & HTMLAttributes<HTMLSpanElement>) => {
  if (as === 'span') return <Chip tone="neutral" className="min-h-(--hd-target-min) bg-(--hd-chip-fill) text-(--hd-secondary-foreground)">{children}</Chip>
  const selected = 'data-on' in props
  return createElement(
    Button,
    {
      ...props,
      variant: 'ghost',
      size: 'chip',
      type: props.type ?? 'button',
      className: cn(
        'bg-(--hd-chip-fill) text-(--hd-secondary-foreground) hover:bg-(--hd-chip-fill) hover:text-(--hd-foreground)',
        selected && 'bg-(--hd-accent-dim) text-(--hd-accent) hover:bg-(--hd-accent-dim) hover:text-(--hd-accent)',
        props.className,
      ),
    },
    children,
  )
}

export {
  Counts,
  DayLabel,
  GroupLine,
  PanelBody,
  PanelEmpty,
  PanelFilter,
  PanelFooter,
  PanelFrame,
  PanelPill,
  PanelRow,
  PanelTools,
  RowTime,
  RunDot,
}
