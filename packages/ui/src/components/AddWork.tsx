import { useState } from 'react'

import type { Intent, RuntimeId, SessionId, TeamPeerInfo } from '@harnessdesk/protocol'

import { ActionError, Button, Card, Checkbox, Dialog, Field, FormStack, Input, NativeSelect, Text, Textarea } from '../design'
import { useStore } from '../state/context'
import styles from './AddWork.module.css'

/**
 * Putting work on the board, with the fields the board actually enforces.
 *
 * The header's input took a title and nothing else, so every job a person
 * wrote owned no files and waited on nothing — and the two fields the host
 * refereees hardest were reachable only by an agent calling `add_intent`. The
 * board could promise one-claim-per-job and not one-agent-per-file, because
 * nobody had anywhere to say which files.
 *
 * The input stays for the common case: a title, typed, one press. This is
 * where the rest of the job goes when it has one.
 *
 * The last field is the one every kanban calls **Assign to**, and it is
 * deliberately not that. Nobody assigns work here: an agent *claims* it, which
 * is what makes the file lock mean anything — a picker that silently created a
 * claim would be a lie the board would then have to keep. So it posts a
 * message naming the job, and says so on the field.
 */
export const AddWork = ({
  room,
  intents,
  peers = [],
  onClose,
  onTrouble,
}: {
  readonly room: string
  readonly intents: readonly Intent[]
  /** Who could be asked to pick it up. Empty when nobody is in the room. */
  readonly peers?: readonly TeamPeerInfo[]
  readonly onClose: () => void
  /** Where a failure that happens *after* the job is on the board is reported. */
  readonly onTrouble?: (message: string) => void
}) => {
  const store = useStore()
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [files, setFiles] = useState('')
  const [dependsOn, setDependsOn] = useState<readonly number[]>([])
  const [ask, setAsk] = useState('nobody')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /* Only work that could still hold this one up. Depending on something already
     done is not a dependency, it is a note — and offering it invites a job that
     starts life in Waiting for no reason. */
  const blockers = intents.filter((one) => one.state !== 'done' && one.state !== 'abandoned')

  const parsed = files
    .split(/[\n,]/)
    .map((one) => one.trim())
    .filter((one) => one !== '')

  const add = async (): Promise<void> => {
    const named = title.trim()
    if (named === '') return
    setBusy(true)
    setProblem(null)
    try {
      await store.teamAdd(room, {
        title: named,
        ...(detail.trim() ? { detail: detail.trim() } : {}),
        ...(parsed.length > 0 ? { files: parsed } : {}),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      })
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not take that.')
      return
    }
    /* Asking is a second, weaker act, and it must not be able to undo the
       first — nor to be *repeated* into a second job.
       
       This used to leave the dialog open with its fields intact and "Add to
       board" still armed, so pressing it again added another card and then
       retried the message: one failed post, two jobs on the board. The job is
       on the board either way, so the dialog is done; the failure is reported
       where the person is now looking, which is the board. */
    const target = peers.find((one) => `${one.runtime} ${one.sessionId}` === ask)
    if (target) {
      await store
        .teamPost(room, `New on the board: “${named}”. Claim it if it is yours to take.`, {
          runtime: target.runtime as RuntimeId,
          sessionId: target.sessionId as SessionId,
        })
        .catch(() =>
          onTrouble?.(
            `“${named}” is on the board, but the message asking ${target.nickname} to pick it up did not land.`,
          ),
        )
    }
    onClose()
  }

  const toggle = (id: number): void => {
    setDependsOn((was) => (was.includes(id) ? was.filter((one) => one !== id) : [...was, id]))
  }

  return (
    <Dialog
      title="Add work to the board"
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={busy || title.trim() === ''} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add to board'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <FormStack>
        <Field label="What needs doing">
          {(control) => (
            <Input
              {...control}
              aria-label="What needs doing"
              value={title}
              placeholder="Fix the token refill in src/limiter.js"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>

        <Field label="Detail" optional>
          {(control) => (
            <Textarea
              {...control}
              aria-label="Detail"
              variant="editor" controlSize="compact" className={styles.area}
              rows={2}
              value={detail}
              placeholder="Anything whoever takes it needs to know before starting."
              onChange={(event) => setDetail(event.target.value)}
            />
          )}
        </Field>

        <Field
          label={<>Files it will own <Text role="muted" ink="muted">one per line</Text></>}
          hint={parsed.length > 0
            ? `Nobody else can claim work overlapping ${parsed.join(', ')} while this is held.`
            : 'Without these, the job is reserved but the code is not.'}
        >
          {(control) => (
            <Textarea
              {...control}
              aria-label="Files it will own"
              variant="editor" controlSize="compact" className={styles.area}
              rows={2}
              value={files}
              placeholder={'src/limiter.js\nsrc/api/**'}
              onChange={(event) => setFiles(event.target.value)}
            />
          )}
        </Field>

        <div className={styles.pair}>
          <Field
            label="Ask someone"
            optional
            hint={peers.length === 0
              ? 'Nobody is in the room yet.'
              : 'Posts a message. The claim is still theirs to take.'}
          >
            {(control) => (
              <NativeSelect
                {...control}
                aria-label="Ask someone to pick it up"
                value={ask}
                disabled={peers.length === 0}
                onChange={(event) => setAsk(event.target.value)}
              >
                <option value="nobody">Nobody — leave it on the board</option>
                {peers.map((one) => (
                  <option key={`${one.runtime} ${one.sessionId}`} value={`${one.runtime} ${one.sessionId}`}>
                    {one.nickname}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        </div>

        {blockers.length > 0 && (
          <Field
            label="Waits for"
            optional
            hint="It sits in Waiting until those are done, then opens on its own."
          >
            {(control) => <Card {...control} spacing="compact" radius="sm" className={styles.deps}>
              {blockers.map((one) => (
                <label key={one.id} className={styles.dep}>
                  <Checkbox
                    aria-label={`Waits for #${one.id}`}
                    checked={dependsOn.includes(one.id)}
                    onCheckedChange={() => toggle(one.id)}
                  />
                  <Text role="meta" numeric>#{one.id}</Text>
                  <Text role="muted" ink="secondary" truncate className={styles.depTitle}>{one.title}</Text>
                </label>
              ))}
            </Card>}
          </Field>
        )}

        {problem && (
          <ActionError>{problem}</ActionError>
        )}
      </FormStack>
    </Dialog>
  )
}
