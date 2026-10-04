import { useEffect, useState } from 'react'
import type { FlowExecution } from '@harnessdesk/protocol'
import { ActionError, Button, Dialog, FormStack, Note } from '../design'
import { useStore } from '../state/context'
import { FlowStart, type FlowChoice, type FlowStartProps } from './FlowStart'

/** Fresh consent to the saved Flow, with editable inputs and seating; never a check retry. */
export const RunAgain = ({ execution, root, sentence, onClose, onStarted }: {
  readonly execution: FlowExecution
  readonly root: string
  readonly sentence: string
  readonly onClose: () => void
  readonly onStarted: (execution: FlowExecution) => void
}) => {
  const store = useStore()
  const [initial, setInitial] = useState<FlowStartProps['initial']>(undefined)
  const [choice, setChoice] = useState<FlowChoice | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void store.flowExecutionSource(execution.id).then(saved => {
      if (live) setInitial({ ...saved, seats: execution.overrides, attended: execution.attended !== false })
    }, error => { if (live) setProblem(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [execution, store])
  const start = async () => {
    if (!choice || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const next = await store.startFlowGoal({ root, sentence, ...choice, continues: execution.id })
      onStarted(next)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      // A refused start may already have redeemed its one-use token. Keep the edits, and preview them afresh.
      setChoice(null)
      setInitial({ source: choice.source, vars: choice.vars, seats: choice.seats, attended: choice.attended })
      setBusy(false)
    }
  }
  return <Dialog title="Run again" size="md" onClose={onClose} footer={<>
    <Button disabled={!choice || busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start'}</Button>
    <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
  </>}>
    <FormStack>
      <Note>This starts a new Run on this Team. The earlier Run’s cards, findings and output are kept.</Note>
      {initial ? <FlowStart root={root} continues={execution.id} initial={initial} disabled={busy} onChange={setChoice} /> : !problem && <Note>Reading the earlier Run’s inputs…</Note>}
      {problem && <ActionError>{problem}</ActionError>}
    </FormStack>
  </Dialog>
}
