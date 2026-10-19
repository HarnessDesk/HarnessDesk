import { isChatFolder } from '../lib/chats'
import { teamsInput } from '../lib/teams-snapshot'
import { goneProjectFolders, roomsByProjectFor } from '../lib/room-folders'
import { SidebarMenuState } from '../design'
import { teamInSidebar, teamListRow, type TeamListState } from '../lib/teams-list'
import {
  Button,
  Chip,
  ContextMenu,
  Dot,
  FRAME,
  LeftColumnList,
  LeftColumnRename,
  LeftColumnGroup,
  LeftColumnListOptions,
  LeftColumnEmpty,
  LeftColumnRow,
  type LeftColumnTrail,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  Separator,
  Spinner,
  LeftColumnSeats,
  Submenu,
  Text,
  buttonVariants,
  useContextMenu,
} from '../design'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

import { isBusy, sessionKey, sessionId, runtimeId, sessionModel, type Session, type SessionSummary, type TeamState } from '@harnessdesk/protocol'

import { agentGroups, agentKey, agentKeyOf } from '../lib/accounts'
import { folderName, groupByProject, groupHolding, isWorktreeSession, migratedRoots, projectGroupRootOf, projectRootOf, roomGroupRootOf, type ProjectGroup } from '../lib/projects'
import { firstAsk, sessionLabel } from '../lib/sessions'
import { seatLabelsOf } from '../lib/seat-names'
import { captureForRoot } from '../lib/provenance'
import { teamSeats, hasConversation, seatDisplayName } from '../lib/team-seats'
import { goalRunOf } from '../lib/goal-run'
import { goalName } from '../lib/goals'
import { selectedProjectRowIndex } from '../lib/sidebar-project-selection'
import { ACTIVE_STATES, TRACE_LABEL, traceOf } from '../lib/trace'
import { panes } from '../state/layout'

