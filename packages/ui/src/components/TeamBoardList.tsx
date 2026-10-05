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

/** One list of the board's existing placements, never group rows or selection. */
export const TeamBoardList = ({ intents, placed, renderRow }: {
  intents: readonly Intent[]
  placed: ReadonlyMap<number, Placement>
  renderRow: (intent: Intent, columns: ReadonlySet<JobColumn>) => ReactNode
}) => {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<FactColumn | 'all'>('all')
  const [sort, setSort] = useState<'state' | 'recent' | 'title'>('state')
  const [columns, setColumns] = useState<ReadonlySet<JobColumn>>(() => new Set(JOB_COLUMNS.map(one => one.id)))
  const filters = ['needs', 'working', 'review', 'todo', 'ready', 'aside'] as const
  const words = query.trim().toLocaleLowerCase()
  const jobs = intents.filter(intent =>
    (state === 'all' || placed.get(intent.id)?.column === state) &&
    [intent.title, intent.role, intent.note, intent.blockedReason, intent.detail].some(one => one?.toLocaleLowerCase().includes(words)),
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
      <PanelPill pressed={state === 'all'} aria-label="All jobs" onClick={() => setState('all')}>All <Text role="meta" numeric>{intents.length}</Text></PanelPill>
      {filters.map(id => {
        const column = FACT_COLUMNS.find(one => one.id === id)!
        if (id === 'aside' && count(id) === 0) return null
        return <PanelPill key={id} pressed={state === id} aria-label={`${column.title} jobs`} onClick={() => setState(id)}>{column.title} <Text role="meta" numeric>{count(id)}</Text></PanelPill>
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
          {JOB_COLUMNS.map(one => <MenuToggle key={one.id} label={one.label} checked={columns.has(one.id)} onChange={() => setColumns(previous => {
            const next = new Set(previous)
            if (next.has(one.id)) next.delete(one.id)
            else next.add(one.id)
            return next
          })} />)}
        </Menu>}
      </Popover>
    </div>
    <div className="overflow-hidden">
      <Table variant="framed" aria-label="Jobs">
        <TableHeader><TableRow>
          <TableHead>Job</TableHead>
          {JOB_COLUMNS.filter(one => columns.has(one.id)).map(one => <TableHead key={one.id} numeric={'numeric' in one && one.numeric}>{one.label}</TableHead>)}
          <TableHead><span className="sr-only">Actions</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>{jobs.map(intent => renderRow(intent, columns))}</TableBody>
      </Table>
      {jobs.length === 0 && <EmptyState variant="inline" title="No jobs match" />}
      <PanelFooter left={`${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}${jobs.length !== intents.length ? ` of ${intents.length}` : ''}`} right={sort === 'state' ? 'Needs you first, then the most recent' : sort === 'recent' ? 'Most recent first' : 'Job title'} />
    </div>
  </PaneColumn>
}
