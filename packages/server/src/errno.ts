/**
 * Telling "nothing here" from "something is wrong" when a folder will not open.
 *
 * A parameterless `catch` around a listing answers every failure with zero
 * rows, and zero rows are also the truth for a folder nobody has made — so a
 * mode, a bad mount or a name the filesystem will not take arrives as "you
 * have none", with nothing logged and no path or reason in it to act on. The
 * person who pays is the one looking at a screen that says they have nothing
 * when they have ten.
 */

/**
 * The two failures that mean "nothing here" rather than "something is wrong".
 *
 * `ENOENT` is a directory nobody has made yet. `ENOTDIR` is a `.harnessdesk`
 * somebody made a *file*, which is a project with nothing of ours in it and
 * not a reason to refuse every listing that project asks for. It is also an
 * entry a walk found in a listing that turns out not to be a folder — a stray
 * `.DS_Store` beside the folders it wanted, or a folder replaced between the
 * listing and the read — which is nothing either.
 *
 * Everything else — a mode, a mount, a name the filesystem will not take — is
 * a real failure, and raised: a path and a reason can be acted on, and zero
 * rows cannot.
 *
 * A folder that has to be one where it is is narrower — see `NOTHING_YET`.
 */
export const NOTHING_HERE: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * The one failure that means "nothing yet" in a folder that has to be one where
 * it is: the desk's own — its rooms, its flow runs, its transcripts — an
 * agent's own history, and a project the desk was asked to search.
 *
 * `ENOENT` is a folder not made yet — a store never written, an agent never
 * run — or one that has gone. A *file* where it belongs, or above it, is not
 * that: it is a place nothing can be kept, or a home that is broken, and an
 * answer of nothing over it says nothing is wrong. So `ENOTDIR` is raised here
 * with everything else.
 */
export const NOTHING_YET: ReadonlySet<string> = new Set(['ENOENT'])

/** A failure's errno — `ENOENT`, `EACCES` — or `''` when it carries none. */
export const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}
