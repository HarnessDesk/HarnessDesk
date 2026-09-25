import { useState } from 'react'

import type { CardEvidence, EvidenceView } from '@harnessdesk/protocol'

import {
  Button,
  Chip,
  CodeText,
  Dialog,
  EmptyState,
  KeyValue,
  KeyValueRow,
  Note,
  StatePill,
  stateTone,
} from '../design'
import { openExternal } from '../lib/desktop'
import {
  byWords,
  cardChips,
  checkWords,
  chipWords,
  chipOf,
  revisionOfFact,
  shortSha,
  spokenChip,
  standingWords,
  type FactChip,
} from '../lib/evidence'
import { ReviewIcon } from './Icons'

/* A stale chip shows its fact and names its distance in the title, so the
   fact stays whole on a narrow card and the distance is one hover away (and
   in the dialog's "Now" row). */
const FactChipView = ({ chip, className }: { readonly chip: FactChip; readonly className?: string }) => (
  <Chip
    tone={chip.outcome === null ? 'neutral' : stateTone(chip.outcome).tone}
    stale={chip.stale}
    unknown={chip.unknown}
    {...(chip.since ? { title: chipWords(chip) } : {})}
    {...(className ? { className } : {})}
  >
    {chip.label}
  </Chip>
)

export const EvidenceChips = ({
  id,
  title,
  card,
}: {
  readonly id: number
  readonly title: string
  readonly card: CardEvidence | undefined
}) => {
  const [open, setOpen] = useState(false)
  const chips = cardChips(card)
  if (chips.length === 0) return null
  return (
    <>
      <Button
        variant="ghost"
        size="inline"
        data-board-row=""
        className="flex min-w-0 max-w-full basis-full shrink flex-wrap items-center justify-start gap-1 whitespace-normal"
        aria-label={`What the desk observed on #${id}: ${chips.map(spokenChip).join(', ')}`}
        onClick={() => setOpen(true)}
      >
        {chips.map((one) => (
          <FactChipView key={one.key} chip={one} />
        ))}
      </Button>
      {open && <ObservedDialog id={id} title={title} card={card} onClose={() => setOpen(false)} />}
    </>
  )
}

export const ObservedDialog = ({
  id,
  title,
  card,
  onClose,
}: {
  readonly id: number
  readonly title: string
  readonly card: CardEvidence | undefined
  readonly onClose: () => void
}) => {
  const facts = card?.facts ?? []
  const running = card?.running ?? []
  return (
    <Dialog
      title={`What the desk observed on #${id}`}
      subhead={title}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {running.map((one) => (
          <Note key={one.name}>{`${one.name} is running, since ${new Date(one.since).toLocaleTimeString()}. What it observes arrives here when it ends.`}</Note>
        ))}
        {facts.length === 0 ? (
          <EmptyState
            tight
            icon={<ReviewIcon />}
            title="Nothing observed yet"
            description="The desk records a check it runs, the branch's diff, and its pull request and CI. Nothing an agent says is recorded here."
          />
        ) : (
          facts.map((view) => <Fact key={view.record.id} view={view} />)
        )}
      </div>
    </Dialog>
  )
}

const Fact = ({ view }: { readonly view: EvidenceView }) => {
  const chip = chipOf(view)
  const fact = view.record.fact
  const at = revisionOfFact(fact)
  const branch = view.record.checkout?.branch ?? null
  return (
    <section aria-label={chipWords(chip)} className="flex flex-col gap-2">
      <FactChipView chip={chip} className="self-start" />
      <KeyValue>
        <KeyValueRow label="Observed">{new Date(view.record.observedAt).toLocaleString()}</KeyValueRow>
        {at !== null && <KeyValueRow label="At">{branch ? `${shortSha(at)} on ${branch}` : shortSha(at)}</KeyValueRow>}
        <KeyValueRow label="By">{byWords(view)}</KeyValueRow>
        {view.record.round != null && <KeyValueRow label="Round">{`Round ${view.record.round} of its flow`}</KeyValueRow>}
        <KeyValueRow label="Now">{standingWords(view.freshness)}</KeyValueRow>
        {fact.kind === 'check' && (
          <KeyValueRow label="Ran">
            <CodeText>{fact.run}</CodeText>
          </KeyValueRow>
        )}
        {fact.kind === 'check' && <KeyValueRow label="Result">{checkWords(fact)}</KeyValueRow>}
        {fact.kind === 'pr' && (
          <KeyValueRow label="State">
            <StatePill state={fact.state} />
          </KeyValueRow>
        )}
        {fact.kind === 'ci' && (
          <KeyValueRow label="Checks">
            {fact.checks.map((one) => `${one.name}: ${one.state}`).join(' · ')}
          </KeyValueRow>
        )}
        {fact.kind === 'diff' && <KeyValueRow label="Since">{shortSha(fact.from)}</KeyValueRow>}
      </KeyValue>
      {fact.kind === 'check' && fact.tail !== '' && (
        <CodeText as="pre" className="whitespace-pre-wrap break-all">
          {fact.tail}
        </CodeText>
      )}
      {fact.kind === 'pr' && fact.url !== null && (
        <Button variant="link" size="inline" className="self-start" onClick={() => openExternal(fact.url ?? '')}>
          {`Open pull request #${fact.number}`}
        </Button>
      )}
    </section>
  )
}
