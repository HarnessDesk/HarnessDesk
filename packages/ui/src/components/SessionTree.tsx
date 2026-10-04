import { teamsInput } from '../lib/teams-snapshot'
import { teamListRow, type TeamListState } from '../lib/teams-list'
import {
  Button,
  Chip,
  ContextMenu,
  DisclosureChevron,
  Dot,
  Input,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  Separator,
  SidebarGroup,
  SidebarGroupContent,
  GroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuState,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Submenu,
  Text,
  buttonVariants,
  useContextMenu,
} from '../design'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

import { openingOf, sessionKey, type Session, type SessionSummary, type TeamState } from '@harnessdesk/protocol'

import { agentGroups, agentKey, agentKeyOf } from '../lib/accounts'
import { folderName, groupByProject, isWorktreeSession, migratedRoots, projectGroupRootOf, projectRootOf, roomGroupRootOf, type ProjectGroup } from '../lib/projects'
import { captureForRoot } from '../lib/provenance'
import { sessionLabel } from '../lib/sessions'
import { teamSeats, hasConversation } from '../lib/team-seats'
import { goalRunOf } from '../lib/goal-run'
import { goalName } from '../lib/goals'
import { ACTIVE_STATES, TRACE_LABEL, traceOf } from '../lib/trace'
import { panes, sessionOf } from '../state/layout'

import { useSnapshot, useSnapshotSelector, useStore } from '../state/context'
import type { AppSnapshot } from '../state/store'
import {
  ArchiveIcon,
  AgentIcon,
  BranchIcon,
  ClockIcon,
  CollapseAllIcon,
  CopyIcon,
  EveryoneIcon,
  ExpandAllIcon,
  FolderGoneIcon,
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
  TrashIcon,
  UnpinIcon,
} from './Icons'
import { SessionHoverCard } from './AgentCards'
import { RuntimeMark } from './BrandIcons'
import { DeleteSession } from './DeleteSession'
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

type SessionRowSlice = {
  openInPane: boolean
  runtime: AppSnapshot['runtimes'][number] | undefined
  density: AppSnapshot['listPrefs']['density']
  pinned: boolean
  liveTitle: string | null | undefined
  trace: ReturnType<typeof traceOf> | null
  backgrounded: number
  folderGone: string | null
  active: boolean
  needsYou: boolean
}

const sameSessionRowSlice = (left: SessionRowSlice, right: SessionRowSlice): boolean =>
  left.openInPane === right.openInPane && left.runtime === right.runtime &&
  left.density === right.density && left.pinned === right.pinned &&
  left.liveTitle === right.liveTitle && left.trace === right.trace &&
  left.backgrounded === right.backgrounded && left.folderGone === right.folderGone &&
  left.active === right.active && left.needsYou === right.needsYou

