import { useState } from 'react'

import type { TeamState } from '@harnessdesk/protocol'

import { Btn, Dialog, Input } from '../design'
import { useStore } from '../state/context'
import styles from './RoomActions.module.css'

/**
 * Renaming a room, and putting one away.
 *
 * Both were wire verbs with no door: a room could be created and joined from
 * the interface and then neither corrected nor removed, so a name typed in a
 * hurry was permanent and an abandoned room stayed in the tree for good.
 *
 * They sit together because they are the two ends of one menu and share one
 * shape — a room, a sentence about consequence, one press — and because the
 * difference between them is the thing a reader has to get right: a rename
 * changes a word, and a delete cannot be undone.
 */
export const RenameRoom = ({
  room,
  onClose,
}: {
  readonly room: TeamState
  readonly onClose: () => void
}) => {
  const store = useStore()
  const [name, setName] = useState(room.name)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const rename = async (): Promise<void> => {
    const called = name.trim()
    if (called === '' || called === room.name) {
      onClose()
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      await store.renameRoom(room.id, called)
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not take that.')
    }
  }

  return (
    <Dialog
      title="Rename this room"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Btn variant="primary" disabled={busy || name.trim() === ''} onClick={() => void rename()}>
            {busy ? 'Renaming…' : 'Rename'}
          </Btn>
          <Btn disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        <Input
          aria-label="Room name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void rename()
          }}
        />
        {/* Only the label moves. Worth saying, because the room is addressed
            by name in the channel — an agent types it to reach a peer — and
            "does this break what the agents were told" is the first question
            somebody renaming one will have. */}
        <p className={styles.note}>
          The name is what the sidebar and the room's own header show. Its board, its members and
          everything said in it are untouched.
        </p>
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** "3 jobs", "1 message" — counted things, said the way a person would. */
const tally = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

export const DeleteRoom = ({
  room,
  onClose,
}: {
  readonly room: TeamState
  readonly onClose: () => void
}) => {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const jobs = room.intents.length
  const members = room.members.length
  const messages = room.channel.filter((entry) => entry.kind === 'message').length
  const going = [
    jobs > 0 ? tally(jobs, 'job') : null,
    messages > 0 ? tally(messages, 'message') : null,
  ].filter((part): part is string => part !== null)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const gone = await store.deleteRoom(room.id)
      store.notice(
        'info',
        gone.intents > 0 || gone.messages > 0
          ? `Deleted “${gone.name}” — ${tally(gone.intents, 'job')} and ${tally(gone.messages, 'message')} went with it.`
          : `Deleted “${gone.name}”.`,
      )
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not take that.')
    }
  }

  return (
    <Dialog
      title={`Delete “${room.name}”?`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Btn variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete room'}
          </Btn>
          <Btn disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
        </>
      }
    >
      <div className={styles.body}>
        {/* What goes, counted. A dialog that says "this cannot be undone" and
            not *what* cannot be undone leaves somebody to guess whether their
            agents are about to be deleted too — which is the fear, and the
            answer is no. */}
        <p className={styles.note}>
          {going.length > 0
            ? `Its board and its chat go with it — ${going.join(' and ')}. This cannot be undone.`
            : 'There is nothing on its board and nothing has been said in it. This cannot be undone.'}
        </p>
        <p className={styles.keeps}>
          {members === 0
            ? 'No conversations are in it.'
            : members === 1
              ? 'The one conversation in it leaves the room and carries on — nothing is closed, and no transcript is touched.'
              : `All ${members} conversations in it leave the room and carry on — nothing is closed, and no transcript is touched.`}
        </p>
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}