import { useSnapshot, useSnapshotSelector, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import {
  ArchiveIcon,
  AgentIcon,
  ClockIcon,
  CollapseAllIcon,
  CopyIcon,
  EveryoneIcon,
  ExpandAllIcon,
  FolderGoneIcon,
  ForkIcon,
  PencilIcon,
  PanelIcon,
  PinIcon,
  SlidersIcon,
  SortNameIcon,
  TeamIcon,
  TrashIcon,
  UnpinIcon,
} from './Icons'
import { SessionHoverCard } from './AgentCards'
import { RuntimeMark } from './BrandIcons'
import { DeleteSession } from './DeleteSession'
import { WorkspaceMenu } from './WorkspaceMenu'

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

type SessionRowSlice = {
  runtime: AppSnapshot['runtimes'][number] | undefined
  pinned: boolean
  liveTitle: string | null | undefined
  livePreview: string | null | undefined
  deskCopy: boolean
  trace: ReturnType<typeof traceOf> | null
  backgrounded: number
  error: string | null
  folderGone: string | null
  active: boolean
  needsYou: boolean
  busy: boolean
  /** What a seat nobody typed to is called: its job and its Team. */
  seatLabel: string | null
}

const sameSessionRowSlice = (left: SessionRowSlice, right: SessionRowSlice): boolean =>
  left.runtime === right.runtime &&
  left.pinned === right.pinned &&
  left.liveTitle === right.liveTitle && left.livePreview === right.livePreview &&
  left.deskCopy === right.deskCopy && left.trace === right.trace &&
  left.backgrounded === right.backgrounded && left.error === right.error && left.folderGone === right.folderGone &&
  left.active === right.active && left.needsYou === right.needsYou && left.busy === right.busy &&
  left.seatLabel === right.seatLabel

const SessionRow = memo(({
  summary,
  now,
  onDelete,
  suppressSelection = false,
  virtualKey,
  virtualIndex,
  virtualCount,
}: {
  summary: SessionSummary
  now: number
  suppressSelection?: boolean
  /** Raises the confirmation; the dialog belongs to the list, not to a row. */
  onDelete: (summary: SessionSummary) => void
  virtualKey?: string
  virtualIndex?: number
  virtualCount?: number
}) => {
  const store = useStore()
  const menu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const key = sessionKey(summary.runtime, summary.id)
  const {
    runtime, pinned, liveTitle, livePreview, deskCopy, trace, backgrounded, error,
    folderGone, active, needsYou, busy, seatLabel,
  } = useSnapshotSelector((snapshot): SessionRowSlice => {
    const live = snapshot.sessions.get(key)
    const status = live?.status ?? summary.status
    const needsYou = snapshot.approvals.some((entry) => entry.key === key) ||
      snapshot.queues.get(key)?.status === 'paused'
    const trace = live ? traceOf(live, needsYou) : null
    return {
      runtime: snapshot.runtimes.find((entry) => entry.id === summary.runtime),
      pinned: snapshot.listPrefs.pinnedSessions.includes(String(key)),
      liveTitle: live?.title,
      livePreview: live ? live.preview ?? firstAsk(live) : undefined,
      deskCopy: live?.deskCopy === true,
      trace,
      error: status.type === 'error' ? status.message ?? 'Failed' : null,
      backgrounded: (snapshot.tasks.get(key) ?? []).filter((task) => task.state === 'running').length,
      folderGone: snapshot.foldersGone.get(summary.cwd) ?? null,
      active: snapshot.activeSessionKey === key,
      needsYou: needsYou || trace === 'waiting',
      busy: live ? isBusy(live) : summary.status.type === 'active',
      seatLabel: seatLabelsOf(snapshot).get(String(key)) ?? null,
    }
  }, sameSessionRowSlice)
  const agentName = runtime?.presentation.name ?? 'This conversation’s runtime'
  /* The name the person just gave it, before the history list has caught up.
     A rename patches the open session and the indexed row at once;
     138 renames in a row left the sidebar saying "Untitled session" down the
     whole list for the better part of a minute while the room's rail already
     read every name. The live session is the fresher record when it exists. */
  /* A Seat without a person's first message is named by its job and Team. */
  const label = sessionLabel(liveTitle === undefined ? summary.title : liveTitle, livePreview ?? summary.preview, seatLabel ?? undefined)
  const traceShown = trace !== null && (ACTIVE_STATES.has(trace) || trace === 'waiting' || trace === 'failed')
  const worktree = isWorktreeSession(summary)
  const running = !needsYou && (backgrounded > 0 || (trace !== null && ACTIVE_STATES.has(trace)) || busy)
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

  const startRename = useCallback(() => {
    setDraft(summary.title ?? '')
    setRenaming(true)
  }, [summary.title])
  const commitRename = useCallback(() => {
    const title = draft.trim()
    setRenaming(false)
    if (title.length === 0 || title === summary.title) return
    void store.renameSession(title, key)
  }, [draft, key, store, summary.title])

  const facts = [
    label, agentName,
    needsYou ? 'Needs you' : error ?? (traceShown ? TRACE_LABEL[trace] : running ? 'Running' : 'Idle'),
    relativeTime(summary.updatedAt, now),
    summary.git?.branch,
    worktree ? `Worktree ${folderName(summary.cwd)}` : null,
    folderGone ? `${folderGone}. The transcript can be read; nothing more can be sent.` : null,
    pinned ? 'Pinned' : null,
    backgrounded > 0 ? `${backgrounded} running in the background` : null,
  ].filter(Boolean).join(' · ')
  const trailing: LeftColumnTrail | undefined = needsYou
    ? { kind: 'mark', icon: <SidebarMenuState label="Needs you" tone="warning" state="limit" compact />, label: 'Needs you' }
    : error !== null || trace === 'failed'
      ? { kind: 'mark', icon: <Dot state="broken" variant="navigation" />, label: error ?? 'Failed' }
      : folderGone
        ? { kind: 'mark', icon: <FolderGoneIcon size={16} />, label: `${folderGone}. The transcript can be read; nothing more can be sent.` }
        : running ? { kind: 'mark', icon: <Spinner size="sm" aria-hidden />, label: 'Working' } : undefined

  return <div data-region="session-row" data-virtual-key={virtualKey} data-virtual-index={virtualIndex}
    data-virtual-count={virtualCount} onContextMenu={menu.open}>
    {renaming ? <LeftColumnRename input={<Input variant="quiet" controlSize="row"
      value={draft} autoFocus onChange={event => setDraft(event.target.value)} onBlur={commitRename}
      onKeyDown={event => {
        if (event.key === 'Enter') commitRename()
        if (event.key === 'Escape') { event.preventDefault(); setRenaming(false) }
      }} />} /> : <LeftColumnRow ref={rowRef} label={label} title={facts} selected={active && !suppressSelection}
      onClick={() => { void store.openSession(summary.id, { runtime: summary.runtime }) }}
      icon={<SessionHoverCard session={summary}><span aria-label={agentName}>{runtime ? <RuntimeMark runtime={runtime} size={16} /> : <AgentIcon size={16} />}</span></SessionHoverCard>}
      trailing={trailing} action={{ label: `Actions for ${label}`, expanded: menu.at !== null,
        onClick: event => { rowRef.current?.focus({ preventScroll: true }); menu.open(event) } }} />}
      <ContextMenu at={menu.at} label={`Actions for ${label}`} onClose={menu.close} icons="all">
        <MenuItem
          icon={<PencilIcon size={13} />}
          label="Rename"
          onSelect={startRename}
        />
        <MenuItem
          icon={pinned ? <UnpinIcon size={13} /> : <PinIcon size={13} />}
          label={pinned ? 'Unpin' : 'Pin'}
          onSelect={() => store.toggleSessionPinned(String(key))}
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
          title="Read this beside the conversation you are in."
          onSelect={() => {
            void store.openSession(summary.id, { runtime: summary.runtime, area: 'right' })
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
        <MenuItem
          icon={<CopyIcon size={13} />}
          label="Copy"
          value="⌘C"
          onSelect={() => void navigator.clipboard?.writeText(label).catch(() => {})}
        />
        <MenuSeparator />
        <MenuItem
          icon={<ArchiveIcon size={13} />}
          label="Archive"
          title="Hide it from the sidebar; find it in Archive"
          onSelect={() => void store.archiveSession(summary.id, summary.runtime, label)}
        />
        <MenuItem
          icon={<TrashIcon size={13} />}
          label="Remove from HarnessDesk"
          title={deskCopy || runtime?.capabilities.readableHistory === false
            ? "HarnessDesk's copy is the only record" : `${agentName} keeps its own copy`}
          onSelect={() => void store.removeSession(summary.id, summary.runtime)}
        />
        <MenuSeparator />
        <MenuItem
          icon={<TrashIcon size={13} />}
          label="Delete everywhere…"
          danger
          disabled={runtime?.capabilities.deleteHistory !== 'trash'}
          title={!runtime ? 'This conversation’s runtime is unavailable.' : runtime.capabilities.deleteHistory === 'erase'
            ? `${agentName} erases it for good, so delete it there` : runtime.capabilities.deleteHistory !== 'trash'
              ? `${agentName} keeps no way to delete one.` : undefined}
          onSelect={() => onDelete(summary)}
        />
      </ContextMenu>
    </div>
})

/**
 * The list's display controls, in one place the way Claude Code desktop and
 * Codex keep theirs: density, an agent filter, and group order, behind one
 * sliders button on the section header. When the filter hides sessions the
 * button wears a dot — a filtered list must never read as missing data.
 */
export const SessionListControls = ({ searching = false }: { searching?: boolean } = {}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const prefs = snapshot.listPrefs
  const filtered = prefs.agent !== null
  const groups = useProjectGroups({ searching })
  const roots = groups.map((group) => group.root)
  const collapsedRoots = migratedRoots(prefs.collapsed, snapshot.workspace, groups)
  const openCount = roots.filter((root) => !collapsedRoots.includes(root)).length

  return (
    <LeftColumnListOptions filtered={filtered}>
      <Popover
        title="How this list is shown"
        drop="down"
        align="left"
        triggerClassName={buttonVariants({ variant: 'muted', size: 'icon-xs' })}
        label={<SlidersIcon size={13} />}
       icons="none">
        {(close) => (
          <Menu close={close}>
            {/* Folding is first because it is the one row here that answers
                "I cannot see the list for the list" — the state everything
                below is a refinement of. ⌥-click on any project's chevron
                does the same thing without opening this. */}
            <MenuLabel>Projects</MenuLabel>
            <Submenu label="Sort projects" value={prefs.sort === 'recency' ? 'Recency' : 'Name'} wide icons="none">
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
            </Submenu>
            <Submenu label="Show runtimes" value={prefs.agent === null ? 'All runtimes' : agentGroups(snapshot.runtimes).find(({ info }) => agentKey(info) === prefs.agent)?.info.presentation.name ?? 'All runtimes'} wide icons="none">
              <MenuItem
                icon={<EveryoneIcon size={14} />}
                selected={prefs.agent === null}
                label="All runtimes"
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
            </Submenu>
            <MenuSeparator />
            <MenuItem
              icon={<CollapseAllIcon size={14} />}
              label="Collapse all"
              value={roots.length === 1 ? '1 project' : `${roots.length} projects`}
              disabled={openCount === 0 ? 'Every project is already folded.' : false}
              onSelect={() => store.setProjectsCollapsed(roots, true)}
            />
            <MenuItem
              icon={<ExpandAllIcon size={14} />}
              label="Expand all"
              disabled={openCount === roots.length ? 'Every project is already open.' : false}
              onSelect={() => store.setProjectsCollapsed(groups.flatMap((group) => group.folders), false)}
            />
          </Menu>
        )}
      </Popover>
      {filtered && <Dot state="signin" aria-hidden="true" />}
    </LeftColumnListOptions>
  )
}

/**
 * A project's row. Click folds it; New session appears on hover.
 * A right-click anywhere on the row opens its remaining actions,
 * because the row is a thing, and things have context menus.
 *
 * The row can also be picked up and dropped somewhere else in the list. That
 * is the only way to say "this one goes here", so a drop is taken as exactly
 * that: see `SessionTree`'s `drop` for what it writes.
 */
const GroupHead = ({
  group,
  open,
  pinned,
  holdsOpen,
  onToggle,
  onToggleAll,
  onNewWorktree,
  drag,
}: {
  group: ProjectGroup
  open: boolean
  /** Read through the groups, so a pin recorded under a clone is the project's. */
  pinned: boolean
  /** The folder the app has open is this project's: its home, or a clone of it. */
  holdsOpen: boolean
  onToggle: () => void
  /** ⌥-click on the chevron: the whole list, not this one folder. */
  onToggleAll: () => void
  onNewWorktree: (root: string) => void
  drag: DragHandlers
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const menu = useContextMenu()
  /* Whether the folder the app is working in *is* this row's home. It used to
     be marked only by leading the list, which says nothing once you have
     arranged the list yourself — and "which project is this about" is the
     question every worktree, every ⌘N and every terminal here is answered
     by. The row lights when the open folder is the project's (`holdsOpen`),
     a clone of it included; where an action takes place is only ever the
     home, or the folder that was opened, and that is this. */
  const current = projectGroupRootOf(snapshot.workspace) === group.root
  /*
   * `group.root` is a comparison key — the canonical form grouping and
   * dedup compare by, `projectGroupRootOf`'s own answer, which for a
   * non-git folder opened through an alias is the host's `realPath` rather
   * than what was actually opened. Acting on it directly reopened that
   * exact alias as a second, indistinguishable workspace the moment "+" or
   * an action in the menu ran (#907) — the dedup this row exists to prove
   * undone by the row's own controls. `projectRootOf` is the answer that
   * was never meant to be corrected this way; for the project standing
   * open, that is the spelling every action here keeps to.
   */
  const actualRoot = current ? (projectRootOf(snapshot.workspace) ?? group.root) : group.root
  const stopped = projectRoots(group)
    .map((root) => captureForRoot(root, snapshot.captureHealth, snapshot.workspaces))
    .find((health) => health?.state === 'stopped')
  const edge = drag.over?.root === group.root ? drag.over.edge : null
  return (
    <div
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
      <LeftColumnRow project current={holdsOpen} dragging={drag.dragging === group.root} insertion={edge ?? undefined} label={group.name}
        expanded={open} title={`${holdsOpen ? (current ? 'The folder this app is working in.\n' : 'Holds the folder this app is working in.\n') : ''}${actualRoot}${pinned ? '\nPinned' : ''}\n⌥-click to ${open ? 'collapse' : 'expand'} every project.${stopped ? `\n${stopped.reason} ${stopped.nextStep}` : ''}`}
        onClick={event => event.altKey ? onToggleAll() : onToggle()}
        trailing={stopped ? { kind: 'mark', icon: <Dot variant="navigation" />, label: `${stopped.reason} ${stopped.nextStep}` }
          : undefined}
        action={{ kind: 'new', label: `New session in ${group.name}`,
          onClick: () => { void store.startSessionIn(actualRoot) } }} />
      <WorkspaceMenu
        group={group}
        current={current}
        actualRoot={actualRoot}
        at={menu.at}
        onClose={menu.close}
        onNewWorktree={onNewWorktree}
      />
    </div>
  )
}

/**
 * Resolve a Team's member data for agent-filter matching and external activation.
 * History, live conversations and durable Seats all remain sources of ownership;
 * the sidebar nests retained Seats under their owning Team.
 */
const roomMembers = (
  room: TeamState,
  sessions: readonly SessionSummary[],
  snapshot: AppSnapshot,
  hiddenKeys: ReadonlySet<string>,
  historyByKey: ReadonlyMap<string, SessionSummary>,
): SessionSummary[] => {
  const shown = new Map(sessions.map(summary => [String(sessionKey(summary.runtime, summary.id)), summary]))
  const filtered = snapshot.listPrefs.agent !== null
  return teamSeats(snapshot.goals.get(room.id), room, goalRunOf(room.id, snapshot.goals.get(room.id), snapshot.flowExecutions))
    .filter(hasConversation)
    .map(({key, record}) => {
      const recorded = historyByKey.get(String(key))
      const listed = shown.get(String(key)) ?? (recorded && !snapshot.foldersGone.has(recorded.cwd) ? recorded : undefined)
      if (listed) return listed
      const live = snapshot.sessions.get(key)
      // A search already put its matches in `shown`. Outside that list, a
      // hidden gone-folder member must not be recreated from its Seat record.
      if (snapshot.foldersGone.has(recorded?.cwd ?? live?.cwd ?? room.cwd ?? room.root)) return undefined
      return live ?? ((record.openedAt > 0 || snapshot.goals.get(room.id)?.receipt) ? {
        id: record.session.sessionId as SessionSummary['id'], runtime: record.session.runtime as SessionSummary['runtime'],
        // The Seat's job is the fallback; its agent's name is not a title.
        title: null, cwd: room.cwd ?? room.root, status: { type: 'idle' as const },
        createdAt: record.openedAt, updatedAt: room.updatedAt,
      } : undefined)
    })
    .filter((one): one is SessionSummary => one !== undefined)
    .filter((one) => !hiddenKeys.has(String(sessionKey(one.runtime, one.id))))
    .filter(
      (one) => !filtered || agentKeyOf(one.runtime, snapshot.runtimes) === snapshot.listPrefs.agent,
    )
}

const RoomRow = ({ room, state, news, open, onToggle, overview, historyByKey, members, suppressSelection = false, virtualKey, virtualIndex, virtualCount }: {
  readonly room: TeamState
  readonly state: TeamListState
  readonly news: boolean
  readonly open: boolean
  readonly onToggle: () => void
  readonly overview: ReturnType<typeof teamsInput>[number]['overview']
  readonly historyByKey: ReadonlyMap<string, SessionSummary>
  readonly members: readonly string[] | null
  readonly suppressSelection?: boolean
  readonly virtualKey?: string
  readonly virtualIndex?: number
  readonly virtualCount?: number
}) => {
  const store = useStore(), snapshot = useSnapshot()
  const goal = snapshot.goals.get(room.id)
  const name = goal ? goalName(goal.goal) : room.name
  const execution = goalRunOf(room.id, goal, snapshot.flowExecutions)
  const seats = teamSeats(goal, room, execution)
  const records = new Map([...(goal?.members ?? []), ...(goal?.pastMembers ?? [])].map(record => [record.id, record]))
  const seatRows = new Map(overview.seats.map(row => [row.seat, row]))
  const ended = execution?.state === 'stopped'
  const waiting = state === 'needs-you' || seats.some(({ key }) => key &&
    (snapshot.approvals.some(one => one.key === key) || snapshot.queues.get(key)?.status === 'paused'
      || (snapshot.sessions.get(key) && traceOf(snapshot.sessions.get(key)!, false) === 'waiting')))
  const running = !ended && !waiting && (state === 'working' || goal?.activity === 'working' || seats.some(({ key }) => {
    const live = key ? snapshot.sessions.get(key) : undefined
    return live !== undefined && isBusy(live) || Boolean(key && snapshot.tasks.get(key)?.some(task => task.state === 'running'))
  }))
  const claimed = room.intents.filter(entry => entry.state === 'claimed').length
  const unread = state === 'unread'
  const held = room.channel.filter(entry => entry.kind === 'message' && entry.state === 'held').length
  const selected = panes(snapshot.layout.root).some(pane => pane.view.kind === 'room' && pane.view.room === room.id)
  const ready = state === 'settled'
  const attention = waiting ? 'Needs you' : news && !selected ? 'New' : null
  const trailing: LeftColumnTrail | undefined = attention
    ? { kind: 'mark', icon: <SidebarMenuState label={attention} tone={waiting ? 'warning' : 'info'} state={waiting ? 'limit' : 'new'} compact />, label: attention }
    : running && !open ? { kind: 'mark', icon: <Spinner size="sm" aria-hidden />, label: 'Working' } : undefined
  const displayMembers = seats.filter(hasConversation).map(seat => ({ record: records.get(seat.record.id), nickname: seat.name, runtimeName: snapshot.runtimes.find(one => one.id === seat.record.session.runtime)?.presentation.name }))
  return <div data-region="team-row" data-virtual-key={virtualKey} data-virtual-index={virtualIndex} data-virtual-count={virtualCount}>
    <LeftColumnRow label={name} icon={<TeamIcon size={16} />} selected={selected && !suppressSelection}
      title={`${name}${state === 'stopping' ? ' · Stopping' : state === 'stopped' ? ' · Stopped' : ''}${attention ? ` · ${attention}` : ''}${ready ? ' · Ready to wrap' : ''}${unread ? ' · Unread activity' : ''}${running ? ' · Working' : ''}${held > 0 ? ` · ${held} held messages` : ''}${claimed > 0 ? ` · ${claimed} claimed jobs` : ''}`}
      disclosure={{ open, onToggle }} buttonProps={{ 'aria-label': `Room ${name}`, onKeyDown: event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          if (event.key === 'ArrowRight' && !open || event.key === 'ArrowLeft' && open) {
            event.preventDefault(); event.stopPropagation(); onToggle()
          }
        }
      } }} trailing={trailing}
      onClick={() => store.openTeamRoom(room.id)} />
    {open && <LeftColumnSeats>{seats.map(seat => {
      const row = seatRows.get(seat.record.id)
      if (!row || members !== null && !members.includes(row.seat)) return null
      const runtime = seat.record.session ? snapshot.runtimes.find(one => one.id === seat.record.session!.runtime) : undefined
      const live = seat.key ? snapshot.sessions.get(seat.key) : undefined
      const summary = seat.key ? historyByKey.get(String(seat.key)) : undefined
      const canOpen = hasConversation(seat) && Boolean(live || summary || seat.record.openedAt > 0)
      const record = records.get(seat.record.id)
      const label = seatDisplayName(record, row.name, runtime?.presentation.name, displayMembers)
      const status = live?.status ?? summary?.status
      const error = status?.type === 'error' ? status.message ?? 'Failed' : live && traceOf(live, false) === 'failed' ? 'Failed' : null
      const working = row.state === 'working' || Boolean(seat.key && snapshot.tasks.get(seat.key)?.some(task => task.state === 'running'))
      const stateLabel = row.state === 'needs-you' ? 'Needs you' : row.state === 'unread' ? 'New' : error ?? (working ? 'Working' : 'Idle')
      const mark: LeftColumnTrail | undefined = row.state === 'needs-you' || row.state === 'unread'
        ? { kind: 'mark', label: stateLabel, icon: <SidebarMenuState label={stateLabel} tone={row.state === 'needs-you' ? 'warning' : 'info'} state={row.state === 'needs-you' ? 'limit' : 'new'} compact /> }
        : error ? { kind: 'mark', label: error, icon: <Dot state="broken" variant="navigation" /> }
          : working ? { kind: 'mark', label: 'Working', prefix: row.card ? `#${row.card.id}` : undefined, icon: <Spinner size="sm" aria-hidden /> } : undefined
      return <li key={row.seat} data-region="seat-row"><LeftColumnRow nested label={label}
        icon={runtime ? <RuntimeMark runtime={runtime} size={16} /> : <AgentIcon size={16} />}
        title={[runtime?.presentation.name, (live ? sessionModel(live) : null) ?? record?.seat?.model, row.card?.title, stateLabel, canOpen ? null : 'Not open'].filter(Boolean).join(' · ')}
        selected={seat.key === snapshot.activeSessionKey && !suppressSelection} trailing={mark}
        onClick={() => { if (canOpen && hasConversation(seat)) void store.openSession(sessionId(seat.record.session.sessionId), { runtime: runtimeId(seat.record.session.runtime) }); else { store.openTeamRoom(room.id); store.setTeamFramePage(room.id, 'overview') } }} /></li>
    })}</LeftColumnSeats>}
  </div>
}

/**
 * The folders that no longer exist, said once.
 *
 * A folder that is gone is not a project, and nothing that ran in it is listed
 * under one: a Team's deleted clone and a deleted worktree were most of a busy
 * desk's "Other projects". Nothing is lost — the conversations are still in
 * the history, which search and the archive read — so this is a line, not a
 * place: quiet text and one menu. The menu forgets them, which stops this
 * counting them and forgets any that were opened as a workspace; it touches no
 * conversation.
 */
const GoneFolders = ({ folders }: { folders: readonly string[] }) => {
  const store = useStore()
  const menu = useContextMenu()
  const count = folders.length === 1 ? '1 folder' : `${folders.length} folders`
  return (
    <div data-region="gone-folders" onContextMenu={menu.open}>
      <LeftColumnRow label={folders.length === 1 ? '1 folder is gone' : `${folders.length} folders are gone`}
        icon={<FolderGoneIcon size={16} />} title="Conversations in a folder that no longer exists are not listed here. They are kept, and search and the archive still find them."
        onClick={menu.open} action={{ label: 'Actions for gone folders', expanded: menu.at !== null, onClick: menu.open }} />
      <ContextMenu at={menu.at} label="Actions for gone folders" onClose={menu.close} icons="all">
        <MenuItem
          icon={<FolderGoneIcon size={13} />}
          label={`Forget ${count}`}
          hint="Their conversations are kept."
          onSelect={() => void store.forgetFolders(folders)}
        />
      </ContextMenu>
    </div>
  )
}

/** How many sessions a workspace shows before "Show more". */
const COLLAPSED_LIMIT = 5

type ProjectRow =
  | { kind: 'room'; room: TeamState; updatedAt: number; pinnedIndex: null }
  | { kind: 'session'; summary: SessionSummary; updatedAt: number; pinnedIndex: number | null }

const WindowedProjectRows = ({
  rows,
  enabled,
  targetIndex,
  navigationIndex,
  footer,
  renderRow,
}: {
  rows: readonly ProjectRow[]
  enabled: boolean
  targetIndex: number
  navigationIndex: number | null
  footer?: ReactNode
  renderRow: (row: ProjectRow, index: number) => ReactNode
}) => {
  const root = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0, origin: 0 })
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map())
  const scroller = useRef<HTMLElement | null>(null)
  const lastTarget = useRef<number | null>(null)
  const lastNavigationTarget = useRef<number | null>(null)
  const keyIndexes = useRef(new Map<string, number>())
  const snapshot = useSnapshot()
  keyIndexes.current = new Map(rows.map((row, index) => [row.kind === 'room' ? `room:${row.room.id}` : `session:${row.summary.runtime}:${row.summary.id}`, index]))
  const estimate = FRAME.rail.rowPitch
  const scrollTarget = navigationIndex ?? targetIndex
  const virtualLabels = JSON.stringify(rows.map((row) => {
    if (row.kind === 'room') {
      const goal = snapshot.goals.get(row.room.id)
      return goal ? goalName(goal.goal) : row.room.name
    }
    const key = sessionKey(row.summary.runtime, row.summary.id)
    const live = snapshot.sessions.get(key)
    return sessionLabel(live ? live.title : row.summary.title, live ? live.preview ?? firstAsk(live) : row.summary.preview, seatLabelsOf(snapshot).get(String(key)))
  }))

  useEffect(() => {
    if (!enabled || !root.current) return
    let parent = root.current.parentElement
    while (parent && parent !== document.body) {
      const overflow = getComputedStyle(parent).overflowY
      if (overflow === 'auto' || overflow === 'scroll') break
      parent = parent.parentElement
    }
    const scrollElement = parent ?? document.scrollingElement
    if (!scrollElement) return
    scroller.current = scrollElement as HTMLElement

    const refresh = () => {
      const element = root.current
      const scroll = scroller.current
      if (!element || !scroll) return
      const rootRect = element.getBoundingClientRect()
      const scrollRect = scroll === document.scrollingElement
        ? { top: 0, height: window.innerHeight }
        : scroll.getBoundingClientRect()
      setViewport({
        top: scroll.scrollTop,
        height: scroll.clientHeight || scrollRect.height,
        origin: rootRect.top - scrollRect.top + scroll.scrollTop,
      })
    }
    const observer = new ResizeObserver((entries) => {
      setHeights((current) => {
        const next = new Map(current)
        let changed = false
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.virtualKey
        const index = key === undefined ? NaN : keyIndexes.current.get(key) ?? NaN
        if (!Number.isInteger(index)) continue
        const row = entry.target as HTMLElement
        const gap = Number.parseFloat(getComputedStyle(row).marginTop) || 0
          const height = entry.contentRect.height + gap
          if (next.get(index) !== height) {
            next.set(index, height)
            changed = true
          }
        }
        return changed ? next : current
      })
    })
    for (const child of [...root.current.children]) {
      if ((child as HTMLElement).dataset.virtualKey !== undefined) observer.observe(child)
    }
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes]) {
          if (node instanceof HTMLElement && node.dataset.virtualKey !== undefined) observer.observe(node)
        }
      }
    })
    mutations.observe(root.current, { childList: true })
    scrollElement.addEventListener('scroll', refresh, { passive: true })
    const resize = new ResizeObserver(refresh)
    resize.observe(scrollElement)
    resize.observe(root.current)
    refresh()
    return () => {
      observer.disconnect()
      mutations.disconnect()
      resize.disconnect()
      scrollElement.removeEventListener('scroll', refresh)
      scroller.current = null
    }
  }, [enabled])

  const itemHeight = (index: number) => heights.get(index) ?? estimate
  let start = 0
  let beforeHeight = 0
  const minY = Math.max(0, viewport.top - viewport.origin - 500)
  while (start < rows.length && beforeHeight + itemHeight(start) < minY) {
    beforeHeight += itemHeight(start++)
  }
  let end = start
  let throughHeight = beforeHeight
  const maxY = viewport.top + viewport.height - viewport.origin + 500
  while (end < rows.length && throughHeight < maxY) throughHeight += itemHeight(end++)
  const keyboardOutsideWindow = navigationIndex !== null && (navigationIndex < start || navigationIndex >= end)
  const renderStart = keyboardOutsideWindow ? Math.max(0, navigationIndex - 5) : start
  const renderEnd = keyboardOutsideWindow ? Math.min(rows.length, navigationIndex + 20) : end
  const renderBeforeHeight = rows.slice(0, renderStart).reduce((total, _row, index) => total + itemHeight(index), 0)
  const renderAfterHeight = rows.slice(renderEnd).reduce((total, _row, index) => total + itemHeight(renderEnd + index), 0)

  useEffect(() => {
    if (!enabled || scrollTarget < 0) return
    if (navigationIndex !== null) {
      if (lastNavigationTarget.current === navigationIndex) return
      lastNavigationTarget.current = navigationIndex
    } else {
      lastNavigationTarget.current = null
      if (lastTarget.current === scrollTarget) return
      lastTarget.current = scrollTarget
    }
    const scroll = scroller.current
    const element = root.current
    if (!scroll || !element) return
    const offset = rows.slice(0, scrollTarget).reduce((total, _row, index) => total + itemHeight(index), 0)
    scroll.scrollTop = viewport.origin + offset
    const event = new Event('scroll')
    scroll.dispatchEvent(event)
  }, [enabled, scrollTarget, navigationIndex, rows, viewport.origin, heights])

  useEffect(() => {
    if (navigationIndex === null) return
    const row = root.current?.querySelector<HTMLElement>(`[data-virtual-index="${navigationIndex}"] [data-slot="sidebar-menu-button"]`)
    row?.focus()
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [navigationIndex, renderStart, renderEnd])

  if (!enabled) return <LeftColumnList ref={root} footer={footer}>{rows.map(renderRow)}</LeftColumnList>
  return <LeftColumnList ref={root} labels={virtualLabels} before={renderBeforeHeight} after={renderAfterHeight} footer={footer}>
    {rows.slice(renderStart, renderEnd).map((row, index) => renderRow(row, renderStart + index))}
  </LeftColumnList>
}

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
    // Every clone of the repository answers to the project too: a room made
    // in one is filed under the project, not under a row of its own.
    ...group.folders,
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
 * What the list is made of.
 *
 * The projects, in the order they are shown; the pinned conversations that
 * ran in a folder that is gone, which no project holds but Pinned still does;
 * and the folders that are gone, which are not listed at all.
 */
