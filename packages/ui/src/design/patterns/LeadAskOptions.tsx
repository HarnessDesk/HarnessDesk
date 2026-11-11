import type { LeadAsk, LeadAskState } from '@harnessdesk/protocol'
import { Button } from '../ui/button'
import { Text } from './Settings'
import { sanitizeText } from '../../lib/sanitize'
import { CheckIcon } from '../../components/Icons'

const clock = (at: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
/** The time of day for today; an earlier day names the day too, so a receipt never reads as today's when it is not. */
const when = (at: number, now = Date.now()) => new Date(at).toDateString() === new Date(now).toDateString() ? clock(at)
  : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)}, ${clock(at)}`

/** What became of a question, as one word for `data-status`: a replaced question is expired to the host, and says why here. */
const statusOf = (settled: LeadAskState | undefined) => settled?.replacedBy ? 'replaced' : settled?.status

/**
 * The composer is the free-text answer. A question nobody can answer any more keeps its options as the same control,
 * inert, so it still reads as the question it was; a line under it says why: who answered, on which device and when,
 * or that time ran out or a newer question took its place, and that nothing was done.
 */
export const LeadAskOptions = ({ ask, onAnswer, disabled = false, picked, settled }: {
  readonly ask: LeadAsk
  readonly onAnswer?: (label: string) => void
  readonly disabled?: boolean
  readonly picked?: string
  /** What the host recorded for this question; absent before the host has said. */
  readonly settled?: LeadAskState
}) => {
  const status = statusOf(settled)
  const answer = status === 'expired' || status === 'replaced' || status === 'answered' ? undefined : onAnswer
  const chosen = settled?.answer?.option ?? picked
  return <section data-slot="lead-ask" data-status={status} data-ask={settled?.id} aria-label={sanitizeText(ask.question)}>
    <Text as="p" role="prose">{sanitizeText(ask.question)}</Text>
    <div data-slot="lead-ask-options" className="flex flex-wrap gap-2">
      {ask.options.map(option => answer
        ? <Button key={option.id} variant={option.id === ask.recommended ? 'primary' : 'secondary'} disabled={disabled} onClick={() => answer(option.label)}>{sanitizeText(option.label)}</Button>
        : <Button key={option.id} variant="secondary" disabled data-picked={chosen === option.label ? 'true' : undefined}
          aria-pressed={chosen === option.label} title={chosen === option.label ? 'Picked' : undefined}>{chosen === option.label && <CheckIcon size={14} aria-hidden />}{sanitizeText(option.label)}</Button>)}
    </div>
    {status === 'replaced' && <Text as="p" role="muted" data-slot="lead-ask-receipt">Replaced by a newer question · nothing was done</Text>}
    {status === 'expired' && <Text as="p" role="muted" data-slot="lead-ask-receipt">Expired · nothing was done</Text>}
    {status === 'answered' && settled?.answer && <Text as="p" role="muted" data-slot="lead-ask-receipt">{`Answered by you on ${sanitizeText(settled.answer.by)} · ${when(settled.answer.at)}`}</Text>}
  </section>
}
