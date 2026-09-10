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