export interface ProjectList {
  readonly groups: ProjectGroup[]
  readonly noFolder: SessionSummary[]
  readonly chatFolders: string[]
  readonly hiddenPinned: SessionSummary[]
  /** Folders that no longer exist and have not been forgotten, each once. */
  readonly gone: readonly string[]
}

export const useProjectList = ({ searching = false }: { searching?: boolean } = {}): ProjectList => {
  const snapshot = useSnapshot()
  /* Open conversations the history does not list, as rows. Recomputed
     whenever a session changes — cheap, a handful of entries — but the
     grouping below is keyed on the facts a row is drawn from, so a token
     streaming into one of them does not regroup a thousand rows. */
  const liveRows = useMemo(() => {
    const listed = new Set(snapshot.history.map((summary) => String(sessionKey(summary.runtime, summary.id))))
    return [...snapshot.sessions.entries()]
      .filter(([key, session]) => !snapshot.previewSessions.has(key) && !session.archived && !listed.has(String(key)))
      .map(([, session]) => rowOf(session))
  }, [snapshot.history, snapshot.sessions, snapshot.previewSessions])
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
    () => [...new Set([...snapshot.teams.values()].map((team) => roomGroupRootOf(team, [snapshot.workspace, ...snapshot.workspaces])))]
      .sort().join('\u0000'),
    [snapshot.teams, snapshot.workspace, snapshot.workspaces],
  )
  return useMemo(() => {
    const listed = [...liveRef.current, ...snapshot.history]
    const historyIdentityKeys = new Set(
      snapshot.historyIdentity.map((summary) => String(sessionKey(summary.runtime, summary.id))),
    )
    const identityHistory = [...snapshot.historyIdentity]
    // Visible history can still be search results for a beat after its field
    // is cleared. Only the store's separately maintained full-history identity
    // is authoritative for project homes; live rows can add their own facts.
    for (const summary of liveRef.current) {
      const key = String(sessionKey(summary.runtime, summary.id))
      if (historyIdentityKeys.has(key)) continue
      historyIdentityKeys.add(key)
      identityHistory.push(summary)
    }
    const filtered = snapshot.listPrefs.agent
      ? listed.filter(
          (summary) => agentKeyOf(summary.runtime, snapshot.runtimes) === snapshot.listPrefs.agent,
        )
      : listed
    /* A folder that no longer exists is not a project, and nothing in it is
       listed under one — a deleted clone, a deleted worktree. The
       conversations are not touched: they are still in the history, which
       search and the archive read, and a person who is searching is asking
       for them, so they are drawn then. The one exception is a conversation
       somebody pinned, which they put at the top on purpose: it stays in
       Pinned, where the row says its folder is gone. */
    const pinnedKeys = new Set(snapshot.listPrefs.pinnedSessions.map(String))
    const shown: SessionSummary[] = []
    const hidden: SessionSummary[] = []
    for (const summary of filtered) {
      if (!searching && snapshot.foldersGone.has(summary.cwd)) hidden.push(summary)
      else shown.push(summary)
    }
    const forgotten = new Set(snapshot.listPrefs.forgottenFolders ?? [])
    const gone = goneProjectFolders(snapshot.foldersGone, forgotten, hidden.map(summary => summary.cwd), roomRoots, searching)
    const hiddenPinned = hidden.filter((summary) => pinnedKeys.has(String(sessionKey(summary.runtime, summary.id))))
    // The open workspace leads, then what the user pinned in the order they
    // pinned it, then the rest by the chosen order. A worktree you have open
    // is the project it is a checkout of, so the row it leads is that one.
    const projectWorkspace = snapshot.workspace && !isChatFolder(snapshot.workspace.path, snapshot.chatsFolderRoots) ? snapshot.workspace : null
    const list = groupByProject(
      shown.filter((summary) => !isChatFolder(summary.cwd, snapshot.chatsFolderRoots)),
      snapshot.workspaces.filter(workspace => !isChatFolder(workspace.path, snapshot.chatsFolderRoots)),
      projectWorkspace,
      { identityHistory: identityHistory.filter(summary => !isChatFolder(summary.cwd, snapshot.chatsFolderRoots)), goneFolders: searching ? undefined : new Set(snapshot.foldersGone.keys()),
        seatProjects: new Map([...snapshot.goals.values()].flatMap(goal => goal.members.flatMap(seat =>
          seat.checkout?.project ? [[sessionKey(seat.session.runtime, seat.session.sessionId), seat.checkout.project] as const] : []))) },
    )
    const pinned = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace, list)
    // A folder just opened has no sessions to be grouped by, and a list that
    // does not mention the folder you are in leaves "where am I" to the branch
    // chip. It gets its row — empty — until the first conversation fills it,
    // unless it is a copy of a project the list already has.
    const current = projectGroupRootOf(projectWorkspace)
    const holding = groupHolding(list, projectWorkspace)
    const currentGone = snapshot.workspace !== null && snapshot.foldersGone.has(snapshot.workspace.path)
    if (current && !snapshot.listPrefs.agent && !holding && (searching || !currentGone)) {
      list.push({ root: current, name: folderName(current), sessions: [], updatedAt: 0, folders: [current] })
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
      if (isChatFolder(root, snapshot.chatsFolderRoots) || claimed.has(root) || !searching && snapshot.foldersGone.has(root)) continue
      list.push({ root, name: folderName(root), sessions: [], updatedAt: 0, folders: [root] })
      claimed.add(root)
    }
    // The folder you have open leads — unless you have put it somewhere
    // yourself, in which case the place you put it wins. Nothing else in the
    // list may quietly overrule an arrangement someone made by hand.
    const lead = holding ?? list.find((group) => group.root === current)
    const rank = (group: ProjectGroup): number => {
      const index = pinned.indexOf(group.root)
      if (index !== -1) return index
      if (group === lead) return -1
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
    const groups = list.sort((a, b) => {
      const byRank = rank(a) - rank(b)
      if (byRank !== 0) return byRank
      if (snapshot.listPrefs.sort === 'name') return a.name.localeCompare(b.name)
      return b.updatedAt - a.updatedAt
    })
    const noFolder = shown.filter((summary) => isChatFolder(summary.cwd, snapshot.chatsFolderRoots)).sort((a, b) => b.updatedAt - a.updatedAt)
    const chatFolders = [...new Set([...noFolder.map(summary => summary.cwd),
      ...roomRoots.split('\u0000').filter(root => root !== '' && isChatFolder(root, snapshot.chatsFolderRoots))])]
    return { groups, noFolder, chatFolders, hiddenPinned, gone }
  }, [snapshot.history, snapshot.historyIdentity, snapshot.goals, snapshot.chatsFolderRoots, liveKey, snapshot.listPrefs.agent, snapshot.listPrefs.pinned, snapshot.listPrefs.pinnedSessions, snapshot.listPrefs.sort, snapshot.listPrefs.forgottenFolders, snapshot.foldersGone, snapshot.workspace, snapshot.workspaces, roomRoots, searching])
}

