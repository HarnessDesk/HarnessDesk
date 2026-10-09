import { useEffect, useState } from 'react'
import type { HostResult, SessionSummary } from '@harnessdesk/protocol'
import { useStore } from '../state/context'
import { Button, ConfirmDialog, MiddleTruncate, Note, Text } from '../design'
import { IgnoredEntries, UncommittedFiles, describeUncommitted } from './WorktreeAlerts'

export const DiscardWorktree = ({ summary, onClose }: { summary: Pick<SessionSummary, 'runtime' | 'id' | 'worktree'>; onClose: () => void }) => {
  const store = useStore()
  const [preview, setPreview] = useState<HostResult<'session/worktreePreview'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void store.transport.request('session/worktreePreview', { runtime: summary.runtime, sessionId: summary.id })
      .then(value => { if (!cancelled) setPreview(value) })
      .catch(thrown => { if (!cancelled) setError(String(thrown)) })
    return () => { cancelled = true }
  }, [store, summary])
  const discard = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const result = await store.transport.request('session/discardWorktree', { runtime: summary.runtime, sessionId: summary.id, stamp: preview.stamp })
      if (result.discarded) onClose()
      else { setPreview(result.preview ?? null); setError('The worktree changed. Review this list and confirm again.') }
    } catch (thrown) { setError(thrown instanceof Error ? thrown.message : String(thrown)); setPreview(null) }
    finally { setBusy(false) }
  }
  const changes = preview?.changes
  return <ConfirmDialog title="Discard worktree?" confirmLabel="Discard worktree" busyLabel="Discarding…"
    tone="destructive" busy={busy} pending={!preview} onConfirm={() => void discard()} onCancel={onClose}>
    <p><Text as="span" role="subject"><MiddleTruncate>{summary.worktree?.path ?? ''}</MiddleTruncate></Text><br />
      The folder and its uncommitted and ignored content go. The branch is kept. There is no undo.</p>
    {error && <Note tone="bad">{error}</Note>}
    {error && !preview && <Button variant="outline" size="sm" onClick={() => {
      setError(null)
      void store.transport.request('session/worktreePreview', { runtime: summary.runtime, sessionId: summary.id })
        .then(setPreview).catch(thrown => setError(String(thrown)))
    }}>Review again</Button>}
    {!changes && !error && <p>Checking for unsaved work…</p>}
    {changes && changes.modified + changes.untracked > 0 && <UncommittedFiles className="mb-3" changes={changes}
      title={`This would discard ${describeUncommitted(changes)}`}>Commit or stash them first to keep them.</UncommittedFiles>}
    {changes && <IgnoredEntries changes={changes} />}
  </ConfirmDialog>
}
