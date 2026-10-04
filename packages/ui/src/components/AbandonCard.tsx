import { useEffect, useRef, useState } from 'react'
import type { FlowExecution, Intent } from '@harnessdesk/protocol'
import { ActionError, Button, ConfirmDialog } from '../design'
import { abandonable, abandonEffect } from '../lib/needs-you'
import { sanitizeText } from '../lib/sanitize'

/**
 * Abandoning a card, asked the way the app asks before it does something
 * that goes on: the question says first what the rule after the card's role
 * will do, which the host's reply never says.
 *
 * The sentence is worked out from the Run's own frozen Flow (`abandonEffect`)
 * and not from what the host answers, which for the window is nothing. A
 * refusal stays in the question with the act disabled, because the host does
 * not yet say beforehand what it will take.
 */
type AbandonCardProps = {
  execution: FlowExecution
  cards: readonly Intent[]
  card: Intent
  /** The Seat that holds a claimed card, when it is known. */
  holder?: string | null | undefined
  /** Abandons the card; rejects with the host's refusal. */
  onAbandon: (card: number) => Promise<void>
  onStop?: (() => void) | undefined
}

/** Finishing a card unmounts its question, including any request still waiting on the host. */
export const AbandonCard = (props: AbandonCardProps) => abandonable(props.card)
  ? <AbandonQuestion key={JSON.stringify([props.execution.id, props.card.id])} {...props} />
  : null

const AbandonQuestion = ({ execution, cards, card, holder, onAbandon, onStop }: AbandonCardProps) => {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const active = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      await onAbandon(card.id)
      if (active.current) setAsking(false)
    } catch (error) {
      if (active.current) setProblem(error instanceof Error && error.message ? error.message : `The host did not abandon #${card.id}; the card is as it was.`)
    } finally {
      if (active.current) setBusy(false)
    }
  }
  const who = holder ? sanitizeText(holder) : null
  return (
    <>
      <Button variant="outline" title={execution.state !== 'running' ? 'Releases this card on the board; no further step starts.' : undefined}
        onClick={() => { setProblem(null); setAsking(true) }}>Abandon card…</Button>
      {asking && (
        <ConfirmDialog
          title={`Abandon card #${card.id}?`}
          confirmLabel="Abandon card" cancelLabel="Keep it"
          busy={busy} busyLabel="Abandoning…" pending={problem !== null}
          onConfirm={() => void confirm()} onCancel={() => setAsking(false)}
        >
          <div className="flex flex-col gap-2">
            <p>{sanitizeText(abandonEffect(execution, cards, card))}</p>
            {card.state === 'claimed' && <p>{who ?? 'A Seat'} holds this card now. Abandoning takes it back, and {who ?? 'it'} cannot finish it.</p>}
            {execution.state === 'running' && onStop && <div><Button variant="link" size="inline-link" disabled={busy}
              onClick={() => { setAsking(false); onStop() }}>Stop the run instead</Button></div>}
            {problem !== null && <ActionError>{problem}</ActionError>}
          </div>
        </ConfirmDialog>
      )}
    </>
  )
}
