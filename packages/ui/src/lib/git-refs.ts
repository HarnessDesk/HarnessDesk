import type { GitBranchRef, GitLogCommit } from '@harnessdesk/protocol'

/**
 * Pure shapes behind the history pane's rail and ref chips: branches folded
 * into their slash-prefix folders the way every git client draws them, and
 * `%D` decorations classified into the chip kinds the table renders.
 */

export type BranchTreeEntry =
  | { readonly kind: 'branch'; readonly branch: GitBranchRef }
  | { readonly kind: 'folder'; readonly name: string; readonly branches: readonly GitBranchRef[] }

/**
 * Branches as the rail lists them: a name with a slash files under its first
 * segment, the rest sort beside the folders by name. Inside a folder the
 * branches keep their full name split off, ordered by name too — the rail
 * shows the remainder.
 */
export const branchTree = (branches: readonly GitBranchRef[]): BranchTreeEntry[] => {
  const folders = new Map<string, GitBranchRef[]>()
  const loose: GitBranchRef[] = []
  for (const branch of branches) {
    const cut = branch.name.indexOf('/')
    if (cut > 0) {
      const folder = branch.name.slice(0, cut)
      const list = folders.get(folder) ?? []
      list.push(branch)
      folders.set(folder, list)
    } else {
      loose.push(branch)
    }
  }
  const entries: BranchTreeEntry[] = [
    ...loose.map((branch) => ({ kind: 'branch' as const, branch })),
    ...[...folders.entries()].map(([name, grouped]) => ({
      kind: 'folder' as const,
      name,
      branches: [...grouped].sort((a, b) => a.name.localeCompare(b.name)),
    })),
  ]
  return entries.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
}

const nameOf = (entry: BranchTreeEntry): string => (entry.kind === 'branch' ? entry.branch.name : entry.name)

/** What the rail prints inside a folder: the name with the folder cut off. */
export const inFolder = (branch: GitBranchRef): string => branch.name.slice(branch.name.indexOf('/') + 1)

export interface RefChip {
  readonly kind: 'head' | 'branch' | 'remote' | 'tag'
  readonly name: string
}

/**
 * `%D` decorations, classified. Git's own words are kept as the chip text —
 * `origin/main` stays whole — and the remote set is what tells a remote
 * branch from a local one with a slash in its name.
 */
export const refChips = (refs: readonly string[], remotes: ReadonlySet<string>): RefChip[] =>
  refs.flatMap((entry): RefChip[] => {
    if (entry === 'HEAD') return [{ kind: 'head', name: 'HEAD' }]
    if (entry.startsWith('HEAD -> ')) return [{ kind: 'head', name: entry.slice('HEAD -> '.length) }]
    if (entry.startsWith('tag: ')) return [{ kind: 'tag', name: entry.slice('tag: '.length) }]
    const cut = entry.indexOf('/')
    if (cut > 0 && remotes.has(entry.slice(0, cut))) return [{ kind: 'remote', name: entry }]
    return [{ kind: 'branch', name: entry }]
  })

export const shortSha = (sha: string): string => sha.slice(0, 7)

/**
 * A commit's date the way a history column reads: the time alone while the
 * day is today, the day and month within the year, the year once it matters.
 */
export const commitDate = (at: number, now: number): string => {
  const then = new Date(at)
  const today = new Date(now)
  const sameDay = then.toDateString() === today.toDateString()
  if (sameDay) return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameYear = then.getFullYear() === today.getFullYear()
  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** The subjects git writes for its own commits, kept quiet in the table. */
export const isMergeSubject = (commit: GitLogCommit): boolean => commit.parents.length > 1
