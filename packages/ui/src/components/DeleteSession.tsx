import { useState } from 'react'

import { sessionKey, type SessionSummary } from '@harnessdesk/protocol'
import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'
import { ConfirmDialog, Note } from '../design'

/** Delete everywhere promises Trash before the person confirms it. */
export const DeleteSession = ({ summary, onClose }: { summary: SessionSummary; onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runtime = snapshot.runtimes.find(entry => entry.id === summary.runtime)
  const agent = runtime?.presentation.name ?? 'The agent'
  const label = sessionLabel(summary.title, summary.preview)
  const allowed = runtime?.capabilities.deleteHistory === 'trash'
  const working = (snapshot.sessions.get(sessionKey(summary.runtime, summary.id))?.status ?? summary.status).type === 'active'
  const remove = async (): Promise<void> => {
    if (!allowed) return
    setBusy(true)
    setError(null)
    try {
      await store.deleteSession(summary.id, summary.runtime)
      store.notice('info', 'Moved to the Trash')
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setBusy(false)
    }
  }
  return <ConfirmDialog
    title={`Delete "${label}" everywhere?`}
    confirmLabel="Move to Trash"
    busyLabel="Moving…"
    tone="destructive"
    busy={busy}
    pending={!allowed}
    focusCancel={!allowed}
    onConfirm={() => void remove()}
    onCancel={onClose}
  >
    <p>It moves to the Trash, and {agent} can no longer resume it.</p>
    {working && <p>The running conversation will stop first.</p>}
    {!allowed && <Note tone="bad">{!runtime ? 'This conversation’s agent is unavailable.' : `${agent} cannot move it to the Trash.`}</Note>}
    {error && <Note tone="bad">{error}</Note>}
  </ConfirmDialog>
}
