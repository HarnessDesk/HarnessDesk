import { useState, type ReactNode } from 'react'
import type { Intent } from '@harnessdesk/protocol'
import { EmptyState, Menu, MenuItem, MenuLabel, MenuSeparator, MenuToggle, PanelFilter, PanelFooter, PanelPill, PaneColumn, Popover, Table, TableBody, TableHead, TableHeader, TableRow, Text } from '../design'
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

/** One list of the board's existing placements, never group rows or selection. */
export const TeamBoardList = ({ intents, placed, renderRow, defaultColumns = ALL_COLUMNS, searchText }: {
  intents: readonly Intent[]
  placed: ReadonlyMap<number, Placement>
  defaultColumns?: ReadonlySet<JobColumn>
  searchText?: (intent: Intent) => readonly (string | null | undefined)[]
  renderRow: (intent: Intent, columns: ReadonlySet<JobColumn>) => ReactNode
}) => {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<FactColumn | 'all'>('all')
  const [sort, setSort] = useState<'state' | 'recent' | 'title'>('state')
  const [choices, setChoices] = useState<ReadonlyMap<JobColumn, boolean>>(() => new Map())
  const columns = new Set(JOB_COLUMNS.filter(one => choices.get(one.id) ?? defaultColumns.has(one.id)).map(one => one.id))
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
  return <PaneColumn inset="reading" className="flex flex-col gap-3" data-slot="board-list">
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
          {JOB_COLUMNS.map(one => <MenuToggle key={one.id} label={one.label} checked={columns.has(one.id)} onChange={() => setChoices(previous => {
            const next = new Map(previous)
            next.set(one.id, !columns.has(one.id))
            return next
          })} />)}
        </Menu>}
      </Popover>
    </div>
    <div className="overflow-hidden">
      <Table variant="framed" aria-label="Jobs">
        <TableHeader><TableRow>
          <TableHead className="w-full">Job</TableHead>
          {JOB_COLUMNS.filter(one => columns.has(one.id)).map(one => <TableHead key={one.id} className={JOB_COLUMN_CLASS[one.id]} numeric={'numeric' in one && one.numeric}>{one.label}</TableHead>)}
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>{jobs.map(intent => renderRow(intent, columns))}</TableBody>
      </Table>
      {jobs.length === 0 && <EmptyState variant="inline" title="No jobs match" />}
      <PanelFooter left={`${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}${jobs.length !== intents.length ? ` of ${intents.length}` : ''}`} right={sort === 'state' ? 'Needs you first, then the most recent' : sort === 'recent' ? 'Most recent first' : 'Job title'} />
    </div>
  </PaneColumn>
}