const SessionRow = memo(({
  summary,
  now,
  onDelete,
  virtualKey,
  virtualIndex,
  virtualCount,
}: {
  summary: SessionSummary
  now: number
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
    openInPane, runtime, density, pinned, liveTitle, trace, backgrounded,
    folderGone, active, needsYou,
  } = useSnapshotSelector((snapshot): SessionRowSlice => {
    const live = snapshot.sessions.get(key)
    const needsYou = snapshot.approvals.some((entry) => entry.key === key) ||
      snapshot.queues.get(key)?.status === 'paused'
    const trace = live ? traceOf(live, needsYou) : null
    return {
      openInPane: panes(snapshot.layout.root).some((pane) => sessionOf(pane) === key),
      runtime: snapshot.runtimes.find((entry) => entry.id === summary.runtime),
      density: snapshot.listPrefs.density,
      pinned: snapshot.listPrefs.pinnedSessions.includes(String(key)),
      liveTitle: live?.title,
      trace,
      backgrounded: (snapshot.tasks.get(key) ?? []).filter((task) => task.state === 'running').length,
      folderGone: snapshot.foldersGone.get(summary.cwd) ?? null,
      active: snapshot.activeSessionKey === key,
      needsYou: needsYou || trace === 'waiting',
    }
  }, sameSessionRowSlice)
  const agentName = runtime?.presentation.name ?? 'This conversation’s agent'
  /* The name the person just gave it, before the history list has caught up.
     A rename patches the open session at once and re-reads the history after;
     138 renames in a row left the sidebar saying "Untitled session" down the
     whole list for the better part of a minute while the room's rail already
     read every name. The live session is the fresher record when it exists. */
  const ownLabel = sessionLabel(liveTitle ?? summary.title, summary.preview)
  const label = ownLabel
  const traceShown = trace !== null && (ACTIVE_STATES.has(trace) || trace === 'waiting' || trace === 'failed')
  // Work the agent sent to the background and walked away from: the turn is
  // over, the row would read idle, and something is still running. The glyph
  // says so with a quiet spinner, so a person browsing other conversations knows this
  // one has something to look at — the Background tasks panel, once opened.
  const dotState =
    backgrounded > 0
      ? 'ready'
      : traceShown && trace === 'waiting'
        ? 'limit'
        : traceShown && trace === 'failed'
          ? 'broken'
          : traceShown || summary.status.type === 'active'
            ? 'signin'
            : 'available'
  const worktree = isWorktreeSession(summary)
  const running = !needsYou && (backgrounded > 0 || (trace !== null && ACTIVE_STATES.has(trace)) || summary.status.type === 'active')
  const hasActivityMark = running || (!needsYou && traceShown)
  const badgeSlot = (step: 0 | 1 | 2) => step === 0
    ? undefined
    : step === 1
      ? 'end-[calc(var(--sidebar-menu-end-rail)+var(--hd-sidebar-end-action-step))]'
      : 'end-[calc(var(--sidebar-menu-end-rail)+var(--hd-sidebar-end-double-action-step))]'
  const worktreeSlot = badgeSlot(hasActivityMark ? 1 : 0)
  const folderGoneSlot = badgeSlot((worktree ? 1 : 0) + (hasActivityMark ? 1 : 0) as 0 | 1 | 2)
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

  /* The row's own height when renaming starts, which the box then holds: a
     comfortable row's second line, or a chip on a compact one, makes the row
     taller than any fixed box, and the rows below would move up under it. */
  const [renameHeight, setRenameHeight] = useState<number | undefined>(undefined)
  const startRename = useCallback(() => {
    setDraft(summary.title ?? '')
    setRenameHeight(rowRef.current?.getBoundingClientRect().height || undefined)
    setRenaming(true)
  }, [summary.title])
  const commitRename = useCallback(() => {
    const title = draft.trim()
    setRenaming(false)
    if (title.length === 0 || title === summary.title) return
    void store.renameSession(title, key)
  }, [draft, key, store, summary.title])

  return (
    <SidebarMenu className={styles.rowWrap} data-region="session-row" data-virtual-key={virtualKey} data-virtual-index={virtualIndex} data-virtual-count={virtualCount} onContextMenu={menu.open}>
      <SidebarMenuItem className="list-none" trailingMarks={(Number(Boolean(folderGone)) + Number(worktree) + Number(hasActivityMark) + Number(needsYou)) as 0 | 1 | 2 | 3 | 4} data-menu-open={menu.at ? '' : undefined}>
        {renaming ? (
          <Input
            variant="quiet" controlSize="row" className={styles.renameInput}
            style={renameHeight ? { minHeight: renameHeight } : undefined}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') {
                event.preventDefault()
                setRenaming(false)
              }
            }}
          />
        ) : (
          <>
            <SidebarMenuButton
              ref={rowRef}
              trailingOverlay
              // The needs-you chip is inline content. The shared sidebar
              // grammar gives the chip its actual width on the inset rail
              // and folds it while this row’s own actions appear.
              labelTrailingContent={needsYou}
              size={density === 'compact' ? 'sm' : 'default'}
              isActive={active}
              data-active={active ? 'true' : undefined}
              aria-current={active ? 'page' : undefined}
              data-open={openInPane ? '' : undefined}
              title={`${agentName} · ${needsYou ? 'Needs you' : traceShown ? TRACE_LABEL[trace] : relativeTime(summary.updatedAt, now)}${summary.git?.branch ? ` · ${summary.git.branch}` : ''}${worktree ? ` · worktree ${folderName(summary.cwd)}` : ''}${backgrounded > 0 ? ` · ${backgrounded} running in the background` : ''}`}
              onClick={() => void store.openSession(summary.id, { runtime: summary.runtime })}
              icon={
                <SessionHoverCard
                  session={summary}
                  actions={[
                    ...(active ? [] : [{ label: 'Open', primary: true,
                      onSelect: () => void store.openSession(summary.id, { runtime: summary.runtime }) }]),
                    { label: 'Rename', onSelect: startRename },
                  ]}
                >
                  <Text role="meta" className="inline-flex items-center justify-center" aria-label={agentName}>
                    {runtime ? <RuntimeMark runtime={runtime} size={14} /> : <AgentIcon size={14} />}
                  </Text>
                </SessionHoverCard>
              }
              label={
                /* The outer label keeps its full-width geometry. A trailing
                   state/action overlays the rail, but these earned chips and
                   glyphs must remain readable beside it. */
                <span className="flex min-w-0 items-center gap-(--hd-space-1)" title={label}>
                  <span className="min-w-0 truncate">{label}</span>
                  {needsYou && <SidebarMenuState label="Needs you" tone="warning" state="limit" />}
                </span>
              }
            />
            {folderGone && (
              <SidebarMenuBadge className={folderGoneSlot}
                role="img"
                aria-label={`Folder is gone — ${folderName(summary.cwd)}`}
                title={`${folderGone}\nThe transcript can be read; nothing more can be sent to it.`}>
                <Text role="meta"><FolderGoneIcon size={11} /></Text>
              </SidebarMenuBadge>
            )}
            {worktree && (
              <SidebarMenuBadge className={worktreeSlot}
                role="img"
                aria-label={`Worktree ${summary.git?.branch ?? folderName(summary.cwd)}`}
                title={`Worktree · ${summary.git?.branch ?? folderName(summary.cwd)}\n${summary.cwd}`}>
                <Text role="meta"><BranchIcon size={11} /></Text>
              </SidebarMenuBadge>
            )}
            {hasActivityMark && (
              <SidebarMenuBadge aria-label={backgrounded > 0 ? 'Background tasks running' : traceShown ? TRACE_LABEL[trace] : 'Running'}>
                {running ? <Spinner size="sm" tone="neutral" data-tasks={backgrounded > 0 ? '' : undefined} data-live={summary.status.type === 'active' ? '' : undefined} aria-hidden /> : <Dot state={dotState} variant="navigation"
                  pulse={trace !== null && ACTIVE_STATES.has(trace)}
                  data-tasks={backgrounded > 0 ? '' : undefined}
                  data-live={summary.status.type === 'active' ? '' : undefined}
                  data-trace={traceShown ? trace : undefined}
                  aria-hidden="true" />}
              </SidebarMenuBadge>
            )}
            <Tooltip>
              <TooltipTrigger data-slot="sidebar-menu-action" render={
                <SidebarMenuAction showOnHover
                  data-state={menu.at ? 'open' : undefined}
                  aria-haspopup="menu" aria-expanded={menu.at !== null}
                  onClick={menu.open}
                  aria-label={`Actions for ${label}`}>
                  <MoreIcon size={12} />
                </SidebarMenuAction>
              } />
              <TooltipContent>Actions for {label}</TooltipContent>
            </Tooltip>
          </>
        )}
      </SidebarMenuItem>
      <ContextMenu at={menu.at} label={`Actions for ${label}`} onClose={menu.close}>
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
          onSelect={() => void store.archiveSession(summary.id, summary.runtime, label)}
        />
        <MenuItem
          icon={<TrashIcon size={13} />}
          label="Delete…"
          danger
          disabled={menu.at && !runtime ? 'This conversation’s agent is unavailable.' : menu.at && !runtime?.capabilities.deleteHistory ? `${agentName} keeps no way to delete one.` : false}
          onSelect={() => onDelete(summary)}
        />
      </ContextMenu>
    </SidebarMenu>
  )
})

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
  const collapsedRoots = migratedRoots(prefs.collapsed, snapshot.workspace)
  const openCount = roots.filter((root) => !collapsedRoots.includes(root)).length

  return (
    <span className={styles.listControls} {...(filtered ? { 'data-filtered': '' } : {})}>
      <Popover
        title="How this list is shown"
        drop="down"
        align="left"
        triggerClassName={buttonVariants({ variant: 'muted', size: 'icon-xs', className: styles.headerDisplayAction })}
        label={<SlidersIcon size={13} />}
      >
        {(close) => (
          <Menu close={close}>
            {/* Folding is first because it is the one row here that answers
                "I cannot see the list for the list" — the state everything
                below is a refinement of. ⌥-click on any project's chevron
                does the same thing without opening this. */}
            <MenuLabel>Projects</MenuLabel>
            <Submenu label="Sort projects" value={prefs.sort === 'recency' ? 'Recency' : 'Name'}>
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
            <Submenu label="Density" value={prefs.density === 'comfortable' ? 'Comfortable' : 'Compact'}>
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
            </Submenu>
            <Submenu label="Show agents" value={prefs.agent === null ? 'All agents' : agentGroups(snapshot.runtimes).find(({ info }) => agentKey(info) === prefs.agent)?.info.presentation.name ?? 'All agents'}>
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
              onSelect={() => store.setProjectsCollapsed(roots, false)}
            />
          </Menu>
        )}
      </Popover>
      {filtered && <Dot state="signin" className={styles.filterState} aria-hidden="true" />}
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
  const stopped = projectRoots(group)
    .map((root) => captureForRoot(root, snapshot.captureHealth, snapshot.workspaces))
    .find((health) => health?.state === 'stopped')
  const pinned = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace).includes(group.root)
  // The folder the app is working in. It used to be marked only by leading
  // the list, which says nothing once you have arranged the list yourself —
  // and "which project is this about" is the question every worktree, every
  // ⌘N and every terminal here is answered by.
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
      <SidebarMenu>
        <SidebarMenuItem trailingActions={2} trailingMarks={pinned ? 1 : 0} data-current={current ? '' : undefined}>
          <SidebarMenuButton
            trailingActions={2}
            data-draggable=""
            data-insert={edge ?? undefined}
            data-dragging={drag.dragging === group.root ? '' : undefined}
            aria-expanded={open}
            onClick={(event) => (event.altKey ? onToggleAll() : onToggle())}
            title={`${current ? 'The folder this app is working in.\n' : ''}${actualRoot}\n⌥-click to ${open ? 'collapse' : 'expand'} every project.`}
            label={<span className="flex min-w-0 items-center gap-(--hd-space-1)">
              <Text role="prose" ink="secondary" truncate>{group.name}</Text>
              <DisclosureChevron open={open} size="xs" className="opacity-0 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100" />
              {stopped && <span title={`${stopped.reason} ${stopped.nextStep}`} className="group-hover/menu-item:hidden group-focus-within/menu-item:hidden"><Chip tone="neutral" variant="quiet" label="Capture stopped" /></span>}
            </span>}
          />
          {pinned && <SidebarMenuBadge title="Pinned" aria-label="Pinned"><PinIcon size={11} /></SidebarMenuBadge>}
          <Tooltip>
            <TooltipTrigger data-slot="sidebar-menu-action" render={
              <SidebarMenuAction showOnHover className="end-[calc(var(--hd-sidebar-end-rail)+var(--hd-sidebar-end-action-step))]"
                onClick={() => void store.startSessionIn(actualRoot)}
                aria-label={`New session in ${group.name}`}>
                <PlusIcon size={12} />
              </SidebarMenuAction>
            } />
            <TooltipContent>New session in {group.name}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger data-slot="sidebar-menu-action" render={
              <SidebarMenuAction showOnHover data-state={menu.at ? 'open' : undefined}
                aria-haspopup="menu" aria-expanded={menu.at !== null}
                onClick={menu.open}
                aria-label={`Actions for ${group.name}`}>
                <MoreIcon size={12} />
              </SidebarMenuAction>
            } />
            <TooltipContent>Actions for {group.name}</TooltipContent>
          </Tooltip>
        </SidebarMenuItem>
      </SidebarMenu>
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
 * A room, in the tree, with the conversations in it folded underneath.
 *
 * A project holds as many rooms as the work wants — the same way it holds
 * sessions — so a room is a row at the same level as a loose conversation,
 * and the ones it holds are one level further in. The group glyph says it is
 * several agents; the dot on each child says it is one.
 *
 * The whole row opens the room. The chevron is a separate button beside it,
 * because "show me who is in here" and "take me in there" are different
 * questions and a tree that answers the wrong one is a tree you stop
 * expanding.
 */
