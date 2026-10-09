import { useCallback, useEffect, useRef, useState } from 'react'

import { SidebarNotices, useInboxMessages } from './Notices'
import type { Account, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'
import { useRuntime, useRuntimeHealth, useSnapshot, useStore } from '../state/context'
import { Slot } from '../slots/registry'
import { AgentIcon, BranchIcon, CaretIcon, CrossIcon, FlowIcon, GoalIcon, PluginIcon, PlusIcon, SearchIcon, SettingsIcon, SignOutIcon, TeamIcon, UsageIcon } from './Icons'
import { WindowControls } from './WindowControls'
import { NewSessionChoice, type NewSessionKind } from './NewSessionChoice'
import { SessionListControls, SessionTree } from './SessionTree'
// Imported for its side effect: the Tasks panel registers itself into the
// `sidebar.panel` slot rendered below.
import './TaskPanel'
import {
  AccountMark,
  UsageMeterRow,
  Bar,
  Button,
  Dot,
  Menu,
  MenuItem,
  MenuAccountGroup,
  MenuAccountRow,
  MenuLabel,
  MenuNote,
  MenuSeparator,
  InboxPanel,
  NavigationGroupHeader,
  Popover,
  RailSection,
  Search,
  Chip,
  Separator,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  Text,
  buttonVariants,
  type MenuAccountFigure,
  type Tone,
} from '../design'
import { accountKey, accountName, accountIdentity, agentKey, tintOf, type AccountPrefs } from '../lib/accounts'
import { folderName, projectRootOf } from '../lib/projects'
import { anyBroken, inForce } from '../lib/agents'
import { livePlugins } from '../lib/plugins'
import { brandOf } from '../lib/identity'
import { profileName } from '../lib/profile'
import { READINESS_LABEL, readinessOf, type Readiness } from '../lib/readiness'
import { AccountHoverCard } from './AgentCards'
import { HarnessMark, RuntimeMark } from './BrandIcons'
import { ProfileFace } from './ProfileFace'
import { Clipped, DisclosureChevron, EmptyState } from '../design'
import type { Section } from './Settings'
import { bindingLane, describeReport, isBlocked } from '../lib/usage'
import { usageReadingTone } from '../lib/limits'
import { usageAccount } from '../lib/usage-alerts'
import styles from './Sidebar.module.css'

/**
 * The sidebar: sessions, grouped by project, over the runtime's own history.
 *
 * The rows are the user's real Codex history, read through the runtime rather
 * than a HarnessDesk-side copy — which is why a session started in the terminal
 * or in VS Code shows up here.
 *
 * The footer is one account row that opens a menu — usage, the runtime's
 * health, settings, sign out — rather than a stack of rows. Sign-out lives
 * here because this is where people look for it: on their own name.
 */

export const Sidebar = ({
  onOpenSettings,
  onOpenPlugins,
  onOpenAgents,
  onOpenTeams,
  onOpenUsage,
  onBrowseFolders,
  onSignIn,
  onSearch,
  activeDestination = null,
}: {
  onOpenSettings: (section?: Section) => void
  onOpenPlugins: () => void
  /** Opens the Agents window — the roster, never a Settings page. */
  onOpenAgents: () => void
  onOpenTeams: () => void
  /** Opens the dashboard, scoped to one agent when the caller names it. */
  onOpenUsage: (runtime?: RuntimeId) => void
  onBrowseFolders: () => void
  /** Opens the sign-in screen, on one runtime when the caller knows which. */
  onSignIn: (runtime?: RuntimeId) => void
  onSearch: () => void
  activeDestination?: 'teams' | 'agents' | 'dashboard' | 'plugins' | null
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const inbox = useInboxMessages()
  const [query, setQuery] = useState('')
  const searchQuery = query.trim()
  // The filter takes the Projects row while it is in use and gives the
  // label back when it is empty and unfocused: a 200px sidebar has room for
  // the word or for a field you can read what you typed in, not both.
  const [filterFocused, setFilterFocused] = useState(false)
  /** The non-default start flow selected from the adjacent menu. */
  const [starting, setStarting] = useState<NewSessionKind | undefined>()
  const filtering = filterFocused || query.length > 0
  const listRef = useRef<HTMLDivElement>(null)
  const now = Date.now()
  // Only the ones a person would want to know about: spent, or nearly.
  const lowAgents = snapshot.usage.filter((report) => {
    if (isBlocked(report)) return true
    const lane = bindingLane(report.lanes)
    return lane !== undefined && lane !== null && 100 - Math.min(100, lane.usedPercent) < 20
  }).length

  // Debounced so typing does not fire a search per keystroke against the runtime.
  useEffect(() => {
    const timer = window.setTimeout(() => void store.searchHistory(query), 220)
    return () => window.clearTimeout(timer)
  }, [query, store])

  const onScroll = useCallback(() => {
    const element = listRef.current
    if (!element || !snapshot.historyCursor || snapshot.historyLoading) return
    if (element.scrollTop + element.clientHeight > element.scrollHeight - 240) {
      void store.loadHistory()
    }
  }, [snapshot.historyCursor, snapshot.historyLoading, store])

  const runtime = useRuntime()
  const health = useRuntimeHealth()
  const ready = health?.state === 'ready' || health?.state === 'idle'
  // These counts match the destinations' own definitions on their windows.
  // Not `plugins.length`: an installed copy a built-in has taken over is off,
  // and counting it here made the sidebar promise one more than the page lists.
  const agentsRoster = snapshot.agents ?? []
  const agentsCount = inForce(agentsRoster).length
  const agentsBroken = anyBroken(agentsRoster)
  const pluginCount = livePlugins(snapshot.plugins).length
  return (
    <div className={styles.sidebar}>
      <div className={styles.header} data-region="sidebar-header">
        <Bar corner className="hd-drag"><WindowControls /></Bar>
        <Bar inset="ink" className="hd-drag">
          <Text role="subject" className={styles.brandMark} aria-hidden><HarnessMark size={14} /></Text>
          <Text role="wordmark" truncate className={styles.workspaceName} title={snapshot.workspace?.path ?? undefined}>HarnessDesk</Text>
          <div className={`${styles.headerActions} hd-no-drag`}>
            <InboxPanel
              side="bottom" size="icon-xs"
              messages={inbox}
              onOpen={(id) => store.markInboxRead(id)}
              onMarkAllRead={() => store.markInboxRead(null)}
              onClear={() => store.clearInbox()}
            />
            <Button
              variant="ghost" size="icon-xs" className="hd-no-drag"
              onClick={onSearch} title="Search everything (⌘K)" aria-label="Search everything" aria-keyshortcuts="Meta+K"
            ><SearchIcon size={13} /></Button>
          </div>
        </Bar>
        {starting && <NewSessionChoice initialKind={starting} onClose={() => setStarting(undefined)} />}
        <RailSection as="nav" stretch="head" className={styles.nav} aria-label="Workspace actions">
          <div className={styles.navRow}>
            <Button
              variant="navigation" size="navigation" className={styles.newSession}
              disabled={!ready || !snapshot.workspace}
              onClick={() => store.newDraft()} title="Start a session here"
            >
              <Text role="muted" className={styles.navIcon}><PlusIcon size={15} /></Text>
              New session
            </Button>
            <WorktreeMenu onChoose={(kind) => setStarting(kind)} />
          </div>
          <SidebarMenu role="group" aria-label="Main sections">
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={<TeamIcon size={14} />} label={<Text role="navigation">Teams</Text>} aria-label="Teams" title="Teams"
                isActive={activeDestination === 'teams'} aria-current={activeDestination === 'teams' ? 'page' : undefined}
                onClick={onOpenTeams}
              />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={<AgentIcon size={14} />} label={<Text role="navigation">Agents</Text>} aria-label="Agents" title="Agents"
                trailingOverlay={agentsCount > 0} labelTrailingContent={agentsCount > 0}
                isActive={activeDestination === 'agents'} aria-current={activeDestination === 'agents' ? 'page' : undefined}
                onClick={onOpenAgents}
              />
              {agentsCount > 0 && <SidebarMenuBadge title={`${agentsCount} Agents${agentsBroken ? ', some unavailable' : ''}`}><Text role="meta" numeric tone={agentsBroken ? 'warning' : undefined}>{agentsCount}</Text></SidebarMenuBadge>}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={<UsageIcon size={14} />} label={<Text role="navigation">Dashboard</Text>} aria-label="Dashboard" title="Dashboard"
                trailingOverlay={lowAgents > 0} labelTrailingContent={lowAgents > 0}
                isActive={activeDestination === 'dashboard'} aria-current={activeDestination === 'dashboard' ? 'page' : undefined}
                onClick={() => onOpenUsage()}
              />
              {lowAgents > 0 && <SidebarMenuBadge title={`${lowAgents} Agents need attention`}><Text role="meta" numeric>{lowAgents}</Text></SidebarMenuBadge>}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                icon={<PluginIcon size={14} />} label={<Text role="navigation">Plugins</Text>} aria-label="Plugins" title="Plugins"
                trailingOverlay={pluginCount > 0} labelTrailingContent={pluginCount > 0}
                isActive={activeDestination === 'plugins'} aria-current={activeDestination === 'plugins' ? 'page' : undefined}
                onClick={onOpenPlugins}
              />
              {pluginCount > 0 && <SidebarMenuBadge title={`${pluginCount} Plugins`}><Text role="meta" numeric>{pluginCount}</Text></SidebarMenuBadge>}
            </SidebarMenuItem>
          </SidebarMenu>
        </RailSection>
      </div>
      <div ref={listRef} className={styles.content} data-region="sidebar-content" onScroll={onScroll}>
        <NavigationGroupHeader
          labelInk="muted"
          label={(
            <span className={styles.groupLabel}>
              <span className={styles.projectName}>Projects</span>
              {query && <span className={styles.filterBadge}><Chip tone="neutral" label="Filtered" /><Button variant="ghost" size="icon-xs" aria-label="Clear list filter" title="Clear list filter" onClick={() => setQuery('')}><CrossIcon size={12} /></Button></span>}
            </span>
          )}
          filtering={filtering}
          keepLabelWhenFiltering
          data-surface=""
          data-filtered={query ? '' : undefined}
        >
          <div className={styles.filter}>
            <Search
              size="compact" icon="filter" className={styles.filterInput}
              placeholder="Filter by title" label="Filter this list" title="Filter this list"
              value={query} onChange={setQuery}
              onFocus={() => setFilterFocused(true)} onBlur={() => setFilterFocused(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  if (query) event.preventDefault()
                  setQuery('')
                  event.currentTarget.blur()
                }
              }}
            />
          </div>
          <SessionListControls searching={searchQuery.length > 0} />
          <Button
            variant="muted" size="icon-xs" edge="end" edgeGlyph={12} className={styles.listAddButton}
            onClick={onBrowseFolders} title="Open a project folder" aria-label="Open a project folder"
          ><PlusIcon size={13} /></Button>
        </NavigationGroupHeader>
        <RailSection stretch="list">
          {snapshot.history.length === 0 && !snapshot.historyLoading && (
            searchQuery
              ? <EmptyState variant="inline" title={`No conversations match “${searchQuery}”.`}>
                  {' '}
                  <Button variant="muted" size="sm" onClick={() => setQuery('')}>Clear search</Button>
                </EmptyState>
              : <EmptyState
                  variant="inline"
                  title={ready
                    ? `No sessions yet. Start one to see it here${runtime.presentation.historySource ? ` — sessions you run in ${runtime.presentation.historySource} show up too` : ''}.`
                    : 'Connect a runtime to see your sessions.'}
                />
          )}
          <SessionTree now={now} searching={searchQuery.length > 0} />
          {snapshot.historyCursor && query.length === 0 && (
            <Button variant="muted" size="sm" disabled={snapshot.historyLoading} onClick={() => void store.loadHistory()}>
              Load more conversations
            </Button>
          )}
        </RailSection>
      </div>
      <Separator />
      <div className={styles.footer} data-region="sidebar-footer">
        <Slot name="sidebar.panel" />
        <SidebarNotices />
        <AccountFooter onOpenSettings={onOpenSettings} onOpenUsage={onOpenUsage} onSignIn={onSignIn} />
      </div>
    </div>
  )
}

/**
 * The other ways to start work, one press right of New session.
 *
 * This slot used to be a single button that made a worktree called
 * `session-mfk3x1` off HEAD and started a conversation in it — a thing that
 * did too much for one unlabelled click and too little to be worth the
 * click. What the slot is actually for is the second copy of this project:
 * making one, and getting back into the ones you already have. So it is a
 * menu, and the making of one is a dialog that asks the two questions a
 * worktree has (what it is called, where it starts from).
 *
 * Codex splits these across two places — the composer picks "New worktree"
 * for the next chat, the project's context menu makes a permanent one. Both
 * are here: the composer's Work in control points the draft in front, and
 * this menu is the same choice reached from the project. Every row of it
 * opens a draft and points it; nothing is made on disk until that draft's
 * first message.
 *
 * It stays visible in a folder that is not a repository, disabled and saying
 * why. A control that vanishes teaches nobody what it was.
 */
const WorktreeMenu = ({ onChoose }: { readonly onChoose: (kind: 'goal' | 'flow' | 'team') => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const health = useRuntimeHealth()
  const ready = health?.state === 'ready' || health?.state === 'idle'
  const hasFolder = Boolean(projectRootOf(snapshot.workspace))
  const isRepo = Boolean(snapshot.workspace?.git?.branch)
  const active = snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) : undefined
  const mine = snapshot.worktrees.filter((entry) => entry.managed)

  return (
    <Popover
      title="More ways to start"
      drop="down"
      align="right"
      triggerClassName={buttonVariants({ variant: 'ghost', size: 'icon-xs', className: styles.navSecondary })}
      label={<CaretIcon size={14} />}
      onOpenChange={(open) => open && void store.loadWorktrees()}
    >
      {(close) => (
        <Menu close={close}>
          <MenuLabel>{folderName(snapshot.workspace?.path ?? '')}</MenuLabel>
          <MenuItem
            icon={<PlusIcon size={14} />}
            label="New worktree…"
            title="Its own checkout, on a branch of its own."
            {...(!isRepo || !ready ? { disabled: true, hint: isRepo ? 'Connect an agent to work in a worktree.' : 'Worktrees need a git repository.' } : {})}
            onSelect={() => {
              close()
              store.askNewWorktree(snapshot.workspace?.path ?? null)
            }}
          />
          {mine.length > 0 && (
            <>
              <MenuLabel>Start in one</MenuLabel>
              {mine.map((worktree) => (
                <MenuItem
                  key={worktree.path}
                  icon={<BranchIcon size={14} />}
                  label={worktree.branch ?? '(detached)'}
                  title={worktree.path}
                  value={active?.cwd === worktree.path ? 'here' : undefined}
                  onSelect={() =>
                    store.startDraftIn({ kind: 'existing', path: worktree.path, branch: worktree.branch ?? null })
                  }
                />
              ))}
            </>
          )}
          <MenuSeparator />
          <MenuItem icon={<GoalIcon size={14} />} label="Goal…" {...(!hasFolder ? { disabled: 'Open a folder to start one.' } : {})} onSelect={() => { close(); onChoose('goal') }} />
          <MenuItem icon={<FlowIcon size={14} />} label="Flow…" {...(!hasFolder ? { disabled: 'Open a folder to start one.' } : {})} onSelect={() => { close(); onChoose('flow') }} />
          <MenuItem icon={<TeamIcon size={14} />} label="Team…" {...(!hasFolder ? { disabled: 'Open a folder to start one.' } : {})} onSelect={() => { close(); onChoose('team') }} />
        </Menu>
      )}
    </Popover>
  )
}

/**
 * The seat: you, and the agent you will pick up next.
 *
 * The row is your identity — HarnessDesk today, your HarnessDesk account
 * when there is one — and it never changes because an agent did. What does
 * change is the badge at its end: the agent new sessions run as, wearing its
 * account's ring, with its readiness beside it. The account's *name* is not
 * on the row: an account is a pen, not a person, and the name card on the
 * badge answers which pen in full.
 *
 * This is where switching happens. Settings is where accounts are *managed*
 * — renamed, signed out of, given a colour; the seat is where they are
 * *used*, because "run the next session as this one" is a thing people do
 * twenty times a day and settings is a place they visit twice a month.
 *
 * Switching is a preference, not a navigation: the conversation on screen
 * stays, the list stays where it was scrolled to, and only a draft — which
 * has no agent of its own — takes on the new one. The conversation's own
 * composer already says who it is with, so this row answers the other
 * question: who is next. That is also why the badge and the menu's tick read
 * `activeRuntime` and never the focused pane's — the menu sets exactly what
 * the badge shows, so the two cannot disagree. An earlier version followed
 * the focused conversation, and ticked one agent while ⌘N started another.
 *
 * The list is every account of every agent, wearing the same dot and the same
 * figure the header strip shows, so a number learnt in one place reads the
 * same in the other.
 */

/** One account, as the menu needs it: who it is, how it is, what is left. */
interface Seat {
  readonly key: string
  readonly info: RuntimeInfo
  readonly account: Account | null
  readonly name: string
  readonly sub: string
  readonly state: Readiness
  /**
   * Whether `runtime/account` has answered for this agent — not the same
   * fact as `state !== 'unknown'`. Broken health and `capabilities.account
   * === false` both take precedence over the account check in `readinessOf`,
   * so an agent that never answered can still read `broken` or `ready`. Only
   * `signin` is now readiness's own guarantee that it answered; everywhere
   * else that needs to tell "has not answered" apart from a real fact reads
   * this instead of the state.
   */
  readonly answered: boolean
  /** What is left of the tightest window, or null when nothing is metered. */
  readonly figure: string | null
  readonly tone: 'good' | 'warn' | 'bad'
  readonly current: boolean
  readonly report: UsageReport | null
  readonly preference: AccountPrefs | undefined
}

/** The part of an account's address after the @, or null for one without. */
const domainOf = (account: Account | null): string | null => {
  const email = account?.email ?? (account?.label.includes('@') ? account.label : null)
  return email ? email.slice(email.indexOf('@') + 1) || null : null
}

const readinessTone = (state: Readiness): Tone | undefined => ({
  ready: undefined,
  available: undefined,
  unknown: undefined,
  signin: 'brand',
  limit: 'warning',
  broken: 'danger',
} as const)[state]

export const AccountFooter = ({
  onOpenSettings,
  onOpenUsage,
  onSignIn,
}: {
  onOpenSettings: (section?: Section) => void
  /** Opens the dashboard, scoped to one agent when the caller names it. */
  onOpenUsage: (runtime?: RuntimeId) => void
  /** Opens the sign-in screen, on one runtime when the caller knows which. */
  onSignIn: (runtime?: RuntimeId) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  // Outside every pane, so this is the default agent — the one ⌘N starts —
  // and not the focused conversation's.
  const runtime = useRuntime()
  const [open, setOpen] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const resetMenu = (): void => {
    setAccountsOpen(false)
    setUsageOpen(false)
    setConfirmingSignOut(false)
  }

  const seats: Seat[] = snapshot.runtimes.flatMap((info): Seat[] => {
    const status = snapshot.accountsByRuntime[info.id] ?? null
    const usage = snapshot.usage.filter((report) => report.runtime === info.id)
    const state = readinessOf({
      registered: true,
      // Every seat's own health: a dead agent used to sit here looking
      // normal unless it happened to be the active one.
      health: snapshot.healthByRuntime[info.id] ?? null,
      account: status,
      accounts: info.capabilities.account,
      usage,
    })
    const accounts = status?.accounts ?? []
    const current = info.id === snapshot.activeRuntime
    const answered = status !== null

    if (accounts.length === 0) {
      return [
        {
          key: `${info.id}:none`,
          info,
          account: null,
          name: info.presentation.name,
          // `state` can be a real fact — broken health, or ready for an
          // agent that runs without one — even before the account read
          // answers, so `state !== 'unknown'` is not "has answered". Gate on
          // the read itself: until it answers, the tooltip names the agent
          // rather than a word for a question it has not asked yet.
          sub: answered ? READINESS_LABEL[state] : info.presentation.name,
          state,
          answered,
          figure: usage[0]
            ? (() => {
                const lane = describeReport(usage[0] as UsageReport, { now: Date.now(), maxLanes: 1 }).hero
                return lane?.known && lane.remainingPercent !== null ? `${lane.remainingPercent}%` : null
              })()
            : null,
          tone: usage[0] ? describeReport(usage[0], { now: Date.now(), maxLanes: 1 }).tone : 'good',
          current,
          report: usage[0] ?? null,
          preference: undefined,
        },
      ]
    }
    return accounts.map((account) => {
      const key = accountKey(info.id, account)
      const report =
        usage.find((entry) => usageAccount(entry) === account.label.trim()) ??
        (accounts.length === 1 ? usage[0] : null)
      const preference = snapshot.accountPrefs[key]
      const view = report ? describeReport(report, { now: Date.now(), maxLanes: 1, preference }) : null
      const lane = view?.hero ?? null
      return {
        key,
        info,
        account,
        name: accountName(account, snapshot.accountPrefs[key], info.presentation.name),
        sub: accountIdentity(account) || info.presentation.name,
        state,
        answered: true,
        figure: lane?.known && lane.remainingPercent !== null ? `${lane.remainingPercent}%` : null,
        tone: view?.blocked ? ('bad' as const) : (lane?.tone ?? ('good' as const)),
        current,
        report: report ?? null,
        preference,
      }
    })
  })

  // The default agent's seat — its account, or its empty chair. Null only
  // with no agents at all, when the row is just the desk.
  const here = seats.find((seat) => seat.current) ?? null
  const signedIn = here?.account !== null && here?.account !== undefined
  const agentName = brandOf(runtime.presentation.name)
  const nextAs = here?.account ? `${agentName} · ${here.name}` : agentName
  // You: the profile's name, which is HarnessDesk until you choose one.
  const yourName = profileName(snapshot.profile)
  const usageView = here?.report
    ? describeReport(here.report, { now: Date.now(), maxLanes: 8, preference: here.preference })
    : null
  const hasUsage = usageView !== null && usageView.all.length > 0
  // The chairs you can sit in. An agent that is waiting for a sign-in is not
  // one — choosing it would start nothing — so it waits behind "Add an
  // account…", whose chooser is where signing in happens. The default stays
  // listed whatever its state: it is the chair you are in.
  // An agent that has not answered yet (`unknown`) is not known to be
  // waiting, so it stays until it says so — or every agent would drop out
  // while accounts load.
  const chairs = seats.filter((seat) => seat.current || seat.state !== 'signin')
  // The list, by agent. An agent with one account is one row wearing its
  // mark. An agent with several is a heading wearing the mark once, and its
  // accounts under it as lines of their own — the agent is said by the
  // heading, so no row has to say it again.
  // Grouped from every chair, folded or not: the default's row keeps the
  // same parent either way, so opening the picker does not remount the row
  // a keyboard is on. Folded, a group shows only the default under its heading.
  const groups: Seat[][] = []
  for (const seat of chairs) {
    const group = groups.find((entry) => agentKey(entry[0]!.info) === agentKey(seat.info))
    if (group) group.push(seat)
    else groups.push([seat])
  }
  const groupOf = (seat: Seat): readonly Seat[] =>
    groups.find((group) => group.includes(seat)) ?? [seat]
  // What a row is called. Under its agent's heading, an account that is
  // only called by the agent's name (a key, a gateway) says which one it is.
  // An account with no one signed in has no name of its own, so under the
  // heading it says that — never the heading's name again, and never the
  // readiness word the figure slot is about to say.
  const labelOf = (seat: Seat): string =>
    groupOf(seat).length > 1 && seat.name === seat.info.presentation.name
      ? (seat.info.slot?.gateway?.name ??
          (seat.account ? seat.sub : seat.answered ? 'No account' : 'Unknown account'))
      : seat.name
  // Two rows with one name get the word that differs, and only they do.
  // Across agents that is the agent — two single rows are two agents. Under
  // one heading it is the address's domain, else the whole identity; never
  // a word that only says the name again.
  const tagOf = (seat: Seat): string | null => {
    const group = groupOf(seat)
    const label = labelOf(seat)
    if (group.length === 1) {
      const twins = groups.filter((other) => other.length === 1 && other[0] !== seat && labelOf(other[0]!) === label)
      const agent = brandOf(seat.info.presentation.name)
      return twins.length > 0 && agent !== label ? agent : null
    }
    const twins = group.filter((other) => other !== seat && labelOf(other) === label)
    if (twins.length === 0) return null
    const domain = domainOf(seat.account)
    if (domain && twins.every((other) => domainOf(other.account) !== domain)) return domain
    return seat.sub && seat.sub !== label ? seat.sub : null
  }

  const signOut = async (close: () => void): Promise<void> => {
    if (!snapshot.activeRuntime) return
    setBusy(true)
    try {
      await store.signOutAgent(snapshot.activeRuntime)
      close()
      resetMenu()
    } finally {
      setBusy(false)
    }
  }

  const unanswered = here !== null && here.state === 'unknown'
  const accountTrigger = (
    <>
      <ProfileFace size={24} />
      <Text role="subject" className={styles.accountName}>
        <Clipped className={styles.accountLabel}>{yourName}</Clipped>
      </Text>
      {here?.figure && here.tone !== 'good' && (
        <Text role="muted" tone={usageReadingTone(here.tone)} numeric className={styles.accountMeta}>
          {here.figure}
        </Text>
      )}
      {here && (
        <AccountHoverCard
          info={here.info}
          account={here.account}
          side="right"
          align="end"
          className={styles.seatTrigger}
          onOpenUsage={onOpenUsage}
          disabled={open}
        >
          <AccountMark
            size="sm"
            {...(here.account
              ? { 'data-tint': tintOf(here.key, snapshot.accountPrefs) }
              : here.state === 'signin'
                ? { 'data-off': '' }
                : {})}
          >
            <RuntimeMark runtime={here.info} size={13} />
          </AccountMark>
        </AccountHoverCard>
      )}
      {/* Until the default agent has answered who is signed in, `state` is
          `unknown` rather than a guess at "Needs sign-in"; the light stays
          neutral and says nothing it does not know, as the badge beside it
          and the menu already do. */}
      <Dot
        {...(unanswered ? {} : { state: here?.state ?? 'available' })}
        role="img"
        aria-label={here ? (unanswered ? agentName : `${agentName}: ${READINESS_LABEL[here.state]}`) : 'No agent'}
      />
    </>
  )

  return (
    <Bar rule="top" ref={accountRef}>
      <Popover
        title={here ? `New sessions run as ${nextAs}` : 'Accounts and settings'}
        /* Opens upward from the footer. Its width belongs to the menu so a
           narrow sidebar does not fold the account and usage rows. */
        side="top"
        sideAlign="start"
        sideOffset={6}
        fullWidth
        panelWidth="wide"
        triggerClassName={buttonVariants({ variant: 'navigation', size: 'navigation', className: styles.accountRow })}
        label={accountTrigger}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) resetMenu()
        }}
      >
        {(close) => (
          <Menu
            close={() => {
              close()
              resetMenu()
            }}
            onEscape={() => {
              close()
              resetMenu()
              accountRef.current?.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')?.focus()
            }}
          >
          {/* You — the seat a HarnessDesk account will take. There is no
              such account yet, and a sign-in button for one would be a lie,
              so this is what is true today: your profile, kept on this Mac.
              Pressing it opens the page where it is set. */}
          <MenuItem
            layout="profile"
            title="Your name and picture. Nothing syncs between machines."
            onSelect={() => {
              onOpenSettings('profile')
            }}
          >
            <ProfileFace size={30} />
            <span className={styles.youText}>
              <span className={styles.youName}>
                <Text role="row"><Clipped className={styles.youLabel}>{yourName}</Clipped></Text>
              </span>
            </span>
          </MenuItem>

          <MenuSeparator />
          <MenuLabel size="compact">Run new sessions as</MenuLabel>
            {groups.map((all) => {
              const group = accountsOpen || !here ? all : all.filter((seat) => seat.current)
              if (group.length === 0) return null
              // The seat's own mark is the trigger, and — like every other one —
              // it is out of the tab order. An earlier version of this comment
              // claimed the card opened on keyboard focus here; review checked,
              // and it does not. It could not: the trigger is `tabIndex={-1}`,
              // and its parent is a `role="menuitem"` that owns the arrow keys.
              // Making the span focusable would put a second stop inside a menu
              // item, which is worse than the card being pointer-only. The
              // seat's own press still does the thing the card's verb does.
              //
              // An account under its agent's heading wears no mark and no card
              // — the heading carries the mark, and a card on the name would
              // open at every rest on the list — only its colour, the ring it
              // wears everywhere else, drawn small.
              const renderSeat = (seat: Seat, child: boolean) => {
                const mark = child ? (
                  <AccountMark
                    size="dot"
                    aria-hidden="true"
                    {...(seat.account ? { 'data-tint': tintOf(seat.key, snapshot.accountPrefs) } : {})}
                  >
                    {null}
                  </AccountMark>
                ) : (
                  <AccountHoverCard
                    info={seat.info}
                    account={seat.account}
                    side="right"
                    align="start"
                    className={styles.seatTrigger}
                    /* The same verbs as the badge's card on the row below: two
                       cards for one account that offered different things were
                       the whole of the complaint. The sidebar's Dashboard opens
                       the dashboard on everything; this opens it on this seat. */
                    onOpenUsage={onOpenUsage}
                  >
                    <AccountMark
                      size="sm"
                      {...(seat.account
                        ? { 'data-tint': tintOf(seat.key, snapshot.accountPrefs) }
                        : seat.state === 'signin'
                          ? { 'data-off': '' }
                          : {})}
                    >
                      <RuntimeMark runtime={seat.info} size={13} />
                    </AccountMark>
                  </AccountHoverCard>
                )
                // What is left, where it is measured; otherwise the one word
                // that is wrong. A ready seat with nothing metered says
                // nothing, and neither does one that has not answered yet.
                const figure: MenuAccountFigure | undefined = seat.figure
                  ? { kind: 'reading', text: seat.figure, tone: usageReadingTone(seat.tone) }
                  : seat.state !== 'ready' && seat.state !== 'available' && seat.state !== 'unknown'
                    ? { kind: 'word', text: READINESS_LABEL[seat.state], tone: readinessTone(seat.state) }
                    : undefined
                return (
                  <MenuAccountRow
                    key={seat.key}
                    mark={mark}
                    // The name is the account's own — yours, or the address it
                    // was signed in with — so the identity under it only said
                    // it again. It is the name's tooltip (not the row's, which
                    // would sit over the mark's card) and whole on the card.
                    // The name gives way before the tag: the tag is the word
                    // that tells two rows apart.
                    name={labelOf(seat)}
                    identity={seat.sub}
                    tag={tagOf(seat)}
                    figure={figure}
                    current={seat.current}
                    expanded={seat.current && chairs.length > 1 ? accountsOpen : undefined}
                    keepOpen={seat.current && chairs.length > 1}
                    onSelect={() => {
                      if (seat.current && chairs.length > 1) {
                        setAccountsOpen((value) => !value)
                        setUsageOpen(false)
                        return
                      }
                      void store.selectRuntime(seat.info.id)
                    }}
                  />
                )
              }
              if (all.length === 1) return renderSeat(group[0]!, false)
              // Folded to the default alone, the group keeps its place (and
              // the row its focus) but draws no heading: one row, its mark.
              const folded = group.length < all.length
              const agent = group[0]!.info
              return (
                <MenuAccountGroup
                  key={agentKey(agent)}
                  heading={!folded}
                  label={agent.presentation.name}
                  mark={
                    <AccountMark size="sm">
                      <RuntimeMark runtime={agent} size={13} />
                    </AccountMark>
                  }
                >
                  {group.map((seat) => renderSeat(seat, !folded))}
                </MenuAccountGroup>
              )
            })}
            <MenuItem
              icon={<PlusIcon size={13} />}
              label="Add an account…"
              onSelect={() => {
                // Opens the chooser rather than adding one here. "An account"
                // does not mean "another of this one": the agent is the first
                // question, and only picking one that is already connected
                // means a second credential home — which the sign-in screen
                // asks for explicitly, so a stray click cannot leave one
                // behind.
                onSignIn()
              }}
            />

          <MenuSeparator />
            {/* Only where something is metered: a row whose whole answer is
                "—" took a line to say there was nothing to say. */}
            {hasUsage && (
            <MenuItem
              expanded={usageOpen}
              keepOpen
              onSelect={() => {
                setUsageOpen((value) => !value)
              }}
              /* The menu's own icon column and value slot, so the gauge and its
                 words line up with Settings below. Dashboard is not in this
                 menu: it is in the sidebar's own nav, always, with this gauge,
                 and a second door here wore the same mark for another verb. */
              icon={<UsageIcon size={13} />}
              label="Usage remaining"
              value={
              <Text role="muted" tone={usageReadingTone(here?.tone)} numeric className={styles.accountMenuMeta}>
                {here?.figure ?? '—'}
                {/* The fold wears the figure's trouble, as the figure beside it does.
                    A fold has one trouble tone, so a spent window's red figure
                    folds under the warning mark. */}
                <DisclosureChevron
                  open={usageOpen}
                  placement="trailing"
                  tone={usageReadingTone(here?.tone) ? 'warning' : 'neutral'}
                  className={styles.accountMenuCaret}
                />
              </Text>
              }
            />
            )}
            {usageOpen && usageView && (
              <div className={styles.usageDetails} data-usage-details>
                <div className={styles.usageLanes}>
                  {usageView.all.map((lane) => (
                    <UsageMeterRow key={lane.id} name={lane.title} percent={lane.remainingPercent} countdown={lane.resetCountdown} countdownTitle={lane.resetClock ? `resets ${lane.resetClock}` : undefined} tone={lane.tone === 'bad' ? 'danger' : lane.tone === 'warn' ? 'warning' : 'neutral'} standalone barless />
                  ))}
                </div>
                {/* No link to the dashboard here: Dashboard is in the
                    sidebar's nav, and a second door to it, indented under
                    the fold, was one row and one ragged edge for nothing. */}
              </div>
            )}
            <MenuItem
              icon={<SettingsIcon size={13} />}
              label="Settings"
              shortcut="⌘,"
              onSelect={() => {
                onOpenSettings()
              }}
            />
            {signedIn && !confirmingSignOut && (
              <MenuItem
                icon={<SignOutIcon size={13} />}
                label={`Sign out of ${agentName}…`}
                danger
                keepOpen
                onSelect={() => setConfirmingSignOut(true)}
              />
            )}
            {confirmingSignOut && (
              <div>
                <MenuNote>
                  Sign out of {agentName}? You'll need to sign in again before the next turn.
                </MenuNote>
                <div className={styles.accountMenuConfirmActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingSignOut(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void signOut(close)}
                  >
                    {busy ? 'Signing out…' : 'Sign out'}
                  </Button>
                </div>
              </div>
            )}
          </Menu>
        )}
      </Popover>
    </Bar>
  )
}
