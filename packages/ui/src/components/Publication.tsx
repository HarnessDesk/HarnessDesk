import { useState } from 'react'

import type { ForgeReference, PublicationItem } from '@harnessdesk/protocol'

import { openExternal } from '../lib/desktop'
import { useStore } from '../state/context'
import { AgentHoverCard } from './AgentCards'
import { GitHubMark } from './BrandIcons'
import { Button, CodeText, IconTile, KindGlyph, StatePill, Text, publicationVerb } from '../design'
import { FrontDoor } from './FrontDoor'
import styles from './Publication.module.css'

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
 *
 * Rendered only from this row's hover card (below): a publication reference is
 * a fact of this conversation, not a shared catalogue piece, so its anatomy
 * lives here rather than in `design/patterns/` — `StatePill` and `KindGlyph`,
 * which other screens also draw, stay behind in `PublicationCard.tsx`.
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
            <Text role="meta" className="min-w-0 truncate">
              <CodeText>{reference.repo} #{reference.number}</CodeText>
            </Text>
            <StatePill state={reference.state} />
          </span>
          {/* The whole of a title the clamp cuts. The row's chip had a tooltip
              carrying this and gave it up — the card opens on the same rest,
              and two boxes on one rest is the rule this card broke — so the
              heading is where a long title has to be readable in full. A
              different rest, on a surface already opened on purpose. */}
          {reference.title && (
            <Text
              as="span"
              role="row"
              weight="semibold"
              title={reference.title}
              className="mt-0.5 block line-clamp-2"
            >
              {reference.title}
            </Text>
          )}
        </span>
      </div>

      {(facts.length > 0 || sized) && (
        <div data-slot="publication-band" className="flex items-center gap-2 border-t border-(--hd-border-strong) px-3 py-2">
          {facts.length > 0 && (
            <Text role="meta" className="min-w-0 truncate">{facts.join(' · ')}</Text>
          )}
          {sized && (
            <span className="ml-auto flex shrink-0 gap-1.5">
              <Text role="meta" tone="success" numeric><CodeText>+{figure(reference.additions ?? 0)}</CodeText></Text>
              <Text role="meta" tone="danger" numeric><CodeText>−{figure(reference.deletions ?? 0)}</CodeText></Text>
            </span>
          )}
        </div>
      )}

      {reference.excerpt && (
        <div data-slot="publication-band" className="border-t border-(--hd-border-strong) px-3 py-2">
          <Text as="p" role="meta" className="line-clamp-6 whitespace-pre-line">
            {reference.excerpt}
          </Text>
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

/**
 * A publication in the transcript: what the conversation put on the forge.
 *
 * One line, in the register of the notice rows around it — a verb, then the
 * thing as a chip, then its state — because the agent's own sentence about
 * it is the next row down and this is the record, not the narration. The
 * chip is the object: hovering opens the card with the forge's own text on
 * it, pressing opens the page. The signature is not repeated here; it is in
 * the description, and the card shows the description.
 *
 * A pull-request reference is also a host-known start: `root` (this row's
 * project) plus the forge's own number is enough for the front door to
 * resolve the exact PR, no checkout and no retyping. An ordinary adjacent
 * button, not a second interactive thing inside the chip's own link — a
 * review or comment reference is a record of what already happened, not a
 * fresh start, so only `pullRequest` offers it, and only once this row knows
 * which project it belongs to.
 */
export const Publication = ({ item, root }: { item: PublicationItem; root?: string }) => {
  const store = useStore()
  const [reviewing, setReviewing] = useState(false)
  const { reference } = item
  const address = `${reference.repo} #${reference.number}`
  const canReview = root !== undefined && reference.kind === 'pullRequest'
  return (
    <div className={styles.publication} data-kind={reference.kind} role="status">
      <Text role="meta" className={styles.publicationIcon}>
        <KindGlyph kind={reference.kind} size={13} />
      </Text>
      <Text role="meta" ink="secondary">{publicationVerb(reference)}</Text>
      <AgentHoverCard body={() => <PublicationCard reference={reference} />} side="bottom" align="start">
        {/* No tooltip of its own. The card opens on this same rest and prints
            the forge's title in its crest, so a `title` here was a second box
            over the first — repeating the card's heading where the forge gave
            a title, and the chip's own text where it did not. The whole of a
            long title is on the card's heading, which carries it. */}
        <Button
          className={styles.publicationChip}
          variant="outline"
          size="chip"
          render={<a href={reference.url} />}
          onClick={(event) => {
            event.preventDefault()
            openExternal(reference.url)
          }}
        >
          <GitHubMark size={12} />
          <CodeText size="inherit" className={styles.publicationAddress}>{address}</CodeText>
        </Button>
      </AgentHoverCard>
      <StatePill state={reference.state} />
      {canReview && (
        <Button
          variant="quiet"
          size="chip"
          title="Choose a shape and start a team reviewing this pull request."
          onClick={() => setReviewing(true)}
        >
          Review…
        </Button>
      )}
      {reviewing && root !== undefined && (
        <FrontDoor
          context={{ kind: 'pull-request', root, number: reference.number }}
          onClose={() => setReviewing(false)}
          onStarted={(execution) => {
            store.openGoal(execution.goal)
            setReviewing(false)
          }}
        />
      )}
    </div>
  )
}
