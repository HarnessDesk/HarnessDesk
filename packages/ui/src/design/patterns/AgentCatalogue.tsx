import { useId, useState, type ReactNode } from 'react'

import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { DisclosureChevron } from '../ui/disclosure-chevron'
import { Chip, Text } from './Settings'
import { IssueMark } from './Menu'
import styles from './AgentCatalogue.module.css'

/** A responsive catalogue of reusable roles; the host remains the authority for their seats. */
export const AgentCatalogue = ({ children }: { readonly children: ReactNode }) =>
  <div data-slot="agent-catalogue" className={styles.grid}>{children}</div>

export interface AgentCatalogueCardProps {
  readonly name: string
  readonly description: string
  readonly face: ReactNode
  /** The observed seat label, including its model and effort when the runtime named them. */
  readonly runtime?: string | null
  readonly ceiling?: ReactNode
  readonly status?: string | null
  readonly problem?: string | null
  readonly broken?: boolean
  readonly onOpen: () => void
}

/** One role, its purpose, and its actual seating result, each with a distinct place. */
export const AgentCatalogueCard = ({ name, description, face, runtime, ceiling, status, problem, broken = false, onOpen }: AgentCatalogueCardProps) => {
  const descriptionId = useId()
  const runtimeId = useId()
  const stateId = useId()
  const problemId = useId()
  return <Button variant="ghost" size="pattern" render={<Card as="button" spacing="compact" />} className={styles.card} data-slot="agent-card" data-kind="record"
    aria-label={name} aria-describedby={[description ? descriptionId : null, runtime ? runtimeId : null, status || ceiling ? stateId : null, problem ? problemId : null].filter(Boolean).join(' ') || undefined} onClick={onOpen}>
    <span className={styles.head}>
      <span data-slot="agent-card-face" className={styles.face}>{face}</span>
      <span data-slot="agent-card-title" className={styles.name}><Text as="span" role="subject" truncate title={name}>{name}</Text></span>
    </span>
    <span id={descriptionId} data-slot="agent-card-description" className={styles.description}>
      <Text as="span" role="prose" ink="secondary">{description}</Text>
    </span>
    <span className={styles.foot}>
      {runtime && <span id={runtimeId} data-slot="agent-card-runtime" className={styles.runtime}><Text as="span" role="meta" ink="secondary" truncate title={runtime}>{runtime}</Text></span>}
      <span data-slot="agent-card-state" className={styles.state}>
        {(status || ceiling) && <span id={stateId} data-slot="agent-card-state-reading" className="inline-flex">
          {status ? <Chip tone={problem ? broken ? 'danger' : 'warning' : 'neutral'} size="sm">{status}</Chip> : ceiling}
        </span>}
        {problem && <IssueMark message={problem} tone={broken ? 'danger' : 'warning'} />}
      </span>
    </span>
    {problem && <span id={problemId} className="sr-only">{problem}</span>}
  </Button>
}

/** Sources and lower-precedence copies stay available without repeating source paragraphs between role cards. */
export const AgentCatalogueSources = ({ children }: { readonly children: ReactNode }) => {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  return <div data-slot="agent-catalogue-sources" className={styles.sources}>
    <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(value => !value)}>
      <DisclosureChevron open={open} />Sources and precedence
    </Button>
    {open && <div id={contentId} className={styles.sourceContent}>{children}</div>}
  </div>
}
