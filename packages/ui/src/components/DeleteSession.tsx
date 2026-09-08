import { useState } from 'react'

import type { RuntimeId, SessionId, SessionSummary } from '@harnessdesk/protocol'

import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { TrashIcon } from './Icons'
import { Btn, Note } from '../design/primitives/Kit'
import { Dialog } from '../design/primitives/Dialog'
import styles from './DeleteSession.module.css'

/**
 * Deleting a conversation.
 *
 * The only irreversible thing the session list can do, so it is the only one
 * with a dialog in front of it — archiving, which is reversible, has none and
 * a one-click undo instead. That pairing is the design: the cheap verb is
 * frictionless and the expensive one is deliberate, and a person who reaches
 * for Delete when they meant Archive is told the difference here rather than
 * discovering it afterwards.
 *
 * What the dialog says is what will actually happen, agent by agent. It names
 * the agent, because the conversation is the agent's and this removes it from
 * the agent's own store, not just from this list; it says the transcript
 * HarnessDesk keeps goes too, because that copy exists and would otherwise
 * outlive the thing it is a copy of; and it offers Archive as the way out,
 * because "I wanted it out of my list" is what almost everyone reaching this
 * dialog actually wanted.
 *
 * Afterwards the toast reports the disposition the runtime reported — the
 * bridges move files to the Trash, Codex erases — because "moved to the
 * Trash" and "deleted" are different promises and only one of them is true
 * for any given agent.
 */
export const DeleteSession = ({
  summary,
  onClose,
}: {
  summary: SessionSummary
  onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runtime = snapshot.runtimes.find((entry) => entry.id === summary.runtime)
  const agent = runtime?.presentation.name ?? String(summary.runtime)
  const label = sessionLabel(summary.title, summary.preview)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await store.deleteSession(
        summary.id as SessionId,
        summary.runtime as RuntimeId,
      )
      store.notice(
        'info',
        outcome.disposition === 'trash'
          ? `Deleted "${label}". Moved to the Trash.`
          : `Deleted "${label}".`,
      )
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Delete conversation"
      icon={<TrashIcon size={15} />}
      tone="destructive"
      onClose={onClose}
      footer={
        <>
          <Btn variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete'}
          </Btn>
          {/* Not offered from the archive screen: it is already archived
              there, and a button that does nothing reads as one that failed. */}
          {!summary.archived && (
            <Btn
              disabled={busy}
              onClick={() => {
                void store.archiveSession(
                  summary.id as SessionId,
                  summary.runtime as RuntimeId,
                  label,
                )
                onClose()
              }}
            >
              Archive instead
            </Btn>
          )}
          <Btn disabled={busy} onClick={onClose}>
            Keep
          </Btn>
        </>
      }
    >
      <p className={styles.subject}>
        {runtime && <RuntimeMark runtime={runtime} size={13} />}
        <span>{label}</span>
      </p>
      <p>
        This removes the conversation from {agent}, and the transcript HarnessDesk kept of it.
        It will not be in either window afterwards.
      </p>
      {!summary.archived && (
        <p>
          To take it out of the list without losing it, archive it instead — an archived
          conversation can be restored at any time.
        </p>
      )}
      {error && <Note tone="bad">{error}</Note>}
    </Dialog>
  )
}