/** The projects alone: what the section's own controls act on. */
export const useProjectGroups = (options: { searching?: boolean } = {}): ProjectGroup[] =>
  useProjectList(options).groups

export const SessionTree = ({ now, searching = false, filter = '', searchEmptyState = null, suppressSelection = false }: {
  now: number
  searching?: boolean
  filter?: string
  searchEmptyState?: ReactNode
  suppressSelection?: boolean
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const treeRef = useRef<HTMLElement>(null)
  const typeahead = useRef({ text: '', timer: 0 })
  const [navigationTarget, setNavigationTarget] = useState<{ root: string; index: number } | null>(null)
  const lastReveal = useRef<string | null>(null)
  const [expandedTeams, setExpandedTeams] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  // Default expansion becomes session state, so leaving a Team does not fold it.
  useEffect(() => {
    const selected = panes(snapshot.layout.root).flatMap(pane => pane.view.kind === 'room' ? [pane.view.room] : [])
    setExpandedTeams(current => {
      const missing = selected.filter(id => !current.has(id))
      return missing.length > 0 ? new Map([...current, ...missing.map(id => [id, true] as const)]) : current
    })
  }, [snapshot.layout.root])
  const filterKey = JSON.stringify([searching ? filter.trim() : null, snapshot.listPrefs.agent])
  const [filterExpansion, setFilterExpansion] = useState<{ key: string; teams: ReadonlyMap<string, boolean> }>(() => ({ key: filterKey, teams: new Map() }))
  useEffect(() => {
    setFilterExpansion(current => current.key === filterKey ? current : { key: filterKey, teams: new Map() })
  }, [filterKey])
  const historyByKey = useMemo(() => new Map(snapshot.history.map(one => [String(sessionKey(one.runtime, one.id)), one])), [snapshot.history])
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set())
  const { groups, noFolder, chatFolders, hiddenPinned, gone } = useProjectList({ searching })
  const noFolderGroup = useMemo<ProjectGroup>(() => ({ root: 'no-folder', name: 'Chats', sessions: noFolder, folders: chatFolders, updatedAt: 0 }), [noFolder, chatFolders])
  const [noFolderOpen, setNoFolderOpen] = useState(false)
  const collapsed = useMemo(
    () => new Set(migratedRoots(snapshot.listPrefs.collapsed, snapshot.workspace, groups)),
    [snapshot.listPrefs.collapsed, snapshot.workspace, groups],
  )

  /* A pin or a fold recorded under a folder that has since been folded into a
     project — a clone, say, that was a row of its own — is the project's, and
     is read that way above. It is rewritten under the project's home as well,
     once, so a toggle or a move works on what is stored and a stale spelling
     cannot bring the pin back after it is undone. Only from the whole list: a
     filtered or searched one is a part of it, and a part must not decide. */
  const listIsWhole = !searching && snapshot.listPrefs.agent === null && !snapshot.historyLoading && snapshot.historyCursor === null
  useEffect(() => {
    if (!listIsWhole) return
    const pinned = migratedRoots(snapshot.listPrefs.pinned, null, groups)
    const folded = migratedRoots(snapshot.listPrefs.collapsed, null, groups)
    const same = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((entry, index) => entry === right[index])
    if (same(pinned, snapshot.listPrefs.pinned) && same(folded, snapshot.listPrefs.collapsed)) return
    store.setListPrefs({ pinned: [...pinned], collapsed: [...folded] })
  }, [groups, listIsWhole, snapshot.listPrefs.collapsed, snapshot.listPrefs.pinned, store])

  const toggle = useCallback((key: string) => {
    const group = groups.find(one => one.root === key)
    const stored = store.getSnapshot().listPrefs.collapsed
    // An explicit action can resolve this project's aliases even while the
    // whole-list migration is waiting for history or a filter to clear.
    if (group && stored.some(root => root !== key && group.folders.includes(root))) {
      store.setListPrefs({ collapsed: stored.filter(root => !group.folders.includes(root)) })
    } else store.toggleCollapsed(key)
  }, [groups, store])

  const teamKeys = useMemo(() => new Set([...snapshot.teams.values()].flatMap(team =>
    teamSeats(snapshot.goals.get(team.id), team, goalRunOf(team.id, snapshot.goals.get(team.id), snapshot.flowExecutions))
      .filter(hasConversation).map(one => String(one.key)))), [snapshot.teams, snapshot.goals, snapshot.flowExecutions])
  const pinnedRows = useMemo(() => {
    const byKey = new Map([...groups.flatMap((group) => group.sessions), ...noFolder, ...hiddenPinned].map((summary) => [String(sessionKey(summary.runtime, summary.id)), summary]))
    return snapshot.listPrefs.pinnedSessions
      .filter(key => !teamKeys.has(String(key)))
      .map((key) => byKey.get(String(key)))
      .filter((summary): summary is SessionSummary => summary !== undefined)
  }, [groups, noFolder, hiddenPinned, snapshot.listPrefs.pinnedSessions, teamKeys])
  const liftedKeys = useMemo(
    () => new Set(pinnedRows.map((summary) => String(sessionKey(summary.runtime, summary.id)))),
    [pinnedRows],
  )


  /* The rooms in each project, so a room can be drawn where it belongs.
     There used to be one line above the whole tree reading "Room · 2 open · 1
     claimed" for whichever folder was open, which is not a place in a tree:
     it named one project's room while standing over all of them, it could
     only ever name *one*, and a project can hold several. Rooms are rows in
     the tree now, beside the sessions, which is where the things you open
     live. */
  const roomsByProject = useMemo(() => roomsByProjectFor(snapshot.teams, snapshot.foldersGone, [snapshot.workspace, ...snapshot.workspaces], searching), [snapshot.teams, snapshot.foldersGone, snapshot.workspace, snapshot.workspaces, searching])

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
  // The project the folder you have open belongs to — its home, or a clone of
  // it — read from the groups, never by comparing the folder with a home.
  const currentGroup = groupHolding(groups, snapshot.workspace)
  const pinnedRoots = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace, groups)
  const near = groups.filter(
    (group) =>
      group === currentGroup || pinnedRoots.includes(group.root) || groups.length <= 2,
  )
  const far = groups.filter((group) => !near.includes(group))

  const activeKey = snapshot.activeSessionKey ? String(snapshot.activeSessionKey) : null
  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    const rows = [...tree.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')]
    const held = rows.find((row) => row === document.activeElement)
    const active = rows.find((row) => row.hasAttribute('aria-current'))
    tree.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      if (button.tabIndex !== -1) button.tabIndex = -1
    })
    const entry = held ?? active ?? rows[0]
    if (entry && entry.tabIndex !== 0) entry.tabIndex = 0
  })

  const onTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof HTMLButtonElement) || !target.matches('[data-slot="sidebar-menu-button"]')) return
    if (event.altKey || event.ctrlKey || event.metaKey && event.key !== '.') return
    const rows = [...(treeRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]') ?? [])]
    const index = rows.indexOf(target)
    if (index < 0) return
    const focus = (row: HTMLButtonElement | undefined) => {
      if (!row) return false
      treeRef.current?.querySelectorAll<HTMLButtonElement>('button').forEach((entry) => { entry.tabIndex = -1 })
      row.tabIndex = 0
      row.focus()
      row.scrollIntoView?.({ block: 'nearest' })
      return true
    }
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey || event.key === '.' && event.metaKey) {
      event.preventDefault()
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      target.click()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nested = target.closest('[data-nested="true"]')
      const leavingSeats = nested && direction > 0 && rows[index + direction]?.closest('[data-nested="true"]') !== nested
      const virtual = nested && !leavingSeats ? null : target.closest<HTMLElement>('[data-virtual-index][data-virtual-count]')
      const project = target.closest<HTMLElement>('[data-virtual-project="true"]')
      const current = Number(virtual?.dataset.virtualIndex)
      const count = Number(virtual?.dataset.virtualCount)
      if (virtual && project?.hasAttribute('data-virtual-labels') && !rows[index + direction]?.closest('[data-nested="true"]') && Number.isInteger(current) && Number.isInteger(count)) {
        const nextIndex = current + direction
        if (nextIndex >= 0 && nextIndex < count) {
          const root = project.parentElement?.dataset.navigationRoot
          if (root) setNavigationTarget({ root, index: nextIndex })
          const mounted = project.querySelector<HTMLButtonElement>(`[data-virtual-index="${nextIndex}"] [data-slot="sidebar-menu-button"]`)
          if (mounted) focus(mounted)
          return
        }
      }
      const next = rows[index + direction]
      if (focus(next)) return
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const virtual = target.closest('[data-nested="true"]') ? null : target.closest<HTMLElement>('[data-virtual-index][data-virtual-count]')
      const project = target.closest<HTMLElement>('[data-virtual-project="true"]')
      const windowedProject = project?.hasAttribute('data-virtual-labels') ? project : null
      if (virtual && windowedProject) {
        const count = Number(virtual.dataset.virtualCount)
        const targetIndex = event.key === 'Home' ? 0 : count - 1
        const root = windowedProject.parentElement?.dataset.navigationRoot
        if (root && Number.isInteger(targetIndex) && targetIndex >= 0) {
          setNavigationTarget({ root, index: targetIndex })
          const mounted = windowedProject.querySelector<HTMLButtonElement>(`[data-virtual-index="${targetIndex}"] [data-slot="sidebar-menu-button"]`)
          if (mounted) focus(mounted)
        }
        return
      }
      const row = event.key === 'Home' ? rows[0] : rows[rows.length - 1]
      if (row) focus(row)
      return
    }
    if (event.key === 'ArrowRight' && target.hasAttribute('aria-expanded')) {
      event.preventDefault()
      if (target.getAttribute('aria-expanded') !== 'true') {
        target.click()
        window.requestAnimationFrame(() => {
          const next = treeRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')[index + 1]
          focus(next)
        })
      }
      else focus(rows[index + 1])
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (target.getAttribute('aria-expanded') === 'true') target.click()
      else {
        const parent = target.closest('[data-nested="true"]')?.parentElement?.querySelector<HTMLButtonElement>(':scope > [data-left-row] > [data-slot="sidebar-menu-button"]') ?? target.closest('[data-project-root], [data-no-folder]')?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"][aria-expanded]') ?? rows.slice(0, index).reverse().find((row) => row.getAttribute('aria-expanded') === 'true')
        focus(parent)
      }
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeahead.current.text += event.key.toLocaleLowerCase()
      window.clearTimeout(typeahead.current.timer)
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.text = '' }, 500)
      const query = typeahead.current.text
      const virtual = target.closest('[data-nested="true"]') ? null : target.closest<HTMLElement>('[data-virtual-index][data-virtual-count]')
      const project = target.closest<HTMLElement>('[data-virtual-project="true"]')
      const windowedProject = project?.hasAttribute('data-virtual-labels') ? project : null
      const labels: string[] = virtual && windowedProject
        ? JSON.parse(windowedProject.dataset.virtualLabels ?? '[]') as string[]
        : rows.map((candidate) => candidate.querySelector('[data-slot="sidebar-menu-label"]')?.textContent?.trim() ?? candidate.textContent?.trim() ?? '')
      const current = windowedProject && virtual ? Number(virtual.dataset.virtualIndex) : index
      for (let offset = 1; offset <= labels.length; offset += 1) {
        const nextIndex = (current + offset) % labels.length
        if (!labels[nextIndex]?.toLocaleLowerCase().startsWith(query)) continue
        event.preventDefault()
        if (virtual && windowedProject) {
          const root = windowedProject.parentElement?.dataset.navigationRoot
          if (root) {
            setNavigationTarget({ root, index: nextIndex })
            const mounted = windowedProject.querySelector<HTMLButtonElement>(`[data-virtual-index="${nextIndex}"] [data-slot="sidebar-menu-button"]`)
            if (mounted) focus(mounted)
          }
        } else focus(rows[nextIndex])
        break
      }
    }
  }, [])
  const teamInputs = teamsInput(snapshot)
  const teamInputsById = new Map(teamInputs.map(input => [input.team.id, input]))
  const teamRows = new Map(teamInputs.map(input => [input.team.id, teamListRow(input)]))
  // A fold hides matches without removing them from the search results.
  const hasChatRooms = chatFolders.some(root => (roomsByProject.get(root) ?? []).some(room => teamInSidebar(teamRows.get(room.id))))
  const hasSearchRows = hasChatRooms || pinnedRows.length > 0 || noFolder.some(summary => !teamKeys.has(String(sessionKey(summary.runtime, summary.id)))) || groups.some((group) =>
    group.sessions.some((summary) => !teamKeys.has(String(sessionKey(summary.runtime, summary.id))))
    || projectRoots(group).some((root) => (roomsByProject.get(root) ?? []).some((room) => teamInSidebar(teamRows.get(room.id)))),
  )
  // A Seat's own checkout can differ from the project that holds its Team.
  const activeTeam = activeKey === null ? null : [...snapshot.teams.values()].find(room =>
    teamInSidebar(teamRows.get(room.id)) && teamSeats(snapshot.goals.get(room.id), room, goalRunOf(room.id, snapshot.goals.get(room.id), snapshot.flowExecutions))
      .some(seat => String(seat.key) === activeKey) && roomMembers(room, [], snapshot, liftedKeys, historyByKey)
      .some(summary => String(sessionKey(summary.runtime, summary.id)) === activeKey)) ?? null
  const activeTeamRoot = activeTeam ? roomGroupRootOf(activeTeam, [snapshot.workspace, ...snapshot.workspaces]) : null
  const activeGroup = useMemo(
    () =>
      activeKey === null
        ? null
        : [...groups, noFolderGroup].find((group) => activeTeamRoot !== null
            ? (group === noFolderGroup ? chatFolders : projectRoots(group)).includes(activeTeamRoot)
            : group.sessions.some((summary) => String(sessionKey(summary.runtime, summary.id)) === activeKey),
          ) ?? null,
    [activeKey, activeTeamRoot, groups, noFolderGroup, chatFolders],
  )

  useEffect(() => {
    if (!activeKey || !activeGroup || liftedKeys.has(activeKey)) { lastReveal.current = null; return }
    // Reveal on activation or newly resolved ownership, then let the person fold it.
    const reveal = JSON.stringify([activeKey, activeGroup.root, activeTeam?.id ?? null])
    if (lastReveal.current !== reveal) {
      lastReveal.current = reveal
      if (activeTeam) setExpandedTeams(current => new Map(current).set(activeTeam.id, true))
      setNavigationTarget(null)
      if (activeGroup === noFolderGroup) setNoFolderOpen(true)
      else if (collapsed.has(activeGroup.root)) toggle(activeGroup.root)
      if (!othersOpen && far.some((group) => group.root === activeGroup.root)) store.setOthersOpen(true)
    }
  }, [activeGroup, activeKey, activeTeam, collapsed, far, liftedKeys, noFolderGroup, othersOpen, roomsByProject, snapshot.goals, snapshot.flowExecutions, store, toggle])

  const anyOpen = groups.some((group) => !collapsed.has(group.root))
  const toggleAll = useCallback(
    () => store.setProjectsCollapsed(groups.flatMap(group => anyOpen ? [group.root] : group.folders), anyOpen),
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
      const existingPinned = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace, groups)
      const keep = new Set([...existingPinned, root])
      const shown = arranged.filter((entry) => keep.has(entry))
      // A pinned project whose sessions have all been archived has no row to
      // be arranged among. It keeps its pin rather than losing it to a drag
      // that was never about it.
      const offscreen = existingPinned.filter((entry) => !shown.includes(entry))
      store.setListPrefs({ pinned: [...shown, ...offscreen] })
      setAnnouncement(`Moved to position ${shown.indexOf(root) + 1} of ${shown.length}`)
    },
    [groups, near, snapshot.listPrefs.pinned, snapshot.workspace, store],
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

  /* The folders that are gone, in one quiet line where the list ends: at the
     end of "Other projects" when that fold is drawn, and under the projects
     when there is no fold. Not a project, and not a row to open. */
  const goneLine = gone.length > 0 ? <GoneFolders folders={gone} /> : null
  const renderGroup = (group: ProjectGroup, folderless = false) => {
    const open = folderless ? noFolderOpen : !collapsed.has(group.root)
    const allRooms = (folderless ? chatFolders : projectRoots(group))
      .flatMap((root) => roomsByProject.get(root) ?? [])
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const rooms = allRooms.filter((room) => teamInSidebar(teamRows.get(room.id)))
    /* A conversation is listed once: under its room if it is in one, under
       the project if it is not. Two rows for one session — the room's copy
       and a loose copy — would make the tree's own count disagree with
       itself, and there would be no way to tell which of them was the one
       that could be dragged, pinned or deleted. */
    const loose = group.sessions.filter(
      (summary) => {
        const key = String(sessionKey(summary.runtime, summary.id))
        return !teamKeys.has(key) && !liftedKeys.has(key)
      },
    )
    const pinnedIndexes = new Map(
      snapshot.listPrefs.pinnedSessions.map((key, index) => [String(key), index]),
    )
    const allRows = [
      ...rooms.map((room) => ({
        kind: 'room' as const,
        room,
        updatedAt: room.updatedAt,
        pinnedIndex: null,
      })),
      ...loose.map((summary) => ({
        kind: 'session' as const,
        summary,
        updatedAt: summary.updatedAt,
        pinnedIndex: pinnedIndexes.get(String(sessionKey(summary.runtime, summary.id))) ?? null,
      })),
    ].sort((a, b) => {
      const aPinned = a.pinnedIndex !== null
      const bPinned = b.pinnedIndex !== null
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      if (a.pinnedIndex !== null && b.pinnedIndex !== null) {
        if (a.pinnedIndex !== b.pinnedIndex) return a.pinnedIndex - b.pinnedIndex
      }
      return b.updatedAt - a.updatedAt
    })
    const selectedIndex = selectedProjectRowIndex(allRows, activeKey, activeTeam?.id ?? null, snapshot.layout.root)
    const expanded = expandedProjects.has(group.root)
    const rows = expanded ? allRows : allRows.slice(0, COLLAPSED_LIMIT)
    if (!expanded && selectedIndex >= COLLAPSED_LIMIT) rows[COLLAPSED_LIMIT - 1] = allRows[selectedIndex]!
    const activeRowIndex = rows.findIndex(row => row === allRows[selectedIndex])
    const firstHiddenIndex = expanded ? -1 : allRows.findIndex(row => !rows.includes(row))
    const overflowTitle = `${allRows.length - rows.length} more ${rooms.length > 0 ? 'rows' : 'conversations'}`
    return (
      <div key={group.root} data-navigation-root={group.root} data-project-root={folderless ? undefined : group.root} data-no-folder={folderless ? '' : undefined}>
        {folderless ? <LeftColumnRow label="Chats"
          expanded={open} onClick={() => setNoFolderOpen(value => !value)} /> : <GroupHead
          group={group}
          open={open}
          pinned={pinnedRoots.includes(group.root)}
          holdsOpen={group === currentGroup}
          onToggle={() => toggle(group.root)}
          onToggleAll={toggleAll}
          onNewWorktree={(root) => store.askNewWorktree(root)}
          drag={drag}
        />}
        {open && !searching && allRooms.length === 0 && group.sessions.length === 0 && (
          <LeftColumnEmpty>No conversations yet — ⌘N starts one here.</LeftColumnEmpty>
        )}
        {open && (allRooms.length > 0 || loose.length > 0) && (
          <WindowedProjectRows
            rows={rows}
            enabled={rows.length > 50}
            targetIndex={activeRowIndex}
            navigationIndex={navigationTarget?.root === group.root ? navigationTarget.index : null}
            footer={allRows.length > COLLAPSED_LIMIT ? <LeftColumnRow label={expanded ? 'Show less' : 'Show more'} title={expanded ? 'Show five rows' : overflowTitle}
              onClick={() => {
                const firstNewIndex = expanded ? null : firstHiddenIndex
                setNavigationTarget(firstNewIndex === null ? null : { root: group.root, index: firstNewIndex })
                setExpandedProjects(current => {
                  const next = new Set(current)
                  if (expanded) next.delete(group.root)
                  else next.add(group.root)
                  return next
                })
              }} /> : undefined}
            renderRow={(row, index) => {
              if (row.kind === 'session') return <SessionRow key={row.summary.id} summary={row.summary} now={now} onDelete={setDeleting} suppressSelection={suppressSelection} virtualKey={`session:${row.summary.runtime}:${row.summary.id}`} virtualIndex={index} virtualCount={rows.length} />
              const selected = activeTeam?.id === row.room.id || panes(snapshot.layout.root).some(pane => pane.view.kind === 'room' && pane.view.room === row.room.id)
              const matchingMembers = searching || snapshot.listPrefs.agent !== null
                ? roomMembers(row.room, group.sessions, snapshot, liftedKeys, historyByKey)
                  .filter(one => !searching || historyByKey.has(String(sessionKey(one.runtime, one.id)))) : []
              const needle = filter.trim().toLocaleLowerCase()
              const goal = snapshot.goals.get(row.room.id)
              const matching = searching || snapshot.listPrefs.agent !== null
                ? teamSeats(goal, row.room, goalRunOf(row.room.id, goal, snapshot.flowExecutions)).filter(seat => {
                  if (!seat.key || liftedKeys.has(String(seat.key))) return false
                  if (snapshot.listPrefs.agent !== null && agentKeyOf(runtimeId(seat.record.session.runtime), snapshot.runtimes) !== snapshot.listPrefs.agent) return false
                  return matchingMembers.some(one => sessionKey(one.runtime, one.id) === seat.key)
                    || searching && needle.length > 0 && seat.name.toLocaleLowerCase().includes(needle)
                }).map(seat => seat.record.id) : null
              const revealing = Boolean(matching?.length)
              const storedOpen = expandedTeams.get(row.room.id) ?? selected
              const open = revealing ? (filterExpansion.key === filterKey ? filterExpansion.teams.get(row.room.id) : undefined) ?? true : storedOpen
              return <RoomRow
                key={row.room.id}
                room={row.room}
                overview={teamInputsById.get(row.room.id)!.overview}
                historyByKey={historyByKey}
                members={matching}
                open={open}
                onToggle={() => {
                  if (revealing) setFilterExpansion(current => ({ key: filterKey,
                    teams: new Map(current.key === filterKey ? current.teams : []).set(row.room.id, !open) }))
                  else setExpandedTeams(current => new Map(current).set(row.room.id, !storedOpen))
                }}
                state={teamRows.get(row.room.id)!.state}
                news={teamRows.get(row.room.id)!.unread}
                suppressSelection={suppressSelection}
                virtualKey={`room:${row.room.id}`}
                virtualIndex={index}
                virtualCount={rows.length}
              />
            }}
          />
        )}

      </div>
    )
  }

  const nearContent = near.map(group => renderGroup(group))
  const farContent = othersOpen ? far.map(group => renderGroup(group)) : null

  const tree = (
    <LeftColumnGroup label="Conversations" heading={false} ref={treeRef} onKeyDown={onTreeKeyDown} onFocusCapture={(event) => {
      const target = event.target as HTMLElement
      if (!target.matches('[data-slot="sidebar-menu-button"]') || target.closest('[data-nested="true"]')) return
      const row = target.closest<HTMLElement>('[data-virtual-index]')
      const root = row?.closest<HTMLElement>('[data-navigation-root]')?.dataset.navigationRoot
      if (root && row) setNavigationTarget({ root, index: Number(row.dataset.virtualIndex) })
    }} role="group" aria-label="Conversations" data-region="session-tree">
      {pinnedRows.length > 0 && (
        <div data-sidebar-band="pinned">
          <LeftColumnGroup label={`Pinned · ${pinnedRows.length}`}>
            {pinnedRows.map(summary => <SessionRow key={`p-${summary.runtime}-${summary.id}`} summary={summary} now={now} onDelete={setDeleting} suppressSelection={suppressSelection} />)}
            <Separator />
          </LeftColumnGroup>
        </div>
      )}
      {nearContent}
      {far.length > 0 && (
        <div>
          <LeftColumnRow label="Other projects" expanded={othersOpen}
            onClick={() => setOthersOpen(!othersOpen)} title={dragging ? 'Drop here to let this project sort itself again' : 'Other projects'}
            insertion={dragging && !far.some(group => group.root === dragging) ? 'into' : undefined}
            trailing={{ kind: 'count', value: far.length, label: `${far.length} other projects` }}
            buttonProps={{ onDragOver: event => {
              if (!dragging) return
              event.preventDefault(); event.dataTransfer.dropEffect = 'move'
            }, onDrop: event => {
              if (!dragging) return
              event.preventDefault(); store.moveProject(dragging, -1)
              setAnnouncement('Back in automatic order'); setDragging(null); setOver(null)
            } }} />
          {othersOpen && <div>{farContent}{goneLine}</div>}
        </div>
      )}
      {far.length === 0 && goneLine}
      {(hasChatRooms || noFolder.some(summary => !teamKeys.has(String(sessionKey(summary.runtime, summary.id))) && !liftedKeys.has(String(sessionKey(summary.runtime, summary.id))))) &&
        renderGroup(noFolderGroup, true)}
      {deleting && <DeleteSession summary={deleting} onClose={() => setDeleting(null)} />}
      {/* Reordering by hand is silent by nature; this is the same move said
          out loud, so the keyboard rows and the drag land in the same place
          for someone who cannot see the list move. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </LeftColumnGroup>
  )
  return <>{tree}{searching && !hasSearchRows && searchEmptyState}</>
}
