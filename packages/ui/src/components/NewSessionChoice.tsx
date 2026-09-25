import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { AgentEntry, SeatPlan } from '@harnessdesk/protocol'

import { agentName, firstReason, inForce, seatTaken } from '../lib/agents'
import {
  ActionError,
  Button,
  ChoiceList,
  Dialog,
  Field,
  FormStack,
  Input,
  NativeSelect,
  Text,
} from '../design'
import { projectRootOf } from '../lib/projects'
import { useShell } from '../panels/views'
import { useSnapshot, useStore } from '../state/context'
import { AgentIcon, FlowIcon, GoalIcon, TeamIcon } from './Icons'
import { FlowStart, type FlowChoice } from './FlowStart'
import { FrontDoor } from './FrontDoor'
import { GoalCreate } from './GoalCreate'

/** What this dialog can start. Order is the order a person reads them in. */
type Kind = 'session' | 'goal' | 'flow' | 'team'

const PLAIN = 'plain'

/**
 * What an Agent says in the "Run as" list and under it: its name and mark
 * for the row, and one line — its description with the seat it would take,
 * or the reason it cannot be seated here — for the hint under the Select.
 * One place to work this out, so the closed trigger, the open list and the
 * hint underneath it can never disagree about a given Agent.
 */
const runAsInfo = (entry: AgentEntry, agentPlans: ReadonlyMap<string, SeatPlan>) => {
  const plan = agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const refused = plan !== undefined && seat === null
  const reason = refused && plan ? firstReason(plan) : null
  return { name: agentName(entry), seat, refused, reason }
}

/**
 * "What are you starting?" asks one question first — a Session, a Goal, a
 * Flow, or a team shape — and only then, for a Session, who runs it. Every
 * created Agent used to lead this dialog as its own row; with more than a
 * couple in force that was a scrolling column of identical tiles with the
 * plain choice — what ⌘N does — buried under all of them. An Agent is now an
 * answer to "who runs the session", not a fifth kind of thing to start.
 */
export const NewSessionChoice = ({ onClose }: { readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const root = projectRootOf(snapshot.workspace)
  const [kind, setKind] = useState<Kind>('session')
  const [runAs, setRunAs] = useState<string>(PLAIN)
  const [creatingGoal, setCreatingGoal] = useState(false)
  const [startingFlow, setStartingFlow] = useState(false)
  const [startingFrontDoor, setStartingFrontDoor] = useState(false)

  useEffect(() => { void store.loadAgents() }, [store])
  const shell = useShell()
  const agents = inForce(snapshot.agents ?? [])
  /* What is shown is what runs. A kind that needs a folder falls back to
     Session once the folder is gone, and an Agent that has left the roster
     falls back to Plain session — never a Start that acts on a choice the
     dialog no longer draws. */
  const shownKind: Kind = kind !== 'session' && !root ? 'session' : kind
  const showRunAs = shownKind === 'session' && agents.length > 0
  const chosenAgent = runAs === PLAIN ? null : agents.find((one) => one.id === runAs) ?? null
  const chosenInfo = chosenAgent ? runAsInfo(chosenAgent, snapshot.agentPlans) : null

  if (creatingGoal && root) return <GoalCreate root={root} onClose={onClose} />
  if (startingFlow && root) return <FlowGoalCreate root={root} onClose={onClose} />
  if (startingFrontDoor && root) {
    return (
      <FrontDoor
        context={{ kind: 'project', root }}
        onClose={onClose}
        onStarted={(execution) => {
          store.openGoal(execution.goal)
          onClose()
        }}
      />
    )
  }


  const activate = (): void => {
    if (shownKind === 'session') {
      onClose()
      if (chosenAgent) void store.startAsAgent(chosenAgent.id)
      else store.newDraft()
      return
    }
    if (shownKind === 'goal') setCreatingGoal(true)
    else if (shownKind === 'flow') setStartingFlow(true)
    else setStartingFrontDoor(true)
  }

  const openAgents = (): void => {
    onClose()
    shell.openAgents()
  }

  /*
   * Enter does the footer's one filled act from anywhere in the dialog —
   * Start, or Continue for the kind that is selected — except inside "Run
   * as", where Enter is the platform's own way to close its list. `capture`
   * runs ahead of a radio row's native Enter, so Enter on a kind proceeds
   * rather than only selecting it again.
   */
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || event.target instanceof HTMLSelectElement) return
    event.preventDefault()
    event.stopPropagation()
    activate()
  }

  const rootDescription = (own: string): string => (root ? own : 'Open a folder to start one.')

  return (
    <Dialog
      title="What are you starting?"
      size="sm"
      onClose={onClose}
      footer={(
        <>
          <Button variant="default" onClick={activate}>
            {shownKind === 'session' ? 'Start' : 'Continue'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      )}
      footerAside={<Button type="button" variant="quiet" onClick={openAgents}>Manage Agents…</Button>}
    >
      <div onKeyDownCapture={onKeyDownCapture}>
        <FormStack>
        <ChoiceList
          label="What are you starting?"
          value={shownKind}
          onChange={setKind}
          autoFocusSelected
          onActivate={activate}
          options={[
            {
              value: 'session',
              title: 'Session',
              description: 'One agent working in this folder.',
              icon: <AgentIcon size={16} />,
              trailing: <Text as="span" role="meta">⌘N</Text>,
            },
            {
              value: 'goal',
              title: 'Goal',
              description: rootDescription('A finishable effort with a shared board and a receipt.'),
              icon: <GoalIcon size={16} />,
              disabled: !root,
            },
            {
              value: 'flow',
              title: 'Flow',
              description: rootDescription('Routes work between several Agents on one Goal.'),
              icon: <FlowIcon size={16} />,
              disabled: !root,
            },
            {
              value: 'team',
              title: 'Team',
              description: rootDescription('Starts from a shape this project ships.'),
              icon: <TeamIcon size={16} />,
              disabled: !root,
            },
          ]}
        />
        {showRunAs && (
          <Field
            label="Run as"
            /* Plain says nothing the Session row above has not; an Agent says what
               it does and where it would sit, or once, why it cannot. */
            {...(chosenInfo ? { hint: chosenInfo.refused
                ? `${chosenInfo.reason ? `Can’t start here: ${chosenInfo.reason}.` : 'Can’t start here.'} Start shows every seat it would take.`
                : [chosenAgent?.definition?.description, chosenInfo.seat ? `It would sit on ${chosenInfo.seat.label}.` : null].filter(Boolean).join(' ') || undefined } : {})}
          >
            {(control) => (
                <NativeSelect
                  id={control.id}
                  aria-describedby={control['aria-describedby']}
                  value={chosenAgent ? chosenAgent.id : PLAIN}
                  onChange={(event) => setRunAs(event.target.value)}
                >
                  <option value={PLAIN}>Plain session</option>
                  {agents.map((entry) => {
                    const info = runAsInfo(entry, snapshot.agentPlans)
                    return (
                      <option key={entry.id} value={entry.id}>
                        {info.refused ? `${info.name} (can’t start here)` : info.name}
                      </option>
                    )
                  })}
                </NativeSelect>
            )}
          </Field>
        )}
        </FormStack>
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
