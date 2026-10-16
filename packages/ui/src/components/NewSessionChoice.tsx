import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { AgentEntry, SeatPlan } from '@harnessdesk/protocol'

import { agentName, firstReason, inForce, seatTaken } from '../lib/agents'
import {
  Button,
  ChoiceList,
  Dialog,
  Field,
  FormStack,
  NativeSelect,
  Text,
} from '../design'
import { projectRootOf } from '../lib/projects'
import { useShell } from '../panels/views'
import { useSnapshot, useStore } from '../state/context'
import { AgentIcon, FlowIcon, GoalIcon, TeamIcon } from './Icons'
import { FrontDoor } from './FrontDoor'

/** What this dialog can start. Order is the order a person reads them in. */
export type NewSessionKind = 'session' | 'goal' | 'flow' | 'team'

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
export const NewSessionChoice = ({ onClose, initialKind = 'session' }: { readonly onClose: () => void; readonly initialKind?: NewSessionKind }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const root = projectRootOf(snapshot.workspace)
  const [kind, setKind] = useState<NewSessionKind>(initialKind)
  const [runAs, setRunAs] = useState<string>(PLAIN)
  const [startingFrontDoor, setStartingFrontDoor] = useState(false)

  useEffect(() => { void store.loadAgents() }, [store])
  const shell = useShell()
  const agents = inForce(snapshot.agents ?? [])
  /* Keep the requested kind visible if the folder disappears. The action is
     disabled below until its requirement is available again. */
  const shownKind = kind
  const showRunAs = shownKind === 'session' && agents.length > 0
  const chosenAgent = runAs === PLAIN ? null : agents.find((one) => one.id === runAs) ?? null
  const chosenInfo = chosenAgent ? runAsInfo(chosenAgent, snapshot.agentPlans) : null

  if (startingFrontDoor && root) {
    return (
      <FrontDoor
        context={{ kind: 'project', root }}
        initialPlain={kind === 'goal'}
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
    setStartingFrontDoor(true)
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
          <Button variant="default" disabled={shownKind !== 'session' && !root} onClick={activate}>
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
              description: 'One runtime working in this folder.',
              icon: <AgentIcon size={16} />,
              trailing: <Text as="span" role="meta">⌘N</Text>,
            },
            {
              value: 'goal',
              title: 'Goal',
              description: rootDescription('Several agents work toward one result, with progress tracked together.'),
              icon: <GoalIcon size={16} />,
              disabled: !root,
            },
            {
              value: 'flow',
              title: 'Flow',
              description: rootDescription('Agents take turns: one writes, another reviews.'),
              icon: <FlowIcon size={16} />,
              disabled: !root,
            },
            {
              value: 'team',
              title: 'Team',
              description: rootDescription('Starts the helpers this project defines.'),
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
                  <option value={PLAIN}>Default runtime</option>
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
