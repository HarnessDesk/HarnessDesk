import { ApprovalCode, Button, Chip, ListRow, Text } from '../design'
import type { ApprovalDetail, NeedsYouAnswers } from '../lib/needs-you'
import { sanitizeHtml, sanitizeText } from '../lib/sanitize'
import type { NeedsYouItem } from '../lib/team-overview'
import { StepAnswer } from './StepAnswer'

/** Agent words stay plain text, with the transcript's sanitation boundary. */
const words = (value: string): string => {
  const box = document.createElement('template')
  box.innerHTML = sanitizeHtml(value)
  return box.content.textContent ?? ''
}

/** How many of a long list a row names before it says how many more. */
const LISTED = 6

const Detail = ({ detail }: { detail: ApprovalDetail }) => (
  <>
    {detail.reason && <Text role="meta" as="div" className="[overflow-wrap:anywhere]">{sanitizeText(detail.reason)}</Text>}
    {detail.code && <ApprovalCode>{sanitizeText(detail.code)}</ApprovalCode>}
    {detail.lists?.map((list) => (
      <Text key={list.label} role="meta" as="div" className="[overflow-wrap:anywhere]" title={sanitizeText(list.items.join('\n'))}>
        <Text role="meta" ink="secondary">{list.label}</Text>{' '}
        {sanitizeText(list.items.slice(0, LISTED).join(', '))}{list.items.length > LISTED ? `, and ${list.items.length - LISTED} more` : ''}
      </Text>
    ))}
  </>
)

/**
 * One thing the Team is waiting on a person for, with the way to answer it.
 *
 * A person's card is answered with its step's own controls; an approval or a
 * question offers the agent's own choices, and sends the decision the docked
 * approval sends, so whichever door answers first wins. What is being approved
 * is shown with it. Where nothing can answer (no door, or none given) the row
 * is the sentence alone, as it was.
 */
export const NeedsYouRow = ({ item, name, answers, onOpenSeat }: {
  item: NeedsYouItem
  /** The Seat that asks, when there is one. */
  name: string | null
  answers?: NeedsYouAnswers | undefined
  onOpenSeat?: ((seat: string) => void) | undefined
}) => {
  const step = answers && item.kind === 'card' && item.card !== null ? answers.stepDoor(item.card) : null
  const request = answers && item.approval !== undefined ? answers.approvalDoor(item.approval) : null
  const seat = item.seat
  const controls = step && answers
    ? <StepAnswer door={step} onAnswer={answers.answerStep} onOpenBoard={answers.openBoard} />
    : request && answers && item.approval !== undefined
      ? (
        <div data-slot="request-answer" className="flex min-w-0 flex-col gap-2">
          <Detail detail={request.detail} />
          <div role="group" aria-label="Your answer" className="flex flex-wrap items-center gap-2">
            {request.choices.map((choice) => (
              <Button
                key={choice.id} variant={choice.primary ? 'default' : 'outline'}
                {...(choice.title ? { title: sanitizeText(choice.title) } : {})}
                onClick={() => answers.respond(request.key, item.approval!, choice.decision)}
              >
                {sanitizeText(choice.label)}
              </Button>
            ))}
            {request.elsewhere && onOpenSeat && seat !== null && (
              <Button variant="default" onClick={() => onOpenSeat(seat)}>Answer in the conversation</Button>
            )}
          </div>
        </div>
      )
      : undefined
  return (
    <ListRow
      data-kind={item.kind}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          {name && <Text role="member" truncate>{words(name)}</Text>}
          <Chip tone="warning">{item.kind === 'card' ? `#${item.card}` : item.kind === 'question' ? 'Question' : 'Approval'}</Chip>
        </span>
      )}
      subtitle={words(item.summary)} wrapSubtitle meta={controls}
    />
  )
}
