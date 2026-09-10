/**
 * A name this host will hand to git as a **single** revision.
 *
 * "The renderer sent it" is not a boundary, so a revision arriving over the
 * wire is checked before it reaches a command line: it may not begin with `-`
 * (which git would read as an option), and it may not carry `..` or `...`
 * (which make it a *range*, and every caller here wants one commit).
 *
 * The character set used to stop there, and stopped too soon: `~` and `^` are
 * ordinary revision syntax — `HEAD~1`, `HEAD^`, `main~2`, `v1.0.0~3` — and a
 * function whose whole job is to resolve a commit-ish refused them. Reset,
 * rebase, merge, diff-range and worktree-add all answered `"HEAD~1" is not a
 * usable revision name`.
 *
 * Neither character weakens the gate. A value still has to *start* with a
 * word character, so `^HEAD` — which means "exclude" to rev-list — is refused
 * exactly as before, and so is anything beginning with a dash.
 *
 * One copy, because there were two: `git-actions.ts` and `git-worktree.ts`
 * carried the same expression, and the report named one of them.
 *
 * Admitting `^` admits two suffixes that are not one revision, and they are
 * refused by name: `^-` (`HEAD^-1` is shorthand for the range
 * `HEAD ^HEAD^1`) and `^@` (every parent — a set). Review caught the first.
 * Both happen to be rejected downstream today, because the callers run
 * `rev-parse --verify`, which demands a single object — but a gate whose
 * contract holds only because of what its callers do next is not a gate, and
 * the next caller may not verify. `^!` needs no rule: `!` was never in the
 * set. `^{commit}`, `^{}` and `^2` are single revisions and still pass.
 */
export const isRevisionName = (ref: string): boolean =>
  /^[\w][\w./@{}~^-]*$/.test(ref) && !ref.includes('..') && !/\^[-@]/.test(ref)
