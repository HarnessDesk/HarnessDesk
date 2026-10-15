import { createContext, useContext,  type ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { useToolBodySections } from './ToolBody'
import { ToolFooterPublisher } from './ToolFooter'
import { Button, buttonVariants } from '../ui/button'
import { ChangeStats } from './Change'
import { MiddleTruncate } from '../ui/key-value'
import { PaneColumn } from './PaneColumn'
import { Chip, Dot, Search, Text } from './Settings'

/**
 * The anatomy shared by the right-hand inspectors.
 *
 * Changes, Activity, Agents and background tasks are different lists inside
 * the same piece of furniture: ordinary control rows, recorded events or objects,
 * and shell-published facts. Owning those roles here means a selected row stays
 * a fill, a running mark stays the same dot, and the list's labels cannot
 * drift back into a fifth spelling.
 */

/** Standalone prose bodies keep their reading gutter; controls use the ordinary row inset. */
const PanelInset = createContext<'dense' | 'reading'>('dense')
const PanelFrame = ({ children, testId, inset = 'dense' }: { children: ReactNode; testId?: string; inset?: 'dense' | 'reading' }) => useToolBodySections() ? <>{children}</> : (
  <PanelInset.Provider value={inset}>
    <div data-slot="inspector-panel" data-inset={inset} data-testid={testId} className="flex h-full min-w-0 flex-col">
      {children}
    </div>
  </PanelInset.Provider>
)

const PanelBody = ({ children }: { children: ReactNode }) => {
  const reading = useContext(PanelInset) === 'reading'
  const sections = useToolBodySections()
  if (sections) return <>{children}</>
  return <div data-slot="inspector-body" className={cn('min-h-0 flex flex-col gap-(--hd-card-gap) flex-1 overflow-y-auto', !reading && 'p-(--hd-inset-dense)')}>
    {reading ? <PaneColumn inset="reading" className="flex min-w-0 flex-col gap-(--hd-card-gap)">{children}</PaneColumn> : children}
  </div>
}

/** Facts retain their existing calculations while the fixed shell owns their footer. */
const PanelFooter = ({ left, right }: { left: ReactNode; right: ReactNode }) => <ToolFooterPublisher left={left} right={right} />

/**
 * A count on the left, and a fact about the whole group on the right.
 *
 * `sticky` keeps the line at the top of the list while its rows scroll under
 * it, on the panel's own ground, for a list long enough that a row can be read
 * without the heading that says which group it is in — a turn of a
 * trajectory, say.
 */
const GroupLine = ({ left, right, sticky = false, as = 'div' }: { left: ReactNode; right?: ReactNode; sticky?: boolean; as?: 'div' | 'h3' }) => {
  const Element = as
  return <Element
    data-slot="inspector-group"
    {...(sticky ? { 'data-sticky': '' } : {})}
    className={cn('m-0 flex items-center gap-2 p-(--hd-inset-dense) px-(--hd-inset-row)', sticky && 'sticky top-0 z-1 bg-(--hd-background)')}
  >
    <Text role="meta" weight="medium" ink="secondary">{left}</Text>
    <span className="flex-1" />
    {right != null && <Text role="meta">{right}</Text>}
  </Element>
}

const PanelEmpty = ({ children }: { children: ReactNode }) => (
  <p data-slot="inspector-empty" className="m-0 px-(--hd-inset-row) py-6 text-center text-sm leading-(--hd-line-sm) text-(--hd-muted-foreground)">
    {children}
  </p>
)

const PanelRow = ({
  lead,
  mark,
  title,
  sub,
  ask,
  askLines = 2,
  meta,
  trail,
  subPath,
  tall,
  selected,
  tooltip,
  wrapTitle = false,
  onClick,
}: {
  /**
   * A word before the mark that says who or what produced the row — the
   * trajectory's "You", "Shell", "Thinking". Set at the meta step in sentence
   * case: a column of capitals is a column shouting its own heading.
   */
  lead?: ReactNode
  mark?: ReactNode
  title: ReactNode
  sub?: ReactNode
  ask?: ReactNode
  /** Prompts stay at two lines; a refusal must be readable in full. */
  askLines?: 2 | 'all'
  meta?: ReactNode
  trail?: ReactNode
  subPath?: boolean
  tall?: boolean
  selected?: boolean
  tooltip?: string
  /** Let sentence-like row titles use their own wrapping/clamp treatment. */
  wrapTitle?: boolean
  onClick?: () => void
}) => {
  const content = (
    <>
      {lead != null ? (
        <Text role="meta" className="shrink-0">{lead}</Text>
      ) : null}
      {mark ? (
        <span
          data-slot="inspector-row-mark"
          className="inline-grid size-(--hd-table-face) shrink-0 place-items-center rounded-(--hd-table-face-radius) text-(--hd-muted-foreground) [&>[data-slot=icon-tile]]:size-full [&>[data-slot=icon-tile]]:rounded-[inherit]"
        >
          {mark}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <Text role="row" truncate={!wrapTitle} className={cn('flex min-w-0 gap-2', wrapTitle ? 'items-start' : 'items-center')}>{typeof title === 'string' && !wrapTitle ? <MiddleTruncate>{title}</MiddleTruncate> : title}</Text>
        {sub ? (
          <Text
            role="meta"
            truncate
            className="mt-(--hd-table-line-gap)"
          >
            {subPath && typeof sub === 'string' ? <MiddleTruncate>{sub}</MiddleTruncate> : sub}
          </Text>
        ) : null}
        {ask ? <Text role="meta" ink="secondary" className={cn('mt-(--hd-table-line-gap) [overflow-wrap:anywhere]', askLines === 2 && 'line-clamp-2')}>{ask}</Text> : null}
        {meta ? <Text role="meta" numeric className="mt-1">{meta}</Text> : null}
      </span>
      {trail}
    </>
  )
  const className = cn(
    buttonVariants({ variant: 'row', size: 'row' }),
    'w-full items-center gap-(--hd-table-lead-gap) px-(--hd-table-edge)',
    (sub || tall || ask || meta) ? 'min-h-(--hd-table-row-min) py-0' : 'min-h-(--hd-table-row-min-bare) py-1',
    !onClick && 'cursor-default hover:bg-transparent',
  )
  const attrs = {
    'data-slot': 'inspector-row',
    'data-hd-table': 'compact',
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


export {
  Counts,
  GroupLine,
  PanelBody,
  PanelEmpty,
  PanelFilter,
  PanelFooter,
  PanelFrame,
  PanelRow,
  RowTime,
  RunDot,
}
