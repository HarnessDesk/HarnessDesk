import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HistorySummary, HostMethods, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'
import { Button, Chip, ConfirmDialog, EmptyState, NativeSelect, Note, PageHead, Row, Rows, RowValue, Search, SectionHead, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Text } from '../design'
import { folderName } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeFace } from './RuntimeFace'
import styles from './History.module.css'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const scanTime = (at: number): string => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Imported metadata is queried separately from the desk's sidebar index. */
export const HistorySection = ({ focus = null, onOpenAgent, onOpen }: {
  focus?: string | null
  onOpenAgent: (id: string) => void
  onOpen: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [agent, setAgent] = useState(focus ?? '')
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState(false)
  const [rows, setRows] = useState<readonly HistorySummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [projects, setProjects] = useState<readonly string[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 440, pitch: 44, columns: 3 })
  const scroll = useRef<HTMLDivElement>(null)
  const epoch = useRef(0)
  const paging = useRef(false)
  const importable = useMemo(() => snapshot.runtimes.filter(info => info.capabilities.listHistory), [snapshot.runtimes])
  const params = useMemo<HostMethods['history/list']['params']>(() => ({ pageSize: 100, includeHidden: hidden,
    ...(agent ? { runtimes: [agent as RuntimeId] } : {}), ...(project ? { repoRoot: project } : {}), ...(query.trim() ? { query: query.trim() } : {}) }), [agent, project, query, hidden])
  useEffect(() => setAgent(focus ?? ''), [focus])

  useEffect(() => {
    let live = true
    const rescan = async () => {
      const results = await Promise.allSettled(importable.map(info => store.loadHistoryImport(info.id)))
      if (!live) return
      const imports = store.getSnapshot().historyImports
      await Promise.allSettled(importable.filter((info, i) => results[i]?.status === 'fulfilled' && imports[info.id] !== null && imports[info.id] !== undefined)
        .map(info => store.transport.request('history/import', { runtime: info.id })))
    }
    void rescan()
    const focus = () => { setRetry(was => was + 1); void rescan() }
    window.addEventListener('focus', focus)
    return () => { live = false; window.removeEventListener('focus', focus) }
  }, [store, importable])

  const read = useCallback(async (generation: number, after?: string) => {
    setLoading(true)
    setProblem(null)
    try {
      const page = await store.transport.request('history/list', { ...params, ...(after ? { cursor: after } : {}) })
      if (epoch.current !== generation) return
      setRows(previous => after ? [...new Map([...previous, ...page.data].map(row => [`${row.runtime}:${row.id}`, row])).values()] : page.data)
      setCursor(page.nextCursor ?? null)
      setProjects(previous => [...new Set([...previous, ...page.data.map(row => row.repo?.root ?? row.cwd)])].sort())
    } catch (error) { if (epoch.current === generation) setProblem(reason(error)) }
    finally { if (epoch.current === generation) { setLoading(false); paging.current = false } }
  }, [store, params])
  useEffect(() => {
    const generation = ++epoch.current
    paging.current = false
    setRows([]); setCursor(null)
    if (scroll.current) scroll.current.scrollTop = 0
    setViewport(was => ({ ...was, top: 0 }))
    void read(generation)
    return () => { epoch.current++ }
  }, [read, snapshot.historyRevision, retry])
  useEffect(() => {
    const node = scroll.current
    if (!node) return
    const measure = () => setViewport(was => ({ ...was, height: node.clientHeight || 440,
      pitch: parseFloat(getComputedStyle(node).getPropertyValue('--hd-table-row-min-bare')) || 44 }))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure); observer.observe(node)
    return () => observer.disconnect()
  }, [rows.length === 0])
  const projectOptions = [...new Set([...projects, ...snapshot.workspaces.map(workspace => workspace.repo?.root ?? workspace.path)])].sort()
  const anyImport = Object.values(snapshot.historyImports).some(state => state != null)
  const open = (row: HistorySummary) => { void store.openSession(row.id, { runtime: row.runtime, preview: true }); onOpen() }
  return <>
    <PageHead title="History" blurb="Conversations imported from your agents. Open one to preview it; send a message to add it to the sidebar." />
    <div className={styles.toolbar}>
      <NativeSelect aria-label="History agent" value={agent} onChange={event => setAgent(event.target.value)}>
        <option value="">All agents</option>{snapshot.runtimes.map(info => <option key={info.id} value={info.id}>{info.presentation.name}</option>)}
      </NativeSelect>
      <NativeSelect aria-label="History project" value={project} onChange={event => setProject(event.target.value)}>
        <option value="">All projects</option>{projectOptions.map(root => <option key={root} value={root}>{folderName(root)}</option>)}
      </NativeSelect>
      <Search className={styles.search} label="Search history titles" placeholder="Search titles" value={query} onChange={setQuery} />
      <label className={styles.hidden}><Text role="row">Show hidden</Text><Switch aria-label="Show hidden" checked={hidden} onCheckedChange={setHidden} /></label>
    </div>
    {problem && <Note tone="bad" action={<Button variant="outline" size="sm" onClick={() => setRetry(was => was + 1)}>Retry</Button>}>{problem}</Note>}
    {!loading && !problem && rows.length === 0 && <EmptyState variant="inline" align="start" title={!anyImport && !agent && !project && !query.trim() && !hidden ? 'Import history from an agent’s settings page.' : 'Nothing matches these filters.'}
      children={!anyImport ? <span className={styles.importActions}>{importable.map(info => <Button key={info.id} variant="outline" onClick={() => onOpenAgent(info.id)}>{info.presentation.name}</Button>)}</span> : undefined} />}
    {rows.length > 0 && <div className={styles.scroll} ref={scroll} data-history-scroll onScroll={event => {
      const node = event.currentTarget
      setViewport(was => ({ ...was, top: node.scrollTop, height: node.clientHeight || 440 }))
      if (cursor && !paging.current && !loading && node.scrollTop + node.clientHeight >= node.scrollHeight - 176) {
        paging.current = true; void read(epoch.current, cursor)
      }
    }}>
      <Table aria-rowcount={rows.length + 1} rows="bare" density="comfortable" inset="row">
        <TableHeader><TableRow><TableHead>Conversation</TableHead><TableHead>Project</TableHead><TableHead align="end">Last active</TableHead></TableRow></TableHeader>
        <TableBody window={viewport}>{rows.map((row, index) => {
          const info = snapshot.runtimes.find(info => info.id === row.runtime)
          const title = sessionLabel(row.title, row.preview)
          return <TableRow aria-rowindex={index + 2} key={`${row.runtime}:${row.id}`} interactive onClick={() => open(row)}>
            <TableCell lead={info && <RuntimeFace runtime={info} size="navigation" />}><span className={styles.title}>
              <Button variant="link" size="content" className={styles.name} title={title}>{title}</Button>
              {row.archived && <Chip tone="neutral">Archived</Chip>}{row.hidden && <Chip tone="neutral">Hidden</Chip>}
            </span></TableCell>
            <TableCell><Text role="meta" className={styles.project} title={row.repo?.root ?? row.cwd}>{folderName(row.repo?.root ?? row.cwd)}</Text></TableCell>
            <TableCell align="end"><Text role="meta" title={scanTime(row.updatedAt)}>{new Date(row.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text></TableCell>
          </TableRow>
        })}</TableBody>
      </Table>
    </div>}
    {loading && <Note>Reading history…</Note>}
  </>
}

export const AgentHistory = ({ info, onBrowse }: { info: RuntimeInfo; onBrowse: (id: string) => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const state = snapshot.historyImports[info.id]
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!info.capabilities.listHistory) return
    let live = true
    void store.loadHistoryImport(info.id).catch(error => { if (live) setProblem(reason(error)) })
    return () => { live = false }
  }, [store, info.id, info.capabilities.listHistory])
  if (!info.capabilities.listHistory) return null
  const run = async (method: 'history/import' | 'history/cancel' | 'history/removeImported') => {
    if (busy) return
    setBusy(true); setProblem(null)
    try { await store.transport.request(method, { runtime: info.id }); await store.loadHistoryImport(info.id); setRemoving(false) }
    catch (error) { setProblem(reason(error)) }
    finally { setBusy(false) }
  }
  const running = state?.state === 'running'
  const complete = state?.state === 'done'
  const failed = state?.state === 'failed'
  const label = running ? 'Importing history' : complete ? 'Imported history' : failed ? 'History import failed' : state?.state === 'cancelled' ? 'History import cancelled' : 'Import history'
  return <>
    <SectionHead name="History" />
    <Rows><Row title={<span title={state?.error}>{label}</span>} control={<>
      {state && <RowValue numeric>{state.count.toLocaleString()} conversations</RowValue>}
      {complete && <RowValue>{scanTime(state.lastScanAt)}</RowValue>}
      <Button variant="outline" size="sm" disabled={busy || state === undefined} onClick={() => void run(running ? 'history/cancel' : 'history/import')}>
        {running ? 'Cancel' : complete ? 'Rescan' : failed ? 'Retry' : state?.state === 'cancelled' ? 'Retry' : 'Import history'}
      </Button>
      {complete && <><Button variant="outline" size="sm" onClick={() => onBrowse(info.id)}>Browse</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(true)}>Remove imported</Button></>}
    </>} /></Rows>
    {problem && <Note tone="bad" action={<Button variant="outline" size="sm" onClick={() => { void store.loadHistoryImport(info.id).then(() => setProblem(null)).catch(error => setProblem(reason(error))) }}>Retry</Button>}>{problem}</Note>}
    {removing && <ConfirmDialog title="Remove imported history?" confirmLabel="Remove imported" tone="destructive" onCancel={() => setRemoving(false)} onConfirm={() => run('history/removeImported')}>
      {info.presentation.name}’s own files stay as they are. Conversations continued here stay in HarnessDesk.
    </ConfirmDialog>}
  </>
}
