import { useEffect, useMemo, useState } from 'react'

import type { AgentEntry } from '@harnessdesk/protocol'

import { firstReason, inForce, markFor, seatTaken } from '../lib/agents'
import { ActionError, Button, Dialog, IconTile, Input, Note, Text } from '../design'
import { FlowStart, type FlowChoice } from './FlowStart'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon, BriefIcon, TeamIcon } from './Icons'
import { projectRoots, useProjectGroups } from './SessionTree'
import styles from './NewSessionChoice.module.css'

/**
 * What are you starting: one agent, or several?
 *
 * The two are different shapes of work and the app had a door for only one of
 * them. "New session" made a solo draft, and a Room appeared later — after
 * agents happened to be in the folder — which meant the collaborative half of
 * the product was something you discovered rather than something you chose.
 * Somebody who came to run three agents on one repository had no way to say so.
 *
 * The dialog is on the *button*, not on the verb: ⌘N still goes straight to a
 * session, because a shortcut is for the thing you already decided, and the
 * command palette's own "New session" is unchanged. Nobody who knows what they
 * want has to answer a question about it.
 *
 * Choosing a room asks for its name before making it. A project holds as many
 * rooms as the work wants — the same way it holds sessions — so "the room" is
 * not a thing a folder can point at, and an unnamed one is a row in the tree
 * that nobody can tell from the row above it. Picking "A room" used to open a
 * surface keyed by the folder that had never been created at all: nothing was
 * written, nothing was listed, and the next launch had no memory of it.
 */
