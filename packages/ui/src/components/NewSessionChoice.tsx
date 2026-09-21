import { useEffect, useState } from 'react'

import type { AgentEntry } from '@harnessdesk/protocol'

import { firstReason, inForce, markFor, seatTaken } from '../lib/agents'
import { Button, Dialog, IconTile, Note, Text } from '../design'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon, BriefIcon, TeamIcon } from './Icons'
import { GoalCreate } from './GoalCreate'
import styles from './NewSessionChoice.module.css'

/**
 * The button asks whether to begin an ordinary conversation or a finishable
 * Goal. Keyboard shortcuts still call `newDraft` directly; this chooser keeps
 * its plain row focused for the same reason.
 */
export const NewSessionChoice = ({ onClose }: { readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const root = projectRootOf(snapshot.workspace)
  const [creatingGoal, setCreatingGoal] = useState(false)

  useEffect(() => { void store.loadAgents() }, [store])
  const agents = inForce(snapshot.agents ?? [])

  if (creatingGoal && root) return <GoalCreate root={root} onClose={onClose} />

  const startPlain = (): void => {
    onClose()
    store.newDraft()
  }

  return (
    <Dialog title="What are you starting?" size="sm" onClose={onClose}>
      <div className={styles.choices}>
        {agents.length > 0 && (
          <div className={styles.group} role="group" aria-label="As an Agent">
            <Note>As an Agent</Note>
            {agents.map((entry) => <AgentChoice key={entry.id} entry={entry} onClose={onClose} />)}
          </div>
        )}
        <Button
          type="button"
          variant="choice" size="row" className={styles.choice}
          autoFocus
          onClick={startPlain}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              startPlain()
            }
          }}
        >
          <IconTile tint="blue"><AgentIcon size={16} /></IconTile>
          <span className={styles.text}>
            <Text role="row">A session</Text>
            <Text role="muted">One agent, working in this folder. What ⌘N does.</Text>
          </span>
        </Button>
        <Button
          type="button"
          variant="choice" size="row" className={styles.choice}
          disabled={!root}
          onClick={() => setCreatingGoal(true)}
        >
          <IconTile tint="violet"><TeamIcon size={16} /></IconTile>
          <span className={styles.text}>
            <Text role="row">A Goal</Text>
            <Text role="muted">A finishable effort with a shared board, durable Seats and an immutable receipt.</Text>
          </span>
        </Button>
      </div>
    </Dialog>
  )
}

const AgentChoice = ({ entry, onClose }: { readonly entry: AgentEntry; readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const refused = plan !== undefined && seat === null
  const reason = refused ? firstReason(plan) : null
  const name = entry.definition?.name ?? entry.id
  return (
    <Button
      type="button"
      variant="choice" size="row" className={styles.choice}
      data-refused={refused ? '' : undefined}
      title={seat ? `${entry.definition?.description ?? name} It would sit on ${seat.label}.` : 'Can’t be seated here — press to see every seat it would take, and what stands in the way.'}
      onClick={() => {
        onClose()
        void store.startAsAgent(entry.id)
      }}
    >
      <IconTile tint="blue">
        {seat ? <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} size={16} /> : <BriefIcon size={16} />}
      </IconTile>
      <span className={styles.text}>
        <Text role="row">{name}</Text>
        {reason && <Text role="muted">{reason}</Text>}
      </span>
    </Button>
  )
}
