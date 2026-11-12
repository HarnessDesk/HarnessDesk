import type { WorkspaceEntry } from '@harnessdesk/protocol'

import { sanitizeText } from './sanitize'

/**
 * What a prompt link (`harnessdesk://new`) does in the renderer: find the
 * project it names among the ones the desk already has, and say what the
 * link carried besides the prompt. Nothing here opens, clones or sends.
 */

const trimSlashes = (path: string): string => (path.length > 1 ? path.replace(/[\\/]+$/, '') : path)

const isPath = (repo: string): boolean => /^(?:\/|[A-Za-z]:[\\/])/.test(repo)

/** The folders a project is known by: what was opened, its link-free form, and its checkout. */
const pathsOf = (entry: WorkspaceEntry): readonly string[] =>
  [entry.path, entry.realPath, entry.checkoutRoot, entry.repo?.root]
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .map(trimSlashes)

/**
 * The open project a link's `repo` names, or null.
 *
 * A path matches a project's folder, its resolved folder, or its checkout. A
 * name matches the repository's `origin` (`host/owner/name`, lower case):
 * `owner/name` its last two parts, `host/owner/name` the whole of it. Two
 * clones of one repository both match; the main checkout wins over a
 * worktree, then the one opened most recently.
 */
export const matchPromptLinkProject = (
  repo: string,
  workspaces: readonly WorkspaceEntry[],
): WorkspaceEntry | null => {
  const matches = workspaces.filter((entry) => {
    if (isPath(repo)) return pathsOf(entry).includes(trimSlashes(repo))
    const origin = entry.repo?.origin?.toLowerCase()
    if (!origin) return false
    const wanted = repo.toLowerCase().replace(/\.git$/, '')
    const parts = wanted.split('/')
    return parts.length === 3 ? origin === wanted : parts.length === 2 && origin.endsWith(`/${wanted}`)
  })
  return [...matches].sort((a, b) =>
    Number(a.repo?.worktree === true) - Number(b.repo?.worktree === true) || b.lastOpenedAt - a.lastOpenedAt,
  )[0] ?? null
}

/**
 * What the link asked for besides the prompt, as plain words for the marker
 * over the composer. The composer has no way to attach a pull request or
 * choose a Flow, so these are said, never acted on — a Flow is never started.
 */
export const promptLinkContext = (link: { readonly pr: number | null; readonly flow: string | null }): string | null => {
  const parts = [
    link.pr !== null ? `Pull request #${link.pr}` : null,
    link.flow !== null ? `Flow ${sanitizeText(link.flow)}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `${parts.join(' · ')}.` : null
}

/** A link's repository, as text a notice can carry. */
export const promptLinkRepoText = (repo: string): string => sanitizeText(repo).slice(0, 200)
