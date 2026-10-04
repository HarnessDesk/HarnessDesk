import { useMemo, useState } from 'react'

import { sessionKey, splitSessionKey, type GoalView, type SessionKey } from '@harnessdesk/protocol'

import { Button, Dialog, Note, RowChoice, Rows } from '../design'
import { groupByProject } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { isRecord, isRecordConversation, RECORD_REASON } from '../lib/team-record'
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
  /* A Run that ends wraps its Team, even under a person who is choosing a conversation for a card: the card is its
     record by then, so what is left of the choice is not an assignment (#1317). */
  const record = isRecord(snapshot.goals.get(view.goal.id) ?? view)
  const [choice, setChoice] = useState<SessionKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const loose = useMemo(() => {
    const members = new Set(view.members.filter((seat) => seat.closed === null).map((seat) => String(sessionKey(seat.session.runtime, seat.session.sessionId))))
    // Re-readable, unlike `values()`: asked once for every conversation in the project.
    const teams = [...snapshot.goals.values()]
    const groups = groupByProject(snapshot.history, snapshot.workspaces.map((workspace) => workspace.path), snapshot.workspace)
    return (groups.find((group) => group.root === view.goal.root)?.sessions ?? []).filter((summary) => {
      const key = sessionKey(summary.runtime, summary.id)
      /* A conversation a wrapped Team keeps is that Team's record, and the host will not seat it for another card
         ("That conversation belongs to a wrapped Team"), so it is not offered only to be refused (#1317). */
      return !members.has(String(key)) && summary.status.type !== 'active' && !isRecordConversation(teams, key)
    })
  }, [snapshot.goals, snapshot.history, snapshot.workspace, snapshot.workspaces, view.goal.root, view.members])

  const assign = async (): Promise<void> => {
    if (choice === null || busy || record) return
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
          <Button disabled={choice === null || busy || record} title={record ? RECORD_REASON : undefined} onClick={() => void assign()}>Assign</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {loose.length > 0 ? (
        <Rows role="radiogroup" aria-label="Conversation">
            {loose.map((summary, index) => {
              const key = sessionKey(summary.runtime, summary.id)
              return (
                <RowChoice
                  key={String(key)}
                  title={sessionLabel(summary.title, summary.preview)}
                  desc={summary.cwd} truncateDesc
                  selected={choice === key}
                  // Nothing chosen yet: the first row is the group's Tab stop, so
                  // the keyboard can reach the list before a pointer has.
                  tabStop={choice === null && index === 0}
                  onClick={() => setChoice(key)}
                />
              )
            })}
        </Rows>
      ) : <Note>Every available conversation in this project is already seated or working.</Note>}
      {record ? <Note>{RECORD_REASON}</Note> : null}
      {problem ? <Note tone="bad">{problem}</Note> : null}
    </Dialog>
  )
}
