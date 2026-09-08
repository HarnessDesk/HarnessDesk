import { useMemo, useState } from 'react'

import { Btn, Dialog, Input } from '../design'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { AgentIcon, TeamIcon } from './Icons'
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

  /** Once the room door is chosen, this holds the name being typed. */
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

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
    try {
      await store.createRoom(root, called)
      onClose()
    } catch (error) {
      setBusy(false)
      setProblem(error instanceof Error ? error.message : 'The host did not make that room.')
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
            <Btn variant="primary" disabled={busy || name.trim() === ''} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create room'}
            </Btn>
            <Btn disabled={busy} onClick={() => setNaming(false)}>
              Back
            </Btn>
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
          <p className={styles.note}>
            {rooms.length > 0
              ? `${rooms.length === 1 ? 'One room' : `${rooms.length} rooms`} already in this project: ${rooms
                  .map((one) => one.name)
                  .join(', ')}. The name is how you tell them apart in the sidebar.`
              : 'A room has a board of its own and reaches only the agents you put in it. The name is what the sidebar shows.'}
          </p>
          {problem && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="What are you starting?" size="sm" onClose={onClose}>
      <div className={styles.choices}>
        <button
          type="button"
          className={styles.choice}
          onClick={() => {
            onClose()
            store.newDraft()
          }}
        >
          <span className={styles.mark}>
            <AgentIcon size={16} />
          </span>
          <span className={styles.text}>
            <span className={styles.name}>A session</span>
            <span className={styles.note}>
              One agent, working in this folder. What ⌘N does.
            </span>
          </span>
        </button>

        <button
          type="button"
          className={styles.choice}
          disabled={!root}
          onClick={() => setNaming(true)}
        >
          <span className={styles.mark} data-tone="team">
            <TeamIcon size={16} />
          </span>
          <span className={styles.text}>
            <span className={styles.name}>A room</span>
            <span className={styles.note}>
              {here > 0
                ? `Several agents share one board. ${here} ${here === 1 ? 'conversation is' : 'conversations are'} already in this project — you choose which of them join.`
                : 'Several agents share one board — work is claimed, and nobody edits the same file twice.'}
            </span>
          </span>
        </button>
      </div>
    </Dialog>
  )
}
