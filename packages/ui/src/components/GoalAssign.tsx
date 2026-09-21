import { useMemo, useState } from 'react'

import { sessionKey, splitSessionKey, type GoalView, type SessionKey } from '@harnessdesk/protocol'

import { Button, Dialog, Note, RadioGroup, RadioGroupItem, Row, Rows } from '../design'
import { groupByProject } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { useSnapshot, useStore } from '../state/context'

export const GoalAssign = ({
  view,
  card,
  onClose,
}: {
  readonly view: GoalView
  readonly card: number
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [choice, setChoice] = useState<SessionKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const loose = useMemo(() => {
    const members = new Set(view.members.filter((seat) => seat.closed === null).map((seat) => String(sessionKey(seat.session.runtime, seat.session.sessionId))))
    const groups = groupByProject(snapshot.history, snapshot.workspaces.map((workspace) => workspace.path), snapshot.workspace)
    return (groups.find((group) => group.root === view.goal.root)?.sessions ?? []).filter((summary) => {
      const key = String(sessionKey(summary.runtime, summary.id))
      return !members.has(key) && summary.status.type !== 'active'
    })
  }, [snapshot.history, snapshot.workspace, snapshot.workspaces, view.goal.root, view.members])

  const assign = async (): Promise<void> => {
    if (choice === null || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const session = splitSessionKey(choice)
      await store.assignGoal(view.goal.id, card, { runtime: session.runtime, sessionId: session.id })
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The desk did not assign that conversation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Assign a conversation"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button disabled={choice === null || busy} onClick={() => void assign()}>Assign</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {loose.length > 0 ? (
        <RadioGroup value={choice ?? ''} onValueChange={(value) => setChoice(value as SessionKey)} aria-label="Conversation">
          <Rows>
            {loose.map((summary) => {
              const key = sessionKey(summary.runtime, summary.id)
              return (
                <Row
                  key={String(key)}
                  title={sessionLabel(summary.title, summary.preview)}
                  desc={summary.cwd}
                  control={<RadioGroupItem value={key} aria-label={sessionLabel(summary.title, summary.preview)} />}
                />
              )
            })}
          </Rows>
        </RadioGroup>
      ) : <Note>Every available conversation in this project is already seated or working.</Note>}
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </Dialog>
  )
}
