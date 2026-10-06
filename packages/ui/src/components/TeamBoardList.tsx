import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Intent } from '@harnessdesk/protocol'
import { EmptyState, Menu, MenuItem, MenuLabel, MenuSeparator, MenuToggle, PanelFilter, PanelFooter, PanelPill, PaneColumn, Popover, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, GroupLabel, Text } from '../design'
import { MoreIcon } from './Icons'
import { FACT_COLUMNS, type FactColumn, type Placement } from '../lib/board-facts'

export const JOB_COLUMNS = [
  { id: 'assignee', label: 'Assignee' },
  { id: 'state', label: 'State' },
  { id: 'pr', label: 'Pull request' },
  { id: 'checks', label: 'Checks' },
  { id: 'changes', label: 'Changes', numeric: true },
  { id: 'updated', label: 'Updated', numeric: true },
] as const
export type JobColumn = typeof JOB_COLUMNS[number]['id']

/** The pane is a container: secondary facts yield before the actions leave it. */
export const JOB_COLUMN_CLASS: Record<JobColumn, string> = {
  assignee: 'hidden @[720px]/board:table-cell',
  state: 'hidden @[520px]/board:table-cell',
  checks: 'hidden @[1024px]/board:table-cell',
  pr: 'hidden @[1100px]/board:table-cell',
  changes: 'hidden @[1200px]/board:table-cell',
  updated: 'hidden @[1280px]/board:table-cell',
}
const ALL_COLUMNS = new Set(JOB_COLUMNS.map(one => one.id))
const JOB_COLUMN_MIN_WIDTH: Readonly<Record<JobColumn, number>> = {
  assignee: 720,
  state: 520,
  checks: 1024,
  pr: 1100,
  changes: 1200,
  updated: 1280,
}

