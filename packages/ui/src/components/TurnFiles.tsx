import { useMemo, useState } from 'react'

import type { FileChange, Turn } from '@harnessdesk/protocol'

import { totalsByFile } from '../lib/turn-view'
import { useSessionKey, useStore } from '../state/context'
import { Button, Card, ChangeStats, Chip, CodeText, IconTile, Separator, Text } from '../design'
import { DiffIcon, RedoIcon, UndoIcon } from './Icons'
import styles from './TurnFiles.module.css'

/**
 * What a turn left on disk, as a card under the answer.
 *
 * One file is named with its counts in the head. Several get three rows and
 * an explicit way to reveal the rest; the rows open each diff, Review opens
 * the Changes panel, and Undo asks the host to put exactly this turn's edits
 * back — the turn's diff reversed, refused whole if a file was touched since.
 *
 * An undo is offered back as a Redo, because the edits it removed exist
 * nowhere else: they are not committed, and the agent would have to be asked
 * to do the work again. The button pair is the whole safety net for pressing
 * Undo on the wrong card.
 *
 * A third button appears only after one particular refusal. A turn holding a
 * deletion the agent recorded no content for cannot be undone whole, and that
 * refusal is right — writing an empty file back over the real one is the loss
 * an undo exists to prevent. What was missing was the other half: the updates
 * and the recorded deletions in the same turn can still go back, and *Undo the
 * rest* asks for exactly that, leaving the file the notice named alone (#237).
 */

const basename = (path: string): string => path.split('/').pop() ?? path

const relativeTo = (path: string, root: string): string => {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export const TurnFiles = ({ turn, changes, root }: { turn: Turn; changes: readonly FileChange[]; root: string }) => {
  const store = useStore()
  const key = useSessionKey()
  const [busy, setBusy] = useState(false)
  const [reverted, setReverted] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // Offered only once the host has refused for this reason; never up front,
  // because most turns have nothing unrecoverable in them.
  const [partly, setPartly] = useState(false)
  const files = useMemo(() => totalsByFile(changes), [changes])
  if (files.length === 0) return null

  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const one = files.length === 1 ? files[0] : undefined
  const shown = one ? [] : expanded ? files : files.slice(0, 3)
  const remaining = one ? 0 : files.length - shown.length
  const verb = files.every((file) => file.kind === 'add')
    ? 'Created'
    : files.every((file) => file.kind === 'delete')
      ? 'Deleted'
      : 'Edited'

  const apply = async (direction: 'undo' | 'redo', skipUnrecoverable = false): Promise<void> => {
    if (!key || busy) return
    setBusy(true)
    try {
      const result =
        direction === 'undo'
          ? await store.revertTurn(turn.id, key, skipUnrecoverable ? { skipUnrecoverable: true } : {})
          : await store.redoTurn(turn.id, key)
      // Only a refusal leaves the card where it was: the host is all-or-
      // nothing, so a failure means the tree is untouched and the offer
      // stands unchanged.
      if (result.done) {
        setReverted(direction === 'undo')
        setPartly(false)
      } else setPartly(result.unrecoverable)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card variant="plate" spacing="compact" className={styles.card} {...(reverted ? { 'data-reverted': '' } : {})}>
      <div className={styles.head}>
        <IconTile aria-hidden>
          <DiffIcon size={16} />
        </IconTile>
        <span className={styles.title}>
          <Text role="subject" className={styles.titleLine}>
            {verb} {one ? basename(one.path) : `${files.length} files`}{' '}
            <ChangeStats added={added} removed={removed} />
            {reverted && <Chip tone="neutral" size="sm">put back</Chip>}
          </Text>
        </span>
        <span className={styles.actions}>
          {turn.status !== 'inProgress' &&
            (reverted ? (
              <Button
                variant="quiet" size="sm" className={styles.action}
                onClick={() => void apply('redo')}
                disabled={busy}
                title="Write this turn's edits again. Refuses if you have edited one of these files since."
              >
                {busy ? 'Redoing…' : 'Redo'}
                <RedoIcon size={13} />
              </Button>
            ) : (
              <>
                <Button
                  variant="quiet" size="sm" className={styles.action}
                  onClick={() => void apply('undo')}
                  disabled={busy}
                  title="Put these files back the way they were before this turn. Refuses if you have edited one since."
                >
                  {busy ? 'Undoing…' : 'Undo'}
                  <UndoIcon size={13} />
                </Button>
                {partly && (
                  <Button
                    variant="quiet" size="sm" className={styles.action}
                    onClick={() => void apply('undo', true)}
                    disabled={busy}
                    title="Put back everything this turn can. The file just named is left exactly as it is — the agent recorded nothing to put back there."
                  >
                    {busy ? 'Undoing…' : 'Undo the rest'}
                    <UndoIcon size={13} />
                  </Button>
                )}
              </>
            ))}
          <Button
            variant="quiet" size="sm" className={styles.action}
            onClick={() => store.setDetailsTab('changes')}
            title="Open the Changes panel"
          >
            Review
          </Button>
        </span>
      </div>
      {!one && <Separator className={styles.rule} />}
      {!one && (
        <ul className={styles.files}>
          {shown.map((file) => {
            const relative = relativeTo(file.path, root)
            const name = basename(relative)
            const dir = relative.slice(0, relative.length - name.length)
            return (
              <li key={file.path}>
                <Button
                  type="button"
                  variant="row" size="row" className={styles.file}
                  onClick={() => store.openFile(file.path)}
                  title={`Open ${relative}`}
                >
                  <CodeText size="inherit" className={styles.path}>
                    {dir && <Text role="muted" ink="muted">{dir}</Text>}
                    {name}
                    {file.kind === 'delete' && <Text role="meta" className={styles.kind}>deleted</Text>}
                    {file.kind === 'add' && <Text role="meta" className={styles.kind}>new</Text>}
                  </CodeText>
                  <ChangeStats added={file.added} removed={file.removed} />
                </Button>
              </li>
            )
          })}
          {remaining > 0 && (
            <li>
              <Button variant="quiet" size="row" className={styles.more} onClick={() => setExpanded(true)}>
                {remaining} more
              </Button>
            </li>
          )}
        </ul>
      )}
    </Card>
  )
}
