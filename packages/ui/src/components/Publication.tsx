import { useState } from 'react'

import type { PublicationItem } from '@harnessdesk/protocol'

import { openExternal } from '../lib/desktop'
import { useStore } from '../state/context'
import { AgentHoverCard } from './AgentCards'
import { GitHubMark } from './BrandIcons'
import { Button, CodeText, KindGlyph, PublicationCard, StatePill, Text, publicationVerb } from '../design'
import { FrontDoor } from './FrontDoor'
import styles from './Publication.module.css'

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
