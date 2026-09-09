/**
 * `git status --porcelain=v1 -z`, read once.
 *
 * The format is two characters of status, a space, and a path — except where a
 * record is a rename or a copy, which is followed by a *second* field holding
 * the origin. A reader that consumes only the first leaves that bare path in
 * the stream, and the next turn of the loop reads it as a status record: three
 * characters come off the front and a file that does not exist is reported.
 *
 * This existed three times in this package and was wrong in two of them, each
 * skipping renames and forgetting copies. Once, here, is the fix.
 *
 * Two things about the format are measured against git 2.50.1 rather than
 * assumed, because the plausible belief is wrong in both directions:
 *
 * - **Copies do occur.** They need `status.renames=copies`, which is an
 *   ordinary documented setting, and a change to the source in the same
 *   index — then git emits `C  dup.txt\0src.txt\0`.
 * - **Only the index column carries the second field.** An unstaged rename is
 *   not a two-path record at all; git reports it as a delete beside an
 *   untracked file (` D src.txt\0?? moved.txt\0`). A reader that also skips on
 *   the worktree column would swallow the record after it.
 */

export interface PorcelainEntry {
  /** The index column: what is staged. */
  readonly index: string
  /** The worktree column: what is not. */
  readonly worktree: string
  /** The path, or the destination where this is a rename or a copy. */
  readonly path: string
  /** Where a rename or copy came from; `null` for everything else. */
  readonly origin: string | null
}

/** True when this record is followed by its origin as a second field. */
const carriesOrigin = (index: string): boolean => index === 'R' || index === 'C'

export const parsePorcelain = (output: string): readonly PorcelainEntry[] => {
  const fields = output.split('\0')
  const entries: PorcelainEntry[] = []
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at]
    // Shorter than `XY p` is the trailing empty field, or nothing useful.
    if (!field || field.length < 4) continue
    const index = field[0] ?? ' '
    const worktree = field[1] ?? ' '
    let origin: string | null = null
    if (carriesOrigin(index)) {
      origin = fields[at + 1] ?? null
      at += 1
    }
    entries.push({ index, worktree, path: field.slice(3), origin })
  }
  return entries
}
