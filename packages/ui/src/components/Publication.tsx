import type { PublicationItem } from '@harnessdesk/protocol'

import { openExternal } from '../lib/desktop'
import { AgentHoverCard } from './AgentCards'
import { GitHubMark } from './BrandIcons'
import { Button, CodeText, KindGlyph, PublicationCard, StatePill, Text, publicationVerb } from '../design'
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
 */
export const Publication = ({ item }: { item: PublicationItem }) => {
  const { reference } = item
  const address = `${reference.repo} #${reference.number}`
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
    </div>
  )
}