export const NewSessionChoice = ({ onClose }: { readonly onClose: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  /* The *project*, not the folder the window happens to be pointed at. A
     linked worktree is a real folder with a path of its own, and a room keyed
     by that path is grouped nowhere the tree looks — it groups a worktree
     under its project. The host resolves a worktree the same way, so those
     two agree; a subfolder is where they part — this names the subfolder and
     the host names the repository above it — which is why the room count
     below asks the tree for every spelling rather than comparing one string. */
  const root = projectRootOf(snapshot.workspace)

  // Fresh every time the dialog opens: whether each Agent can be seated here
  // is what the list is for, and a sign-in since last time changes it.
  useEffect(() => {
    void store.loadAgents()
  }, [store])
  const agents = inForce(snapshot.agents ?? [])

  /** Once the room door is chosen, this holds the name being typed. */
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /**
   * The flow this room should run, if any.
   *
   * Here rather than on a page of its own because this is where the person
   * said it should be: "when a user starts a room, the user can choose an
   * agent as well as set up a workflow". A room with no flow stays exactly the
   * room it was — the choice defaults to none and costs a glance.
   */
  const [flow, setFlow] = useState<FlowChoice | null>(null)

  /* How many conversations already live here — the sidebar's own number, from
     the sidebar's own selector.

     Three earlier attempts each resembled it and none matched. `sessions`
     counted a draft the tree had not listed. `history` by path prefix missed
     what `groupByProject` folds — roots, subfolders, worktrees. Grouping the
     full history missed the agent filter the sidebar applies *first*, so with
     the list narrowed to one agent the tree said 1 and this said 2, directly
     beneath it. A rule that resembles another rule is a rule that will
     disagree with it, so this calls the same hook. */
  const groups = useProjectGroups()
  const here = useMemo(
    () => groups.find((group) => group.root === root)?.sessions.length ?? 0,
    [groups, root],
  )

  /* How many rooms this project already has, which is what makes the name
     worth asking for: the second one has to be tellable from the first. */
  const rooms = useMemo(() => {
    /* Every spelling of this folder, not just the one `projectRootOf` gave —
       the same identity the tree matches rooms on. An open subfolder is its
       project's home here and in the sidebar, while the host keys the room
       that gets made at the repository, so comparing the two as strings read
       "no rooms yet" for a project that had several. */
    const here = groups.find((group) => group.root === root)
    const roots = new Set(here ? projectRoots(here) : root ? [root] : [])
    return [...snapshot.teams.values()].filter((team) => roots.has(team.root))
  }, [groups, snapshot.teams, root])

  const create = async (): Promise<void> => {
    const called = name.trim()
    if (!root || called === '') return
    setBusy(true)
    setProblem(null)
    let room: string
    try {
      room = await store.createRoom(root, called)
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not make that room.')
      return
    }
    if (!flow) {
      onClose()
      return
    }
    /* The room first, the flow into it. Seating opens conversations and spends
       a request each, so a flow that fails halfway leaves a room the person
       can look at — and the seats it did open are in it — rather than nothing
       and a sentence. */
    try {
      await store.startFlow(room, flow.source, { path: flow.path, vars: flow.vars })
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(
        `${called} was made, but the flow did not start: ${
          error instanceof Error ? error.message : 'the host refused it'
        }`,
      )
    }
  }

  if (naming) {
    return (
      <Dialog
        title="Name this room"
        size="sm"
        onClose={onClose}
        footer={
          <>
            <Button variant="default" disabled={busy || name.trim() === ''} onClick={() => void create()}>
              {busy
                ? flow
                  ? 'Seating…'
                  : 'Creating…'
                : flow
                  ? 'Create room and start'
                  : 'Create room'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setNaming(false)}>
              Back
            </Button>
          </>
        }
      >
        <div className={styles.naming}>
          <Input
            aria-label="Room name"
            autoFocus
            value={name}
            placeholder="Checkout rewrite"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
          <Note>
            {rooms.length > 0
              ? `${rooms.length === 1 ? 'One room' : `${rooms.length} rooms`} already in this project: ${rooms
                  .map((one) => one.name)
                  .join(', ')}. The name is how you tell them apart in the sidebar.`
              : 'A room has a board of its own and reaches only the agents you put in it. The name is what the sidebar shows.'}
          </Note>
          {root && <FlowStart root={root} disabled={busy} onChange={setFlow} />}
          {problem && (
            <ActionError>{problem}</ActionError>
          )}
        </div>
      </Dialog>
    )
  }

  // What ⌘N does, and what Enter starts here too — the owner's rule that a
  // person who never touches Agents sees today's app, unchanged, whatever
  // else this dialog now lists above it.
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
            {agents.map((entry) => (
              <AgentChoice key={entry.id} entry={entry} onClose={onClose} />
            ))}
          </div>
        )}

        <Button
          type="button"
          variant="choice" size="row" className={styles.choice}
          // The row focused when the dialog opens, whatever else is listed
          // above it: the plain choice stays what Enter starts.
          autoFocus
          onClick={startPlain}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              startPlain()
            }
          }}
        >
          <IconTile tint="blue">
            <AgentIcon size={16} />
          </IconTile>
          <span className={styles.text}>
            <Text role="row">A session</Text>
            <Text role="muted">
              One agent, working in this folder. What ⌘N does.
            </Text>
          </span>
        </Button>

        <Button
          type="button"
          variant="choice" size="row" className={styles.choice}
          disabled={!root}
          onClick={() => setNaming(true)}
        >
          <IconTile tint="violet">
            <TeamIcon size={16} />
          </IconTile>
          <span className={styles.text}>
            <Text role="row">A room</Text>
            <Text role="muted">
              {here > 0
                ? `Several agents share one board. ${here} ${here === 1 ? 'conversation is' : 'conversations are'} already in this project — you choose which of them join.`
                : 'Several agents share one board — work is claimed, and nobody edits the same file twice.'}
            </Text>
          </span>
        </Button>
      </div>
    </Dialog>
  )
}

/**
 * One Agent, as a door: its name, and the mark of the runtime it would sit on
 * here. One that cannot be seated here stays, with its first reason on
 * screen — and pressing it asks, which raises the refusal sheet with every
 * candidate and its fix rather than a button that does nothing.
 *
 * Not `aria-disabled`: the canonical Button already refuses pointer events on
 * that attribute (`design/ui/button.tsx`'s base class), and a screen may not
 * redraw a canonical control to undo it (the `canonical-control-visual-
 * override` gate) — `aria-disabled` here would be un-clickable, not merely
 * grey. `data-refused` is set, the same marker `TeamBoardPane`'s drop target
 * and this Button's own `ghost` variant already use for it; `choice`, the
 * variant this row takes, has no `data-[refused]` rule yet the way `ghost`
 * does (`data-[refused]:opacity-45`) — a primitive shape to ask the UI-system
 * session for, noted in the report — so this row reads its refusal from the
 * reason on screen alone until that lands.
 */
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
      title={
        seat
          ? `${entry.definition?.description ?? name} It would sit on ${seat.label}.`
          : 'Can’t be seated here — press to see every seat it would take, and what stands in the way.'
      }
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
