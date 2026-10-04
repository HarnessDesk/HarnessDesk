import { useId, useState } from 'react'
import { ActionError, Button, Input, Text } from '../design'
import { wordOf } from '../lib/agents'
import type { StepAnswer as Answer, StepDoor } from '../lib/needs-you'
import { sanitizeText } from '../lib/sanitize'

const wordsOf = (answer: Answer): string => answer.outcome === null ? 'Mark done' : sanitizeText(wordOf(answer.outcome))

/**
 * Answering a card a Flow addressed to a person: one button for each word its
 * role declares, an optional note the next step reads, and what each answer
 * will do, said before any is given.
 *
 * The same controls stand in the Overview's Needs-you rows and in the Run
 * inspector, and they make the request the board makes. A refusal stays on
 * screen with the answer it refused disabled, because the host does not yet
 * say beforehand what it will take; the other words stay open.
 */
export const StepAnswer = ({ door, onAnswer, onOpenBoard }: {
  door: StepDoor
  /** Gives the answer; rejects with the host's refusal. */
  onAnswer: (card: number, outcome: string | null, note: string) => Promise<void>
  onOpenBoard: () => void
}) => {
  const effectId = useId()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set())
  const [problem, setProblem] = useState<string | null>(null)
  if (door.kind === 'review') {
    return (
      <div data-slot="step-answer" data-kind="review" className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={onOpenBoard} title="This step records which attempt you choose, and only the board's picker does that.">
          Pick an attempt on the board
        </Button>
      </div>
    )
  }
  const effects = door.answers.flatMap((one) => one.effect === null ? [] : [one.effect])
  const give = async (answer: Answer): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await onAnswer(door.card, answer.outcome, note.trim())
    } catch (error) {
      setRefused((was) => new Set(was).add(answer.outcome ?? ''))
      setProblem(error instanceof Error && error.message ? error.message : `The host did not take that answer on #${door.card}; the card is as it was.`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-slot="step-answer" data-kind="answer" className="flex min-w-0 flex-col gap-2">
      {effects.length > 0 && (
        <div data-slot="step-effect" id={effectId}>
          <Text as="p" role="meta" className="[overflow-wrap:anywhere]">{sanitizeText(effects.join(' '))}</Text>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Note" placeholder="Add a note (optional)" className="min-w-40 flex-1"
          title="Kept on the card as your handoff, which the next step reads."
          value={note} disabled={busy} onChange={(event) => setNote(event.target.value)}
        />
        <div role="group" aria-label="Your answer" {...(effects.length > 0 ? { 'aria-describedby': effectId } : {})} className="flex flex-wrap items-center gap-2">
          {door.answers.map((answer) => (
            <Button
              key={answer.outcome ?? ''} variant="outline" disabled={busy || refused.has(answer.outcome ?? '')}
              {...(answer.effect === null ? {} : { title: sanitizeText(answer.effect) })}
              onClick={() => void give(answer)}
            >
              {wordsOf(answer)}
            </Button>
          ))}
        </div>
      </div>
      {problem !== null && <ActionError>{problem}</ActionError>}
    </div>
  )
}