/**
 * A room's members, resolved against what the tree is *showing* — the agent
 * filter applies here as it does everywhere else, and the live session map is
 * read too, because a conversation reaches `sessions` a beat before it
 * reaches `history`: adding an agent from the room's own rail put it in the
 * roster while the tree still said "0" beneath, for as long as the history
 * took to catch up. `RoomRow`'s own count and its nested member list both
 * read this, so the two can never disagree about how many the row is
 * showing.
 */
const roomMembers = (
  room: TeamState,
  sessions: readonly SessionSummary[],
  snapshot: AppSnapshot,
  hiddenKeys: ReadonlySet<string>,
): SessionSummary[] => {
  const shown = new Map(
    [...snapshot.history, ...sessions].map((summary) => [String(sessionKey(summary.runtime, summary.id)), summary]),
  )
  const filtered = snapshot.listPrefs.agent !== null
  return teamSeats(snapshot.goals.get(room.id), room, goalRunOf(room.id, snapshot.goals.get(room.id), snapshot.flowExecutions))
    .filter(hasConversation)
    .map(({key, record, name}) => shown.get(String(key)) ?? snapshot.sessions.get(key) ?? (
      (record.openedAt > 0 || snapshot.goals.get(room.id)?.receipt) ? {
        id: record.session.sessionId as SessionSummary['id'], runtime: record.session.runtime as SessionSummary['runtime'],
        title: name, cwd: room.cwd ?? room.root, status: { type: 'idle' as const },
        createdAt: record.openedAt, updatedAt: room.updatedAt,
      } : undefined
    ))
    .filter((one): one is SessionSummary => one !== undefined)
    .filter((one) => !hiddenKeys.has(String(sessionKey(one.runtime, one.id))))
    .filter(
      (one) => !filtered || agentKeyOf(one.runtime, snapshot.runtimes) === snapshot.listPrefs.agent,
    )
}

