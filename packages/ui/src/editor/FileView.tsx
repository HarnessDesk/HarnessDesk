import { Suspense, useContext, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { WORKSPACE_BINARY_LIMIT_BYTES, type RuntimeId, type WorkspaceReadFileResult } from '@harnessdesk/protocol'
import { Banner, BannerAction, Button, SelectionAction, Segmented, ToolPane, ToolPaneBody, ToolPaneGuest, ToolPaneMessage, ToolPaneStage } from '../design'
import { ExternalIcon } from '../components/Icons'
import { KeyboardHereContext, usePane, useSnapshot, useStore } from '../state/context'
import { useTheme } from '../state/theme'
import { sanitizeText } from '../lib/sanitize'
import { CodeView, MergeView, MarkdownView, countTextChanges, editorLook, readHead } from './index'
import styles from './FileView.module.css'
import { quoteSelection, previewSelection } from './quote'
import { askInChat, canAskInChat } from './ask'
import type { EditorSelection } from './CodeView'

export type FileViewMode = 'preview' | 'source' | 'changes'
export interface FileBase {
  readonly content: string
  readonly hash: string
  readonly truncated: boolean
}
/** Ephemeral renderer state. Preserve the base as well as the draft across unmounts. */
export interface FileDocumentState {
  readonly base: FileBase
  readonly content: string
  readonly pendingCreation: boolean
  /** An explicit disk-vs-draft comparison, retained when the view moves. */
  readonly comparison?: { readonly content: string; readonly hash: string; readonly missing?: boolean }
}
export interface FileTransfer {
  readonly path: string
  readonly runtime: RuntimeId
  readonly root: string | null
  readonly subject?: string
  readonly view: FileViewMode
  readonly document: FileDocumentState | null
}
export interface FileSaveHandle { readonly save: () => Promise<boolean> }
export interface FileViewProps {
  /** Explicit Save from a parent close question uses this surface's conflict handling. */
  readonly saveRef?: Ref<FileSaveHandle>

  readonly path: string
  readonly runtime: RuntimeId
  readonly root: string | null
  readonly subject?: string
  readonly view?: FileViewMode
  readonly onViewChange?: (view: FileViewMode) => void
  readonly onPopOut?: (file: FileTransfer) => void
  /** Initial state for path/runtime; root arrival refreshes only HEAD provenance. */
  readonly document?: FileDocumentState | null
  readonly onDocumentChange?: (document: FileDocumentState | null) => void
}

type Conflict = { kind: 'text'; content: string; hash: string; missing?: boolean } | { kind: 'binary' | 'tooLarge'; size: number }
type Problem = { kind: 'missing' } | { kind: 'unreadable'; message: string } | { kind: 'tooLarge'; size: number }
interface FileState {
  base: FileBase | null
  draft: string | null
  pending: boolean
  problem: Problem | null
  binary: { size: number; imageSrc: string | null } | null
  conflict: Conflict | null
  head: string | null | undefined
  comparing: boolean
  saving: boolean
}
const blank = (): FileState => ({ base: null, draft: null, pending: false, problem: null, binary: null, conflict: null, head: undefined, comparing: false, saving: false })
const dirty = (state: FileState) => state.pending || (state.draft !== null && state.draft !== state.base?.content)
const documentOf = (state: FileState): FileDocumentState | null => state.base && dirty(state)
  ? { base: state.base, content: state.draft ?? state.base.content, pendingCreation: state.pending, ...(state.comparing && state.conflict?.kind === 'text' ? { comparison: { content: state.conflict.content, hash: state.conflict.hash, ...(state.conflict.missing ? { missing: true } : {}) } } : {}) } : null
const IMAGE_TYPES: Readonly<Record<string, string>> = { avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const initialMode = (path: string): FileViewMode => /\.(md|markdown|html?|pdf)$/i.test(path) ? 'preview' : 'source'
const MAX_EDITABLE = 512 * 1024

const reconcileRead = (before: FileState, file: WorkspaceReadFileResult, mediaType?: string): FileState => {
  // A restored draft keeps its original hash; a fresh disk read cannot rebase it.
  if (dirty(before) && before.base) {
    if (file.kind === 'text') return { ...before, problem: null, binary: null, conflict: file.hash === before.base.hash ? null : { kind: 'text', content: file.content, hash: file.hash }, comparing: file.hash === before.base.hash ? false : before.comparing }
    if (file.kind === 'binary' || file.kind === 'tooLarge') return { ...before, problem: null, binary: null, conflict: { kind: file.kind, size: file.size }, comparing: false }
    if (file.kind === 'missing') return { ...before, problem: null, binary: null, conflict: before.pending ? null : { kind: 'text', content: '', hash: '', missing: true }, comparing: before.pending ? false : before.comparing }
    return { ...before, problem: file }
  }
  if (file.kind === 'text') return { ...before, base: file, draft: null, pending: false, problem: null, binary: null, conflict: null, comparing: false }
  if (file.kind === 'binary') return { ...before, base: null, binary: { size: file.size, imageSrc: mediaType && file.content !== undefined ? `data:${mediaType};base64,${file.content}` : null }, problem: null }
  return { ...before, base: null, binary: null, problem: file }
}

/** One document surface; callers own tabs, window mode and the lifetime of drafts. */
export const FileView = (props: FileViewProps) => {
  const { path, runtime, root, subject } = props
  const store = useStore(), snapshot = useSnapshot(), theme = useTheme(), pane = usePane()
  const selectionId = useId()
  const keyboardHere = useContext(KeyboardHereContext)
  const surface = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null)
  const selected = useRef(selection); selected.current = selection
  const ask = useRef<() => boolean>(() => false)
  const callbacks = useRef(props); callbacks.current = props
  const [state, setState] = useState<FileState>(blank)
  const current = useRef(state)
  const update = (change: (before: FileState) => FileState) => { current.current = change(current.current); setState(current.current) }
  const [chosen, setChosen] = useState<FileViewMode>(() => props.view ?? initialMode(path))
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const [frameGeneration, setFrameGeneration] = useState(0)
  const mode = props.view ?? chosen
  const changeView = (view: FileViewMode) => { setChosen(view); callbacks.current.onViewChange?.(view) }
  const epoch = useRef(0), loadId = useRef(0), pollId = useRef(0), modifiedAt = useRef<number | null>(null)
  const diskRead = useRef<WorkspaceReadFileResult | null>(null)
  const headRevision = useRef(0), headInFlight = useRef(false), headQueued = useRef(false)
  const refreshHead = useRef<() => void>(() => {})
  const markdown = /\.(md|markdown)$/i.test(path), html = /\.html?$/i.test(path), pdf = /\.pdf$/i.test(path)
  const native = mode === 'preview' && (html || pdf)
  const appearance = useMemo(() => editorLook(snapshot.editorPrefs), [snapshot.editorPrefs])

  // Every asynchronous reader is tied to a file identity and a save generation.
  // Edits made while reading are checked at completion, never captured as clean.
  const load = async (identity: number) => {
    const reading = ++loadId.current
    try {
      const mediaType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
      const [file, meta] = await Promise.all([
        store.transport.request('workspace/readFile', { path, runtime, maxBytes: WORKSPACE_BINARY_LIMIT_BYTES, ...(mediaType ? { encoding: 'base64' as const } : {}) }),
        store.transport.request('workspace/stat', { path, runtime }).catch(() => null),
      ])
      if (identity !== epoch.current || reading !== loadId.current) return
      modifiedAt.current = meta?.modifiedAt ?? null
      diskRead.current = file; ++headRevision.current
      update(before => reconcileRead(before, file, mediaType))
      refreshHead.current()
    } catch (error) {
      if (identity !== epoch.current || reading !== loadId.current) return
      update(before => ({ ...before, problem: { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) } }))
    }
  }
  // HEAD can move without changing this file's mtime. Reuse the latest disk
  // snapshot, fence provenance changes, and coalesce polling into one request.
  refreshHead.current = () => {
    const file = diskRead.current, provenance = callbacks.current
    if (!provenance.root || !file || current.current.saving || !((file.kind === 'text' && !file.truncated) || file.kind === 'missing')) return
    if (headInFlight.current) { headQueued.current = true; return }
    headInFlight.current = true; headQueued.current = false
    const identity = epoch.current, revision = headRevision.current
    const accepts = () => identity === epoch.current && revision === headRevision.current
    void readHead((method, params) => store.transport.request(method, params), { path: provenance.path, root: provenance.root, runtime: provenance.runtime, disk: file }).then(head => {
      if (accepts()) update(before => ({ ...before, head: head.status === 'outside-repository' ? undefined : head.content }))
    }).catch(() => { if (accepts()) update(before => ({ ...before, head: undefined })) }).finally(() => {
      headInFlight.current = false
      if (headQueued.current) { headQueued.current = false; refreshHead.current() }
    })
  }

  useEffect(() => {
    const identity = ++epoch.current
    diskRead.current = null; ++headRevision.current
    const saved = callbacks.current.document
    update(() => saved ? { ...blank(), base: saved.base, draft: saved.content, pending: saved.pendingCreation, conflict: saved.comparison ? { kind: 'text', ...saved.comparison } : null, comparing: !!saved.comparison } : blank())
    setChosen(callbacks.current.view ?? initialMode(path)); modifiedAt.current = null
    if (!pdf) void load(identity)
    store.reportEditor?.({ kind: 'opened', path, at: Date.now() })
    return () => { ++epoch.current; ++headRevision.current; diskRead.current = null; headQueued.current = false; store.reportEditor?.({ kind: 'closed', path, at: Date.now() }) }
  }, [path, runtime, store])

  // A conversation's root can arrive after the same physical file is opened.
  // It changes only comparison provenance, never its draft, save or ticket.
  useEffect(() => {
    ++headRevision.current
    update(before => ({ ...before, head: undefined }))
    refreshHead.current()
  }, [root])

  useEffect(() => { if (state === current.current) callbacks.current.onDocumentChange?.(documentOf(state)) }, [state.base, state.draft, state.pending, state.comparing, state.conflict])

  useEffect(() => {
    if (!native) return
    const identity = epoch.current
    let live = true
    setFrameSrc(null); setFrameError(null)
    void Promise.all([
      store.transport.request('preview/ticket', { path, runtime }),
      store.transport.request('workspace/stat', { path, runtime }).catch(() => null),
    ]).then(([issued, meta]) => {
      if (!live || identity !== epoch.current) return
      // Text reads own the HTML document's disk baseline. A later ticket stat
      // must not hide another writer from the editing surface's polling.
      if (pdf) modifiedAt.current = meta?.modifiedAt ?? null
      setFrameSrc(`/preview-frame?ticket=${issued.ticket}`)
    }).catch((error: unknown) => { if (live && identity === epoch.current) setFrameError(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [native, path, runtime, store, frameGeneration])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (current.current.saving) return
      const identity = epoch.current, polling = ++pollId.current
      void store.transport.request('workspace/stat', { path, runtime }).then(meta => {
        if (identity !== epoch.current || polling !== pollId.current || current.current.saving) return
        if (meta.modifiedAt === modifiedAt.current) { refreshHead.current(); return }
        if (pdf) { modifiedAt.current = meta.modifiedAt; setFrameGeneration(value => value + 1) }
        else { void load(identity); if (native) setFrameGeneration(value => value + 1) }
      }).catch(() => {
        // A deleted path makes stat reject. Read its tagged result rather than
        // mistaking that rejection for an unchanged document.
        if (identity !== epoch.current || polling !== pollId.current || current.current.saving) return
        if (!pdf) void load(identity)
        if (native) setFrameGeneration(value => value + 1)
      })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [path, runtime, store, native])

  const save = async (expectedHash = current.current.base?.hash): Promise<boolean> => {
    const before = current.current
    if (!before.base || before.base.truncated || before.base.content.length > MAX_EDITABLE || !dirty(before) || before.saving || expectedHash === undefined || before.conflict?.kind === 'binary' || before.conflict?.kind === 'tooLarge') return false
    let saved = false
    const content = before.draft ?? before.base.content
    const identity = ++epoch.current; ++loadId.current; ++pollId.current; ++headRevision.current
    update(one => ({ ...one, saving: true }))
    try {
      const result = await store.transport.request('file/save', { path, runtime, content, expectedHash })
      if (identity !== epoch.current) return false
      if (result.saved) {
        update(one => ({ ...one, base: { content, hash: result.hash, truncated: false }, draft: one.draft === content ? null : one.draft, pending: false, conflict: null, comparing: false }))
        // Keep polling suspended until the post-save baseline stat is installed.
        const meta = await store.transport.request('workspace/stat', { path, runtime }).catch(() => null)
        if (identity !== epoch.current) return false
        modifiedAt.current = meta?.modifiedAt ?? null
        store.reportEditor?.({ kind: 'saved', path, at: Date.now(), hash: result.hash })
        // Stat can already include a foreign write after our save. Verify bytes
        // after installing that baseline so this write cannot become invisible.
        const mediaType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
        const verified = await store.transport.request('workspace/readFile', { path, runtime, maxBytes: WORKSPACE_BINARY_LIMIT_BYTES, ...(mediaType ? { encoding: 'base64' as const } : {}) })
        if (identity !== epoch.current) return false
        diskRead.current = verified; ++headRevision.current
        update(one => reconcileRead(one, verified, mediaType))
        saved = !dirty(current.current)
      } else if ('reason' in result) update(one => ({ ...one, conflict: { kind: result.reason, size: result.size } }))
      else update(one => ({ ...one, conflict: { kind: 'text', ...result.conflict } }))
    } catch (error) { if (identity === epoch.current) store.notice?.('error', error instanceof Error ? error.message : String(error)) }
    finally { if (identity === epoch.current) { update(one => ({ ...one, saving: false })); refreshHead.current(); if (native) setFrameGeneration(value => value + 1) } }
    if (identity !== epoch.current) return false
    callbacks.current.onDocumentChange?.(documentOf(current.current))
    return saved
  }
  useImperativeHandle(props.saveRef, () => ({ save: () => save() }))

  const content = state.draft ?? state.base?.content ?? ''
  const changed = state.head !== undefined && (state.head === null || state.head !== content)
  const counts = changed ? countTextChanges(state.head ?? '', content) : null
  const actualMode = mode === 'changes' && !changed && !state.comparing ? 'source' : mode
  const editable = !!state.base && !state.base.truncated && state.base.content.length <= MAX_EDITABLE
  const canSave = editable && state.conflict?.kind !== 'binary' && state.conflict?.kind !== 'tooLarge'
  const quotePath = root && path.startsWith(`${root.replace(/\/$/, '')}/`) ? path.slice(root.replace(/\/$/, '').length + 1) : path
  const onSelection = (one: EditorSelection | null) => {
    const text = one ? quoteSelection(quotePath, one.source, one.from, one.to) : null
    setSelection(text && one?.rect ? { text, rect: one.rect } : null)
  }
  ask.current = () => {
    const one = selected.current
    if (!one || !pane?.paneId || !subject || !canAskInChat(store, pane.paneId, subject)) return false
    void askInChat(store, pane.paneId, subject, one.text)
    setSelection(null)
    return true
  }
  const editorProps = { onSelection, value: content, path, readOnly: !editable, dark: theme === 'dark', look: appearance, lineNumbers: snapshot.editorPrefs.lineNumbers, wrap: snapshot.editorPrefs.wrap, tabSize: snapshot.editorPrefs.tabSize, ariaLabel: path, className: styles.editor, decorations: snapshot.editorPlane.find(one => one.path === path)?.decorations ?? [], onChange: (value: string) => { update(one => ({ ...one, draft: value })); store.reportEditor?.({ kind: 'changed', path, at: Date.now() }) }, onSave: () => { void save() } }
  const conflict = state.conflict
  const reload = () => {
    if (conflict?.kind !== 'text') return
    update(one => ({ ...one, base: conflict.missing ? null : { content: conflict.content, hash: conflict.hash, truncated: false }, draft: null, pending: false, conflict: null, comparing: false, problem: conflict.missing ? { kind: 'missing' } : null }))
  }
  useEffect(() => { setSelection(null) }, [path, runtime, actualMode, subject, keyboardHere])
  useEffect(() => {
    const request = (event: Event) => {
      const focus = document.activeElement
      const host = surface.current
      // A retained selection in a hidden file or after typing elsewhere is stale.
      if (!host || host.closest('[inert], [data-hidden]') || (focus !== document.body && focus !== null && !host.contains(focus) && !document.getElementById(selectionId)?.contains(focus))) return
      const detail = (event as CustomEvent<{ handled: boolean }>).detail
      if (!detail.handled) detail.handled = ask.current()
    }
    window.addEventListener('harnessdesk:ask-in-chat', request)
    return () => window.removeEventListener('harnessdesk:ask-in-chat', request)
  }, [selectionId])
  useEffect(() => {
    const read = () => {
      const host = surface.current, one = document.getSelection()
      const start = one?.anchorNode, end = one?.focusNode
      if (!host || !one || one.isCollapsed || !start || !end || !host.contains(start) || !host.contains(end)) {
        // Source selections are owned by the editor engine, not native DOM selection.
        if (actualMode === 'preview' || (one && !one.isCollapsed)) setSelection(null)
        return
      }
      const deleted = (start instanceof Element ? start : start.parentElement)?.closest('.cm-deletedChunk')
      if (actualMode !== 'preview' && !deleted) return
      const source = deleted ? state.comparing && conflict?.kind === 'text' ? conflict.content : state.head ?? '' : content
      const text = previewSelection(quotePath, source, one.toString())
      const rect = one.getRangeAt(0).getBoundingClientRect()
      setSelection(text ? { text, rect } : null)
    }
    document.addEventListener('selectionchange', read)
    const host = surface.current
    host?.addEventListener('scroll', read, true)
    const unfocused = (event: FocusEvent) => { if (event.target instanceof Node && !host?.contains(event.target) && !document.getElementById(selectionId)?.contains(event.target)) setSelection(null) }
    document.addEventListener('focusin', unfocused)
    return () => { document.removeEventListener('selectionchange', read); host?.removeEventListener('scroll', read, true); document.removeEventListener('focusin', unfocused) }
  }, [actualMode, quotePath, content, state.comparing, state.head, conflict, selectionId])
  return <ToolPane variant="integrated" onKeyDown={event => {
    if (!event.defaultPrevented && !event.altKey && !event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (canSave) void save()
    }
  }}>
    <div className={styles.bar} data-slot="file-bar">
      <span className={styles.path} title={sanitizeText(path)}>{sanitizeText(path)}</span>
      {dirty(state) && <Button size="sm" disabled={!canSave || state.saving} onClick={() => void save()}>{state.saving ? 'Saving…' : 'Unsaved · Save ⌘S'}</Button>}
      {(state.base || native) && <Segmented<FileViewMode> label="File view" value={actualMode} onChange={view => { update(one => ({ ...one, comparing: false })); changeView(view) }} options={[
        ...((markdown || html || pdf) ? [{ value: 'preview' as const, label: 'Preview' }] : []),
        ...(!pdf ? [{ value: 'source' as const, label: 'Source' }] : []),
        ...(counts ? [{ value: 'changes' as const, label: `Changes +${counts.added} −${counts.removed}` }] : []),
      ]} />}
      {props.onPopOut && <Button variant="ghost" size="icon-sm" title="Pop out to Editor mode" aria-label="Pop out to Editor mode" onClick={() => props.onPopOut?.({ path, runtime, root, ...(subject ? { subject } : {}), view: state.head === undefined && mode === 'changes' ? mode : actualMode, document: documentOf(current.current) })}><ExternalIcon size={14} /></Button>}
    </div>
    {conflict && <Banner tone="warning" measure="container" title={conflict.kind === 'text' ? `${sanitizeText(path.split('/').pop() ?? path)} changed on disk while you had unsaved edits.` : conflict.kind === 'binary' ? 'This file is now binary. Your save was refused.' : 'This file is now too large to edit. Your save was refused.'} actions={conflict.kind === 'text' ? <>
      <BannerAction variant="secondary" disabled={state.saving} onClick={() => { update(one => ({ ...one, comparing: true })); changeView('changes') }}>Compare</BannerAction>
      <BannerAction variant="secondary" disabled={state.saving} onClick={reload}>Reload</BannerAction>
      <BannerAction disabled={state.saving} onClick={() => void save(conflict.hash)}>Keep mine</BannerAction>
    </> : undefined} />}
    <ToolPaneBody ref={surface} bleed className={styles.body} data-preview={actualMode === 'preview' ? '' : undefined}>
      {native ? frameError ? <ToolPaneMessage>{frameError}</ToolPaneMessage> : frameSrc === null ? <ToolPaneMessage>Loading…</ToolPaneMessage> : <ToolPaneStage><ToolPaneGuest title={path} src={frameSrc} {...(html ? { sandbox: 'allow-scripts allow-forms allow-popups' } : {})} /></ToolPaneStage>
        : state.problem ? state.problem.kind === 'missing' ? <ToolPaneMessage as="div"><p>{sanitizeText(path.split('/').pop() ?? path)} does not exist yet.</p><Button variant="outline" size="sm" onClick={() => { update(one => ({ ...one, base: { content: '', hash: '', truncated: false }, draft: '', pending: true, problem: null })); changeView('source') }}>Create this file</Button></ToolPaneMessage> : <ToolPaneMessage>{state.problem.kind === 'tooLarge' ? `File too large — ${(state.problem.size / (1024 * 1024)).toFixed(1)} MB` : state.problem.message}</ToolPaneMessage>
        : state.binary ? state.binary.imageSrc ? <div className={styles.imageStage}><img className={styles.image} src={state.binary.imageSrc} alt={sanitizeText(path.split('/').pop() ?? path)} onError={() => update(one => ({ ...one, binary: one.binary ? { ...one.binary, imageSrc: null } : null }))} /></div> : <ToolPaneMessage>Binary file — {(state.binary.size / 1024).toFixed(1)} KB</ToolPaneMessage>
        : !state.base ? <ToolPaneMessage>Loading…</ToolPaneMessage>
        : actualMode === 'preview' && markdown ? <div className={styles.document}><div className={styles.documentControls}><Button variant="ghost" size="sm" onClick={() => changeView('source')}>Edit</Button></div><MarkdownView text={content} /></div>
        : <Suspense fallback={<div className={styles.editor} />}>
          {state.comparing && conflict?.kind === 'text' ? <MergeView {...editorProps} original={conflict.content} /> : actualMode === 'changes' ? <MergeView {...editorProps} original={state.head ?? ''} /> : <CodeView {...editorProps} />}
        </Suspense>}
      {state.base?.truncated && <ToolPaneMessage>Showing the first part of a large file.</ToolPaneMessage>}
    </ToolPaneBody>
    {keyboardHere !== false && selection && pane?.paneId && subject && <SelectionAction id={selectionId} rect={selection.rect} onAsk={() => { ask.current() }} onDismiss={() => setSelection(null)} />}
  </ToolPane>
}
