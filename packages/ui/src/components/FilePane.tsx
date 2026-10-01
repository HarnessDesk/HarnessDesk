import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { editorLook } from '../lib/editor-prefs'
import { useSnapshot, useStore } from '../state/context'
import { useMount } from '../panels/mount'
import { useTheme } from '../state/theme'
import {
  Button,
  ToolPane,
  ToolPaneBody,
  ToolPaneMessage,
  ToolPaneNotice,
} from '../design'
import { AlertIcon } from './Icons'
import { ToolPaneHeader } from './ToolPaneHeader'
import styles from './ToolPanes.module.css'

/**
 * CodeMirror is loaded when a file is first opened, not at startup.
 *
 * The pane is statically imported by `Panes`, so a plain import would put the
 * editor's core — state, view, commands, language, search — into the chunk
 * that paints the window, for a window that usually opens on a conversation
 * and may never show a file at all. Grammars are already lazy one level down
 * in `lib/editor.ts`; this is the same discipline applied to the editor
 * itself.
 */
const CodeEditor = lazy(async () => ({ default: (await import('./CodeEditor')).CodeEditor }))

/**
 * A file, viewed and edited.
 *
 * Reading goes through the runtime's own filesystem view where it has one,
 * so the person sees what the agent sees. Saving is where care is needed:
 * an agent in another pane may have written the same file since it was
 * loaded, and a plain overwrite would erase that silently. So every save
 * carries the hash of what was loaded, the host refuses a save whose hash is
 * stale and returns the other content, and the pane shows both sides rather
 * than picking one. While the pane is open, the file's modification time is
 * polled so a change on disk is noticed before the next keystroke, not after
 * the next save.
 *
 * Reading and editing are one CodeMirror view, not a highlighted block that
 * swaps for a textarea. The swap was the visible bug: syntax colour vanished
 * the instant you pressed Edit, which read as the app losing its place. One
 * view also means the cursor, scroll position and undo history survive
 * entering and leaving edit mode, and that a file reloaded from disk lands
 * without throwing the reader back to line one.
 */

const POLL_MS = 3000
const MAX_EDITABLE = 512 * 1024

interface Loaded {
  readonly content: string
  readonly hash: string
  readonly truncated: boolean
}

type FileConflict =
  | { readonly kind: 'text'; readonly content: string; readonly hash: string }
  | { readonly kind: 'binary'; readonly size: number }
  | { readonly kind: 'tooLarge'; readonly size: number }

export const FileConflictNotice = ({
  conflict,
  onTakeTheirs,
  onOverwrite,
}: {
  readonly conflict: FileConflict
  readonly onTakeTheirs: () => void
  readonly onOverwrite: () => void
}) => (
  <ToolPaneNotice tone="danger" placement="top">
    <AlertIcon size={13} />
    <span className="flex-1">
      {conflict.kind === 'binary'
        ? 'This file is now binary. Your save was refused.'
        : conflict.kind === 'tooLarge'
          ? 'This file is now too large to edit. Your save was refused.'
          : 'This file changed on disk since you loaded it — your save was refused so nothing was lost.'}
    </span>
    {conflict.kind === 'text' && (
      <>
        <Button variant="outline" size="sm" onClick={onTakeTheirs}>Take theirs</Button>
        <Button variant="outline" size="sm" onClick={onOverwrite}>Overwrite with mine</Button>
      </>
    )}
  </ToolPaneNotice>
)

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
}
const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024

