import { useState } from 'react'
import { ComparisonNotice } from '../design'
import type { ComparisonVerdictModel } from '../lib/comparison-verdict'
import { sanitizeText } from '../lib/sanitize'

export const ComparisonVerdict = ({ verdict, nameOfSeat, onOpenRun, onPick, dismissed = false, onDismiss }: {
  verdict: ComparisonVerdictModel | null
  nameOfSeat: (seat: string | null) => string
  onOpenRun: (row: string | null) => void
  onPick: () => void
  dismissed?: boolean
  onDismiss?: () => void
}) => {
  const id = verdict?.id ?? null
  const [dismissal, setDismissal] = useState({ id, hidden: false })
  // An ordinary refresh keeps a dismissal. Any changed verdict, including a
  // return to a previously picked attempt, gets its own entrance.
  if (dismissal.id !== id) setDismissal({ id, hidden: false })
  if (!verdict || dismissed || (dismissal.id === id && dismissal.hidden)) return <ComparisonNotice />
  const waiting = verdict.kind === 'waiting'
  const judge = !waiting ? verdict.judge.kind === 'person' ? 'You' : sanitizeText(nameOfSeat(verdict.judge.seat)) : null
  return <ComparisonNotice
    key={id}
    waiting={waiting}
    title={waiting ? 'Your pick is next' : <>{judge} picked {verdict.attempt.label}</>}
    reason={!waiting && verdict.reason ? sanitizeText(verdict.reason) : undefined}
    action={waiting ? { label: 'Pick an attempt…', onSelect: onPick }
      : { label: 'Merge the picked change', onSelect: () => onOpenRun(verdict.next?.id ?? verdict.judge.id) }}
    onDismiss={() => onDismiss ? onDismiss() : setDismissal({ id, hidden: true })}
  />
}
