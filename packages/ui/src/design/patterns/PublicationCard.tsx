import type { ForgeReference } from '@harnessdesk/protocol'

import { GitHubMark } from '@/components/BrandIcons'
import { CommentIcon, IssueIcon, PullRequestIcon, ReviewIcon } from '@/components/Icons'
import { openExternal } from '@/lib/desktop'
import { Button, IconTile, softTone, type Tone } from '@/design/ui'

const STATE: Record<NonNullable<ForgeReference['state']>, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'success' },
  draft: { label: 'Draft', tone: 'neutral' },
  merged: { label: 'Merged', tone: 'brand' },
  closed: { label: 'Closed', tone: 'danger' },
}

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
  const { label, tone } = STATE[state]
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

const figure = (n: number | null): string => (n === null ? '' : n.toLocaleString())

/**
 * Something on the forge, as a card: a pull request, a review, a comment.
 *
 * Built on the agent card's anatomy — crest, bands, verbs — because the reader
 * has learnt it there and a second anatomy for a second kind of thing would
 * cost them the learning twice. What differs is the subject: a pull request
 * has a state that is a judgement (merged is good news, closed without merging
 * is not), so its pill takes a tone where an agent's tile takes a tint.
 *
 * The text on it is the forge's own. The card shows the pull request's title
 * and the opening of its description exactly as GitHub holds them, which is
 * how the signature at the end of a short description appears here — as part
 * of the text, not as a claim the desk makes about it.
 */
export const PublicationCard = ({ reference }: { reference: ForgeReference }) => {
  const facts: string[] = []
  if (reference.author) facts.push(reference.author)
  if (reference.files !== null) facts.push(`${reference.files} file${reference.files === 1 ? '' : 's'}`)
  const sized = reference.additions !== null || reference.deletions !== null

  return (
    <div className="text-(--hd-card-foreground)" data-slot="publication-card" data-kind={reference.kind}>
      {/* Crest: the forge's mark, the address, the title as the forge has it. */}
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
        <IconTile>
          <GitHubMark size={16} />
        </IconTile>
        <span className="min-w-0 flex-1 pt-px">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate font-(family-name:--hd-font-code) text-xs text-(--hd-muted-foreground)">
              {reference.repo} #{reference.number}
            </span>
            <StatePill state={reference.state} />
          </span>
          {/* The whole of a title the clamp cuts. The row's chip had a tooltip
              carrying this and gave it up — the card opens on the same rest,
              and two boxes on one rest is the rule this card broke — so the
              heading is where a long title has to be readable in full. A
              different rest, on a surface already opened on purpose. */}
          {reference.title && (
            <span
              title={reference.title}
              className="mt-0.5 line-clamp-2 block text-sm leading-tight font-semibold"
            >
              {reference.title}
            </span>
          )}
        </span>
      </div>

      {(facts.length > 0 || sized) && (
        <div data-slot="publication-band" className="flex items-center gap-2 border-t border-(--hd-border-strong) px-3 py-2 text-xs">
          {facts.length > 0 && <span className="min-w-0 truncate text-(--hd-muted-foreground)">{facts.join(' · ')}</span>}
          {sized && (
            <span className="ml-auto flex shrink-0 gap-1.5 font-(family-name:--hd-font-code) tabular-nums">
              <span className="text-(--hd-success-ink)">+{figure(reference.additions ?? 0)}</span>
              <span className="text-(--hd-danger-ink)">−{figure(reference.deletions ?? 0)}</span>
            </span>
          )}
        </div>
      )}

      {reference.excerpt && (
        <div data-slot="publication-band" className="border-t border-(--hd-border-strong) px-3 py-2">
          <p className="line-clamp-6 text-xs leading-snug whitespace-pre-line text-(--hd-muted-foreground)">
            {reference.excerpt}
          </p>
        </div>
      )}

      <div data-slot="publication-band" className="flex items-center gap-1.5 border-t border-(--hd-border-strong) px-3 py-2">
        <Button size="sm" variant="secondary" onClick={() => openExternal(reference.url)}>
          Open on GitHub
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(reference.url)
          }}
        >
          Copy link
        </Button>
      </div>
    </div>
  )
}
