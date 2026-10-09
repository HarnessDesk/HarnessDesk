import { useCallback, useEffect, useRef, useState } from 'react'
import { splitSessionKey, type SessionKey, type StorageCandidate, type StorageCleanupPreview, type StorageCleanupResult, type StorageConversation, type StorageKeptWorktree, type StorageUsage } from '@harnessdesk/protocol'
import { Alert, AlertContent, AlertTitle, Button, Chip, ConfirmDialog, Dialog, MiddleTruncate, NativeSelect, Note, NoteList, PageHead, Row, Rows, RowValue, SectionHead, Switch } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { panes } from '../state/layout'
import { mountedViews } from '../state/workbench'
import { sessionLabel } from '../lib/sessions'
import { DiscardWorktree } from './DiscardWorktree'

const bytes = (value: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let step = 0
  while (value >= 1024 && step < units.length - 1) { value /= 1024; step++ }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${units[step]}`
}
const countOf = (count: number): string => `${count} ${count === 1 ? 'worktree' : 'worktrees'}`
const inventoryTitle = (row: StorageKeptWorktree): string => row.reason ?? (row.changes
  ? `${row.changes.modified} modified, ${row.changes.untracked} untracked, ${row.changes.ignoredCount} ignored entries` : 'Review the worktree before discarding it.')

export const StorageSection = () => {
  const store = useStore(), snapshot = useSnapshot()
  const usageRevision = useRef(0)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [kept, setKept] = useState<readonly StorageKeptWorktree[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [age, setAge] = useState<30 | 60 | 90>(30)
  const [preview, setPreview] = useState<StorageCleanupPreview | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [includeDirty, setIncludeDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<StorageCleanupResult | null>(null)
  const [clearing, setClearing] = useState(false)
  const [discarding, setDiscarding] = useState<StorageKeptWorktree | null>(null)
  const read = useCallback(async () => {
    const revision = usageRevision.current
    const [usage, kept] = await Promise.all([store.transport.request('storage/usage', {}), store.transport.request('storage/kept', {})])
    if (revision === usageRevision.current) setUsage(usage)
    setKept(kept)
  }, [store])
  useEffect(() => {
    let live = true, observed = false
    const off = store.subscribeStorageUsage(usage => { observed = true; usageRevision.current++; if (live) setUsage(usage) })
    void Promise.all([store.transport.request('storage/usage', {}), store.transport.request('storage/kept', {})])
      .then(([usage, kept]) => { if (live) { if (!observed) setUsage(usage); setKept(kept) } })
      .catch(error => { if (live) setProblem(String(error)) })
    return () => { live = false; off() }
  }, [store, snapshot.status])

  // Re-read the current layout at confirmation, since a conversation can open while reviewing.
  const exclude = (): StorageConversation[] => {
    const current = store.getSnapshot()
    const views = [...panes(current.layout.root).map(pane => pane.view), ...mountedViews(current.workbench).map(entry => entry.mounted.view)]
    const keys = new Set([...views.flatMap(view => view.kind === 'conversation' ? view.session ? [view.session] : []
      : view.kind === 'room' ? [...view.watching ?? [], ...view.sideBySide?.tiles ?? [], ...view.sideBySide?.pinned ?? []] : []), ...current.listPrefs.pinnedSessions])
    return [...keys].map(key => { const { runtime, id } = splitSessionKey(key as SessionKey); return { runtime, sessionId: id } })
  }
  const review = async () => {
    setBusy(true); setProblem(null); setResult(null); setPreview(null); setIncludeDirty(false); setReviewing(true)
    try { setPreview(await store.transport.request('storage/cleanupPreview', { olderThanDays: age, exclude: exclude() })) }
    catch (error) { setProblem(String(error)) }
    finally { setBusy(false) }
  }
  const cleanup = async () => {
    if (!preview || busy) return
    setBusy(true); setProblem(null)
    try {
      const result = await store.transport.request('storage/cleanup', { olderThanDays: age, exclude: exclude(), includeDirty, inventoryToken: preview.inventoryToken })
      setResult(result); setPreview(null)
      store.notice('info', `Removed ${countOf(result.removed)} · freed ${bytes(result.freedBytes)}${result.refused.length ? ` · ${result.refused.length} refused` : ''}`)
      await read()
      if (!result.refused.length) setReviewing(false)
    } catch (error) { setProblem(String(error)); setPreview(null) }
    finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true)
    try { const result = await store.transport.request('history/clearCached', {}); setClearing(false); store.notice('info', `Cleared ${result.count} cached previews`); await read() }
    catch (error) { setProblem(String(error)) }
    finally { setBusy(false) }
  }
  const value = (reading: { bytes: number; computing: boolean; count?: number; error?: string } | undefined) =>
    <RowValue><span title={reading?.error}>{!reading || reading.computing ? 'Measuring…' : reading.error ? 'Unavailable' : `${reading.count === undefined ? '' : `${reading.count} · `}${bytes(reading.bytes)}`}</span></RowValue>
  const candidates = preview?.candidates ?? [], clean = candidates.filter(row => row.clean), dirty = candidates.filter(row => !row.clean)
  const selected = candidates.filter(row => row.clean || includeDirty)
  const candidate = (row: StorageCandidate, inventory = false) => <div key={row.path}>
    <Row title={<span title={row.path}>{sessionLabel(row.title, null)}</span>} control={<>
      <RowValue>{snapshot.runtimes.find(info => info.id === row.runtime)?.presentation.name ?? 'Unavailable agent'}</RowValue>
      <RowValue>{bytes(row.bytes)}</RowValue>
    </>} />
    {inventory && <Alert tone="warning"><AlertContent><AlertTitle>
      {row.changes.modified} modified · {row.changes.untracked} untracked · {row.changes.ignoredCount} ignored
      </AlertTitle><NoteList>
        {row.changes.files.map(file => <li key={file}>{file}</li>)}
        {row.changes.ignored.map(file => <li key={file}><span>{file}</span> <Chip size="sm" tone="warning">Ignored</Chip></li>)}
        {row.changes.ignoredCount > row.changes.ignored.length && <li>and {row.changes.ignoredCount - row.changes.ignored.length} more ignored entries</li>}
      </NoteList></AlertContent></Alert>}
  </div>
  return <>
    <PageHead title="Storage" />
    {problem && !reviewing && <Note tone="bad">{problem}</Note>}
    <Rows>
      <Row title="Conversation database" control={value(usage?.database)} />
      <Row title="Snapshots" control={value(usage?.snapshots)} />
      <Row title="Cached previews" control={<>{value(usage ? { ...usage.cachedPreviews, computing: false } : undefined)}<Button variant="outline" size="sm" disabled={!usage || !usage.cachedPreviews.count || busy} onClick={() => setClearing(true)}>Clear</Button></>} />
      <Row title="Worktrees" titleChip={usage?.worktrees.kept ? <Chip size="sm" tone="warning">{usage.worktrees.kept} kept</Chip> : undefined} control={value(usage?.worktrees)} />
    </Rows>
    {!!kept.length && <>
      <SectionHead name="Kept worktrees" />
      <Rows>{kept.map(row => <Row key={row.path} title={<span title={inventoryTitle(row)}>{sessionLabel(row.title, null)}</span>} control={<>
        <RowValue><span title={row.path}><MiddleTruncate>{row.path}</MiddleTruncate></span></RowValue>
        <Button variant="outline" size="sm" title={row.reason ?? 'Review the inventory before discarding this worktree'} onClick={() => setDiscarding(row)}>Discard worktree…</Button>
      </>} />)}</Rows>
    </>}
    <SectionHead name="Clean up inactive conversations" />
    <Rows><Row title="Inactive for" control={<>
      <NativeSelect aria-label="Inactive for" value={age} disabled={busy || reviewing} onChange={event => setAge(Number(event.target.value) as 30 | 60 | 90)}>
        {[30, 60, 90].map(days => <option key={days} value={days}>{days} days</option>)}
      </NativeSelect>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void review()}>Review…</Button>
    </>} /></Rows>
    {reviewing && <Dialog title="Clean up inactive conversations" size="lg" onClose={() => { if (!busy) { setReviewing(false); setProblem(null) } }}
      description={includeDirty ? 'Unsaved and ignored content goes with the folders. Conversations and branches stay. There is no undo.' : 'Conversations and branches stay. Reopening a conversation recreates its worktree.'}
      footer={<>
        {result || !preview ? <Button variant="default" disabled={busy} onClick={() => void review()}>Review again</Button> : <Button variant={includeDirty ? 'danger' : 'default'} disabled={busy || !selected.length} onClick={() => void cleanup()}>{busy ? 'Removing…' : `Remove ${countOf(selected.length)}`}</Button>}
        <Button variant="outline" disabled={busy} onClick={() => { setReviewing(false); setProblem(null) }}>Close</Button>
      </>}>
      {problem && <Note tone="bad">{problem}</Note>}
      {busy && !preview && !result && <RowValue>Reviewing worktrees…</RowValue>}
      {preview && <>
        <SectionHead name="Clean worktrees" action={<RowValue>{bytes(preview.cleanBytes)}</RowValue>} />
        <Rows>{clean.map(row => candidate(row))}{!clean.length && <Row title="No clean worktrees to remove" />}</Rows>
        {!!dirty.length && <>
          <SectionHead name="Worktrees with unsaved or ignored content" />
          <Rows>
            <Row title="Also discard unsaved and ignored content" control={<Switch aria-label="Also discard unsaved and ignored content" checked={includeDirty} disabled={busy} onCheckedChange={setIncludeDirty} />} />
            {dirty.map(row => candidate(row, includeDirty))}
          </Rows>
        </>}
        <Row title="Space freed" control={<RowValue>{bytes(selected.reduce((sum, row) => sum + row.bytes, 0))}</RowValue>} />
      </>}
      {result && <><SectionHead name="Worktrees kept" /><div className="grid gap-2">{result.refused.map(row => <Note key={row.path} tone="bad"><span title={row.path}><MiddleTruncate>{row.path}</MiddleTruncate></span>: {row.reason}</Note>)}</div></>}
    </Dialog>}
    {clearing && <ConfirmDialog title="Clear cached previews?" confirmLabel="Clear cached previews" busy={busy} onCancel={() => { if (!busy) setClearing(false) }} onConfirm={() => void clear()}>
      Previews are read again from the agent next time. Conversations opened here and full conversation bodies stay.
      {problem && <Note tone="bad">{problem}</Note>}
    </ConfirmDialog>}
    {discarding && <DiscardWorktree summary={{ runtime: discarding.runtime, id: discarding.sessionId, worktree: { path: discarding.path, branch: null, state: 'kept' } }} onClose={() => {
      setDiscarding(null); void store.transport.request('storage/usage', {}).then(() => read()).catch(error => setProblem(String(error)))
    }} />}
  </>
}
