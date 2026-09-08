import { useMemo, useState } from 'react'

import type { FileChange, Turn } from '@harnessdesk/protocol'

import { totalsByFile } from '../lib/turn-view'
import { useSessionKey, useStore } from '../state/context'
import { DiffIcon, RedoIcon, UndoIcon } from './Icons'
import styles from './TurnFiles.module.css'

/**
 * What a turn left on disk, as a card under the answer.
 *
 * "Edited 3 files · +607 −0", then a row per file with its own counts; the
 * rows open the file's diff, Review opens the Changes panel, and Undo asks
 * the host to put exactly this turn's edits back — the turn's diff reversed,
 * refused whole if a file was touched since. The card is the answer to "what
 * did it actually change", which the prose above it rarely says precisely.
 *
 * An undo is offered back as a Redo, because the edits it removed exist
 * nowhere else: they are not committed, and the agent would have to be asked
 * to do the work again. The button pair is the whole safety net for pressing
 * Undo on the wrong card.
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
  const files = useMemo(() => totalsByFile(changes), [changes])
  if (files.length === 0) return null

  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const verb = files.every((file) => file.kind === 'add') ? 'Created' : files.every((file) => file.kind === 'delete') ? 'Deleted' : 'Edited'

  const apply = async (direction: 'undo' | 'redo'): Promise<void> => {
    if (!key || busy) return
    setBusy(true)
    try {
      const done = direction === 'undo' ? await store.revertTurn(turn.id, key) : await store.redoTurn(turn.id, key)
      // Only a refusal leaves the card where it was: the host is all-or-
      // nothing, so a failure means the tree is untouched and the offer
      // stands unchanged.
      if (done) setReverted(direction === 'undo')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.card} {...(reverted ? { 'data-reverted': '' } : {})}>
      <div className={styles.head}>
        <span className={styles.glyph}>
          <DiffIcon size={16} />
        </span>
        <span className={styles.title}>
          <span className={styles.titleLine}>
            {verb} {files.length} file{files.length === 1 ? '' : 's'}
            {reverted && <span className={styles.revertedTag}>put back</span>}
          </span>
          <span className={styles.counts}>
            <span className={styles.added}>+{added}</span> <span className={styles.removed}>−{removed}</span>
          </span>
        </span>
        <span className={styles.actions}>
          {turn.status !== 'inProgress' &&
            (reverted ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => void apply('redo')}
                disabled={busy}
                title="Write this turn's edits again. Refuses if you have edited one of these files since."
              >
                {busy ? 'Redoing…' : 'Redo'}
                <RedoIcon size={13} />
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={() => void apply('undo')}
                disabled={busy}
                title="Put these files back the way they were before this turn. Refuses if you have edited one since."
              >
                {busy ? 'Undoing…' : 'Undo'}
                <UndoIcon size={13} />
              </button>
            ))}
          <button
            type="button"
            className={`${styles.action} ${styles.actionPrimary}`}
            onClick={() => store.setDetailsTab('changes')}
            title="Open the Changes panel"
          >
            Review
          </button>
        </span>
      </div>
      <ul className={styles.files}>
        {files.map((file) => {
          const relative = relativeTo(file.path, root)
          const name = basename(relative)
          const dir = relative.slice(0, relative.length - name.length)
          return (
            <li key={file.path}>
              <button
                type="button"
                className={styles.file}
                onClick={() => store.openFile(file.path)}
                title={`Open ${relative}`}
              >
                <span className={styles.path}>
                  {dir && <span className={styles.dir}>{dir}</span>}
                  {name}
                  {file.kind === 'delete' && <span className={styles.kind}>deleted</span>}
                  {file.kind === 'add' && <span className={styles.kind}>new</span>}
                </span>
                <span className={styles.counts}>
                  <span className={styles.added}>+{file.added}</span> <span className={styles.removed}>−{file.removed}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
