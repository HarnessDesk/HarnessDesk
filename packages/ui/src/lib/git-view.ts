import type { GitFileStatus } from '@harnessdesk/protocol'

/**
 * Whether a file belongs in the staged view or in the working tree's.
 *
 * `git/status` lists a path once for each column that changed (#31), so a file
 * staged and then changed again is in both views, one entry in each. A
 * conflict is listed once, unstaged, because a merge resolves it in the
 * working tree, and that is the only view it is in. An untracked file is in
 * the working tree whatever its flag says.
 *
 * One rule for the two surfaces that split files this way, the Changes panel
 * and the review workspace. Each had it written out, and neither was tested
 * (#180).
 */
export const inView = (file: GitFileStatus, staged: boolean): boolean =>
  staged ? file.staged : !file.staged || file.status === 'untracked'
