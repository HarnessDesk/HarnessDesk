import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'

import { sessionKey, splitContext, type Session, type SessionSummary, type TeamState } from '@harnessdesk/protocol'

import { agentGroups, agentKey, agentKeyOf } from '../lib/accounts'
import { folderName, groupByProject, isWorktreeSession, projectRootOf, type ProjectGroup } from '../lib/projects'
import { sessionLabel } from '../lib/sessions'
import { ACTIVE_STATES, TRACE_LABEL, traceOf } from '../lib/trace'
import { panes, sessionOf } from '../state/layout'

import { useSnapshot, useStore } from '../state/context'
import {
  ArchiveIcon,
  BranchIcon,
  ChevronIcon,
  ClockIcon,
  CollapseAllIcon,
  CopyIcon,
  EveryoneIcon,
  ExpandAllIcon,
  FolderIcon,
  FolderOpenIcon,
  ForkIcon,
  MoreIcon,
  PencilIcon,
  PanelIcon,
  PinIcon,
  PlusIcon,
  RowsLooseIcon,
  RowsTightIcon,
  SlidersIcon,
  SortNameIcon,
  TeamIcon,
  TodoActiveIcon,
  TrashIcon,
  UnpinIcon,
} from './Icons'
import { SessionHoverCard } from './AgentCards'
import { RuntimeMark } from './BrandIcons'
import { DeleteRoom, RenameRoom } from './RoomActions'
import { DeleteSession } from './DeleteSession'
import { Menu, MenuItem, MenuLabel, MenuSeparator, ContextMenu, useContextMenu } from './Menu'
import { Popover } from './Popover'
import { WorkspaceMenu } from './WorkspaceMenu'
import styles from './Sidebar.module.css'

/**
 * The session list, grouped by the folder each session belongs to.
 *
 * Grouping by workspace rather than by date because that is how the work is
 * actually divided: someone with four projects wants their sessions separated by
 * project, and "yesterday" spanning three codebases is not a useful grouping.
 * Recency still orders both the groups and the sessions inside them.
 */


