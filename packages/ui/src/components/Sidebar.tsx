import { describeStrip, type StripMeter } from '../lib/plan-strip'
import { SidebarUpdate } from './SidebarUpdate'
import { LeftColumnModeHead } from '../design'
import { SettingsNavigation } from './SettingsNavigation'
import { LeftColumn, LeftColumnBody, LeftColumnNavigation, LeftColumnProjectsHead, LeftColumnTop, LeftColumnRow, LeftColumnSeat, LeftColumnGroup } from '../design'
import { LibraryIcon } from './Icons'
import { Slot } from '../slots/registry'
import { sidebarPlacement } from '../state/workbench'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { SidebarNotices, useInboxMessages } from './Notices'
import type { Account, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'
import { useActiveSession, useRuntime, useRuntimeHealth, useSnapshot, useStore } from '../state/context'
import { AgentIcon, BranchIcon, CaretIcon, CrossIcon, PluginIcon, PlusIcon, SearchIcon, SettingsIcon, SignInIcon, SignOutIcon, TeamIcon, UsageIcon } from './Icons'
import { FrontDoor } from './FrontDoor'
import { SessionListControls, SessionTree } from './SessionTree'
import {
  AccountMark,
  UsageMeterRow,
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
  Popover,
  Search,
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
import { RuntimeMark } from './BrandIcons'
import { ProfileFace } from './ProfileFace'
import { Clipped, DisclosureChevron, EmptyState } from '../design'
import type { Section } from './Settings'
import { bindingLane, describeReport, describeLane, formatAge, formatMoney, isBlocked } from '../lib/usage'
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
  onOpenLibrary,
  onOpenAgents,
  onOpenTeams,
  onOpenUsage,
  onBrowseFolders,
  onSignIn,
  onSearch,
  activeDestination = null,
  active = true, settings, listFilter, sessionsOwner = true,
}: {
  onOpenSettings: (section?: Section) => void
  onOpenPlugins: () => void
  onOpenLibrary?: () => void
  /** Opens the Agents window — the roster, never a Settings page. */
  onOpenAgents: () => void
  onOpenTeams: () => void
  /** Opens the dashboard, scoped to one agent when the caller names it. */
  onOpenUsage: (runtime?: RuntimeId) => void
  onBrowseFolders: () => void
  /** Opens the sign-in screen, on one runtime when the caller knows which. */
  onSignIn: (runtime?: RuntimeId) => void
  onSearch: () => void
  active?: boolean
  settings?: { section: Section; onSection: (section: Section) => void; onBack: () => void }
  listFilter?: { value: string; onChange: (value: string) => void }
  sessionsOwner?: boolean
  activeDestination?: 'teams' | 'agents' | 'library' | 'plugins' | 'dashboard' | null
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const inbox = useInboxMessages()
  const [localQuery, setLocalQuery] = useState('')
  const query = listFilter?.value ?? localQuery
  const setQuery = listFilter?.onChange ?? setLocalQuery
  const searchQuery = query.trim()
  // The filter takes the Projects row while it is in use and gives the
  // label back when it is empty and unfocused: a 200px sidebar has room for
  // the word or for a field you can read what you typed in, not both.
  const [filterFocused, setFilterFocused] = useState(false)
  /** The non-default start flow selected from the adjacent menu. */
  const [starting, setStarting] = useState<boolean>(false)
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
    if (!sessionsOwner) return
    const timer = window.setTimeout(() => void store.searchHistory(query), 220)
    return () => window.clearTimeout(timer)
  }, [query, store, sessionsOwner])

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
  const top = <LeftColumnTop shown={sidebarPlacement(snapshot) !== 'away'}
    back={snapshot.navCanBack} forward={snapshot.navCanForward}
    toggle={() => store.toggleSidebar()} goBack={() => { void store.navigateBack() }}
    goForward={() => { void store.navigateForward() }}
    search={<Button variant="ghost" size="icon-sm" onClick={onSearch}
      title="Search everything (⌘K)" aria-label="Search everything" aria-keyshortcuts="Meta+K"><SearchIcon size={16} /></Button>} />
  const pageDoors = [
    { id: 'teams' as const, label: 'Teams', icon: <TeamIcon size={16} />, run: onOpenTeams, count: 0 },
    { id: 'agents' as const, label: 'Agents', icon: <AgentIcon size={16} />, run: onOpenAgents, count: agentsCount },
    { id: 'library' as const, label: 'Library', icon: <LibraryIcon size={16} />, run: onOpenLibrary ?? (() => onOpenSettings('library')), count: 0 },
    { id: 'plugins' as const, label: 'Plugins', icon: <PluginIcon size={16} />, run: onOpenPlugins, count: pluginCount },
    { id: 'dashboard' as const, label: 'Dashboard', icon: <UsageIcon size={16} />, run: () => onOpenUsage(), count: lowAgents },
  ]
  const sessionsHead = <>

    <LeftColumnNavigation>
      <LeftColumnRow label="New session" icon={<PlusIcon size={16} />}
        disabled={!ready || !snapshot.workspace} title="Start a session here" onClick={() => store.newDraft()}
        menu={{ icons: 'all', label: 'More ways to start', onOpenChange: open => { if (open) void store.loadWorktrees() },
          content: close => <WorktreeItems close={close} onChoose={() => setStarting(true)} /> }} />
      <LeftColumnGroup label="Main sections" heading={false}>
        {pageDoors.map(door => <LeftColumnRow key={door.id} label={door.label} icon={door.icon}
          selected={activeDestination === door.id} onClick={door.run}
          title={door.id === 'agents' && agentsBroken ? 'Agents, some unavailable' : door.label}
          trailing={door.count > 0 ? { kind: 'count', value: door.count,
            label: door.id === 'agents' ? `${door.count} Agents${agentsBroken ? ', some unavailable' : ''}` : door.id === 'dashboard' ? `${door.count} Agents need attention` : `${door.count} Plugins` } : undefined} />)}
      </LeftColumnGroup>
    </LeftColumnNavigation>
  </>
  const sessionsBody = (
    <LeftColumnBody hidden={Boolean(settings)} ref={listRef} onScroll={onScroll}>
    <LeftColumnProjectsHead value={query} onChange={setQuery} focused={filterFocused}
      onFocusChange={setFilterFocused} options={<SessionListControls searching={searchQuery.length > 0} />}
      onBrowseFolders={onBrowseFolders} />
      {snapshot.history.length === 0 && !snapshot.historyLoading && !searchQuery && (
        <EmptyState
          variant="inline"
          title={ready
            ? `No sessions yet. Start one to see it here${runtime.presentation.historySource ? ` — sessions you run in ${runtime.presentation.historySource} show up too` : ''}.`
            : 'Connect a runtime to see your sessions.'}
        />
      )}
      <SessionTree
        now={now}
        searching={searchQuery.length > 0}
        searchEmptyState={searchQuery && !snapshot.historyLoading ? (
          <EmptyState variant="inline" title={`No conversations match “${searchQuery}”.`}>
            {' '}
            <Button variant="muted" size="sm" onClick={() => setQuery('')}>Clear search</Button>
          </EmptyState>
        ) : null}
      />
      {snapshot.historyCursor && query.length === 0 && (
        <LeftColumnRow label="Load more conversations" disabled={snapshot.historyLoading} onClick={() => { void store.loadHistory() }} />
      )}
    </LeftColumnBody>
  )
  return <>
    {starting && projectRootOf(snapshot.workspace) && <FrontDoor context={{ kind: 'project', root: projectRootOf(snapshot.workspace)! }} onClose={() => setStarting(false)} onStarted={execution => { store.openGoal(execution.goal); setStarting(false) }} />}
  <LeftColumn active={active} top={top} head={<LeftColumnModeHead hidden={Boolean(settings)}>{sessionsHead}</LeftColumnModeHead>}
    body={<>{sessionsBody}<LeftColumnBody hidden={!settings}>
      {settings && <SettingsNavigation section={settings.section} onSection={settings.onSection} onBack={settings.onBack} />}
    </LeftColumnBody></>}
    footer={<><Slot name="sidebar.panel" /><SidebarNotices /><SidebarUpdate /><AccountFooter notifications={<InboxPanel side="top" size="icon-sm" messages={inbox}
      onOpen={id => store.markInboxRead(id)} onMarkAllRead={() => store.markInboxRead(null)}
      onClear={() => store.clearInbox()} />}
      onOpenSettings={onOpenSettings}
      onOpenUsage={onOpenUsage} onSignIn={onSignIn} settingsOpen={Boolean(settings)}
      onGear={settings ? () => {} : () => onOpenSettings('general')} /></>} />
  </>
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
const WorktreeItems = ({ onChoose, close }: { readonly onChoose: () => void; readonly close: () => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const health = useRuntimeHealth()
  const ready = health?.state === 'ready' || health?.state === 'idle'
  const hasFolder = Boolean(projectRootOf(snapshot.workspace))
  const isRepo = Boolean(snapshot.workspace?.git?.branch)
  const active = snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) : undefined
  const mine = snapshot.worktrees.filter((entry) => entry.managed)

  return (
        <Menu close={close}>
          <MenuItem icon={<PlusIcon size={14} />} label="New session" shortcut="⌘N" onSelect={() => { close(); store.newDraft() }} />
          <MenuItem icon={<TeamIcon size={14} />} label="New Team…" shortcut="⌘⇧N" {...(!hasFolder ? { disabled: 'Open a folder to start one.' } : {})} onSelect={() => { close(); onChoose() }} />
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
        </Menu>
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
  notifications,
  onOpenSettings,
  onOpenUsage,
  onSignIn,
  settingsOpen = false,
  onGear = () => onOpenSettings('general'),
}: {
  onOpenSettings: (section?: Section) => void
  notifications?: ReactNode
  onGear?: () => void
  settingsOpen?: boolean
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
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const resetMenu = (): void => {
    setAccountsOpen(false)
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
    <LeftColumnSeat notifications={notifications} settingsOpen={settingsOpen} onSettings={onGear} menu={<div ref={accountRef}>
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
            <SeatPlanUsage onOpen={onOpenUsage} onSignIn={onSignIn} />
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
    </div>} />
  )
}

/** The same plan facts as PlanMeters, in the seat's existing menu rows. */
const SeatPlanUsage = ({ onOpen, onSignIn }: { onOpen: (runtime: RuntimeId) => void; onSignIn: (runtime: RuntimeId) => void }) => {
  const snapshot = useSnapshot(), session = useActiveSession()
  const [now, setNow] = useState(Date.now), [expanded, setExpanded] = useState<string | null>(null)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])
  const view = describeStrip({ runtimes: snapshot.runtimes, usage: snapshot.usage, accountsByRuntime: snapshot.accountsByRuntime,
    accountPrefs: snapshot.accountPrefs, health: snapshot.health, activeRuntime: snapshot.activeRuntime, sessionRuntime: session?.runtime ?? null, now })
  const meters: readonly StripMeter[] = [...(view.anchor?.kind === 'meter' ? [view.anchor.meter] : []), ...(view.rest?.meters ?? [])]
  return <>
    {view.anchor?.kind === 'signIn' && <MenuItem icon={<SignInIcon size={13} />} label={`Sign in to ${view.anchor.info.presentation.name}`}
      onSelect={() => { if (view.anchor?.kind === 'signIn') onSignIn(view.anchor.info.id) }} />}
    {meters.map((meter, index) => {
      const key = `${meter.runtime}:${meter.report.account ?? ''}`, open = expanded === key
      return <SeatUsageRows key={key} meter={meter} now={now} open={open}
        label={index === 0 && view.anchor?.kind === 'meter' ? 'Usage remaining' : `${meter.name}${meter.account ? ` · ${meter.account}` : ''} usage`}
        toggle={() => setExpanded(open ? null : key)} onOpen={() => onOpen(meter.runtime)} />
    })}
    {view.rest?.asides.map(aside => <MenuItem key={aside.runtime} icon={aside.detail === 'Needs sign-in' ? <SignInIcon size={13} /> : <UsageIcon size={13} />}
      label={aside.detail === 'Needs sign-in' ? `Sign in to ${aside.info.presentation.name}` : `${aside.info.presentation.name} usage`}
      hint={aside.detail === 'Needs sign-in' ? undefined : aside.detail}
      onSelect={() => aside.detail === 'Needs sign-in' ? onSignIn(aside.runtime) : onOpen(aside.runtime)} />)}
  </>
}
const SeatUsageRows = ({ meter, now, open, label, toggle, onOpen }: { meter: StripMeter; now: number; open: boolean; label: string; toggle: () => void; onOpen: () => void }) => <>
  <MenuItem icon={<UsageIcon size={13} />} label={label} value={<Text role="muted" tone={usageReadingTone(meter.tone)} numeric className={styles.accountMenuMeta}>
    {meter.figure}<DisclosureChevron open={open} placement="trailing" tone={usageReadingTone(meter.tone) ? 'warning' : 'neutral'} className={styles.accountMenuCaret} /></Text>} expanded={open} keepOpen onSelect={toggle} title={meter.title} />
  {open && <div className={styles.usageDetails} data-usage-details>
    {(meter.report.plan || meter.report.account) && <MenuNote>{[meter.report.plan, meter.report.account].filter(Boolean).join(' · ')}</MenuNote>}
    <div className={styles.usageLanes}>{meter.report.lanes.map(raw => {
      const lane = describeLane(raw, now, meter.report.lanes)
      return <UsageMeterRow key={lane.id} name={lane.title} percent={lane.remainingPercent}
        countdown={lane.gatedUntil === null ? lane.resetCountdown : `blocked ${lane.gatedFor ?? '—'}`}
        countdownTitle={lane.gatedUntil !== null ? `blocked until ${lane.gatedClock}` : lane.resetClock ? `resets ${lane.resetClock}` : undefined}
        tone={lane.tone === 'bad' ? 'danger' : lane.tone === 'warn' ? 'warning' : 'neutral'} standalone barless />
    })}</div>
    <MenuNote>{[meter.report.spend?.todayCost != null ? `${formatMoney(meter.report.spend.todayCost, meter.report.spend.currency)} today` : null,
      meter.report.source.label, formatAge(meter.report.fetchedAt, now)].filter(Boolean).join(' · ')}</MenuNote>
    <MenuItem icon={<UsageIcon size={13} />} label="Open usage" onSelect={onOpen} />
  </div>}
</>
