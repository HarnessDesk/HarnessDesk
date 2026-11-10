import type { LeadAsk, LeadAskState } from '@harnessdesk/protocol'
import { Button } from '../ui/button'
import { Chip, Text } from './Settings'
import { sanitizeText } from '../../lib/sanitize'

const clock = (at: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)

/**
 * The composer is the free-text answer; settled choices remain readable without controls. A question the host has
 * expired offers no answer and says so; one that was answered says who answered it, on which device and when.
 */
export const LeadAskOptions = ({ ask, onAnswer, disabled = false, picked, settled }: {
  readonly ask: LeadAsk
  readonly onAnswer?: (label: string) => void
  readonly disabled?: boolean
  readonly picked?: string
  /** What the host recorded for this question; absent for a question with no clock. */
  readonly settled?: LeadAskState
}) => {
  const answer = settled?.status === 'expired' ? undefined : onAnswer
  const chosen = picked ?? settled?.answer?.option
  return <section data-slot="lead-ask" data-status={settled?.status} aria-label={sanitizeText(ask.question)}>
    <Text as="p" role="prose">{sanitizeText(ask.question)}</Text>
    <div data-slot="lead-ask-options" className="flex flex-wrap gap-2">
      {ask.options.map(option => answer
        ? <Button key={option.id} variant={option.id === ask.recommended ? 'primary' : 'secondary'} disabled={disabled} onClick={() => answer(option.label)}>{sanitizeText(option.label)}</Button>
        : <span key={option.id} data-picked={chosen === option.label ? 'true' : undefined}><Chip variant="quiet" tone="neutral">{sanitizeText(option.label)}{chosen === option.label ? ' · Picked' : ''}</Chip></span>)}
    </div>
    {settled?.status === 'expired' && <Text as="p" role="muted" data-slot="lead-ask-receipt">Expired · nothing was done</Text>}
    {settled?.status === 'answered' && settled.answer && <Text as="p" role="muted" data-slot="lead-ask-receipt">{`Answered · ${sanitizeText(settled.answer.by)} · ${clock(settled.answer.at)}`}</Text>}
  </section>
}
