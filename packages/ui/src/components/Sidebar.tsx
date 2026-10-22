import { describeStrip, type StripMeter } from '../lib/plan-strip'
import { SidebarUpdate } from './SidebarUpdate'
import { LeftColumnModeHead } from '../design'
import { SettingsNavigation } from './SettingsNavigation'
import { LeftColumn, LeftColumnBody, LeftColumnNavigation, LeftColumnProjectsHead, LeftColumnTop, LeftColumnRow, LeftColumnSeat, LeftColumnGroup } from '../design'
import { LibraryIcon } from './Icons'
import { Slot } from '../slots/registry'
import { sidebarPlacement } from '../state/workbench'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { SidebarNotices, useAccountQuotaWarning, useInboxMessages } from './Notices'
import type { Account, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'
import { useActiveSession, useRuntime, useRuntimeHealth, useSnapshot, useStore } from '../state/context'
import { AgentIcon, BranchIcon, CaretIcon, CrossIcon, FolderOpenIcon, PlusIcon, SearchIcon, SettingsIcon, SignOutIcon, TeamIcon, UsageIcon } from './Icons'
import { FrontDoor } from './FrontDoor'
import { SessionListControls, SessionTree } from './SessionTree'
import {
  AccountMark,
  MenuFacts,
  Submenu,
  ConfirmDialog,
  ActionError,
  useDismissOverlays,
  Button,
  Bar,
  Menu,
  Row,
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
import { accountForUsage, accountKey, accountName, accountIdentity, agentKey, prefsForUsage, runtimeLabel, tintOf, type AccountPrefs } from '../lib/accounts'
import { folderName, projectRootOf } from '../lib/projects'
import { anyBroken } from '../lib/agents'
import { FlowIcon } from './Icons'
import { Explorer, effectiveWindowMode } from '../editor'
import { brandOf } from '../lib/identity'
import { profileName } from '../lib/profile'
import { READINESS_LABEL, readinessOf, type Readiness } from '../lib/readiness'
import { HarnessMark, RuntimeMark } from './BrandIcons'
import { ProfileFace } from './ProfileFace'
import { Clipped, EmptyState } from '../design'
import type { Section } from './Settings'
import { bindingLane, describeReport, describeLane, formatAge, formatMoney, isBlocked, workingAccount } from '../lib/usage'
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
  onOpenLibrary,
  onOpenAgents,
  onOpenTeams,
  onOpenFlows,
  onOpenUsage,
  onBrowseFolders,
  onSignIn,
  onSearch,
  activeDestination = null,
  active = true, settings, listFilter, sessionsOwner = true,
}: {
  onOpenSettings: (section?: Section) => void
  onOpenLibrary?: () => void
  /** Opens the Agents window — the roster, never a Settings page. */
  onOpenAgents: () => void
  onOpenTeams: () => void
  onOpenFlows?: () => void
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
  activeDestination?: 'teams' | 'flows' | 'agents' | 'library' | 'plugins' | 'dashboard' | null
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const inbox = useInboxMessages()
  const destination = snapshot.workbench.navigation.current
  const explorerSession = effectiveWindowMode(snapshot.windowMode, snapshot.workbench) === 'editor' && destination.kind === 'work' && destination.view.kind === 'conversation' ? destination.view.session : null
  const explorerShown = explorerSession !== null && !settings
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

  const health = useRuntimeHealth()
  const ready = health?.state === 'ready' || health?.state === 'idle'
  const agentsBroken = anyBroken(snapshot.agents ?? [])
  const top = <LeftColumnTop shown={sidebarPlacement(snapshot) !== 'away'}
    settings={Boolean(settings)}
    modeSwitch={{ value: effectiveWindowMode(snapshot.windowMode, snapshot.workbench),
      onChange: value => store.setWindowMode(value),
      disabled: effectiveWindowMode('editor', snapshot.workbench) !== 'editor',
      disabledTitle: "Editor mode opens a conversation's files" }}
    back={snapshot.navCanBack} forward={snapshot.navCanForward}
    toggle={() => store.toggleSidebar()} goBack={() => { void store.navigateBack() }}
    goForward={() => { void store.navigateForward() }}
    search={<Button variant="ghost" size="icon-sm" onClick={onSearch}
      title="Search everything (⌘K)" aria-label="Search everything" aria-keyshortcuts="Meta+K"><SearchIcon size={16} /></Button>} />
  const brand = <Bar inset="ink" className="hd-drag" data-left-brand>
    <HarnessMark size={14} />
    <Text role="wordmark" truncate title={snapshot.workspace?.path ?? undefined}>HarnessDesk</Text>
  </Bar>
  const pageDoors = [
    { id: 'teams' as const, label: 'Teams', icon: <TeamIcon size={16} />, run: onOpenTeams, count: 0 },
    { id: 'flows' as const, label: 'Flows', icon: <FlowIcon size={16} />, run: onOpenFlows ?? (() => store.openDestination({kind:'flows',root:null,id:null,origin:null})), count: 0 },
    { id: 'agents' as const, label: 'Agents', icon: <AgentIcon size={16} />, run: onOpenAgents, count: 0 },
    { id: 'library' as const, label: 'Customize', icon: <LibraryIcon size={16} />, run: onOpenLibrary ?? (() => onOpenSettings('library')), count: 0 },
    { id: 'dashboard' as const, label: 'Dashboard', icon: <UsageIcon size={16} />, run: () => onOpenUsage(), count: lowAgents },
  ]
  const sessionsHead = <>

    <LeftColumnNavigation>
      <LeftColumnRow label="New session" icon={<PlusIcon size={16} />}
        disabled={!ready || !snapshot.workspace} title="Start a session here" onClick={() => store.newDraft()}
        menu={{ icons: 'all', label: 'More ways to start', onOpenChange: open => { if (open) { void store.loadWorktrees(); if (snapshot.workspace) void store.refreshWorkspaceGit(snapshot.workspace.path) } },
          content: close => <WorktreeItems close={close} onBrowseFolders={onBrowseFolders} onChoose={() => { store.returnToWork(); setStarting(true) }} /> }} />
      <LeftColumnGroup label="Main sections" heading={false}>
        {pageDoors.map(door => <LeftColumnRow key={door.id} label={door.label} icon={door.icon}
          selected={activeDestination === door.id || (door.id === 'library' && activeDestination === 'plugins')} onClick={door.run}
          title={door.id === 'agents' && agentsBroken ? 'Agents, some unavailable' : door.label}
          trailing={door.count > 0 ? { kind: 'count', value: door.count,
            label: `${door.count} Runtimes need attention` } : undefined} />)}
      </LeftColumnGroup>
    </LeftColumnNavigation>
  </>
  const sessionsBody = (
    <LeftColumnBody hidden={Boolean(settings) || explorerShown} ref={listRef} onScroll={onScroll}>
    <LeftColumnProjectsHead value={query} onChange={setQuery} focused={filterFocused}
      onFocusChange={setFilterFocused} options={<SessionListControls searching={searchQuery.length > 0} />}
      onBrowseFolders={onBrowseFolders} />
      <SessionTree
        now={now}
        suppressSelection={activeDestination !== null}
        searching={searchQuery.length > 0}
        filter={searchQuery}
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
  <LeftColumn active={active} top={<>{top}{brand}</>} head={<LeftColumnModeHead hidden={Boolean(settings) || explorerShown}>{sessionsHead}</LeftColumnModeHead>}
    body={<>{sessionsBody}{explorerShown && <Explorer session={explorerSession} />}<LeftColumnBody hidden={!settings}>
      {settings && <SettingsNavigation section={settings.section} onSection={settings.onSection} onBack={settings.onBack} />}
    </LeftColumnBody></>}
    footer={<><Slot name="sidebar.panel" />{!settings && <SidebarNotices />}<SidebarUpdate /><AccountFooter notifications={<InboxPanel side="top" size="icon-sm" messages={inbox}
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
const WorktreeItems = ({ onChoose, close, onBrowseFolders }: { readonly onChoose: () => void; readonly close: () => void; readonly onBrowseFolders: () => void }) => {
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
          <MenuItem icon={<FolderOpenIcon size={14} />} label="Open folder…" onSelect={() => { close(); onBrowseFolders() }} />
          <MenuItem icon={<TeamIcon size={14} />} label="New Team…" shortcut="⌘⇧N" {...(!hasFolder ? { disabled: 'Open a folder to start one.' } : {})} onSelect={() => { close(); onChoose() }} />
          {isRepo && snapshot.workspace?.git?.sha === null ? (
            <Row title="Make a first commit to work in a worktree" control={
              <Button variant="quiet" size="sm" onClick={() => { close(); store.askCommit(snapshot.workspace!.path) }}>Commit</Button>
            } />
          ) : <MenuItem
            icon={<BranchIcon size={14} />}
            label="New worktree…"
            title="Its own checkout, on a branch of its own."
            {...(!isRepo || !ready ? { disabled: isRepo ? 'Connect a runtime to work in a worktree.' : 'Worktrees need a git repository.' } : {})}
            onSelect={() => {
              close()
              store.askNewWorktree(snapshot.workspace?.path ?? null)
            }}
          />}
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

/** A broken launch or sign-in requirement outranks a cached reading. */
const figureOf = (seat: Seat): MenuAccountFigure | undefined =>
  seat.state === 'broken' || seat.state === 'signin'
    ? { kind: 'word', text: READINESS_LABEL[seat.state], tone: readinessTone(seat.state) }
    : seat.figure
      ? { kind: 'reading', text: seat.figure, tone: usageReadingTone(seat.tone) }
      : seat.state === 'limit'
        ? { kind: 'word', text: READINESS_LABEL[seat.state], tone: readinessTone(seat.state) }
        : undefined

const SeatFigure = ({ figure }: { figure: MenuAccountFigure | undefined }) => figure
  ? <Text role={figure.kind === 'reading' ? 'muted' : 'meta'} tone={figure.tone} numeric={figure.kind === 'reading'}>{figure.text}</Text>
  : null

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
  const quotaWarning = useAccountQuotaWarning()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  useDismissOverlays(confirmingSignOut, () => { setSignOutError(null); setConfirmingSignOut(false) })
  const accountRef = useRef<HTMLDivElement>(null)

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
  const report = workingAccount(snapshot.usage.filter(one => one.runtime === snapshot.activeRuntime), one =>
    prefsForUsage(one.runtime, one.account, snapshot.accountsByRuntime, snapshot.accountPrefs) ?? {})
  const here = seats.find(seat => seat.current && seat.report === report) ?? seats.find(seat => seat.current) ?? null
  const currentFigure = here ? figureOf(here) : undefined
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
  // The whole roster lives in its own flyout, leaving the footer menu short.
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
    setSignOutError(null)
    try {
      await store.signOutAgent(snapshot.activeRuntime)
      close()
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const accountTrigger = (
    <>
      <ProfileFace size={24} />
      <Text role="subject" className={styles.accountName}>
        <Clipped truncate className={styles.accountLabel}>{yourName}</Clipped>
      </Text>
      <CaretIcon size={16} />
    </>
  )

  return (
    <LeftColumnSeat notifications={notifications} settingsOpen={settingsOpen} onSettings={onGear} menu={<div ref={accountRef}>
      <Popover
        title={[here ? `New sessions run as ${nextAs}` : 'Accounts and settings', quotaWarning].filter(Boolean).join(' · ')}
        /* Opens upward from the footer. Its width belongs to the menu so a
           narrow sidebar does not fold the account and usage rows. */
        side="top"
        sideAlign="start"
        sideOffset={6}
        fullWidth
        panelWidth="wide"
        icons="all"
        triggerClassName={buttonVariants({ variant: 'navigation', size: 'navigation', className: styles.accountRow })}
        label={accountTrigger}
      >
        {(close) => (
          <Menu
            close={close}
            onEscape={() => {
              close()
              accountRef.current?.querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')?.focus()
            }}
          >
          {/* You — the seat a HarnessDesk account will take. There is no
              such account yet, and a sign-in button for one would be a lie,
              so this is what is true today: your profile, kept on this Mac.
              Pressing it opens the page where it is set. */}
          <MenuItem icon={<ProfileFace size={16} />} label={yourName} title="Your name and picture. Nothing syncs between machines." onSelect={() => onOpenSettings('profile')} />

          <MenuSeparator />
          <Submenu
            icon={here ? <AccountMark size="menu" {...(here.account ? { 'data-tint': tintOf(here.key, snapshot.accountPrefs) } : here.state === 'signin' ? { 'data-off': '' } : {})}><RuntimeMark runtime={here.info} size={16} /></AccountMark> : <AgentIcon size={16} />}
            label={here ? <span data-menu-account-name="" data-identity={here.sub} title={here.sub}>{labelOf(here)}</span> : 'Accounts'}
            value={currentFigure?.kind === 'word' ? <SeatFigure figure={currentFigure} /> : undefined}
            current={Boolean(here)}
            icons="all"
          >
            <MenuLabel size="compact">Run new sessions as</MenuLabel>
            {groups.map((group) => {
              const renderSeat = (seat: Seat, child: boolean) => (
                <MenuAccountRow
                  key={seat.key}
                  mark={child
                    ? <AccountMark size="dot" aria-hidden="true" {...(seat.account ? { 'data-tint': tintOf(seat.key, snapshot.accountPrefs) } : {})}>{null}</AccountMark>
                    : <AccountMark size="menu" {...(seat.account ? { 'data-tint': tintOf(seat.key, snapshot.accountPrefs) } : seat.state === 'signin' ? { 'data-off': '' } : {})}><RuntimeMark runtime={seat.info} size={16} /></AccountMark>}
                  name={labelOf(seat)}
                  identity={seat.sub}
                  tag={tagOf(seat)}
                  figure={figureOf(seat)}
                  current={seat.current}
                  onSelect={() => { void store.selectRuntime(seat.info.id) }}
                />
              )
              if (group.length === 1) return renderSeat(group[0]!, false)
              const agent = group[0]!.info
              return <MenuAccountGroup key={agentKey(agent)} label={agent.presentation.name}
                mark={<AccountMark size="sm"><RuntimeMark runtime={agent} size={16} /></AccountMark>}>
                {group.map((seat) => renderSeat(seat, true))}
              </MenuAccountGroup>
            })}
            {here?.state === 'signin' && <MenuItem icon={<RuntimeMark runtime={here.info} size={16} />}
              label={`Sign in to ${here.info.presentation.name}`} onSelect={() => onSignIn(here.info.id)} />}
            <MenuSeparator />
            <MenuItem icon={<PlusIcon size={16} />} label="Add an account…" onSelect={() => onSignIn()} />
            <MenuItem icon={<SettingsIcon size={16} />} label="Manage runtimes" onSelect={() => onOpenSettings('runtimes')} />
          </Submenu>
          <SeatPlanUsage onOpen={onOpenUsage} onSignIn={onSignIn} />
          <MenuSeparator />
            <MenuItem
              icon={<SettingsIcon size={16} />}
              label="Settings"
              shortcut="⌘,"
              onSelect={() => {
                onOpenSettings()
              }}
            />
            {signedIn && <MenuItem icon={<SignOutIcon size={16} />} label={`Sign out of ${agentName}…`} danger onSelect={() => { setSignOutError(null); setConfirmingSignOut(true) }} />}
          </Menu>
        )}
      </Popover>
      {confirmingSignOut && <ConfirmDialog title={`Sign out of ${agentName}?`} confirmLabel="Sign out" cancelLabel="Keep signed in" tone="destructive" busy={busy} onCancel={() => { setSignOutError(null); setConfirmingSignOut(false) }} onConfirm={() => void signOut(() => setConfirmingSignOut(false))}>
        <>You'll need to sign in again before the next turn.{signOutError && <ActionError>{signOutError}</ActionError>}</>
      </ConfirmDialog>}
    </div>} />
  )
}

/** Usage has its own level; roster growth never adds rows to the root menu. */
const SeatPlanUsage = ({ onOpen, onSignIn }: { onOpen: (runtime?: RuntimeId) => void; onSignIn: (runtime: RuntimeId) => void }) => {
  const snapshot = useSnapshot()
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer) }, [])
  const view = describeStrip({ runtimes: snapshot.runtimes, usage: snapshot.usage, accountsByRuntime: snapshot.accountsByRuntime,
    accountPrefs: snapshot.accountPrefs, health: snapshot.health, activeRuntime: snapshot.activeRuntime, sessionRuntime: null, now })
  const current = view.anchor?.kind === 'meter' ? view.anchor.meter : null
  const others = view.rest?.meters ?? []
  const shortAccountName = (meter: StripMeter): string => {
    const account = accountForUsage(meter.runtime, meter.report.account, snapshot.accountsByRuntime)
    return account
      ? accountName(account, snapshot.accountPrefs[accountKey(meter.runtime, account)], meter.name)
      : meter.account?.split('@')[0] ?? meter.name
  }
  const usageAccountName = (meter: StripMeter): string => {
    const short = shortAccountName(meter)
    // A short name is useful only when it still tells reporting accounts apart.
    const collision = others.some(other => other !== meter && other.name === meter.name && shortAccountName(other) === short)
    return collision ? meter.account ?? short : short
  }
  return <Submenu icon={<UsageIcon size={16} />} label="Usage" icons="all"
    value={current ? <Text role="muted" tone={usageReadingTone(current.tone)} numeric>{current.figure.endsWith('%') ? `${current.figure} left` : current.figure}</Text> : undefined}>
    {current ? <SeatUsageFacts meter={current} now={now} /> : <MenuNote>No usage reported for this account.</MenuNote>}
    {view.anchor?.kind === 'signIn' && <MenuItem icon={<RuntimeMark runtime={view.anchor.info} size={16} />}
      label={`Sign in to ${view.anchor.info.presentation.name}`}
      onSelect={() => { if (view.anchor?.kind === 'signIn') onSignIn(view.anchor.info.id) }} />}
    <MenuItem icon={<UsageIcon size={16} />} label="Open usage" onSelect={() => onOpen(snapshot.activeRuntime ?? undefined)} />
    {others.length > 0 && <>
      <MenuSeparator />
      <MenuLabel size="compact">Other accounts</MenuLabel>
      {others.map(meter => {
        const name = meter.account ? `${meter.name} · ${usageAccountName(meter)}` : runtimeLabel(meter.info, snapshot.runtimes, snapshot.accountsByRuntime, snapshot.accountPrefs)
        return <MenuItem key={`${meter.runtime}:${meter.report.account ?? ''}`}
          icon={<RuntimeMark runtime={meter.info} size={16} />}
          label={<span data-menu-account-name="" title={meter.title}>{name}</span>}
          value={<Text role="muted" tone={usageReadingTone(meter.tone)} numeric>{meter.figure}</Text>}
          title={meter.title} onSelect={() => onOpen(meter.runtime)} />
      })}
    </>}
  </Submenu>
}

const SeatUsageFacts = ({ meter, now }: { meter: StripMeter; now: number }) => <div data-usage-details>
  <MenuLabel size="compact">{meter.name}{meter.report.plan ? ` · ${meter.report.plan}` : ''}</MenuLabel>
  {meter.report.account && <MenuNote><Text as="div" role="meta" truncate title={meter.report.account}>{meter.report.account}</Text></MenuNote>}
  <MenuFacts rows={meter.report.lanes.map(raw => {
    const lane = describeLane(raw, now, meter.report.lanes)
    return { id: lane.id, name: lane.title, percent: lane.remainingPercent,
      countdown: lane.gatedUntil === null ? lane.resetCountdown : `blocked ${lane.gatedFor ?? '—'}`,
      countdownTitle: lane.gatedUntil !== null ? `blocked until ${lane.gatedClock}` : lane.resetClock ? `resets ${lane.resetClock}` : undefined,
      tone: lane.tone === 'bad' ? 'danger' as const : lane.tone === 'warn' ? 'warning' as const : 'neutral' as const, barless: true }
  })} />
  <MenuNote>{[meter.report.spend?.todayCost != null ? `${formatMoney(meter.report.spend.todayCost, meter.report.spend.currency)} today` : null,
    meter.report.source.label, formatAge(meter.report.fetchedAt, now)].filter(Boolean).join(' · ')}</MenuNote>
</div>
