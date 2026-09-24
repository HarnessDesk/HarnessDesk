import { useEffect, useState } from 'react'

import type { AgentEntry, SeatPlan } from '@harnessdesk/protocol'

import { ActionError, Button, Dialog, FormStack, ListRow, Note, RadioGroup, RadioGroupItem, Text } from '../design'
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

  const choice =
    (agentId && roster?.some((one) => one.id === agentId) ? agentId : null) ??
    roster?.find((one) => seatTaken(plans.get(one.id)) !== null)?.id ??
    roster?.[0]?.id ??
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
            <RadioGroup className={styles.picker} value={choice ?? ''} onValueChange={(value) => setAgentId(String(value))}>
              {roster.map((entry) => {
                const plan = plans.get(entry.id)
                const taken = seatTaken(plan)
                const reason = plan && !taken ? firstReason(plan) : null
                const name = agentName(entry)
                // Stable per Agent, not `useId()`: this runs inside `.map`,
                // where a hook cannot be called at all.
                const reasonId = reason ? `add-member-reason-${entry.id}` : undefined
                return (
                  <ListRow
                    key={entry.id}
                    as="label"
                    interactive
                    size="sm"
                    {...(reason ? { 'data-refused': '' } : {})}
                    lead={(
                      <>
                        <RadioGroupItem
                          value={entry.id}
                          aria-label={name}
                          {...(reasonId ? { 'aria-describedby': reasonId } : {})}
                        />
                        {taken ? <RuntimeMark runtime={markFor(taken, snapshot.runtimes)} size={14} /> : <BriefIcon size={14} />}
                      </>
                    )}
                    title={<Text role="value" truncate>{name}</Text>}
                    {...(reason ? {
                      subtitle: <Text id={reasonId} role="meta" tone="warning">{`Can't seat here · ${reason}`}</Text>,
                      wrapSubtitle: true,
                    } : {})}
                    trail={taken ? <Text role="meta">{taken.label}</Text> : reason ? undefined : <Text role="meta">Checking…</Text>}
                  />
                )
              })}
            </RadioGroup>
          )}
          <Note>The host records a durable Seat before the Agent receives its Goal.</Note>
        </div>
        {problem ? <ActionError>{problem}</ActionError> : null}
      </FormStack>
    </Dialog>
  )
}