const RoomRow = ({
  room,
  state,
  sessions,
  now,
  open,
  onToggle,
  onDelete,
  hiddenKeys,
  virtualKey,
  virtualIndex,
  virtualCount,
}: {
  readonly room: TeamState
  readonly state: TeamListState
  /** The project's conversations — members are matched against these. */
  readonly sessions: readonly SessionSummary[]
  readonly now: number
  readonly open: boolean
  readonly onToggle: () => void
  readonly onDelete: (summary: SessionSummary) => void
  readonly hiddenKeys: ReadonlySet<string>
  readonly virtualKey?: string
  readonly virtualIndex?: number
  readonly virtualCount?: number
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const goal = snapshot.goals.get(room.id)
  const name = goal ? goalName(goal.goal) : room.name
  const waiting = state === 'needs-you' || teamSeats(goal, room, goalRunOf(room.id, goal, snapshot.flowExecutions)).some(({ key }) =>
    key && (snapshot.approvals.some(one => one.key === key) || snapshot.queues.get(key)?.status === 'paused' || (snapshot.sessions.get(key) && traceOf(snapshot.sessions.get(key)!, false) === 'waiting')))
  const running = !waiting && (state === 'working' || goal?.activity === 'working')
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
  const filtered = snapshot.listPrefs.agent !== null
  const members = roomMembers(room, sessions, snapshot, hiddenKeys)
  /* A wrapped Team's Seats whose conversation was not kept: names, with nothing to open. Listed together, as the
     conversations that were kept are. */
  const unlinked = open ? teamSeats(goal, room, goalRunOf(room.id, goal, snapshot.flowExecutions)).filter(one => !hasConversation(one)) : []
  const claimed = room.intents.filter((one) => one.state === 'claimed').length
  const held = room.channel.filter(
    (entry) => entry.kind === 'message' && entry.state === 'held',
  ).length

  return (
    <SidebarMenu data-virtual-key={virtualKey} data-virtual-index={virtualIndex} data-virtual-count={virtualCount}>
      <SidebarMenuItem trailingMarks={Number(held > 0) + Number(waiting || running) as 0 | 1 | 2}>
        <div className="relative min-w-0">
          <SidebarMenuButton
            trailingOverlay
            role="button"
          aria-label={`Room ${name}`}
          title={`${name} — ${held > 0 ? `${held} held ${held === 1 ? 'message' : 'messages'} waiting for you` : 'the board, the chat, and who is here'}${claimed > 0 ? ` · ${claimed} claimed ${claimed === 1 ? 'job' : 'jobs'}` : ''}`}
          data-held={held > 0 ? '' : undefined}
          onClick={() => store.openTeamRoom(room.id)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              store.openTeamRoom(room.id)
            }
          }}
          icon={<Text role="meta"><TeamIcon size={14} /></Text>}
          label={<span className="flex min-w-0 items-center gap-(--hd-space-1)">
            <span className="min-w-0 truncate">{name}</span>
            {waiting && <SidebarMenuState label="Needs you" tone="warning" state="limit" />}
          </span>}
        />
        {running && <SidebarMenuBadge aria-label="Running" className={held > 0 ? 'end-[calc(var(--sidebar-menu-end-rail)+var(--hd-sidebar-end-action-step))]' : undefined}>
          <Spinner size="sm" tone="neutral" aria-hidden />
        </SidebarMenuBadge>}
        {held > 0 && <SidebarMenuBadge kind="count" title={`${held} held ${held === 1 ? 'message' : 'messages'} waiting for you`}>
          {held}
        </SidebarMenuBadge>}
        <SidebarMenuAction showOnHover
          aria-expanded={open}
          aria-label={open ? `Hide the agents in ${name}` : `Show the agents in ${name}`}
          title={filtered
            ? `${members.length} of this room's conversations match the agent filter`
            : members.length === 1 ? '1 conversation in this room' : `${members.length} conversations in this room`}
          onClick={onToggle}>
          <DisclosureChevron open={open} size="xs" />
        </SidebarMenuAction>
        </div>
        {unlinked.length > 0 && (
          <SidebarMenu nested>
            {unlinked.map((one) => (
              <SidebarMenuItem key={one.record.id}>
                <SidebarMenuButton disabled title="Conversation not kept" label={one.name} />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
        {open && members.length > 0 && (
          <SidebarMenu nested>
            {members.map((summary) => (
              <SidebarMenuItem key={summary.id}>
                <SessionRow summary={summary} now={now} onDelete={onDelete} />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** How many sessions a workspace shows before "Show more". */
const COLLAPSED_LIMIT = 5
const EXPANSION_STEP = 25

type ProjectRow =
  | { kind: 'room'; room: TeamState; updatedAt: number; pinnedIndex: null }
  | { kind: 'session'; summary: SessionSummary; updatedAt: number; pinnedIndex: number | null }

const WindowedProjectRows = ({
  rows,
  enabled,
  targetIndex,
  navigationIndex,
  density,
  className,
  footer,
  renderRow,
}: {
  rows: readonly ProjectRow[]
  enabled: boolean
  targetIndex: number
  navigationIndex: number | null
  density: AppSnapshot['listPrefs']['density']
  className?: string
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
  const estimate = density === 'compact' ? 34 : 46
  const scrollTarget = navigationIndex ?? targetIndex
  const virtualLabels = JSON.stringify(rows.map((row) => {
    if (row.kind === 'room') {
      const goal = snapshot.goals.get(row.room.id)
      return goal ? goalName(goal.goal) : row.room.name
    }
    const key = sessionKey(row.summary.runtime, row.summary.id)
    const live = snapshot.sessions.get(key)
    return sessionLabel(live?.title ?? row.summary.title, row.summary.preview)
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

  if (!enabled) return <SidebarGroupContent nested ref={root} className={className} data-virtual-project="true">{rows.map(renderRow)}{footer}</SidebarGroupContent>
  return (
    <SidebarGroupContent nested ref={root} className={className} data-virtual-project="true"
      data-virtual-labels={virtualLabels}>
      {renderStart > 0 && <div aria-hidden="true" style={{ height: renderBeforeHeight }} />}
      {rows.slice(renderStart, renderEnd).map((row, index) => renderRow(row, renderStart + index))}
      {renderAfterHeight > 0 && <div aria-hidden="true" style={{ height: renderAfterHeight }} />}
      {footer}
    </SidebarGroupContent>
  )
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
 * How the opening message is called, for a row with no name yet, by the rule
 * every adapter's preview follows (`openingOf`): the person's first line, or
 * for a message that's only blocks, the block that says what the
 * conversation is. It reads every text block of a message, because the
 * composer puts attached context in blocks of its own before the typed words.
 * The first message that says anything answers (review of #231).
 */
const firstAsk = (session: Session): string | null => {
  for (const turn of session.turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue
      const opening = openingOf(item.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'))
      if (opening) return opening
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
    () => [...new Set([...snapshot.teams.values()].map((team) => roomGroupRootOf(team, [snapshot.workspace, ...snapshot.workspaces])))]
      .sort().join('\u0000'),
    [snapshot.teams, snapshot.workspace, snapshot.workspaces],
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
    const current = projectGroupRootOf(snapshot.workspace)
    const list = groupByProject(
      filtered,
      snapshot.workspaces.map((workspace) => workspace.path),
      snapshot.workspace,
    )
    const pinned = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace)
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
  const treeRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', timer: 0 })
  const [navigationTarget, setNavigationTarget] = useState<{ root: string; index: number } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [revealedCount, setRevealedCount] = useState<ReadonlyMap<string, number>>(() => new Map())
  const collapsed = useMemo(
    () => new Set(migratedRoots(snapshot.listPrefs.collapsed, snapshot.workspace)),
    [snapshot.listPrefs.collapsed, snapshot.workspace],
  )
  const groups = useProjectGroups()

  const toggle = useCallback((key: string) => store.toggleCollapsed(key), [store])

  const teamKeys = useMemo(() => new Set([...snapshot.teams.values()].flatMap(team =>
    teamSeats(snapshot.goals.get(team.id), team, goalRunOf(team.id, snapshot.goals.get(team.id), snapshot.flowExecutions))
      .filter(hasConversation).map(one => String(one.key)))), [snapshot.teams, snapshot.goals, snapshot.flowExecutions])
  const pinnedRows = useMemo(() => {
    const byKey = new Map(groups.flatMap((group) => group.sessions).map((summary) => [String(sessionKey(summary.runtime, summary.id)), summary]))
    return snapshot.listPrefs.pinnedSessions
      .filter(key => !teamKeys.has(String(key)))
      .map((key) => byKey.get(String(key)))
      .filter((summary): summary is SessionSummary => summary !== undefined)
  }, [groups, snapshot.listPrefs.pinnedSessions, teamKeys])
  const liftedKeys = useMemo(
    () => new Set(pinnedRows.map((summary) => String(sessionKey(summary.runtime, summary.id)))),
    [pinnedRows],
  )
  const toggleTeam = useCallback((id: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

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
      const root = roomGroupRootOf(team, [snapshot.workspace, ...snapshot.workspaces])
      const held = out.get(root)
      if (held) held.push(team)
      else out.set(root, [team])
    }
    return out
  }, [snapshot.teams, snapshot.workspace, snapshot.workspaces])

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
  const currentRoot = projectGroupRootOf(snapshot.workspace)
  const pinnedRoots = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace)
  const near = groups.filter(
    (group) =>
      group.root === currentRoot || pinnedRoots.includes(group.root) || groups.length <= 2,
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

  const onTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
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
      const nestedMember = target.closest('[data-nested="true"]') !== null
      const virtual = nestedMember ? null : target.closest<HTMLElement>('[data-virtual-index][data-virtual-count]')
      const project = target.closest<HTMLElement>('[data-virtual-project="true"]')
      const current = Number(virtual?.dataset.virtualIndex)
      const count = Number(virtual?.dataset.virtualCount)
      if (virtual && project && Number.isInteger(current) && Number.isInteger(count)) {
        const nextIndex = current + direction
        if (nextIndex >= 0 && nextIndex < count) {
          const root = project.parentElement?.dataset.projectRoot
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
      const nestedMember = target.closest('[data-nested="true"]') !== null
      const virtual = nestedMember ? null : target.closest<HTMLElement>('[data-virtual-index][data-virtual-count]')
      const project = target.closest<HTMLElement>('[data-virtual-project="true"]')
      const windowedProject = project?.hasAttribute('data-virtual-labels') ? project : null
      if (virtual && windowedProject) {
        const count = Number(virtual.dataset.virtualCount)
        const targetIndex = event.key === 'Home' ? 0 : count - 1
        const root = windowedProject.parentElement?.dataset.projectRoot
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
    if (event.key === 'ArrowRight') {
      const disclosure = target.parentElement?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-action"][aria-label*="agents in"]')
      if (disclosure) {
        event.preventDefault()
        if (disclosure.getAttribute('aria-expanded') !== 'true') disclosure.click()
        window.requestAnimationFrame(() => {
          const member = target.parentElement?.parentElement?.querySelector<HTMLButtonElement>('[data-nested="true"] [data-slot="sidebar-menu-button"]')
          focus(member ?? undefined)
        })
        return
      }
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
      const nested = target.closest<HTMLElement>('[data-nested="true"]')
      const room = nested?.parentElement
      const roomOpener = room?.querySelector<HTMLButtonElement>('[aria-label^="Room "]')
      const disclosure = room?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-action"][aria-label*="agents in"]')
      if (nested && roomOpener && disclosure) {
        if (disclosure.getAttribute('aria-expanded') === 'true') {
          focus(roomOpener)
          disclosure.click()
        }
        else focus(roomOpener)
      } else if (target.parentElement?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-action"][aria-label*="agents in"]')?.getAttribute('aria-expanded') === 'true') {
        target.parentElement.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-action"][aria-label*="agents in"]')?.click()
      } else if (target.getAttribute('aria-expanded') === 'true') target.click()
      else {
        const parent = rows.slice(0, index).reverse().find((row) => row.getAttribute('aria-expanded') === 'true')
        focus(parent)
      }
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typeahead.current.text += event.key.toLocaleLowerCase()
      window.clearTimeout(typeahead.current.timer)
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.text = '' }, 500)
      const query = typeahead.current.text
      const nestedMember = target.closest('[data-nested="true"]') !== null
      const virtual = nestedMember ? null : target.closest<HTMLElement>('[data-virtual-index][data-virtual-count]')
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
          const root = windowedProject.parentElement?.dataset.projectRoot
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
  const activeGroup = useMemo(
    () =>
      activeKey === null
        ? null
        : groups.find((group) =>
            group.sessions.some((summary) => String(sessionKey(summary.runtime, summary.id)) === activeKey),
          ) ?? null,
    [activeKey, groups],
  )

  useEffect(() => {
    if (!activeKey || !activeGroup || liftedKeys.has(activeKey)) return
    if (collapsed.has(activeGroup.root)) store.toggleCollapsed(activeGroup.root)
    if (!othersOpen && far.some((group) => group.root === activeGroup.root)) store.setOthersOpen(true)

    const roomKeys = new Set(
      projectRoots(activeGroup)
        .flatMap((root) => roomsByProject.get(root) ?? [])
        .flatMap((room) => teamSeats(snapshot.goals.get(room.id), room, goalRunOf(room.id, snapshot.goals.get(room.id), snapshot.flowExecutions)).map(one => String(one.key))),
    )
    const loose = activeGroup.sessions.filter(
      (summary) => !roomKeys.has(String(sessionKey(summary.runtime, summary.id))),
    )
    const activeIndex = loose.findIndex(
      (summary) => String(sessionKey(summary.runtime, summary.id)) === activeKey,
    )
    const visibleCount = revealedCount.get(activeGroup.root) ?? COLLAPSED_LIMIT
    if (activeIndex >= visibleCount) {
      setRevealedCount((current) => new Map(current).set(activeGroup.root, activeIndex + 1))
    }
  }, [activeGroup, activeKey, collapsed, far, liftedKeys, othersOpen, revealedCount, roomsByProject, store])

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
      const existingPinned = migratedRoots(snapshot.listPrefs.pinned, snapshot.workspace)
      const keep = new Set([...existingPinned, root])
      const shown = arranged.filter((entry) => keep.has(entry))
      // A pinned project whose sessions have all been archived has no row to
      // be arranged among. It keeps its pin rather than losing it to a drag
      // that was never about it.
      const offscreen = existingPinned.filter((entry) => !shown.includes(entry))
      store.setListPrefs({ pinned: [...shown, ...offscreen] })
      setAnnouncement(`Moved to position ${shown.indexOf(root) + 1} of ${shown.length}`)
    },
    [near, snapshot.listPrefs.pinned, snapshot.workspace, store],
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

  const teamRows = new Map(teamsInput(snapshot).map(input => [input.team.id, teamListRow(input)]))
  const renderGroup = (group: ProjectGroup) => {
    const open = !collapsed.has(group.root)
    const allRooms = projectRoots(group)
      .flatMap((root) => roomsByProject.get(root) ?? [])
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const rooms = allRooms.filter((room) => teamRows.get(room.id)?.active)
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
    const projectSessions = group.sessions.filter((summary) => !liftedKeys.has(String(sessionKey(summary.runtime, summary.id))))
    const visibleCount = Math.min(loose.length, revealedCount.get(group.root) ?? COLLAPSED_LIMIT)
    const shown = loose.slice(0, visibleCount)
    const pinnedIndexes = new Map(
      snapshot.listPrefs.pinnedSessions.map((key, index) => [String(key), index]),
    )
    const rows = [
      ...rooms.map((room) => ({
        kind: 'room' as const,
        room,
        updatedAt: room.updatedAt,
        pinnedIndex: null,
      })),
      ...shown.map((summary) => ({
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
    const activeRowIndex = rows.findIndex(
      (row) => row.kind === 'session' && String(sessionKey(row.summary.runtime, row.summary.id)) === activeKey,
    )
    return (
      <div key={group.root} data-project-root={group.root}>
        <GroupHead
          group={group}
          open={open}
          onToggle={() => toggle(group.root)}
          onToggleAll={toggleAll}
          onNewWorktree={(root) => store.askNewWorktree(root)}
          drag={drag}
        />
        {open && allRooms.length === 0 && group.sessions.length === 0 && (
          <Text as="div" role="meta" className={styles.groupBlank}>
            No conversations yet — ⌘N starts one here.
          </Text>
        )}
        {open && (allRooms.length > 0 || loose.length > 0) && (
          <WindowedProjectRows
            rows={rows}
            enabled={rows.length > 50}
            targetIndex={activeRowIndex}
            navigationIndex={navigationTarget?.root === group.root ? navigationTarget.index : null}
            density={snapshot.listPrefs.density}
            className={styles.nested}
            footer={loose.length > visibleCount ? (
              <SidebarMenu><SidebarMenuItem>
                <SidebarMenuButton size="sm" icon={<span aria-hidden="true" />} label={`${loose.length - visibleCount} more`}
                  onClick={() => {
                    const shown = revealedCount.get(group.root) ?? COLLAPSED_LIMIT
                    setNavigationTarget({ root: group.root, index: rows.length })
                    setRevealedCount((current) => new Map(current).set(group.root, Math.min(loose.length, shown + EXPANSION_STEP)))
                  }} />
              </SidebarMenuItem></SidebarMenu>
            ) : undefined}
            renderRow={(row, index) =>
              row.kind === 'room' ? (
                <RoomRow
                  key={row.room.id}
                  room={row.room}
                  state={teamRows.get(row.room.id)!.state}
                  sessions={projectSessions}
                  now={now}
                  open={expanded.has(row.room.id)}
                  onToggle={() => toggleTeam(row.room.id)}
                  onDelete={setDeleting}
                  hiddenKeys={liftedKeys}
                  virtualKey={`room:${row.room.id}`}
                  virtualIndex={index}
                  virtualCount={rows.length}
                />
              ) : (
                <SessionRow key={row.summary.id} summary={row.summary} now={now} onDelete={setDeleting} virtualKey={`session:${row.summary.runtime}:${row.summary.id}`} virtualIndex={index} virtualCount={rows.length} />
              )
            }
          />
        )}

      </div>
    )
  }

  return (
    <div ref={treeRef} onKeyDown={onTreeKeyDown} onFocusCapture={(event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-index]')
      const root = row?.closest<HTMLElement>('[data-project-root]')?.dataset.projectRoot
      if (root && row) setNavigationTarget({ root, index: Number(row.dataset.virtualIndex) })
    }} role="group" aria-label="Conversations" data-region="session-tree">
      {pinnedRows.length > 0 && (
        <SidebarGroup className={styles.triage} data-sidebar-band="pinned">
          <GroupLabel ink="muted">Pinned · {pinnedRows.length}</GroupLabel>
          <SidebarGroupContent nested>
            {pinnedRows.map((summary) => (
              <SessionRow key={`p-${summary.runtime}-${summary.id}`} summary={summary} now={now} onDelete={setDeleting} />
            ))}
          </SidebarGroupContent>
          <Separator />
        </SidebarGroup>
      )}
      {near.map(renderGroup)}
      {far.length > 0 && (
        <div>
          <SidebarMenu><SidebarMenuItem>
            <SidebarMenuButton
              label={<span className="flex items-center gap-(--hd-space-2)"><Text role="navigation" ink="muted">Other projects</Text><span data-slot="sidebar-menu-icon" className="inline-flex shrink-0 items-center justify-center"><DisclosureChevron open={othersOpen} size="xs" className={styles.groupChevron} /></span></span>}
              aria-expanded={othersOpen}
              onClick={() => setOthersOpen(!othersOpen)}
              {...(dragging && !far.some((group) => group.root === dragging) ? { 'data-insert': 'into' } : {})}
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
            />
            <SidebarMenuBadge aria-label={`${far.length} other projects`}>{far.length}</SidebarMenuBadge>
          </SidebarMenuItem></SidebarMenu>
          {othersOpen && <SidebarGroupContent>{far.map(renderGroup)}</SidebarGroupContent>}
        </div>
      )}
      {deleting && <DeleteSession summary={deleting} onClose={() => setDeleting(null)} />}
      {/* Reordering by hand is silent by nature; this is the same move said
          out loud, so the keyboard rows and the drag land in the same place
          for someone who cannot see the list move. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}
