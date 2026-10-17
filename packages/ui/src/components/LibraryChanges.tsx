import { useEffect, useState } from 'react'
import type { HostResult, Library } from '@harnessdesk/protocol'
import { useSnapshot, useStore } from '../state/context'
import { ActionError, Button, CodeText, EmptyState, FormStack, PageExplanation, PageOptions, Row, Rows, Search, Text, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarGap } from '../design'
import { DestinationBar, useDestinationActive } from '../panels/destination-page'
import { RuntimeMark } from './BrandIcons'
import { AlertIcon, ImportIcon, RetryIcon, TrashIcon } from './Icons'
import { shortPath } from '../lib/paths'
import { LibraryFlows, type LibraryFlow } from './LibraryActions'
import { HISTORY_TRY, HISTORY_VERB } from './LibraryWriteToast'

type Entry = HostResult<'audit/query'>[number]
type Filter = 'all' | 'restore' | 'failed'
const canRestore = (entry: Entry) => entry.backupPath !== undefined && entry.status === 'done'
const dayOf = (at: number) => { const day = new Date(at); return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() }

/** The Library's existing 90-day audit read, with the same preview-before-write restore. */
export const LibraryChanges = ({ onBack, now = Date.now() }: { readonly onBack: () => void; readonly now?: number }) => {
  const store = useStore(), snapshot = useSnapshot(), active = useDestinationActive()
  const [entries, setEntries] = useState<readonly Entry[] | null>(null)
  const [library, setLibrary] = useState<Library | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [filter, setFilter] = useState<Filter>('all'), [search, setSearch] = useState('')
  const [flow, setFlow] = useState<LibraryFlow | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    store.transport.request('audit/query', { sinceDays: 90 }).then(answer => {
      if (!cancelled) { setEntries(answer.filter(entry => entry.kind === 'library/write').sort((a, b) => b.at - a.at)); setError(null) }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    store.transport.request('library/read', {}).then(answer => { if (!cancelled) setLibrary(answer) }).catch(() => {})
    return () => { cancelled = true }
  }, [store, active, revision])
  const rows = entries ?? []
  const counts = { all: rows.length, restore: rows.filter(canRestore).length, failed: rows.filter(entry => entry.status === 'failed').length }
  const query = search.trim().toLowerCase()
  const shown = rows.filter(entry => (filter === 'all' || (filter === 'restore' ? canRestore(entry) : entry.status === 'failed'))
    && (!query || `${entry.name ?? ''} ${entry.path ?? ''} ${shortPath(entry.path ?? '', library?.home)}`.toLowerCase().includes(query)))
  const today = dayOf(now), yesterdayDate = new Date(today)
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = yesterdayDate.getTime()
  const groups = [
    { label: 'Today', rows: shown.filter(entry => dayOf(entry.at) >= today), earlier: false },
    { label: 'Yesterday', rows: shown.filter(entry => dayOf(entry.at) === yesterday), earlier: false },
    { label: 'Earlier', rows: shown.filter(entry => dayOf(entry.at) < yesterday), earlier: true },
  ]
  const columns = snapshot.runtimes.map(runtime => ({ id: runtime.id, label: runtime.presentation.name, info: runtime }))
  return <>
    <DestinationBar place="Library" />
    <PageOptions title="Changes made here"><Toolbar><Button variant="ghost" size="sm" onClick={onBack}>Back to Library</Button></Toolbar></PageOptions>
    <PageExplanation>Every change made from the Library in the last 90 days. Restore shows what it would put back and what it would replace before it does either.</PageExplanation>
    <Toolbar data-slot="library-changes-controls">
      <ToggleGroup type="single" size="sm" variant="chips" aria-label="Changes" value={filter} onValueChange={value => { if (value) setFilter(value as Filter) }}>
        {([{ value: 'all', label: 'All' }, { value: 'restore', label: 'Can restore' }, { value: 'failed', label: 'Failed' }] as const).map(chip => <ToggleGroupItem key={chip.value} value={chip.value} aria-label={chip.label}>
          {chip.label}<Text role="meta" numeric {...(chip.value === 'failed' && filter !== 'failed' ? { tone: 'warning' as const } : {})}>{counts[chip.value]}</Text>
        </ToggleGroupItem>)}
      </ToggleGroup>
      <ToolbarGap /><Search label="Search changes" placeholder="Search changes" value={search} onChange={setSearch} />
    </Toolbar>
    {error ? <ActionError>{error}</ActionError> : entries === null ? <Text role="muted">Reading changes…</Text> : shown.length === 0
      ? rows.length === 0 ? <EmptyState title="Nothing has been changed from here." />
        : <EmptyState title="Nothing matches"><Button variant="ghost" onClick={() => { setFilter('all'); setSearch('') }}>Clear</Button></EmptyState>
      : groups.filter(group => group.rows.length > 0).map(group => <FormStack key={group.label}>
        <Text as="h2" role="section">{group.label} <Text role="meta" numeric>{group.rows.length}</Text></Text>
        <Rows role="list">{group.rows.map((entry, index) => {
          const runtime = snapshot.runtimes.find(runtime => runtime.id === entry.runtime)
          const op = entry.op ?? '', name = entry.name ?? '', path = entry.path ?? ''
          const Icon = entry.status === 'failed' ? AlertIcon : op.endsWith('/remove') ? TrashIcon : op.endsWith('/create') ? ImportIcon : RetryIcon
          return <Row key={`${entry.at}-${index}`} role="listitem" layout="record" kind="record" mark={<Icon size={16} />}
            title={<Text role="navigation" {...(entry.status === 'failed' ? { tone: 'warning' as const } : {})}>{entry.status === 'failed' ? `Failed to ${HISTORY_TRY[op] ?? op} ${name}${entry.detail ? ` — ${entry.detail}` : ''}` : `${HISTORY_VERB[op] ?? op} ${name}`}</Text>}
            desc={<Toolbar><Text role="meta" numeric>{new Date(entry.at).toLocaleString(undefined, { ...(group.earlier ? { dateStyle: 'medium' as const } : {}), timeStyle: 'short' })}</Text><Text role="meta">·</Text>
              <Toolbar>{runtime && <RuntimeMark runtime={runtime} size={13} />}<Text role="meta">{runtime?.presentation.name ?? 'Unavailable runtime'}</Text></Toolbar><Text role="meta">·</Text>
              <Text role="meta" title={path} truncate dir="rtl"><bdi dir="ltr"><CodeText as="code" size="inherit">{shortPath(path, library?.home)}</CodeText></bdi></Text></Toolbar>}
            control={canRestore(entry) ? <Button variant="outline" size="sm" onClick={() => setFlow({ type: 'plan', title: `Restore ${name}`, intents: [{ kind: 'restoreCopy', name, backupPath: entry.backupPath!, targetPath: path }] })}>Restore…</Button> : undefined} />
        })}</Rows>
      </FormStack>)}
    <LibraryFlows flow={flow} setFlow={setFlow} library={library} columns={columns} onApplied={() => setRevision(value => value + 1)} />
  </>
}
