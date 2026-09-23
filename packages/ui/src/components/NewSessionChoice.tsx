import { useEffect, useState } from 'react'

import type { AgentEntry } from '@harnessdesk/protocol'

import { firstReason, inForce, markFor, seatTaken } from '../lib/agents'
import { ActionError, Button, Dialog, Field, IconTile, Input, Note, Text } from '../design'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon, BriefIcon, FlowIcon, TeamIcon } from './Icons'
import { FlowStart, type FlowChoice } from './FlowStart'
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
  const [startingFlow, setStartingFlow] = useState(false)

  useEffect(() => { void store.loadAgents() }, [store])
  const agents = inForce(snapshot.agents ?? [])
  /*
   * The plain choice sits under every Agent row, so a plain `autoFocus`
   * scrolls the whole "As an Agent" roster up to bring it into view the
   * moment this dialog mounts — on a roster long enough that the plain
   * choice starts below the fold, that slides the top rows up toward the
   * header until a click meant for a row's centre can land on the header
   * instead, silently (#870). Keeping this choice focused is still right —
   * Enter still starts a plain session, whatever else is listed above it —
   * it just must never move the roster to do it. A callback ref rather than
   * an effect: the dialog's content mounts into a portal a render after this
   * component's own effects already ran once with static dependencies, so an
   * effect keyed to "run on mount" can fire before the button exists. A
   * callback ref runs exactly when React attaches the node, on whichever
   * render that turns out to be.
   */
  const focusWithoutScrolling = (node: HTMLButtonElement | null): void => {
    node?.focus({ preventScroll: true })
  }

  if (creatingGoal && root) return <GoalCreate root={root} onClose={onClose} />
  if (startingFlow && root) return <FlowGoalCreate root={root} onClose={onClose} />

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
          ref={focusWithoutScrolling}
          variant="choice" size="row" className={styles.choice}
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
        <Button
          type="button"
          variant="choice" size="row" className={styles.choice}
          disabled={!root}
          onClick={() => setStartingFlow(true)}
        >
          <IconTile tint="violet"><FlowIcon size={16} /></IconTile>
          <span className={styles.text}>
            <Text role="row">A flow</Text>
            <Text role="muted">An editable policy that routes work between several Agents on one Goal.</Text>
          </span>
        </Button>
      </div>
    </Dialog>
  )
}

/**
 * A flow's own Goal: one host operation, `flow/start-goal`, rather than an
 * empty Goal made first and a flow started into it after — the run and its
 * Goal are minted together, so a flow that fails to seat never leaves a bare
 * Goal behind for someone to notice was never actually running anything.
 */
const FlowGoalCreate = ({ root, onClose }: { readonly root: string; readonly onClose: () => void }) => {
  const store = useStore()
  const [sentence, setSentence] = useState('')
  const [choice, setChoice] = useState<FlowChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const valid = choice !== null && sentence.trim().length > 0 && sentence.trim().length <= 2000

  const start = async (): Promise<void> => {
    if (!valid || !choice || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const execution = await store.startFlowGoal({ root, source: choice.source, token: choice.token, sentence: sentence.trim(), vars: choice.vars })
      store.openGoal(execution.goal)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The desk did not start this flow.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Run a flow"
      size="md"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" disabled={!valid || busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start'}</Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      <Field
        label="What finishes this?"
        error={sentence.trim().length > 2000 ? 'Keep it to 2,000 characters.' : undefined}
      >
        {(control) => (
          <Input
            {...control}
            aria-label="What finishes this?"
            autoFocus
            value={sentence}
            onChange={(event) => setSentence(event.target.value)}
          />
        )}
      </Field>
      <FlowStart root={root} disabled={busy} onChange={setChoice} />
      {problem && <ActionError>{problem}</ActionError>}
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
