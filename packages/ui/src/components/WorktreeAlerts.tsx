import type { ReactNode } from 'react'

import type { WorktreeChanges } from '@harnessdesk/protocol'

import { Alert, AlertContent, AlertDescription, AlertTitle } from '../design/ui/alert'
import { AlertIcon } from './Icons'

/**
 * The two things a worktree dialog says that are not sentences: the files git
 * has not got, and a refusal.
 *
 * Removing a worktree and bringing one back both turn on the same fact, and
 * each drew it from a stylesheet of its own — one copied from the other value
 * for value, beside a dialog body that already sets and spaces its sentences.
 * Both are the design system's `Alert` now: a warning with the count as its
 * title and the files in the code face (a path is a thing a reader may have
 * to retype), and a danger alert for what went wrong, where it went wrong.
 *
 * Each takes a `className` because it sits among the dialog body's
 * paragraphs, and the body spaces only its own paragraphs.
 */

/** "1 modified and 2 untracked files" — the count a title leads with. */
export const describeUncommitted = (changes: WorktreeChanges): string => {
  const parts: string[] = []
  if (changes.modified > 0) parts.push(`${changes.modified} modified`)
  if (changes.untracked > 0) parts.push(`${changes.untracked} untracked`)
  return `${parts.join(' and ')} file${changes.modified + changes.untracked === 1 ? '' : 's'}`
}

/**
 * What git ignores, split by whether losing it costs anything.
 *
 * The porcelain gives the distinction away for free: git collapses a directory
 * it ignores whole to a name ending in `/`, and a whole ignored directory is
 * the rebuildable kind — `node_modules/`, `.venv/`, `dist/`. What is left is a
 * *file*, and a file git never had is a file nothing on the machine can put
 * back. An `.env` is the case this exists for: it makes the checkout read as
 * clean, it goes with the folder, and then it is gone (#209).
 */
export const splitIgnored = (
  changes: WorktreeChanges,
): { readonly gone: readonly string[]; readonly rebuildable: readonly string[] } => {
  const gone: string[] = []
  const rebuildable: string[] = []
  for (const entry of changes.ignored) (entry.endsWith('/') ? rebuildable : gone).push(entry)
  return { gone, rebuildable }
}

/** "2 files and 1 folder" — counted over what is shown, plus whatever is beyond it. */
export const describeIgnored = (changes: WorktreeChanges): string => {
  const { gone, rebuildable } = splitIgnored(changes)
  const beyond = changes.ignoredCount - (gone.length + rebuildable.length)
  const parts: string[] = []
  if (gone.length > 0) parts.push(`${gone.length} file${gone.length === 1 ? '' : 's'}`)
  if (rebuildable.length > 0) parts.push(`${rebuildable.length} folder${rebuildable.length === 1 ? '' : 's'}`)
  const said = parts.join(' and ') || `${changes.ignoredCount} entries`
  return beyond > 0 ? `${said} and ${beyond} more` : said
}

/** A few names for a sentence, rather than a second listing. */
const named = (entries: readonly string[]): string =>
  entries.length <= 3 ? entries.join(', ') : `${entries.slice(0, 3).join(', ')} and ${entries.length - 3} more`

/**
 * What git ignores here, named before the folder goes.
 *
 * Both verbs that take a worktree's folder delete these — `git worktree
 * remove` without being forced, and the `rm` that ends a bring-back — and
 * `git status` counts none of them, so the checkout reads as clean. The
 * dialogs used to say so in general ("anything git ignores there, such as an
 * .env file") and name nothing, which is the difference between a warning and
 * a fact: a person cannot copy out a file they have not been told is there.
 *
 * Files and rebuildable folders are said differently on purpose. Losing
 * `node_modules/` costs an install; losing an `.env` that was never in git
 * costs the file.
 */
export const IgnoredEntries = ({
  changes,
  className,
}: {
  changes: WorktreeChanges
  className?: string
}) => {
  if (changes.ignoredCount === 0) return null
  const { gone, rebuildable } = splitIgnored(changes)
  return (
    <Alert tone="warning" className={className}>
      <AlertIcon />
      <AlertContent>
        <AlertTitle>{`This also deletes ${describeIgnored(changes)} git ignores here`}</AlertTitle>
        <ul className="my-1 list-disc pl-4 font-mono text-sm break-all text-(--hd-secondary-foreground)">
          {changes.ignored.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
          {changes.ignoredCount > changes.ignored.length && (
            <li className="list-none font-sans">and {changes.ignoredCount - changes.ignored.length} more</li>
          )}
        </ul>
        <AlertDescription>
          {gone.length > 0 && (
            <>
              {named(gone)} {gone.length === 1 ? 'is' : 'are'} not in git, so nothing can put{' '}
              {gone.length === 1 ? 'it' : 'them'} back — copy {gone.length === 1 ? 'it' : 'them'} out
              first if you need {gone.length === 1 ? 'it' : 'them'}.{' '}
            </>
          )}
          {rebuildable.length > 0 && <>{named(rebuildable)} can be built again.</>}
        </AlertDescription>
      </AlertContent>
    </Alert>
  )
}

export const UncommittedFiles = ({
  changes,
  title,
  className,
  children,
}: {
  changes: WorktreeChanges
  title: string
  className?: string
  children: ReactNode
}) => (
  <Alert tone="warning" className={className}>
    <AlertIcon />
    <AlertContent>
      <AlertTitle>{title}</AlertTitle>
      <ul className="my-1 list-disc pl-4 font-mono text-sm break-all text-(--hd-secondary-foreground)">
        {changes.files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      <AlertDescription>{children}</AlertDescription>
    </AlertContent>
  </Alert>
)

/**
 * What went wrong, where it went wrong. `live` for a refusal that arrives
 * while someone is reading — an assertive region — and never for one that is
 * already on screen when the dialog opens.
 */
export const WorktreeProblem = ({
  live = false,
  className,
  children,
}: {
  live?: boolean
  className?: string
  children: ReactNode
}) => (
  <Alert tone="danger" className={className} {...(live ? { role: 'alert' } : {})}>
    <AlertIcon />
    <AlertContent>
      <AlertDescription>{children}</AlertDescription>
    </AlertContent>
  </Alert>
)
