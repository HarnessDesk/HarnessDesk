import type { LeadAsk } from '@harnessdesk/protocol'
import { Button } from '../ui/button'
import { Chip, Text } from './Settings'
import { sanitizeText } from '../../lib/sanitize'

/** The composer is the free-text answer; settled choices remain readable without controls. */
export const LeadAskOptions = ({ ask, onAnswer, disabled = false, picked }: {
  readonly ask: LeadAsk
  readonly onAnswer?: (label: string) => void
  readonly disabled?: boolean
  readonly picked?: string
}) => <section data-slot="lead-ask" aria-label={sanitizeText(ask.question)}>
  <Text as="p" role="prose">{sanitizeText(ask.question)}</Text>
  <div data-slot="lead-ask-options" className="flex flex-wrap gap-2">
    {ask.options.map(option => onAnswer
      ? <Button key={option.id} variant={option.id === ask.recommended ? 'primary' : 'secondary'} disabled={disabled} onClick={() => onAnswer(option.label)}>{sanitizeText(option.label)}</Button>
      : <span key={option.id} data-picked={picked === option.label ? 'true' : undefined}><Chip variant="quiet" tone="neutral">{sanitizeText(option.label)}{picked === option.label ? ' · Picked' : ''}</Chip></span>)}
  </div>
</section>
