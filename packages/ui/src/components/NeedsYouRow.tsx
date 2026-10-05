import { ActionError, ApprovalCode, Button, Chip, ListRow, Text } from '../design'
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
    {detail.code !== undefined && <ApprovalCode>{sanitizeText(detail.code)}</ApprovalCode>}
    {detail.inputTo && (
      <div className="flex min-w-0 flex-col gap-1">
        <Text role="meta" as="div"><Text role="meta" ink="secondary">To</Text></Text>
        <ApprovalCode>{sanitizeText(detail.inputTo.command)}</ApprovalCode>
      </div>
    )}
    {detail.folder && <Text role="meta" as="div" title={sanitizeText(detail.folder)} className="[overflow-wrap:anywhere]">
      <Text role="meta" ink="secondary">In</Text>{' '}{sanitizeText(detail.folder)}
    </Text>}
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
  const request = answers && item.approval !== undefined && item.sessionKey !== undefined
    ? answers.approvalDoor(item.approval, item.sessionKey)
    : null
  const refusals = request && answers
    ? answers.approvalRefusals(request.key, request.approval)
    : []
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
                disabled={refusals.some((refusal) => refusal.choiceId === choice.id)}
                {...(choice.title ? { title: sanitizeText(choice.title) } : {})}
                onClick={() => { void answers.respond(request.key, request.approval, choice.decision, choice.id) }}
              >
                {sanitizeText(choice.label)}
              </Button>
            ))}
            {request.elsewhere && onOpenSeat && seat !== null && (
              <Button variant="default" onClick={() => onOpenSeat(seat)}>Answer in the conversation</Button>
            )}
          </div>
          {refusals.map((refusal) => <ActionError key={refusal.choiceId}>{sanitizeText(refusal.message)}</ActionError>)}
        </div>
      )
      : undefined
  return (
    <ListRow
      data-kind={item.kind}
      wrapTitle={item.kind === 'card'}
      title={(
        <span className={item.kind === 'card' ? 'flex min-w-0 flex-wrap items-center gap-2' : 'flex min-w-0 items-center gap-2'}>
          {item.kind === 'card' && <Text role="subject">{words(item.summary)}</Text>}
          {name && <Text role="member" truncate>{words(name)}</Text>}
          <Chip tone="warning">{item.kind === 'card' ? `#${item.card}` : item.kind === 'question' ? 'Question' : 'Approval'}</Chip>
          {request?.detail.inputTo && <Chip tone="neutral">stdin</Chip>}
        </span>
      )}
      subtitle={item.kind === 'card' ? undefined : words(item.summary)} wrapSubtitle meta={controls}
    />
  )
}
