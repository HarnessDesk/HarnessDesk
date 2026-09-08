import { useEffect, useRef, useState } from 'react'

import { useStore } from '../state/context'
import { useMount } from '../panels/mount'
import { Markdown } from './Markdown'
import { ToolPaneHeader } from './ToolPaneHeader'
import styles from './ToolPanes.module.css'

/**
 * Rendered previews: HTML, PDF and Markdown.
 *
 * HTML renders in an iframe with `sandbox` set and `allow-same-origin`
 * deliberately absent, so the document gets an opaque origin: it can run its
 * own scripts but cannot reach this page, the host's socket, or the launch
 * token in the URL. The renderer itself has no Node access — that boundary
 * is the desktop shell's — and the iframe is a second one inside it. PDFs go
 * through the browser's own viewer from a `data:` URL, which is an opaque
 * origin by construction; Markdown through the same sanitising renderer the
 * transcript uses.
 */

type Kind = 'html' | 'pdf' | 'markdown' | 'unsupported'

const kindOf = (path: string): Kind => {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  return 'unsupported'
}

/** How often the previewed file's mtime is checked while the pane is open. */
const POLL_MS = 2000

export const PreviewPane = () => {
  const store = useStore()
  const mount = useMount()
  const view = mount?.view.kind === 'preview' ? mount.view : null
  const path = view?.path ?? null
  const runtime = view?.runtime ?? null
  const kind = path ? kindOf(path) : 'unsupported'
  const [content, setContent] = useState<string | null>(null)
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped to force a re-read; the file on disk is the only truth here.
  const [generation, setGeneration] = useState(0)
  const modifiedAt = useRef<number | null>(null)

  useEffect(() => {
    setError(null)
    if (!path || !runtime || kind === 'unsupported') return
    let cancelled = false
    if (kind === 'html' || kind === 'pdf') {
      // Framed kinds render from /preview-frame rather than inline content:
      // a srcdoc document inherits this app's CSP, which forbids the inline
      // scripts a previewed page is made of. The ticket is single-use and
      // never the launch token — the previewed page can read its own URL.
      void Promise.all([
        store.transport.request('preview/ticket', { path, runtime }),
        store.transport.request('workspace/stat', { path, runtime }).catch(() => null),
      ])
        .then(([issued, meta]) => {
          if (cancelled) return
          modifiedAt.current = meta?.modifiedAt ?? null
          setFrameSrc(`/preview-frame?ticket=${issued.ticket}`)
        })
        .catch((thrown: unknown) => {
          if (!cancelled) setError(thrown instanceof Error ? thrown.message : String(thrown))
        })
    } else {
      void Promise.all([
        store.transport.request('workspace/readFile', {
          path,
          runtime,
          maxBytes: 8 * 1024 * 1024,
        }),
        store.transport.request('workspace/stat', { path, runtime }).catch(() => null),
      ])
        .then(([file, meta]) => {
          if (cancelled) return
          modifiedAt.current = meta?.modifiedAt ?? null
          setContent(file.content)
        })
        .catch((thrown: unknown) => {
          if (!cancelled) setError(thrown instanceof Error ? thrown.message : String(thrown))
        })
    }
    return () => {
      cancelled = true
    }
  }, [kind, path, runtime, store, generation])

  // A preview is a view of the file, not of the moment it was opened: while
  // an agent (or an editor pane) rewrites the file, the pane follows. The
  // preview holds no user state worth protecting, so reloading is always safe.
  useEffect(() => {
    if (!path || !runtime || kind === 'unsupported') return
    const timer = window.setInterval(() => {
      void store.transport
        .request('workspace/stat', { path, runtime })
        .then((meta) => {
          if (meta.modifiedAt !== null && meta.modifiedAt !== modifiedAt.current) {
            setGeneration((tick) => tick + 1)
          }
        })
        .catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [kind, path, runtime, store])

  if (!mount || !view || !path) return null

  return (
    <div className={styles.pane}>
      <ToolPaneHeader title={`Preview · ${path.split('/').pop() ?? path}`} subtitle={path}>
        <button
          type="button"
          className={styles.headerButton}
          onClick={() => setGeneration((tick) => tick + 1)}
          title="Reload the preview from disk"
        >
          Reload
        </button>
        <button type="button" className={styles.headerButton} onClick={() => store.openFile(path, { split: null })}>
          Source
        </button>
      </ToolPaneHeader>
      <div className={styles.body} data-preview="">
        {error ? (
          <p className={styles.message}>{error}</p>
        ) : kind === 'unsupported' ? (
          <p className={styles.message}>Only HTML, PDF and Markdown files have a preview.</p>
        ) : kind === 'html' ? (
          frameSrc === null ? (
            <p className={styles.message}>Loading…</p>
          ) : (
            <iframe
              className={styles.frame}
              title={path}
              sandbox="allow-scripts allow-forms allow-popups"
              src={frameSrc}
            />
          )
        ) : kind === 'pdf' ? (
          frameSrc === null ? (
            <p className={styles.message}>Loading…</p>
          ) : (
            // No `sandbox` here: Chromium treats its PDF viewer as a plugin
            // and blocks plugins in sandboxed frames. The endpoint's CSP and
            // the single-use ticket still bound what the document can do.
            <iframe className={styles.frame} title={path} src={frameSrc} />
          )
        ) : content === null ? (
          <p className={styles.message}>Loading…</p>
        ) : (
          <div className={styles.markdown}>
            <Markdown text={content} />
          </div>
        )}
      </div>
    </div>
  )
}