const relativeTime = (timestamp: number, now: number): string => {
  const seconds = Math.max(1, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const SessionRow = ({
  summary,
  now,
  onDelete,
}: {
  summary: SessionSummary
  now: number
  /** Raises the confirmation; the dialog belongs to the list, not to a row. */
  onDelete: (summary: SessionSummary) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const menu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const openInPane = panes(snapshot.layout.root).some(
    (pane) => sessionOf(pane) === sessionKey(summary.runtime, summary.id),
  )
  const runtime = snapshot.runtimes.find((entry) => entry.id === summary.runtime)
  const agentName = runtime?.presentation.name ?? summary.runtime
  // Whether this agent can actually delete a stored conversation. Codex can;
  // a bridge that knows where its agent writes can; anything else is offered
  // a disabled row with the reason rather than a Delete that throws.
  const deletable = runtime?.capabilities.deleteHistory ?? false
  // A live conversation says what it is doing; a stored one says when it was.
  const key = sessionKey(summary.runtime, summary.id)
  const pinned = snapshot.listPrefs.pinnedSessions.includes(String(key))
  const live = snapshot.sessions.get(key)
  // A queue the host stopped is a conversation waiting on a decision, exactly
  // as an approval is: the messages are safe, and nothing moves until someone
  // says so. Reading both through one flag keeps the sidebar honest.
  const needsYou =
    snapshot.approvals.some((entry) => entry.key === key) ||
    snapshot.queues.get(key)?.status === 'paused'
  const trace = live ? traceOf(live, needsYou) : null
  /* The name the person just gave it, before the history list has caught up.
     A rename patches the open session at once and re-reads the history after;
     138 renames in a row left the sidebar saying "Untitled session" down the
     whole list for the better part of a minute while the room's rail already
     read every name. The live session is the fresher record when it exists. */
  const label = sessionLabel(live?.title ?? summary.title, summary.preview)
  const traceShown = trace !== null && (ACTIVE_STATES.has(trace) || trace === 'waiting' || trace === 'failed')
  // Work the agent sent to the background and walked away from: the turn is
  // over, the row would read idle, and something is still running. The glyph
  // says so, in green, so a person browsing other conversations knows this
  // one has something to look at — the Background tasks panel, once opened.
  const backgrounded = (snapshot.tasks.get(key) ?? []).filter((task) => task.state === 'running').length
  const worktree = isWorktreeSession(summary)
  const active = snapshot.activeSessionKey === key
  const rowRef = useRef<HTMLButtonElement>(null)
  /* Brought on screen when it becomes the active one. A list long enough to
     hold a month of review rooms keeps the conversation being typed into
     thousands of pixels below the fold, and a row nobody can see is a row
     nobody can find. `nearest` moves nothing when it is already in view; a
     row that is not rendered — a folded project — is not this effect's to
     unfold. */
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const commitRename = useCallback(() => {
    const title = draft.trim()
    setRenaming(false)
    if (title.length === 0 || title === summary.title) return
    // Renaming needs the session live, since the title is the runtime's. The
    // comparison is on the key, not the id: ACP agents number their sessions,
    // so "same id" is not "same conversation", and the open below has to name
    // the runtime for the same reason.
    if (snapshot.activeSessionKey !== key) {
      void store
        .openSession(summary.id, { runtime: summary.runtime })
        .then(() => store.renameSession(title))
      return
    }
    void store.renameSession(title)
  }, [draft, key, snapshot.activeSessionKey, store, summary.id, summary.runtime, summary.title])

  return (
    <div className={styles.rowWrap} {...(menu.at ? { 'data-menu-open': '' } : {})} onContextMenu={menu.open}>
      {renaming ? (
        <div style={{ padding: '4px 8px' }}>
          <input
            className={styles.renameInput}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') {
                // Spent on the rename, so a floating sidebar stays open.
                event.preventDefault()
                setRenaming(false)
              }
            }}
          />
        </div>
      ) : (
        <>
          <button
            ref={rowRef}
            type="button"
            className={styles.row}
            data-density={snapshot.listPrefs.density}
            {...(snapshot.activeSessionKey === key ? { 'data-active': '' } : {})}
            {...(openInPane ? { 'data-open': '' } : {})}
            title={
              snapshot.listPrefs.density === 'compact'
                ? `${agentName} · ${traceShown ? TRACE_LABEL[trace] : relativeTime(summary.updatedAt, now)}${summary.git?.branch ? ` · ${summary.git.branch}` : ''}${worktree ? ` · worktree ${folderName(summary.cwd)}` : ''}${backgrounded > 0 ? ` · ${backgrounded} running in the background` : ''}`
                : backgrounded > 0
                  ? `${backgrounded === 1 ? '1 task is' : `${backgrounded} tasks are`} still running in the background — open the conversation, then Background tasks`
                  : openInPane
                    ? 'This conversation is on screen'
                    : 'Open this conversation'
            }
            onClick={() => void store.openSession(summary.id, { runtime: summary.runtime })}
          >
            {/* The one place in this row that identifies the conversation
                rather than describing it, and so the one place the name card
                hangs from. The row shows a title and a time; *which agent
                this is, on what model, with how much context left* is not on
                it at all — at compact density it is not even in the `title`.
                That is the card's whole case here. */}
            <SessionHoverCard
              session={summary}
              className={styles.statusTarget}
              actions={[
                ...(snapshot.activeSessionKey === key
                  ? []
                  : [
                      {
                        label: 'Open',
                        primary: true,
                        onSelect: () =>
                          void store.openSession(summary.id, { runtime: summary.runtime }),
                      },
                    ]),
                {
                  label: 'Rename',
                  onSelect: () => {
                    setDraft(summary.title ?? '')
                    setRenaming(true)
                  },
                },
              ]}
            >
              <span
                className={styles.statusGlyph}
                {...(backgrounded > 0 ? { 'data-tasks': '' } : {})}
                {...(summary.status.type === 'active' ? { 'data-live': '' } : {})}
                {...(traceShown ? { 'data-trace': trace } : {})}
                aria-hidden="true"
              />
            </SessionHoverCard>
            <span className={styles.rowBody}>
              <span className={styles.rowHead}>
                <span className={styles.rowTitle}>{label}</span>
                {/* One project, several checkouts. The row says which it ran
                    in with a branch glyph rather than a group of its own —
                    a worktree is where a conversation happened, not what it
                    was about — and the glyph sits on the list's right rail,
                    so "which of these ran in a worktree" is one glance down
                    a column rather than five titles read to their end. */}
                {worktree && (
                  <span
                    className={styles.rowWorktree}
                    role="img"
                    aria-label={`Worktree ${summary.git?.branch ?? folderName(summary.cwd)}`}
                    title={`Worktree · ${summary.git?.branch ?? folderName(summary.cwd)}\n${summary.cwd}`}
                  >
                    <BranchIcon size={11} />
                  </span>
                )}
              </span>
              {snapshot.listPrefs.density === 'comfortable' && (
                <span className={styles.rowMeta}>
                  {snapshot.runtimes.length > 1 && (
                    <>
                      <span className={styles.rowMetaItem}>{agentName}</span>
                      <span className={styles.dot} />
                    </>
                  )}
                  {traceShown ? (
                    <span className={styles.rowMetaItem} data-trace={trace}>
                      {TRACE_LABEL[trace]}
                    </span>
                  ) : (
                    <span className={styles.rowMetaItem}>{relativeTime(summary.updatedAt, now)}</span>
                  )}
                  {summary.git?.branch && (
                    <>
                      <span className={styles.dot} />
                      <span className={`${styles.rowMetaItem} ${styles.rowMetaBranch}`}>
                        {summary.git.branch}
                      </span>
                    </>
                  )}
                </span>
              )}
            </span>
          </button>

          <span className={styles.rowMenu} {...(menu.at ? { 'data-open': '' } : {})}>
            <button
              type="button"
              className={styles.rowMenuButton}
              aria-haspopup="menu"
              aria-expanded={menu.at !== null}
              onClick={menu.open}
              title={`Actions for ${label}`}
              aria-label={`Actions for ${label}`}
            >
              <MoreIcon size={12} />
            </button>
          </span>
        </>
      )}
      <ContextMenu at={menu.at} label={`Actions for ${label}`} onClose={menu.close}>
        <MenuItem
          icon={pinned ? <UnpinIcon size={13} /> : <PinIcon size={13} />}
          label={pinned ? 'Unpin' : 'Pin'}
          onSelect={() => store.toggleSessionPinned(String(key))}
        />
        <MenuItem
          icon={<CopyIcon size={13} />}
          label="Copy"
          value="⌘C"
          onSelect={() => void navigator.clipboard?.writeText(label).catch(() => {})}
        />
        <MenuSeparator />
        {/* The way to get a second transcript on screen. Reading what another
            harness is doing while you work with this one is the case the
            one-conversation rule could never serve, and it is deliberate
            rather than accidental — which is the distinction that rule was
            really drawing. */}
        <MenuItem
          icon={<PanelIcon size={13} />}
          label="Open on the right"
          hint="Read this beside the conversation you are in"
          onSelect={() => {
            void store.openSession(summary.id, { runtime: summary.runtime, area: 'right' })
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<PencilIcon size={13} />}
          label="Rename"
          onSelect={() => {
            setDraft(summary.title ?? '')
            setRenaming(true)
          }}
        />
        <MenuItem
          icon={<ForkIcon size={13} />}
          label="Branch from here"
          onSelect={() => {
            void store
              .openSession(summary.id, { runtime: summary.runtime })
              .then(() => store.forkSession())
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<ArchiveIcon size={13} />}
          label="Archive"
          onSelect={() => void store.archiveSession(summary.id, summary.runtime, label)}
        />
        <MenuItem
          icon={<TrashIcon size={13} />}
          label="Delete…"
          danger
          disabled={deletable ? false : `${agentName} keeps no way to delete one.`}
          onSelect={() => onDelete(summary)}
        />
      </ContextMenu>
    </div>
  )
}

/**
 * The list's display controls, in one place the way Claude Code desktop and
 * Codex keep theirs: density, an agent filter, and group order, behind one
 * sliders button on the section header. When the filter hides sessions the
 * button wears a dot — a filtered list must never read as missing data.
 */
export const SessionListControls = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const prefs = snapshot.listPrefs
  const filtered = prefs.agent !== null
  const groups = useProjectGroups()
  const roots = groups.map((group) => group.root)
  const openCount = roots.filter((root) => !prefs.collapsed.includes(root)).length

  return (
    <span className={styles.listControls} {...(filtered ? { 'data-filtered': '' } : {})}>
      <Popover title="How this list is shown" drop="down" align="left" label={<SlidersIcon size={13} />}>
        {(close) => (
          <Menu close={close}>
            {/* Folding is first because it is the one row here that answers
                "I cannot see the list for the list" — the state everything
                below is a refinement of. ⌥-click on any project's chevron
                does the same thing without opening this. */}
            <MenuLabel>Projects</MenuLabel>
            {/* The count was the only part of this row's second line that was
                not a restatement of the verb, and a count is not a sentence:
                it goes at the row's end, where the app already puts a
                branch's age. */}
            <MenuItem
              icon={<CollapseAllIcon size={14} />}
              label="Collapse all"
              value={roots.length === 1 ? '1 project' : `${roots.length} projects`}
              title="Folds every project shut."
              disabled={openCount === 0 ? 'Every project is already folded.' : false}
              onSelect={() => store.setProjectsCollapsed(roots, true)}
            />
            <MenuItem
              icon={<ExpandAllIcon size={14} />}
              label="Expand all"
              disabled={openCount === roots.length ? 'Every project is already open.' : false}
              onSelect={() => store.setProjectsCollapsed(roots, false)}
            />
            <MenuLabel>Density</MenuLabel>
            <MenuItem
              icon={<RowsLooseIcon size={14} />}
              selected={prefs.density === 'comfortable'}
              label="Comfortable"
              onSelect={() => store.setListPrefs({ density: 'comfortable', densityPicked: true })}
            />
            <MenuItem
              icon={<RowsTightIcon size={14} />}
              selected={prefs.density === 'compact'}
              label="Compact"
              onSelect={() => store.setListPrefs({ density: 'compact', densityPicked: true })}
            />
            <MenuLabel>Agent</MenuLabel>
            <MenuItem
              icon={<EveryoneIcon size={14} />}
              selected={prefs.agent === null}
              label="All agents"
              onSelect={() => store.setListPrefs({ agent: null })}
            />
            {/* One row per agent, not per account. Codex's accounts share one
                session store, so "sessions from this account" is not a thing
                the list could honour — the agent is the real distinction. */}
            {agentGroups(snapshot.runtimes).map(({ info }) => (
              <MenuItem
                key={info.id}
                icon={<RuntimeMark runtime={info} />}
                selected={prefs.agent === agentKey(info)}
                label={info.presentation.name}
                onSelect={() => store.setListPrefs({ agent: agentKey(info) })}
              />
            ))}
            <MenuLabel>Sort folders</MenuLabel>
            <MenuItem
              icon={<ClockIcon size={14} />}
              selected={prefs.sort === 'recency'}
              label="Recency"
              onSelect={() => store.setListPrefs({ sort: 'recency' })}
            />
            <MenuItem
              icon={<SortNameIcon size={14} />}
              selected={prefs.sort === 'name'}
              label="Name"
              onSelect={() => store.setListPrefs({ sort: 'name' })}
            />
          </Menu>
        )}
      </Popover>
    </span>
  )
}

/**
 * A project's row. Click opens and closes it; the two buttons at its end
 * appear on hover — a new session, and everything else behind a kebab —
 * and a right-click anywhere on the row opens that same everything-else,
 * because the row is a thing, and things have context menus.
 *
 * The row can also be picked up and dropped somewhere else in the list. That
 * is the only way to say "this one goes here", so a drop is taken as exactly
 * that: see `SessionTree`'s `drop` for what it writes.
 */
const GroupHead = ({
  group,
  open,
  onToggle,
  onToggleAll,
  onNewWorktree,
  drag,
}: {
  group: ProjectGroup
  open: boolean
  onToggle: () => void
  /** ⌥-click on the chevron: the whole list, not this one folder. */
  onToggleAll: () => void
  onNewWorktree: (root: string) => void
  drag: DragHandlers
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const menu = useContextMenu()
  const pinned = snapshot.listPrefs.pinned.includes(group.root)
  // The folder the app is working in. It used to be marked only by leading
  // the list, which says nothing once you have arranged the list yourself —
  // and "which project is this about" is the question every worktree, every
  // ⌘N and every terminal here is answered by.
  const current = projectRootOf(snapshot.workspace) === group.root
  const edge = drag.over?.root === group.root ? drag.over.edge : null
  return (
    <div
      className={styles.groupHead}
      {...(menu.at ? { 'data-menu-open': '' } : {})}
      {...(edge ? { 'data-insert': edge } : {})}
      {...(drag.dragging === group.root ? { 'data-dragging': '' } : {})}
      draggable
      onDragStart={(event) => drag.onStart(event, group.root)}
      onDragOver={(event) => drag.onOver(event, group.root)}
      onDragLeave={drag.onLeave}
      onDrop={(event) => drag.onDrop(event, group.root)}
      onDragEnd={drag.onEnd}
      onContextMenu={menu.open}
    >
      <button
        type="button"
        className={styles.groupRow}
        {...(current ? { 'data-current': '' } : {})}
        onClick={(event) => (event.altKey ? onToggleAll() : onToggle())}
        title={`${current ? 'The folder this app is working in.\n' : ''}${group.root}\n⌥-click to ${open ? 'collapse' : 'expand'} every project.`}
      >
        <ChevronIcon
          className={styles.groupChevron}
          size={11}
          {...(open ? { 'data-open': '' } : {})}
        />
        {/* An open folder for the one you are in, a closed one for the rest:
            the same distinction the OS file manager makes, and the one Codex
            makes in this exact list. */}
        {current ? (
          <FolderOpenIcon size={12} className={styles.groupIcon} />
        ) : (
          <FolderIcon size={12} className={styles.groupIcon} />
        )}
        <span className={styles.groupName}>{group.name}</span>
        {pinned && <PinIcon size={11} className={styles.groupPin} />}
        <span className={styles.groupCount}>{group.sessions.length}</span>
      </button>
      <span className={styles.groupTools}>
        <button
          type="button"
          className={styles.groupAdd}
          onClick={() => void store.startSessionIn(group.root)}
          title={`New session in ${group.name}`}
          aria-label={`New session in ${group.name}`}
        >
          <PlusIcon size={12} />
        </button>
        <button
          type="button"
          className={styles.groupAdd}
          aria-haspopup="menu"
          aria-expanded={menu.at !== null}
          onClick={menu.open}
          title={`Actions for ${group.name}`}
          aria-label={`Actions for ${group.name}`}
        >
          <MoreIcon size={12} />
        </button>
      </span>
      <WorkspaceMenu
        group={group}
        at={menu.at}
        onClose={menu.close}
        onNewWorktree={onNewWorktree}
      />
    </div>
  )
}

/**
 * A room, in the tree, with the conversations in it folded underneath.
 *
 * A project holds as many rooms as the work wants — the same way it holds
 * sessions — so a room is a row at the same level as a loose conversation,
 * and the ones it holds are one level further in. The group glyph says it is
 * several agents; the dot on each child says it is one.
 *
 * The whole row opens the room. The chevron is a separate button inside it,
 * because "show me who is in here" and "take me in there" are different
 * questions and a tree that answers the wrong one is a tree you stop
 * expanding.
 */
const RoomRow = ({
  room,
  sessions,
  now,
  open,
  onToggle,
  onDelete,
  onRename,
  onDeleteRoom,
}: {
  readonly room: TeamState
  /** The project's conversations — members are matched against these. */
  readonly sessions: readonly SessionSummary[]
  readonly now: number
  readonly open: boolean
  readonly onToggle: () => void
  readonly onDelete: (summary: SessionSummary) => void
  readonly onRename: (room: TeamState) => void
  readonly onDeleteRoom: (room: TeamState) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const menu = useContextMenu()
  /* Resolved against what the tree is *showing* first, so the agent filter
     applies here as it does everywhere else — a room drawn straight from its
     member list would keep conversations the filter had just removed from
     every other row, the sidebar disagreeing with itself one line apart.
     Then the live session map, because a conversation reaches `sessions` a
     beat before it reaches `history`: adding an agent from the room's own
     rail put it in the roster while the tree said "No agents in here yet"
     directly beneath, for as long as the history took to catch up.

     The filter is then applied to the answer rather than by withholding that
     second lookup. Starving it was the same rule by accident and only while
     the group happened to be carrying the members: a room in a project the
     tree drew for the room's own sake has no sessions of its own, so every
     member resolved to nothing and a full room read "No agents in here yet"
     under a filter its members matched. Saying which conversations the
     filter keeps is the rule; where they were found is not. */
  const shown = new Map(
    sessions.map((summary) => [String(sessionKey(summary.runtime, summary.id)), summary]),
  )
  const filtered = snapshot.listPrefs.agent !== null
  const members = room.members
    .map((key) => shown.get(String(key)) ?? snapshot.sessions.get(key))
    .filter((one): one is SessionSummary => one !== undefined)
    .filter(
      (one) => !filtered || agentKeyOf(one.runtime, snapshot.runtimes) === snapshot.listPrefs.agent,
    )
  const claimed = room.intents.filter((one) => one.state === 'claimed').length
  const held = room.channel.filter(
    (entry) => entry.kind === 'message' && entry.state === 'held',
  ).length

  return (
    <div>
      <div
        className={styles.roomRow}
        {...(held > 0 ? { 'data-held': '' } : {})}
        {...(menu.at ? { 'data-menu-open': '' } : {})}
        role="button"
        tabIndex={0}
        onContextMenu={menu.open}
        aria-label={`Room ${room.name}`}
        title={
          held > 0
            ? `${room.name} — a held message is waiting for you`
            : `${room.name} — the board, the chat, and who is here`
        }
        onClick={() => store.openTeamRoom(room.id)}
        onKeyDown={(event) => {
          /* Only the row's own keys. The chevron inside it is a button, and
             its Enter or Space bubbles here: focusing the twisty and pressing
             either opened the room instead of folding it, and Space's
             `preventDefault` below swallowed the click that would have done
             the folding. A nested control answers for itself. */
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            store.openTeamRoom(room.id)
          }
        }}
      >
        <button
          type="button"
          className={styles.roomTwisty}
          aria-expanded={open}
          aria-label={open ? `Hide the agents in ${room.name}` : `Show the agents in ${room.name}`}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          <ChevronIcon className={styles.groupChevron} size={11} {...(open ? { 'data-open': '' } : {})} />
        </button>
        <TeamIcon size={12} className={styles.roomIcon} />
        <span className={styles.groupName}>{room.name}</span>
        {/* A state and a size, and they must not read as one number. Drawn
            plainly the row said "1 0" — two counts in the same grey, the same
            size, a gap apart, and the second with nothing on it to say what it
            counted. The project row one line above already answers this: a
            glyph qualifies the count beside it, so what is a state looks like
            a state. */}
        {claimed > 0 && (
          <span className={styles.roomClaimed} title={`${claimed} of this room's jobs ${claimed === 1 ? 'is' : 'are'} claimed`}>
            <TodoActiveIcon size={11} />
            {claimed}
          </span>
        )}
        <span
          className={styles.groupCount}
          /* `members` is resolved against what the tree is showing, so under an
             agent filter it is a subset — saying "N conversations in this
             room" of a filtered count states as fact a number the filter
             chose. The row says which number it is showing. */
          title={
            filtered
              ? `${members.length} of this room's conversations match the agent filter`
              : members.length === 1
                ? '1 conversation in this room'
                : `${members.length} conversations in this room`
          }
        >
          {members.length}
        </span>
        {/* The same ⋯ a conversation row has, in the same place, because a
            room is another thing this project holds and the two rows must not
            teach different habits. */}
        <span className={styles.rowMenu} {...(menu.at ? { 'data-open': '' } : {})}>
          <button
            type="button"
            className={styles.rowMenuButton}
            aria-haspopup="menu"
            aria-expanded={menu.at !== null}
            onClick={(event) => {
              event.stopPropagation()
              menu.open(event)
            }}
            title={`Actions for ${room.name}`}
            aria-label={`Actions for ${room.name}`}
          >
            <MoreIcon size={12} />
          </button>
        </span>
      </div>
      <ContextMenu at={menu.at} label={`Actions for ${room.name}`} onClose={menu.close}>
        <MenuItem
          icon={<PencilIcon size={13} />}
          label="Rename…"
          onSelect={() => onRename(room)}
        />
        <MenuSeparator />
        <MenuItem
          icon={<TrashIcon size={13} />}
          danger
          label="Delete room…"
          /* The room, not the conversations. Saying which is the whole of what
             somebody needs to know before pressing it, and the dialog behind
             it says it again with the counts. */
          title="Puts the board and the chat away. The conversations carry on."
          onSelect={() => onDeleteRoom(room)}
        />
      </ContextMenu>
      {open && (
        <div className={styles.nested}>
          {members.length === 0 ? (
            <div className={styles.emptyGroup}>No agents in here yet — open it to add one.</div>
          ) : (
            members.map((summary) => (
              <SessionRow key={summary.id} summary={summary} now={now} onDelete={onDelete} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** How many sessions a workspace shows before "Show more". */
const COLLAPSED_LIMIT = 5

/** Where a dragged project would land: above or below the row under the pointer. */
interface DropTarget {
  readonly root: string
  readonly edge: 'before' | 'after'
}

interface DragHandlers {
  readonly dragging: string | null
  readonly over: DropTarget | null
  onStart(event: ReactDragEvent, root: string): void
  onOver(event: ReactDragEvent, root: string): void
  onLeave(): void
  onDrop(event: ReactDragEvent, root: string): void
  onEnd(): void
}

/**
 * Every spelling of one project's folder that a room might be keyed by.
 *
 * `homeOf` deliberately homes a project at the subfolder you have open —
 * `projects.test.ts` pins it, and a second opinion there is a duplicate row.
 * The host keys a room at the *repository*: `Team.createRoom` overwrites
 * whatever root it was handed with `#boardRootOf`'s answer. So opening
 * `<repo>/packages/ui` and making a room there produces a room rooted at
 * `<repo>` and a project row homed at `packages/ui`, and comparing the two
 * as strings drew the project twice — once holding your conversations and
 * once holding your room.
 *
 * Neither side is wrong, and nothing here overrules either: the row's own
 * conversations already carry the repository they came from, so the row can
 * answer to both names without changing what it is called.
 *
 * This is the one disagreement left. The others a room's root could once
 * have carried were the host spelling one folder two ways, and the host
 * resolves both halves through `repositoryOf` now, so a symlinked path or
 * an open parent folder standing in for the repository under it cannot
 * produce one. What survives is structural rather than accidental: the tree
 * homes a project where you are standing and the host names the repository,
 * on purpose, and both go on being right. If that ever stops being true,
 * this can go — a fallback nobody can name a live case for is a liability.
 */
export const projectRoots = (group: ProjectGroup): string[] => [
  ...new Set([
    group.root,
    ...group.sessions.map((one) => one.repo?.root).filter((root): root is string => !!root),
  ]),
]

/** Our own drag, not a file from the desktop. */
const PROJECT_MIME = 'application/x-harnessdesk-project'

/**
 * The projects the list is showing, in the order it shows them.
 *
 * A hook rather than a value computed in `SessionTree`, because the controls
 * on the section header act on the same projects — "collapse all" has to
 * know which folders "all" means — and two answers to that question is one
 * too many.
 */
/**
 * A history row for a conversation that is open here and listed nowhere.
 *
 * The history is the agents' own stores read through them, and an agent with
 * no `session/list` — Gemini CLI — lists nothing at all, so the conversation
 * being typed into had no row anywhere in the tree. The same gap opens for a
 * beat after any conversation starts, before the history catches up. The
 * live map is the desk's own knowledge of what is open, and a row drawn from
 * it says what the session says about itself. The repository is left unknown
 * rather than guessed: the grouping already folds a worktree path onto its
 * checkout, which is the case this was found in.
 */
const rowOf = (session: Session): SessionSummary => ({
  id: session.id,
  runtime: session.runtime,
  title: session.title ?? null,
  preview: session.preview ?? firstAsk(session),
  cwd: session.cwd,
  status: session.status,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  git: session.git ?? null,
  repo: null,
})

/**
 * The first thing the person typed, for a row with no name yet — their words
 * alone, with any envelope the desk sent beside them taken off here rather
 * than left for every reader to strip. Every text block of a message is
 * read, not the first: the composer puts attached context — a page, a
 * plan — in blocks of its own *before* the typed words, so the first block
 * of a message with chips is all envelope and strips to nothing.
 */
const firstAsk = (session: Session): string | null => {
  for (const turn of session.turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue
      for (const block of item.content) {
        if (block.type !== 'text') continue
        const words = splitContext(block.text).text.trim()
        if (words.length > 0) return words
      }
    }
  }
  return null
}

export const useProjectGroups = (): ProjectGroup[] => {
  const snapshot = useSnapshot()
  /* Open conversations the history does not list, as rows. Recomputed
     whenever a session changes — cheap, a handful of entries — but the
     grouping below is keyed on the facts a row is drawn from, so a token
     streaming into one of them does not regroup a thousand rows. */
  const liveRows = useMemo(() => {
    const listed = new Set(snapshot.history.map((summary) => String(sessionKey(summary.runtime, summary.id))))
    return [...snapshot.sessions.entries()]
      .filter(([key]) => !listed.has(String(key)))
      .map(([, session]) => rowOf(session))
  }, [snapshot.history, snapshot.sessions])
  /* The facts a live row is drawn from, as one string. The first ask is one
     of them: a conversation opened empty is "Untitled session" until the
     person types, and the row has to learn its name then — a key without
     the preview kept the old label for as long as nothing else about the
     row changed. Assistant tokens never move it, because `firstAsk` reads
     the person's messages only. */
  const liveKey = useMemo(
    () =>
      liveRows
        .map(
          (row) =>
            `${row.runtime}\u0000${row.id}\u0000${row.title ?? ''}\u0000${row.preview ?? ''}\u0000${row.cwd}\u0000${row.status.type}`,
        )
        .join('\u0001'),
    [liveRows],
  )
  const liveRef = useRef(liveRows)
  liveRef.current = liveRows
  /* The roots the rooms declare, and not `teams` itself, because that map is
     replaced on every board mutation — a chat post, a claim, a rename — and
     re-grouping the whole history for a message nobody asked this list about
     is work for nothing. Only the set of roots changes what comes out.
     Joined on NUL, the one byte a path cannot hold. */
  const roomRoots = useMemo(
    () => [...new Set([...snapshot.teams.values()].map((team) => team.root))].sort().join('\u0000'),
    [snapshot.teams],
  )
  return useMemo(() => {
    const listed = [...liveRef.current, ...snapshot.history]
    const filtered = snapshot.listPrefs.agent
      ? listed.filter(
          (summary) => agentKeyOf(summary.runtime, snapshot.runtimes) === snapshot.listPrefs.agent,
        )
      : listed
    // The open workspace leads, then what the user pinned in the order they
    // pinned it, then the rest by the chosen order. A worktree you have open
    // is the project it is a checkout of, so the row it leads is that one.
    const current = projectRootOf(snapshot.workspace)
    const list = groupByProject(
      filtered,
      snapshot.workspaces.map((workspace) => workspace.path),
      snapshot.workspace,
    )
    const pinned = snapshot.listPrefs.pinned
    // A folder just opened has no sessions to be grouped by, and a list that
    // does not mention the folder you are in leaves "where am I" to the branch
    // chip. It gets its row — empty — until the first conversation fills it.
    if (current && !snapshot.listPrefs.agent && !list.some((group) => group.root === current)) {
      list.push({ root: current, name: folderName(current), sessions: [], updatedAt: 0 })
    }
    /* And a room earns its project a row for the same reason, with more of a
       claim to one: nothing creates a room implicitly — somebody made it and
       gave it a name, and it is a place the list is meant to reach.
       The groups above are keyed by what the *sessions* said about their
       checkout; a room is keyed by the root the *host* resolved when it was
       made. Those agree in the ordinary case and part company in real ones —
       a project nothing has reached `history` from yet (a session lands in
       `sessions` a beat before `history`, so a room's own members do not
       make its project a group), and a folder the host can no longer
       resolve at all, whose room keeps the root it was recorded with.
       A room whose root is merely a different *spelling* of a folder the
       tree already draws is not this loop's business: `projectRoots` above
       matches those onto the row that is already there.
       Either way a room with no group was drawn nowhere at all: it is
       only ever rendered from inside a project, so the tree held thirteen
       rooms and showed one, and the five for the folder being worked in were
       the ones missing while a room from another project stayed. Reaching a
       room is the whole point of the row, so the row comes first and the
       disagreement shows as an extra folder rather than as nothing. That
       folder is never the current one — the fallback above would already have
       made that row — so past two projects it waits inside "Other projects"
       with everything else you are not standing in. */
    const claimed = new Set(list.flatMap((group) => projectRoots(group)))
    for (const root of roomRoots.split('\u0000')) {
      // The empty string is "no rooms at all", and a room with no folder has
      // none to be filed under either — the same answer serves both.
      if (root === '' || claimed.has(root)) continue
      list.push({ root, name: folderName(root), sessions: [], updatedAt: 0 })
      claimed.add(root)
    }
    // The folder you have open leads — unless you have put it somewhere
    // yourself, in which case the place you put it wins. Nothing else in the
    // list may quietly overrule an arrangement someone made by hand.
    const rank = (group: ProjectGroup): number => {
      const index = pinned.indexOf(group.root)
      if (index !== -1) return index
      if (group.root === current) return -1
      return pinned.length
    }
    const pinnedSessions = snapshot.listPrefs.pinnedSessions
    for (const group of list) {
      group.sessions.sort((a, b) => {
        const aKey = String(sessionKey(a.runtime, a.id))
        const bKey = String(sessionKey(b.runtime, b.id))
        const aPin = pinnedSessions.indexOf(aKey)
        const bPin = pinnedSessions.indexOf(bKey)
        if (aPin !== -1 && bPin !== -1) return aPin - bPin
        if (aPin !== -1) return -1
        if (bPin !== -1) return 1
        return 0
      })
    }
    return list.sort((a, b) => {
      const byRank = rank(a) - rank(b)
      if (byRank !== 0) return byRank
      if (snapshot.listPrefs.sort === 'name') return a.name.localeCompare(b.name)
      return b.updatedAt - a.updatedAt
    })
  }, [snapshot.history, liveKey, snapshot.listPrefs.agent, snapshot.listPrefs.pinned, snapshot.listPrefs.pinnedSessions, snapshot.listPrefs.sort, snapshot.workspace, snapshot.workspaces, roomRoots])
}

export const SessionTree = ({ now }: { now: number }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const collapsed = useMemo(
    () => new Set(snapshot.listPrefs.collapsed),
    [snapshot.listPrefs.collapsed],
  )
  const groups = useProjectGroups()

  const toggle = useCallback((key: string) => store.toggleCollapsed(key), [store])

  // Live state across every workspace, for the triage band.
  const triage = useMemo(() => {
    const waiting: SessionSummary[] = []
    const working: SessionSummary[] = []
    for (const summary of snapshot.history) {
      const key = sessionKey(summary.runtime, summary.id)
      const live = snapshot.sessions.get(key)
      if (!live) continue
      const state = traceOf(
        live,
        snapshot.approvals.some((entry) => entry.key === key) ||
          snapshot.queues.get(key)?.status === 'paused',
      )
      if (state === 'waiting') waiting.push(summary)
      else if (ACTIVE_STATES.has(state)) working.push(summary)
    }
    return { waiting, working }
  }, [snapshot.history, snapshot.sessions, snapshot.approvals, snapshot.queues])

  /* The rooms in each project, so a room can be drawn where it belongs.
     There used to be one line above the whole tree reading "Room · 2 open · 1
     claimed" for whichever folder was open, which is not a place in a tree:
     it named one project's room while standing over all of them, it could
     only ever name *one*, and a project can hold several. Rooms are rows in
     the tree now, beside the sessions, which is where the things you open
     live. */
  const roomsByProject = useMemo(() => {
    const out = new Map<string, TeamState[]>()
    for (const team of snapshot.teams.values()) {
      const held = out.get(team.root)
      if (held) held.push(team)
      else out.set(team.root, [team])
    }
    for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }, [snapshot.teams])

  // The current project stays open; the rest fold under "Other projects"
  // once there are enough of them for the fold to save anything. The fold's
  // state lives in preferences rather than in localStorage: the renderer is
  // served from a fresh origin on every launch, so anything written there is
  // gone by the next one.
  const othersOpen = snapshot.listPrefs.othersOpen
  const setOthersOpen = useCallback((open: boolean) => store.setOthersOpen(open), [store])
  // One dialog for the whole list rather than one per row: it is modal, only
  // one can be open, and a row that unmounts while its own dialog was open —
  // which is exactly what a delete does — would take the dialog with it.
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  /* The room being renamed, and the room being put away — held by *id*, not
     by the object. A captured `TeamState` is a photograph: later pushes
     replace the room in the snapshot and never touch what the dialog is
     reading, so a Delete opened on an empty room went on saying "there is
     nothing on its board" while a job was added to it, and pressing it would
     have taken that job with no warning. Resolved from the snapshot on every
     render instead, and the dialog closes on its own if the room goes. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)
  const renamingRoom = renaming === null ? null : (snapshot.teams.get(renaming) ?? null)
  const closingRoom = closing === null ? null : (snapshot.teams.get(closing) ?? null)
  const currentRoot = projectRootOf(snapshot.workspace)
  const near = groups.filter(
    (group) =>
      group.root === currentRoot || snapshot.listPrefs.pinned.includes(group.root) || groups.length <= 2,
  )
  const far = groups.filter((group) => !near.includes(group))

  const anyOpen = groups.some((group) => !collapsed.has(group.root))
  const toggleAll = useCallback(
    () => store.setProjectsCollapsed(groups.map((group) => group.root), anyOpen),
    [anyOpen, groups, store],
  )

  /**
   * Where a drop puts a project.
   *
   * There is exactly one manual order in this list and it is the pinned run,
   * so arranging by hand and pinning are the same act: the projects you have
   * dropped somewhere keep the order you dropped them in, and they wear the
   * pin that says so. Dropping onto "Other projects" hands one back to the
   * sort. Everything else in the list is still ordered by recency or name,
   * and nothing you did not touch changes place.
   */
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  const [announcement, setAnnouncement] = useState('')

  const arrange = useCallback(
    (root: string, beforeRoot: string | null) => {
      const order = near.map((group) => group.root).filter((entry) => entry !== root)
      const at = beforeRoot === null ? order.length : order.indexOf(beforeRoot)
      const index = at === -1 ? order.length : at
      const arranged = [...order.slice(0, index), root, ...order.slice(index)]
      // Only the project you dragged joins the run: moving one thing must not
      // quietly arrange the others, and the folder you happen to have open is
      // in this list for a different reason than the ones you put here.
      const keep = new Set([...snapshot.listPrefs.pinned, root])
      const shown = arranged.filter((entry) => keep.has(entry))
      // A pinned project whose sessions have all been archived has no row to
      // be arranged among. It keeps its pin rather than losing it to a drag
      // that was never about it.
      const offscreen = snapshot.listPrefs.pinned.filter((entry) => !shown.includes(entry))
      store.setListPrefs({ pinned: [...shown, ...offscreen] })
      setAnnouncement(`Moved to position ${shown.indexOf(root) + 1} of ${shown.length}`)
    },
    [near, snapshot.listPrefs.pinned, store],
  )

  const drag: DragHandlers = {
    dragging,
    over,
    onStart: (event, root) => {
      event.dataTransfer.setData(PROJECT_MIME, root)
      event.dataTransfer.effectAllowed = 'move'
      setDragging(root)
    },
    onOver: (event, root) => {
      if (!dragging || dragging === root) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const box = event.currentTarget.getBoundingClientRect()
      setOver({ root, edge: event.clientY < box.top + box.height / 2 ? 'before' : 'after' })
    },
    onLeave: () => setOver(null),
    onDrop: (event, root) => {
      if (!dragging || dragging === root) return
      event.preventDefault()
      const edge = over?.root === root ? over.edge : 'before'
      const after = near[near.findIndex((group) => group.root === root) + 1]
      arrange(dragging, edge === 'before' ? root : (after?.root ?? null))
      setDragging(null)
      setOver(null)
    },
    onEnd: () => {
      setDragging(null)
      setOver(null)
    },
  }

  const renderGroup = (group: ProjectGroup) => {
    const open = !collapsed.has(group.root)
    const rooms = projectRoots(group)
      .flatMap((root) => roomsByProject.get(root) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
    /* A conversation is listed once: under its room if it is in one, under
       the project if it is not. Two rows for one session — the room's copy
       and a loose copy — would make the tree's own count disagree with
       itself, and there would be no way to tell which of them was the one
       that could be dragged, pinned or deleted. */
    const inRooms = new Set(rooms.flatMap((room) => room.members.map(String)))
    const loose = group.sessions.filter(
      (summary) => !inRooms.has(String(sessionKey(summary.runtime, summary.id))),
    )
    const shown = expanded.has(group.root) ? loose : loose.slice(0, COLLAPSED_LIMIT)
    return (
      <div key={group.root}>
        <GroupHead
          group={group}
          open={open}
          onToggle={() => toggle(group.root)}
          onToggleAll={toggleAll}
          onNewWorktree={(root) => store.askNewWorktree(root)}
          drag={drag}
        />
        {open && rooms.length === 0 && group.sessions.length === 0 && (
          <div className={styles.emptyGroup}>
            No conversations yet — ⌘N starts one here.
          </div>
        )}
        {open && (rooms.length > 0 || loose.length > 0) && (
          <div className={styles.nested}>
            {/* Rooms first, then the conversations working on their own.
                A room is a container and the loose sessions are not, so
                putting the containers at the top keeps the indented block
                in one run rather than threaded through the flat rows. */}
            {rooms.map((room) => (
              <RoomRow
                key={room.id}
                room={room}
                sessions={group.sessions}
                now={now}
                open={!collapsed.has(room.id)}
                onToggle={() => toggle(room.id)}
                onDelete={setDeleting}
                onRename={(one) => setRenaming(one.id)}
                onDeleteRoom={(one) => setClosing(one.id)}
              />
            ))}
            {shown.map((summary) => (
              <SessionRow key={summary.id} summary={summary} now={now} onDelete={setDeleting} />
            ))}
            {!expanded.has(group.root) && loose.length > COLLAPSED_LIMIT && (
              <button
                type="button"
                className={styles.showMore}
                onClick={() =>
                  setExpanded((current) => new Set(current).add(group.root))
                }
              >
                Show {loose.length - COLLAPSED_LIMIT} more
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Triage first: what needs the developer, then what is working — every
          workspace, one list. The words come from the live trace. */}
      {triage.waiting.length > 0 && (
        <div className={styles.triage} data-tone="waiting">
          <div className={styles.triageLabel}>Needs you · {triage.waiting.length}</div>
          {triage.waiting.map((summary) => (
            <SessionRow
              key={`w-${summary.runtime}-${summary.id}`}
              summary={summary}
              now={now}
              onDelete={setDeleting}
            />
          ))}
        </div>
      )}
      {triage.working.length > 0 && (
        <div className={styles.triage} data-tone="working">
          <div className={styles.triageLabel}>Working · {triage.working.length}</div>
          {triage.working.map((summary) => (
            <SessionRow
              key={`a-${summary.runtime}-${summary.id}`}
              summary={summary}
              now={now}
              onDelete={setDeleting}
            />
          ))}
        </div>
      )}
      {near.map(renderGroup)}
      {far.length > 0 && (
        <>
          <button
            type="button"
            className={styles.otherProjects}
            onClick={() => setOthersOpen(!othersOpen)}
            aria-expanded={othersOpen}
            {...(dragging && !far.some((group) => group.root === dragging)
              ? { 'data-insert': 'into' }
              : {})}
            title={dragging ? 'Drop here to let this project sort itself again' : undefined}
            onDragOver={(event) => {
              if (!dragging) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(event) => {
              if (!dragging) return
              event.preventDefault()
              store.moveProject(dragging, -1)
              setAnnouncement('Back in automatic order')
              setDragging(null)
              setOver(null)
            }}
          >
            <ChevronIcon className={styles.groupChevron} size={11} {...(othersOpen ? { 'data-open': '' } : {})} />
            Other projects
            <span className={styles.groupCount}>{far.length}</span>
          </button>
          {othersOpen && far.map(renderGroup)}
        </>
      )}
      {deleting && <DeleteSession summary={deleting} onClose={() => setDeleting(null)} />}
      {renamingRoom && <RenameRoom room={renamingRoom} onClose={() => setRenaming(null)} />}
      {closingRoom && <DeleteRoom room={closingRoom} onClose={() => setClosing(null)} />}
      {/* Reordering by hand is silent by nature; this is the same move said
          out loud, so the keyboard rows and the drag land in the same place
          for someone who cannot see the list move. */}
      <div className={styles.srOnly} role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  )
}
