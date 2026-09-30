import { useEffect, useState } from 'react'

import type { AgentEntry, SeatPlan } from '@harnessdesk/protocol'

import { ActionError, Button, ChoiceList, Dialog, FormStack, Note, Text } from '../design'
import { agentName, firstReason, inForce, markFor, seatTaken } from '../lib/agents'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { BriefIcon } from './Icons'
import styles from './AddMember.module.css'

/** Goal membership has one door: seat an Agent and persist its Seat before its order. */
export const AddMember = ({
  room,
  root,
  onClose,
}: {
  readonly room: string
  readonly root: string
  readonly onClose: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const goal = snapshot.goals.get(room)
  const [roster, setRoster] = useState<readonly AgentEntry[] | null>(null)
  const [plans, setPlans] = useState<ReadonlyMap<string, SeatPlan>>(new Map())
  const [agentId, setAgentId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    store.agentsIn(root).then(
      (list) => { if (live) setRoster(inForce(list)) },
      () => { if (live) setRoster([]) },
    )
    store.plansIn(root).then(
      (list) => { if (live) setPlans(new Map(list.map((plan) => [plan.id, plan]))) },
      () => undefined,
    )
    return () => { live = false }
  }, [store, root])

  const refusal = (entry: AgentEntry): string | null => {
    const plan = plans.get(entry.id)
    return plan && !seatTaken(plan) ? firstReason(plan) : null
  }
  const selectable = (entry: AgentEntry): boolean => refusal(entry) === null
  const choice =
    (agentId && roster?.some((one) => one.id === agentId) ? agentId : null) ??
    roster?.find((one) => selectable(one) && seatTaken(plans.get(one.id)) !== null)?.id ??
    roster?.find(selectable)?.id ??
    null

  const seat = async (): Promise<void> => {
    if (!goal || !choice || busy) return
    setBusy(true)
    setProblem(null)
    try {
      await store.seatGoal({ goal: room, agent: choice })
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The Goal would not seat that Agent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Seat an Agent in this Goal"
      size="md"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={busy || !goal || !choice} onClick={() => void seat()}>
            {busy ? 'Seating…' : 'Seat Agent'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      <FormStack>
        {!goal ? <ActionError>This Goal is no longer available. Read the project again.</ActionError> : null}
        <div className={styles.field}>
          <Text role="row">Its Agents, and the seat each would take here</Text>
          {roster === null ? <Text role="muted">Reading this project’s Agents…</Text> : (
            <ChoiceList
              label="Its Agents, and the seat each would take here"
              value={choice}
              onChange={setAgentId}
              options={roster.map((entry) => {
                const plan = plans.get(entry.id)
                const taken = seatTaken(plan)
                const reason = refusal(entry)
                const name = agentName(entry)
                return (
                  {
                    value: entry.id,
                    title: name,
                    ...(reason ? { description: <Text role="meta" tone="warning">{`Can't seat here · ${reason}`}</Text> } : {}),
                    refused: Boolean(reason),
                    icon: taken ? <RuntimeMark runtime={markFor(taken, snapshot.runtimes)} size={14} /> : <BriefIcon size={14} />,
                    trailing: taken ? <Text role="meta">{taken.label}</Text> : reason ? undefined : <Text role="meta">Checking…</Text>,
                  }
                )
              })}
            />
          )}
          <Note>The host records a durable Seat before the Agent receives its Goal.</Note>
        </div>
        {problem ? <ActionError>{problem}</ActionError> : null}
      </FormStack>
    </Dialog>
  )
}
