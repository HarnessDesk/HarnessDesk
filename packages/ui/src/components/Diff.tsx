import { useCallback, useMemo, useRef, useState } from 'react'

import { asAdditions, asRemovals, drawnWhole, parseDiff, type WholeFile } from '../lib/diff'
import { ChevronIcon } from './Icons'
import styles from './Diff.module.css'

/**
 * Unified diff rendering. Parsing lives in `lib/diff`.
 *
 * Hunk navigation is here rather than in the panel because a hunk is a
 * property of the diff, not of where it is shown: the same control works on
 * a turn's aggregated diff and on one file's working-tree diff.
 */

const COLLAPSE_AFTER = 400

export interface DiffViewProps {
  readonly diff: string
  /**
   * Set where the payload may be a whole file rather than a diff: `'added'`
   * (or `true`) for an added file, drawn as its additions; `'removed'` for a
   * deleted one, drawn as its removals. A payload that carries a hunk header
   * is drawn as the diff it is either way.
   */
  readonly wholeFile?: boolean | WholeFile
  /**
   * Wrap long lines instead of scrolling them.
   *
   * Off everywhere a diff is read in a pane, where sideways scrolling is the
   * expected thing and keeps the columns straight. On where a diff is the
   * evidence in a *dialog* — the library's install preview is 620px wide, an
   * eighty-column line does not fit in it, and a preview whose whole job is
   * "read this before you agree" must not hide the ends of its lines behind
   * a scrollbar nobody drags.
   */
  readonly wrap?: boolean
}

export const DiffView = ({ diff, wholeFile = false, wrap = false }: DiffViewProps) => {
  const [expanded, setExpanded] = useState(false)
  const [hunk, setHunk] = useState(0)
  const rows = useRef<Map<number, HTMLTableRowElement>>(new Map())

  const lines = useMemo(
    () => {
      const whole: WholeFile = wholeFile === true ? 'added' : wholeFile || false
      if (!drawnWhole(diff, whole !== false)) return parseDiff(diff)
      return whole === 'removed' ? asRemovals(diff) : asAdditions(diff)
    },
    [diff, wholeFile],
  )
  const hunkRows = useMemo(
    () => lines.flatMap((line, index) => (line.kind === 'hunk' ? [index] : [])),
    [lines],
  )

  const visible = expanded ? lines : lines.slice(0, COLLAPSE_AFTER)
  const hidden = lines.length - visible.length

  const go = useCallback(
    (next: number) => {
      const target = hunkRows[next]
      if (target === undefined) return
      if (target >= COLLAPSE_AFTER) setExpanded(true)
      setHunk(next)
      // The row may only mount after expanding; scroll on the next frame.
      requestAnimationFrame(() => {
        rows.current.get(target)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    },
    [hunkRows],
  )

  return (
    <div className={styles.diff}>
      {hunkRows.length > 1 && (
        <div className={styles.nav}>
          <span>
            Hunk {Math.min(hunk + 1, hunkRows.length)} of {hunkRows.length}
          </span>
          <button
            type="button"
            className={styles.navButton}
            disabled={hunk <= 0}
            onClick={() => go(hunk - 1)}
            aria-label="Previous hunk"
          >
            <ChevronIcon size={11} style={{ transform: 'rotate(-90deg)' }} />
          </button>
          <button
            type="button"
            className={styles.navButton}
            disabled={hunk >= hunkRows.length - 1}
            onClick={() => go(hunk + 1)}
            aria-label="Next hunk"
          >
            <ChevronIcon size={11} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </div>
      )}
      <div className={styles.scroll}>
        <table className={styles.table} {...(wrap ? { 'data-wrap': '' } : {})}>
          <tbody>
            {visible.map((line, index) => (
              <tr
                key={index}
                ref={(element) => {
                  if (element) rows.current.set(index, element)
                  else rows.current.delete(index)
                }}
                className={`${styles.row} ${
                  line.kind === 'add'
                    ? styles.add
                    : line.kind === 'remove'
                      ? styles.remove
                      : line.kind === 'hunk' || line.kind === 'meta'
                        ? styles.hunk
                        : ''
                }`}
                {...(line.kind === 'hunk' && hunkRows[hunk] === index ? { 'data-current': '' } : {})}
              >
                <td className={styles.gutter}>{line.oldNumber ?? ''}</td>
                <td className={styles.gutter}>{line.newNumber ?? ''}</td>
                <td className={styles.code}>
                  <span className={styles.marker}>
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}
                  </span>
                  {line.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className={styles.truncated}>
          {hidden.toLocaleString()} more lines
          <button type="button" className={styles.expand} onClick={() => setExpanded(true)}>
            Show all
          </button>
        </div>
      )}
    </div>
  )
}
