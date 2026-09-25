import { useCallback, useEffect, useRef, useState } from 'react'

import type { Account, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'
import { useRuntime, useRuntimeHealth, useSnapshot, useStore } from '../state/context'
import { Slot } from '../slots/registry'
import { BranchIcon, BriefIcon, FilterIcon, PluginIcon, PlusIcon, SearchIcon, SettingsIcon, SignOutIcon, UsageIcon } from './Icons'
import { WindowControls } from './WindowControls'
import { NewSessionChoice } from './NewSessionChoice'
import { SessionListControls, SessionTree } from './SessionTree'
// Imported for its side effect: the Tasks panel registers itself into the
// `sidebar.panel` slot rendered below.
import './TaskPanel'
import {
  AccountMark,
  Bar,
  Button,
  Dot,
  Menu,
  MenuItem,
  MenuLabel,
  MenuNote,
  MenuSeparator,
  NavigationGroupHeader,
  Popover,
  RailSection,
  RefusedAction,
  Search,
  Text,
  buttonVariants,
  type Tone,
} from '../design'
import { accountKey, accountName, accountIdentity, tintOf, type AccountPrefs } from '../lib/accounts'
import { folderName } from '../lib/projects'
import { brandOf } from '../lib/identity'
import { profileName } from '../lib/profile'
import { READINESS_LABEL, readinessOf, type Readiness } from '../lib/readiness'
import { livePlugins } from '../lib/plugins'
import { anyBroken, inForce } from '../lib/agents'
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
  onOpenUsage,
  onBrowseFolders,
  onSignIn,
  onSearch,
}: {
  onOpenSettings: (section?: Section) => void
  onOpenPlugins: () => void
  /** Opens the Agents window — the roster, never a Settings page. */
  onOpenAgents: () => void
  /** Opens the dashboard, scoped to one agent when the caller names it. */
  onOpenUsage: (runtime?: RuntimeId) => void
  onBrowseFolders: () => void
  /** Opens the sign-in screen, on one runtime when the caller knows which. */
  onSignIn: (runtime?: RuntimeId) => void
  onSearch: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  // The filter takes the Workspaces row while it is in use and gives the
  // label back when it is empty and unfocused: a 200px sidebar has room for
  // the word or for a field you can read what you typed in, not both.
  const [filterFocused, setFilterFocused] = useState(false)
  /** The "session, or room?" dialog. On the button only; ⌘N is the express lane. */
  const [starting, setStarting] = useState(false)
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
  const ready = health?.state === 'ready'
  // Not `plugins.length`: an installed copy a built-in has taken over is off,
  // and counting it here made the sidebar promise one more than the page lists.
  const pluginCount = livePlugins(snapshot.plugins).length
  // Null until a surface that lists Agents has asked (the plain path's own
  // rule): this row then counts none and wears no dot, rather than reading
  // the roster itself just to sit in the sidebar.
  const agentsRoster = snapshot.agents ?? []
  const agentsCount = inForce(agentsRoster).length
  const agentsBroken = anyBroken(agentsRoster)

  return (
    <div className={styles.sidebar}>
      <Bar corner className="hd-drag">
        <WindowControls />
      </Bar>

      {/* The magnifier is search, not filtering: it opens the palette over
          everything — sessions, files, agents, commands — which is what a
          magnifier at the top of a window promises. Narrowing the list is the
          Workspaces row's job, down where the list is. */}
      <Bar inset="ink">
        <Text role="subject" className={styles.brandMark} aria-hidden>
          <HarnessMark size={14} />
        </Text>
        <Text role="wordmark" truncate className={styles.workspaceName} title={snapshot.workspace?.path ?? undefined}>
          HarnessDesk
        </Text>
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost" size="icon-sm" className={`${styles.iconButton} hd-no-drag`}
          onClick={onSearch}
          title="Search sessions, files, agents and commands (⌘K)"
          aria-label="Search everything"
        >
          <SearchIcon size={13} />
        </Button>
      </Bar>

      {/* Three slots, because the top of the sidebar is the most valuable
          space in the app and only what a person reaches for *while working*
          earns a place in it: start a conversation, with the worktrees of
          this project one press to its right; what is left of the
          plan; and the way into what the agents can do. The archive is
          deliberately not up here — filing a conversation away happens from
          its own ⋯ menu, and going to look for it again is a trip somebody
          makes twice a month, so it lives in Settings with the rest of the
          on-purpose visits. Changes lives in every conversation's header, and
          ⌘K reaches the rest. */}
      {starting && <NewSessionChoice onClose={() => setStarting(false)} />}
      <RailSection as="nav" stretch="head" className={styles.nav} aria-label="Workspace actions">
        <div className={styles.navRow}>
          <Button
            variant="navigation" size="navigation" className={styles.navItem}
            disabled={!ready || !snapshot.workspace}
            /* Asks which kind of work this is; ⌘N and the palette still go
               straight to a session. See `NewSessionChoice`. */
            onClick={() => setStarting(true)}
            title="Start one agent, or a room for several."
          >
            <Text role="muted" className={styles.navIcon}><PlusIcon size={15} /></Text>
            New session
          </Button>
          <WorktreeMenu />
        </div>
        {/* The plain path's one new row (the owner's rule, 2026-09-18): who
            can do the work, beside where the work already starts. Its count
            is the roster in force, and it wears the same warn tone the
            Dashboard's own badge does — never a chip drawn just for this row. */}
        <Button variant="navigation" size="navigation" className={styles.navItem} onClick={onOpenAgents}>
          <BriefIcon size={15} className={styles.navIcon} />
          Agents
          {agentsCount > 0 && (
            <span className={styles.navCount} {...(agentsBroken ? { 'data-tone': 'warn' } : {})}>
              {agentsCount}
            </span>
          )}
        </Button>
        {/* Called with nothing, on purpose: the handler takes an agent id
            now, and a click event in its place would open the dashboard
            scoped to an object. */}
        <Button variant="navigation" size="navigation" className={styles.navItem} onClick={() => onOpenUsage()}>
          <Text role="muted" className={styles.navIcon}><UsageIcon size={15} /></Text>
          Dashboard
          {/* The count is the number of agents that need attention, not the
              number that report — a badge for "everything is fine" is noise. */}
          {lowAgents > 0 && (
            <Text role="meta" numeric className={styles.navCount}>
              {lowAgents}
            </Text>
          )}
        </Button>
        <Button variant="navigation" size="navigation" className={styles.navItem} onClick={onOpenPlugins}>
          <Text role="muted" className={styles.navIcon}><PluginIcon size={15} /></Text>
          Plugins
          {pluginCount > 0 && (
            <Text role="meta" numeric className={styles.navCount}>{pluginCount}</Text>
          )}
        </Button>
      </RailSection>

      {/* The list's own row: what the list is, the field that narrows it, and
          the two things you do to it. It sits outside the scroller so that
          filtering stays one click away however far down the list you are. */}
      <NavigationGroupHeader label="Workspaces" filtering={filtering}>
        <div className={styles.filter}>
          <Search
            size="compact"
            icon="filter"
            className={styles.filterInput}
            placeholder={filtering ? 'Filter sessions' : ''}
            label="Filter sessions"
            title="Narrow the list below. ⌘K searches everything."
            value={query}
            onChange={setQuery}
            onFocus={() => setFilterFocused(true)}
            onBlur={() => setFilterFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                // Spent on the words it clears, and said so: a sidebar floating
                // over a narrow window stays open for the list the filter just
                // gave back. An empty filter has nothing to clear, and lets the
                // key go on to whatever it would have closed.
                if (query) event.preventDefault()
                setQuery('')
                event.currentTarget.blur()
              }
            }}
          />
        </div>
        <SessionListControls />
        <Button
          variant="muted" size="icon-sm" className={styles.iconButton}
          onClick={onBrowseFolders}
          title="Open a project folder"
          aria-label="Open a project folder"
        >
          <PlusIcon size={13} />
        </Button>
      </NavigationGroupHeader>

      <RailSection stretch="list" className={styles.list} ref={listRef} onScroll={onScroll}>
        {snapshot.history.length === 0 && !snapshot.historyLoading && (
          <EmptyState
            variant="inline"
            title={ready
              ? `No sessions yet. Start one to see it here${
                  runtime.presentation.historySource
                    ? ` — sessions you run in ${runtime.presentation.historySource} show up too`
                    : ''
                }.`
              : 'Connect a runtime to see your sessions.'}
          />
        )}
        <SessionTree now={now} />
      </RailSection>

      <Slot name="sidebar.panel" />

      <AccountFooter
        onOpenSettings={onOpenSettings}
        onOpenUsage={onOpenUsage}
        onSignIn={onSignIn}
      />
    </div>
  )
}

