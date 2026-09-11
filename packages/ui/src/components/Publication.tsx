import type { PublicationItem } from '@harnessdesk/protocol'

import { openExternal } from '../lib/desktop'
import { AgentHoverCard } from './AgentCards'
import { GitHubMark } from './BrandIcons'
import { KindGlyph, PublicationCard, StatePill, publicationVerb } from '../design/patterns/PublicationCard'
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
      <span className={styles.publicationIcon}>
        <KindGlyph kind={reference.kind} size={13} />
      </span>
      <span className={styles.publicationVerb}>{publicationVerb(reference)}</span>
      <AgentHoverCard body={() => <PublicationCard reference={reference} />} side="bottom" align="start">
        <a
          className={styles.publicationChip}
          href={reference.url}
          title={reference.title ?? address}
          onClick={(event) => {
            event.preventDefault()
            openExternal(reference.url)
          }}
        >
          <GitHubMark size={12} />
          <span className={styles.publicationAddress}>{address}</span>
        </a>
      </AgentHoverCard>
      <StatePill state={reference.state} />
    </div>
  )
}