export const FilePane = () => {
  const store = useStore()
  const mount = useMount()
  const theme = useTheme()
  const view = mount?.view.kind === 'file' ? mount.view : null
  const path = view?.path ?? null
  const runtime = view?.runtime ?? null

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [readProblem, setReadProblem] = useState<
    { kind: 'missing' }
    | { kind: 'unreadable'; message: string }
    | { kind: 'tooLarge'; size: number }
    | null
  >(null)
  const [binary, setBinary] = useState<{ size: number; imageSrc: string | null } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [conflict, setConflict] = useState<FileConflict | null>(null)
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  const [saving, setSaving] = useState(false)
  const modifiedAt = useRef<number | null>(null)
  const { editorPrefs, editorPlane } = useSnapshot()
  const appearance = useMemo(() => editorLook(editorPrefs), [editorPrefs])

  /**
   * What plugins have marked on *this* file.
   *
   * Read off the plane rather than pushed at the pane, because the plane is
   * host state and this pane may have been opened by the person rather than
   * by whoever did the marking — both routes have to arrive at the same file
   * showing the same marks.
   */
  const decorations = useMemo(
    () => editorPlane.find((document) => document.path === path)?.decorations ?? [],
    [editorPlane, path],
  )

  const load = useCallback(async (): Promise<void> => {
    if (!path || !runtime) return
    try {
      const [file, meta] = await Promise.all([
        store.transport.request('workspace/readFile', { path, runtime }),
        store.transport.request('workspace/stat', { path, runtime }).catch(() => null),
      ])
      modifiedAt.current = meta?.modifiedAt ?? null
      if (file.kind === 'missing') {
        setLoaded(null)
        setBinary(null)
        setReadProblem({ kind: 'missing' })
      } else if (file.kind === 'unreadable') {
        setLoaded(null)
        setBinary(null)
        setReadProblem(file)
      } else if (file.kind === 'tooLarge') {
        setLoaded(null)
        setBinary(null)
        setReadProblem(file)
      } else if (file.kind === 'binary') {
        setLoaded(null)
        setReadProblem(null)
        const extension = path.split('.').pop()?.toLowerCase() ?? ''
        const mediaType = IMAGE_TYPES[extension]
        let imageSrc: string | null = null
        let oversized: { kind: 'tooLarge'; size: number } | null = null
        if (mediaType && file.size <= MAX_PREVIEW_IMAGE_BYTES) {
          try {
            const encoded = await store.transport.request('workspace/readFile', { path, runtime, encoding: 'base64' })
            if (encoded.kind === 'binary' && encoded.content !== undefined) imageSrc = `data:${mediaType};base64,${encoded.content}`
            else if (encoded.kind === 'tooLarge') oversized = encoded
          } catch { /* Keep the binary summary if a preview read is refused. */ }
        }
        if (oversized) {
          setBinary(null)
          setReadProblem(oversized)
        } else {
          setBinary({ size: file.size, imageSrc })
        }
      } else {
        setLoaded(file)
        setBinary(null)
        setReadProblem(null)
      }
      setChangedOnDisk(false)
    } catch (thrown) {
      setLoaded(null)
      setBinary(null)
      setReadProblem({ kind: 'unreadable', message: thrown instanceof Error ? thrown.message : String(thrown) })
    }
  }, [path, runtime, store])

  useEffect(() => {
    setLoaded(null)
    setBinary(null)
    setReadProblem(null)
    setDraft(null)
    setConflict(null)
    void load()
  }, [load])

  // Opened and closed, for whoever is draining. Its own effect, keyed on the
  // path alone: `load` changes identity when the runtime does, and a reload
  // is not a second opening.
  useEffect(() => {
    if (!path) return
    store.reportEditor({ kind: 'opened', path, at: Date.now() })
    return () => store.reportEditor({ kind: 'closed', path, at: Date.now() })
  }, [path, store])

  // Notice a change on disk while the pane is open. A clean pane reloads by
  // itself; one with edits keeps them and says so.
  useEffect(() => {
    if (!path || !runtime) return
    const timer = window.setInterval(() => {
      void store.transport
        .request('workspace/stat', { path, runtime })
        .then((meta) => {
          if (meta.modifiedAt === null || meta.modifiedAt === modifiedAt.current) return
          if (draft === null) void load()
          else setChangedOnDisk(true)
        })
        .catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [draft, load, path, runtime, store])

  const save = useCallback(
    async (expectedHash: string): Promise<void> => {
      if (!path || !runtime || draft === null) return
      setSaving(true)
      try {
        const result = await store.transport.request('file/save', {
          path,
          runtime,
          content: draft,
          expectedHash,
        })
        if (result.saved) {
          setLoaded({ content: draft, hash: result.hash, truncated: false })
          setDraft(null)
          setConflict(null)
          setChangedOnDisk(false)
          const meta = await store.transport.request('workspace/stat', { path, runtime }).catch(() => null)
          modifiedAt.current = meta?.modifiedAt ?? null
          // The hash rides along so a formatter can tell its own write from
          // the person's without reading the file back.
          store.reportEditor({ kind: 'saved', path, at: Date.now(), hash: result.hash })
          store.notice('info', `Saved ${path.split('/').pop()}.`)
        } else if ('reason' in result) {
          setConflict({ kind: result.reason, size: result.size })
        } else {
          setConflict({ kind: 'text', ...result.conflict })
        }
      } catch (thrown) {
        store.notice('error', thrown instanceof Error ? thrown.message : String(thrown))
      } finally {
        setSaving(false)
      }
    },
    [draft, path, runtime, store],
  )

  if (!mount || !view || !path) return null
  const dirty = draft !== null && draft !== loaded?.content
  const editable = loaded !== null && !loaded.truncated && loaded.content.length <= MAX_EDITABLE

  return (
    <ToolPane variant="integrated">
      <ToolPaneHeader title={path.split('/').pop() ?? path} subtitle={path}>
        {loaded && draft === null && editable && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(loaded.content)}>
            Edit
          </Button>
        )}
        {draft !== null && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (conflict?.kind === 'binary') {
                  setDraft(null)
                  setLoaded(null)
                  setBinary({ size: conflict.size, imageSrc: null })
                  setConflict(null)
                  return
                }
                if (conflict?.kind === 'tooLarge') {
                  setDraft(null)
                  setLoaded(null)
                  setReadProblem({ kind: 'tooLarge', size: conflict.size })
                  setConflict(null)
                  return
                }
                setDraft(null)
                setConflict(null)
                if (changedOnDisk) void load()
              }}
            >
              {dirty ? 'Discard' : 'Done'}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saving || !loaded || conflict?.kind === 'binary' || conflict?.kind === 'tooLarge'}
              onClick={() => loaded && void save(loaded.hash)}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      </ToolPaneHeader>

      {conflict && (
        <FileConflictNotice
          conflict={conflict}
          onTakeTheirs={() => {
            if (conflict.kind !== 'text') return
            setLoaded({ content: conflict.content, hash: conflict.hash, truncated: false })
            setDraft(null)
            setConflict(null)
          }}
          onOverwrite={() => {
            if (conflict.kind === 'text') void save(conflict.hash)
          }}
        />
      )}
      {changedOnDisk && !conflict && (
        <ToolPaneNotice tone="warning" placement="top">
          <AlertIcon size={13} />
          <span className="flex-1">Changed on disk while you were editing.</span>
          <Button variant="outline" size="sm" onClick={() => void load().then(() => setDraft(null))}>
            Reload
          </Button>
        </ToolPaneNotice>
      )}

      <ToolPaneBody bleed className={styles.body}>
        {readProblem ? (
          readProblem.kind === 'missing' ? (
            <ToolPaneMessage as="div">
              <p style={{ margin: '0 0 10px' }}>{path.split('/').pop()} does not exist yet.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // An empty file with an empty hash: the host treats a save
                  // of a file it cannot read as a creation, so the ordinary
                  // save path is also the create path.
                  setLoaded({ content: '', hash: '', truncated: false })
                  setDraft('')
                  setReadProblem(null)
                }}
              >
                Create this file
              </Button>
            </ToolPaneMessage>
          ) : readProblem.kind === 'tooLarge' ? (
            <ToolPaneMessage>File too large — {(readProblem.size / (1024 * 1024)).toFixed(1)} MB</ToolPaneMessage>
          ) : (
            <ToolPaneMessage>{readProblem.message}</ToolPaneMessage>
          )
        ) : binary ? (
          binary.imageSrc ? (
            <div className={styles.imagePreviewStage}>
              <img
                className={styles.imagePreview}
                src={binary.imageSrc}
                alt={path.split('/').pop() ?? path}
                onError={() => setBinary((current) => current ? { ...current, imageSrc: null } : current)}
              />
            </div>
          ) : (
            <ToolPaneMessage>Binary file — {(binary.size / 1024).toFixed(1)} KB</ToolPaneMessage>
          )
        ) : !loaded ? (
          <ToolPaneMessage>Loading…</ToolPaneMessage>
        ) : (
          // The fallback is deliberately empty: the chunk arrives in a frame
          // or two off local disk, and a spinner that flashes for one frame
          // reads as a fault where nothing was wrong.
          <Suspense fallback={<div className={styles.cmEditor} />}>
            <CodeEditor
              className={styles.cmEditor}
              value={draft ?? loaded.content}
              path={path}
              readOnly={draft === null}
              dark={theme === 'dark'}
              look={appearance}
              lineNumbers={editorPrefs.lineNumbers}
              wrap={editorPrefs.wrap}
              tabSize={editorPrefs.tabSize}
              ariaLabel={path}
              decorations={decorations}
              onChange={(value) => {
                setDraft(value)
                // Typing, not saving. A linter wants this; a formatter wants
                // the `saved` below — collapsing them would make one wrong.
                store.reportEditor({ kind: 'changed', path, at: Date.now() })
              }}
              onSave={() => {
                // Cmd+S in a pane that is only reading is not an error worth
                // reporting; it is a habit, and doing nothing is the answer.
                if (dirty && loaded) void save(loaded.hash)
              }}
            />
          </Suspense>
        )}
        {loaded?.truncated && <ToolPaneMessage>Showing the first part of a large file.</ToolPaneMessage>}
      </ToolPaneBody>
    </ToolPane>
  )
}