/**
 * The worktrees of the project you are in, one press right of New session.
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
const WorktreeMenu = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const health = useRuntimeHealth()
  const ready = health?.state === 'ready'
  const isRepo = Boolean(snapshot.workspace?.git?.branch)
  const active = snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) : undefined
  const mine = snapshot.worktrees.filter((entry) => entry.managed)

  if (!isRepo || !ready) {
    const reason = isRepo
      ? 'Connect an agent to work in a worktree.'
      : 'Worktrees need a git repository. This folder is not one.'
    return (
      <RefusedAction reason={reason}>
        <Button
          variant="ghost" size="icon-sm" className={styles.navSecondary}
          disabled
          aria-label="Worktrees"
        >
          <BranchIcon size={14} />
        </Button>
      </RefusedAction>
    )
  }

  return (
    <Popover
      title="Worktrees of this project"
      drop="down"
      align="right"
      triggerClassName={buttonVariants({ variant: 'ghost', size: 'icon-sm', className: styles.navSecondary })}
      label={<BranchIcon size={14} />}
      onOpenChange={(open) => open && void store.loadWorktrees()}
    >
      {(close) => (
        <Menu close={close}>
          {/* Which project, first — the same question the dialog answers in
              its subhead, answered one step earlier. */}
          <MenuLabel>{folderName(snapshot.workspace?.path ?? '')}</MenuLabel>
          <MenuItem
            icon={<PlusIcon size={14} />}
            label="New worktree…"
            title="Its own checkout, on a branch of its own."
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
  /** What is left of the tightest window, or null when nothing is metered. */
  readonly figure: string | null
  readonly tone: 'good' | 'warn' | 'bad'
  readonly current: boolean
  readonly report: UsageReport | null
  readonly preference: AccountPrefs | undefined
}

