import type { ForgeReference } from '@harnessdesk/protocol'

import { CommentIcon, IssueIcon, PullRequestIcon, ReviewIcon } from '@/components/Icons'
import { softTone, type Tone } from '../ui/tone'

/** A published change or check outcome that the interface can judge in a word. */
export type StateToneState =
  | 'open'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'passed'
  | 'failed'
  | 'running'
  | 'skipped'
  | 'timed out'

const STATE_TONE = {
  open: { label: 'Open', tone: 'success' },
  draft: { label: 'Draft', tone: 'neutral' },
  merged: { label: 'Merged', tone: 'brand' },
  closed: { label: 'Closed', tone: 'danger' },
  passed: { label: 'Passed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  running: { label: 'Running', tone: 'info' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  'timed out': { label: 'Timed out', tone: 'warning' },
} as const satisfies Record<StateToneState, { label: string; tone: Tone }>

/** The one label and tone for a pull-request state or check outcome. */
export const stateTone = (state: StateToneState): { label: string; tone: Tone } =>
  STATE_TONE[state]

/** The verb the transcript row leads with: what the conversation did. */
export const publicationVerb = (reference: ForgeReference): string => {
  // What a comment or a review is on is said by the reference, never guessed
  // from what it happens to carry; a pull request is the default subject.
  const thing = reference.subject === 'issue' ? 'the issue' : 'the pull request'
  switch (reference.kind) {
    case 'pullRequest':
      return reference.action === 'updated' ? 'Updated the pull request' : reference.action === 'opened' ? 'Opened a pull request' : 'Pull request'
    case 'review':
      return 'Reviewed the pull request'
    case 'comment':
      return `Commented on ${thing}`
    case 'issue':
      return reference.action === 'opened' ? 'Opened an issue' : 'Issue'
  }
}

/** The glyph for what was published: a pull request, a review, a comment, an issue. */
export const KindGlyph = ({ kind, size = 14 }: { kind: ForgeReference['kind']; size?: number }) => {
  switch (kind) {
    case 'pullRequest':
      return <PullRequestIcon size={size} />
    case 'review':
      return <ReviewIcon size={size} />
    case 'comment':
      return <CommentIcon size={size} />
    case 'issue':
      return <IssueIcon size={size} />
  }
}

/** A pull request's state in a word, toned as the judgement it is: merged is good news, closed without merging is not. */
export const StatePill = ({ state, className }: { state: ForgeReference['state']; className?: string }) => {
  if (!state) return null
  const { label, tone } = stateTone(state)
  return (
    <span
      data-slot="publication-state"
      data-state={state}
      className={`inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-xs font-medium whitespace-nowrap ${softTone({ tone })} ${className ?? ''}`}
    >
      {label}
    </span>
  )
}
