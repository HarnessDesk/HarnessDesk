import { useCallback, useEffect, useRef, useState } from 'react'
import { splitSessionKey, type FileMatch, type GitStatus, type RuntimeId, type SessionKey } from '@harnessdesk/protocol'
import { Button, Dialog, LeftColumnBody, LeftColumnEmpty, LeftColumnExplorerFoot, LeftColumnExplorerHead, LeftColumnRow, NavigationList, Search } from '../design'
import { FileIcon, FolderIcon } from '../components/Icons'
import { useSnapshot, useStore } from '../state/context'
import { editorConversation, effectiveExplorerFilter } from './state'
import { explorerChanges, explorerPath, explorerRows, type ExplorerEntry } from './explorer-tree'

/** Session metadata owns both the folder and runtime; a selected workspace is never a substitute. */
export const Explorer = ({ session, onOpen }: { readonly session: SessionKey; readonly onOpen?: (path: string) => void }) => {
  const snapshot = useSnapshot()
  const conversation = snapshot.sessions.get(session)
  const root = conversation?.cwd ? explorerPath(conversation.cwd, conversation.cwd) : null
  const runtime = conversation?.runtime ?? splitSessionKey(session).runtime
  return root ? <ExplorerFolder key={`${session}:${runtime}:${root}`} subject={`session:${session}`} root={root} runtime={runtime} onOpen={onOpen} />
    : <LeftColumnBody><LeftColumnEmpty>This conversation's folder is not available yet.</LeftColumnEmpty></LeftColumnBody>
}
export const ExplorerFolder = ({ subject, root, runtime, onOpen }: { subject: string; root: string; runtime: RuntimeId; onOpen?: (path: string) => void }) => {
  const store = useStore(), snapshot = useSnapshot()
  const state = editorConversation(snapshot.editorState, subject)
  const [listings, setListings] = useState<ReadonlyMap<string, readonly ExplorerEntry[]>>(new Map())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const [git, setGit] = useState<GitStatus | null>(null)
  const [gitError, setGitError] = useState(false)
  const [finding, setFinding] = useState(false)
  const live = useRef(false), browsing = useRef(new Set<string>()), gitBusy = useRef(false)
  const expanded = useRef(state.expanded)
  expanded.current = state.expanded
  const browse = useCallback((path: string) => {
    if (browsing.current.has(path) || explorerPath(root, path) !== path) return
    browsing.current.add(path)
    void store.transport.request('workspace/browse', { mode: 'entries', root, path, runtime }).then(result => {
      if (!live.current) return
      const entries = result.entries.filter((entry): entry is ExplorerEntry => entry.kind === 'file' || entry.kind === 'directory')
      setListings(before => new Map(before).set(path, entries))
      setErrors(before => { const next = new Map(before); next.delete(path); return next })
    }).catch((error: unknown) => {
      if (live.current) setErrors(before => new Map(before).set(path, error instanceof Error ? error.message : 'Folder could not be read.'))
    }).finally(() => browsing.current.delete(path))
  }, [store, root, runtime])
  useEffect(() => {
    live.current = true
    const refresh = () => {
      browse(root)
      for (const path of expanded.current) browse(path)
      if (gitBusy.current) return
      gitBusy.current = true
      void store.transport.request('git/status', { root }).then(result => {
        if (live.current) { setGit(result); setGitError(false) }
      }).catch(() => { if (live.current) { setGit(null); setGitError(true) } }).finally(() => { gitBusy.current = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    window.addEventListener('focus', refresh)
    return () => { live.current = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [root, store, browse])
  useEffect(() => {
    for (const path of state.expanded) if (!listings.has(path) && !errors.has(path)) browse(path)
  }, [state.expanded, listings, errors, browse])
  useEffect(() => {
    // A pane tree has its own Find file action; the Editor sidebar owns the
    // window command so two retained trees cannot open two dialogs.
    if (onOpen) return
    const open = () => setFinding(true)
    window.addEventListener('harnessdesk:go-to-file', open)
    return () => window.removeEventListener('harnessdesk:go-to-file', open)
  }, [onOpen])
  const changes = explorerChanges(root, git)
  const filter = git ? effectiveExplorerFilter(state.filter, changes.size > 0) : 'all'
  const rows = explorerRows(root, listings, state.expanded, filter, changes)
  return <>
    <LeftColumnExplorerHead name={root.split('/').pop() || root} path={root} filter={filter} changes={git ? changes.size : null}
      onFilter={value => store.setEditorExplorerFilter(subject, value)} />
    <LeftColumnBody>
      {gitError && <LeftColumnEmpty>Changes could not be read.</LeftColumnEmpty>}
      {rows.map(row => <LeftColumnRow key={row.path} label={row.name} title={row.path}
        icon={row.kind === 'directory' ? <FolderIcon size={16} /> : <FileIcon size={16} />}
        tree={{ depth: row.depth, expanded: row.kind === 'directory' ? state.expanded.includes(row.path) : undefined, letter: row.letter }}
        selected={row.kind === 'file' && row.path === state.active}
        trailing={row.letter ? { kind: 'mark', icon: row.letter, label: `${row.name}: ${changes.get(row.path)?.status ?? 'added'}` } : undefined}
        onClick={() => row.kind === 'directory'
          ? store.setEditorExpandedFolders(subject, state.expanded.includes(row.path) ? state.expanded.filter(path => path !== row.path) : [...state.expanded, row.path])
          : onOpen ? onOpen(row.path) : store.openEditorFile(subject, row.path)}
        onDoubleClick={() => { if (row.kind === 'file') { if (onOpen) onOpen(row.path); else store.openEditorFile(subject, row.path, { keep: true }) } }} />)}
      {rows.length === 0 && !errors.has(root) && <LeftColumnEmpty>{!listings.has(root) && !errors.has(root) ? 'Loading files…' : filter === 'changed' ? 'No changed files.' : 'No files in this folder.'}</LeftColumnEmpty>}
      {[...errors].map(([path, message]) => <LeftColumnEmpty key={path}>{path.split('/').pop()}: {message}{' '}
        <Button variant="muted" size="sm" onClick={() => browse(path)}>Retry</Button></LeftColumnEmpty>)}
    </LeftColumnBody>
    <LeftColumnExplorerFoot onClick={() => setFinding(true)} />
    {finding && <GoToFile root={root} runtime={runtime} onClose={() => setFinding(false)} onChoose={path => {
      if (onOpen) onOpen(path); else store.openEditorFile(subject, path, { keep: true }); setFinding(false)
    }} />}
  </>
}
const GoToFile = ({ root, runtime, onClose, onChoose }: {
  root: string; runtime: RuntimeId; onClose: () => void; onChoose: (path: string) => void
}) => {
  const store = useStore()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; files: readonly FileMatch[]; error: boolean } | null>(null)
  const needle = query.trim()
  useEffect(() => {
    if (needle.length < 2) return
    let current = true
    const timer = window.setTimeout(() => {
      void store.transport.request('workspace/files', { root, runtime, query: needle, limit: 40 }).then(files => {
        if (current) setResult({ query: needle, files: files.filter(file => file.kind !== 'directory' && explorerPath(root, file.path) !== null), error: false })
      }).catch(() => { if (current) setResult({ query: needle, files: [], error: true }) })
    }, 80)
    return () => { current = false; window.clearTimeout(timer) }
  }, [needle, root, runtime, store])
  const visible = result?.query === needle ? result : null
  const chooseFirst = () => { const first = visible?.files[0]; if (first) { const path = explorerPath(root, first.path); if (path) onChoose(path) } }
  return <Dialog title="Go to file" size="md" onClose={onClose}>
    <Search autoFocus label="Find a file" placeholder="Find a file" value={query} onChange={setQuery}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); chooseFirst() } }} />
    <NavigationList>
      {visible?.files.map(file => <LeftColumnRow key={file.path} label={file.relativePath ?? file.path.slice(root.length + 1)}
        icon={<FileIcon size={16} />} title={file.path} onClick={() => { const path = explorerPath(root, file.path); if (path) onChoose(path) }} />)}
      <LeftColumnEmpty>{needle.length < 2 ? 'Type at least two characters.' : !visible ? 'Searching…' : visible.error ? 'Files could not be searched.' : visible.files.length === 0 ? 'No files match.' : ''}</LeftColumnEmpty>
    </NavigationList>
  </Dialog>
}