const readinessTone = (state: Readiness): Tone | undefined => ({
  ready: undefined,
  available: undefined,
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

    if (accounts.length === 0) {
      return [
        {
          key: `${info.id}:none`,
          info,
          account: null,
          name: info.presentation.name,
          sub: READINESS_LABEL[state],
          state,
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
  const chairs = seats.filter((seat) => seat.current || seat.state !== 'signin')
  // One address signed in to two agents is two chairs with one name. Only
  // there does a row say whose chair it is; the mark says it everywhere else.
  const shared = new Set(
    chairs.map((seat) => seat.name).filter((name, index, names) => names.indexOf(name) !== index),
  )

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
      <Dot
        state={here?.state ?? 'available'}
        role="img"
        aria-label={here ? `${agentName}: ${READINESS_LABEL[here.state]}` : 'No agent'}
      />
    </>
  )

  return (
    <Bar rule="top" ref={accountRef}>
      <Popover
        title={here ? `New sessions run as ${nextAs}` : 'Accounts and settings'}
        /* Opens upward from the footer and stays inside the sidebar, the row's
           own width: the menu belongs to this row, not to the transcript it
           would otherwise be laid over. */
        side="top"
        sideAlign="start"
        sideOffset={6}
        fullWidth
        panelWidth="trigger"
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
            {(accountsOpen ? chairs : here ? [here] : chairs).map((seat) => (
              <MenuItem
                key={seat.key}
                layout="account"
                /* One line a seat. The name is the account's own — yours, or
                   the address it was signed in with — so the identity under
                   it only said it again; it is here, and whole on the mark's
                   card. */
                title={seat.sub}
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
              >
                {/* The seat's own mark is the trigger, and — like every other
                    one — it is out of the tab order. An earlier version of
                    this comment claimed the card opened on keyboard focus
                    here; review checked, and it does not. It could not: the
                    trigger is `tabIndex={-1}`, and its parent is a
                    `role="menuitem"` that owns the arrow keys. Making the span
                    focusable would put a second stop inside a menu item, which
                    is worse than the card being pointer-only. The seat's own
                    press still does the thing the card's verb does. */}
                <AccountHoverCard
                  info={seat.info}
                  account={seat.account}
                  side="right"
                  align="start"
                  className={styles.seatTrigger}
                  /* The same verbs as the badge's card on the row below: two
                     cards for one account that offered different things were
                     the whole of the complaint. The menu's Dashboard row opens
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
                <span className={styles.seatText}>
                  <Text role="navigation" fade className={styles.seatName}>
                    {seat.name}
                    {shared.has(seat.name) && (
                      <Text role="meta" className={styles.seatAgent}>
                        {brandOf(seat.info.presentation.name)}
                      </Text>
                    )}
                  </Text>
                </span>
                {/* What is left, where it is measured; otherwise the one word
                    that is wrong. A ready seat with nothing metered says
                    nothing. */}
                {seat.figure ? (
                  <Text role="muted" tone={usageReadingTone(seat.tone)} numeric className={styles.seatFigure}>
                    {seat.figure}
                  </Text>
                ) : seat.state !== 'ready' && seat.state !== 'available' ? (
                  <Text role="meta" tone={readinessTone(seat.state)} className={styles.seatFigure}>
                    {READINESS_LABEL[seat.state]}
                  </Text>
                ) : null}
              </MenuItem>
            ))}
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
                    <div className={styles.usageLane} key={lane.id}>
                      <Text role="muted" truncate className={styles.usageLaneName}>{lane.title}</Text>
                      <Text role="muted" tone={usageReadingTone(lane.tone)} numeric className={styles.accountMenuMeta}>
                        {lane.remainingPercent === null ? '—' : `${lane.remainingPercent}%`}
                      </Text>
                      <Text role="meta" numeric className={styles.usageLaneReset}>
                        {lane.shortCountdown ? `in ${lane.shortCountdown}` : '—'}
                      </Text>
                    </div>
                  ))}
                </div>
                {/* No link to the dashboard here: Dashboard is the row below,
                    and a second door to it, indented under the fold, was one
                    row and one ragged edge for nothing. */}
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