/** The same observed jobs, grouped by state only in the compact layout. */
export const TeamBoardList = ({ intents, placed, renderRow, defaultColumns = ALL_COLUMNS, searchText, compact = false, grouped = false }: {
  compact?: boolean
  grouped?: boolean
  intents: readonly Intent[]
  placed: ReadonlyMap<number, Placement>
  defaultColumns?: ReadonlySet<JobColumn>
  searchText?: (intent: Intent) => readonly (string | null | undefined)[]
  renderRow: (intent: Intent, columns: ReadonlySet<JobColumn>) => ReactNode
}) => {
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<FactColumn | 'all'>('all')
  const [sort, setSort] = useState<'state' | 'recent' | 'title'>('state')
  const [choices, setChoices] = useState<ReadonlyMap<JobColumn, boolean>>(() => new Map())
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  useEffect(() => {
    const pane = root.current?.closest<HTMLElement>('[data-slot="tool-pane"]')
    if (!pane) return
    const measure = (): void => {
      const width = pane.getBoundingClientRect().width
      if (width > 0) setPaneWidth(width)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])
  const columns = new Set(JOB_COLUMNS.filter(one => choices.get(one.id) ?? defaultColumns.has(one.id)).map(one => one.id))
  if (grouped) columns.delete('state')
  const filters = ['needs', 'working', 'review', 'todo', 'ready', 'aside'] as const
  const words = query.trim().toLocaleLowerCase()
  const jobs = intents.filter(intent =>
    (state === 'all' || placed.get(intent.id)?.column === state) &&
    [String(intent.id), `#${intent.id}`, intent.title, intent.role, intent.blockedReason, intent.detail,
      FACT_COLUMNS.find(one => one.id === placed.get(intent.id)?.column)?.title,
      ...(searchText?.(intent) ?? [intent.state === 'done' || intent.state === 'abandoned' ? intent.note : null])].some(one => one?.toLocaleLowerCase().includes(words)),
  ).sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title) || a.id - b.id
    if (sort === 'state') {
      const attention = Number(placed.get(b.id)?.column === 'needs') - Number(placed.get(a.id)?.column === 'needs')
      if (attention) return attention
    }
    return b.updatedAt - a.updatedAt || a.id - b.id
  })
  const count = (column: FactColumn) => intents.filter(one => placed.get(one.id)?.column === column).length
  return <PaneColumn ref={root} inset="reading" className="flex flex-col gap-3" data-slot="board-list" data-grouped={grouped || undefined}>
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 basis-48"><PanelFilter value={query} placeholder="Filter jobs" onChange={setQuery} /></div>
      <PanelPill pressed={state === 'all'} onClick={() => setState('all')}>All <Text role="meta" numeric>{intents.length}</Text></PanelPill>
      {filters.map(id => {
        const column = FACT_COLUMNS.find(one => one.id === id)!
        if (id === 'aside' && count(id) === 0 && state !== id) return null
        return <PanelPill key={id} pressed={state === id} onClick={() => setState(id)}>{column.title} <Text role="meta" numeric>{count(id)}</Text></PanelPill>
      })}
      <span className="flex-1" />
      <Popover label={<MoreIcon />} title="View: columns and sort" align="right">
        {close => <Menu close={close}>
          <MenuLabel>Sort</MenuLabel>
          <MenuItem label="Needs you first" current={sort === 'state'} onSelect={() => setSort('state')} />
          <MenuItem label="Most recent" current={sort === 'recent'} onSelect={() => setSort('recent')} />
          <MenuItem label="Job title" current={sort === 'title'} onSelect={() => setSort('title')} />
          <MenuSeparator />
          <MenuLabel>Columns</MenuLabel>
          {JOB_COLUMNS.map(one => <MenuToggle key={one.id} label={one.label} checked={columns.has(one.id)}
            disabled={grouped && one.id === 'state' ? 'State is shown by the group heading' : paneWidth !== null && paneWidth < JOB_COLUMN_MIN_WIDTH[one.id]
              ? `Widen the pane to at least ${JOB_COLUMN_MIN_WIDTH[one.id]}px to show this column`
              : false}
            onChange={() => setChoices(previous => {
              const next = new Map(previous)
              next.set(one.id, !columns.has(one.id))
              return next
            })} />)}
        </Menu>}
      </Popover>
    </div>
    <div className="overflow-hidden">
      <Table variant="framed" density={compact ? 'compact' : 'comfortable'} aria-label="Jobs">
        <TableHeader><TableRow>
          <TableHead className="w-full">Job</TableHead>
          {JOB_COLUMNS.filter(one => columns.has(one.id)).map(one => <TableHead key={one.id} className={JOB_COLUMN_CLASS[one.id]} numeric={'numeric' in one && one.numeric}>{one.label}</TableHead>)}
          <TableHead><span className="sr-only">Primary action</span></TableHead>
          <TableHead><span className="sr-only">More actions</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>{grouped ? [...filters, 'unknown' as const].map(state => {
          const group = jobs.filter(job => (placed.get(job.id)?.column ?? 'unknown') === state)
          if (!group.length) return null
          const title = FACT_COLUMNS.find(one => one.id === state)?.title ?? 'Unplaced'
          return <Fragment key={state}>
            <TableRow data-state-group={state}><TableCell colSpan={columns.size + 3}><GroupLabel as="h3">{title}</GroupLabel></TableCell></TableRow>
            {group.map(intent => renderRow(intent, columns))}
          </Fragment>
        }) : jobs.map(intent => renderRow(intent, columns))}</TableBody>
      </Table>
      {jobs.length === 0 && <EmptyState variant="inline" title="No jobs match" />}
      <PanelFooter left={`${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}${jobs.length !== intents.length ? ` of ${intents.length}` : ''}`} right={grouped ? (sort === 'title' ? 'Grouped by state, then job title' : 'Needs you first, then the most recent') : sort === 'state' ? 'Needs you first, then the most recent' : sort === 'recent' ? 'Most recent first' : 'Job title'} />
    </div>
  </PaneColumn>
}
