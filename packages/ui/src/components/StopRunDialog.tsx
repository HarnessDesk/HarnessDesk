import { useEffect, useRef, useState } from 'react'
import { ActionError, ConfirmDialog, IconTile, Input, ListRow, ListRows, Text } from '../design'
import { sanitizeText } from '../lib/sanitize'
import { AgentIcon } from './Icons'

export interface StopRunSeat {
  id: string
  name: string
  interrupt: boolean | undefined
}
/** The Run stops before the host asks its Seats to stop. A failed cleanup can be asked again. */
export const StopRunDialog = ({ seats, onStop, onClose, refusal }: {
  seats: readonly StopRunSeat[]
  onStop: (reason: string) => Promise<unknown>
  onClose: () => void
  refusal?: string | null
}) => {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const active = useRef(false)
  const pending = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const tooLong = note.trim().length > 4096
  const stop = async (): Promise<void> => {
    if (pending.current || tooLong || refusal) return
    pending.current = true
    setBusy(true)
    setProblem(null)
    try {
      await onStop(note.trim() || 'You stopped this Run. No further step starts.')
      if (active.current) onClose()
    } catch (error) {
      if (active.current) setProblem(error instanceof Error && error.message ? error.message : 'The stop could not finish. Try again to finish stopping this Run.')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  return <ConfirmDialog title="Stop this Run?" confirmLabel="Stop run" cancelLabel="Keep running"
    busy={busy} busyLabel="Stopping…" pending={tooLong || Boolean(refusal)}
    onConfirm={() => void stop()} onCancel={onClose}>
    <div className="flex min-w-0 flex-col gap-3">
      <p>The Run stops now and no further step starts.</p>
      <p>Cards, findings and recorded cost are kept. Stopping a Seat is best effort; if it cannot stop now, its current turn finishes and nothing follows it.</p>
      {seats.length ? <ListRows aria-label="Seats to stop">
        {seats.map(seat => <ListRow key={seat.id} data-stop-seat={seat.id} wrapTitle wrapSubtitle
          lead={<IconTile shape="face" size="sm"><AgentIcon /></IconTile>}
          title={sanitizeText(seat.name)} subtitle={seat.interrupt === true ? 'stops now' : 'stops when its current turn ends'} />)}
      </ListRows> : <Text role="meta">No open Seats in this Run.</Text>}
      <Input aria-label="Note" placeholder="Add a note (optional)" value={note} maxLength={4096} disabled={busy}
        onChange={event => setNote(event.target.value)} />
      {tooLong && <ActionError>Keep the note within 4,096 characters.</ActionError>}
      {problem && <ActionError>{sanitizeText(problem)}</ActionError>}
      {refusal && <ActionError>{sanitizeText(refusal)}</ActionError>}
    </div>
  </ConfirmDialog>
}
