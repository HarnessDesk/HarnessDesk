import { useCallback, useEffect, useRef, useState } from 'react'

import type { Account, RuntimeId, RuntimeInfo } from '@harnessdesk/protocol'
import { useRuntime, useSnapshot, useStore } from '../state/context'
import { Slot } from '../slots/registry'
import { BranchIcon, CheckIcon, FilterIcon, PluginIcon, PlusIcon, SearchIcon, SettingsIcon, SignOutIcon, UsageIcon } from './Icons'
import { WindowControls } from './WindowControls'
import { NewSessionChoice } from './NewSessionChoice'
import { SessionListControls, SessionTree } from './SessionTree'
// Imported for its side effect: the Tasks panel registers itself into the
// `sidebar.panel` slot rendered below.
import './TaskPanel'
import { Menu, MenuItem, MenuLabel } from './Menu'
import { Popover } from './Popover'
import { accountKey, accountName, accountIdentity, tintOf } from '../lib/accounts'
import { folderName } from '../lib/projects'
import { brandOf } from '../lib/identity'
import { READINESS_LABEL, readinessOf, type Readiness } from '../lib/readiness'
import { livePlugins } from '../lib/plugins'
import { AccountHoverCard } from './AgentCards'
import { HarnessMark, RuntimeMark } from './BrandIcons'
import { bindingLane, describeReport, isBlocked } from '../lib/usage'
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
  onOpenUsage,
  onBrowseFolders,
  onSignIn,
  onSearch,
}: {
  onOpenSettings: () => void
  onOpenPlugins: () => void
  onOpenUsage: () => void
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
  const ready = snapshot.health?.state === 'ready'
  // Not `plugins.length`: an installed copy a built-in has taken over is off,
  // and counting it here made the sidebar promise one more than the page lists.
  const pluginCount = livePlugins(snapshot.plugins).length

  return (
    <div className={styles.sidebar}>
      <div className={`${styles.titlebar} hd-drag`}>
        <WindowControls />
      </div>

      {/* The magnifier is search, not filtering: it opens the palette over
          everything — sessions, files, agents, commands — which is what a
          magnifier at the top of a window promises. Narrowing the list is the
          Workspaces row's job, down where the list is. */}
      <div className={styles.header}>
        <span className={styles.brandMark} aria-hidden>
          <HarnessMark size={14} />
        </span>
        <span className={styles.workspaceName} title={snapshot.workspace?.path ?? undefined}>
          HarnessDesk
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={`${styles.iconButton} hd-no-drag`}
          onClick={onSearch}
          title="Search sessions, files, agents and commands (⌘K)"
          aria-label="Search everything"
        >
          <SearchIcon size={13} />
        </button>
      </div>

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
      <nav className={styles.nav} aria-label="Workspace actions">
        <div className={styles.navRow}>
          <button
            type="button"
            className={styles.navItem}
            disabled={!ready || !snapshot.workspace}
            /* Asks which kind of work this is; ⌘N and the palette still go
               straight to a session. See `NewSessionChoice`. */
            onClick={() => setStarting(true)}
            title="Start one agent, or a room for several."
          >
            <PlusIcon size={15} className={styles.navIcon} />
            New session
          </button>
          <WorktreeMenu />
        </div>
        <button type="button" className={styles.navItem} onClick={onOpenUsage}>
          <UsageIcon size={15} className={styles.navIcon} />
          Dashboard
          {/* The count is the number of agents that need attention, not the
              number that report — a badge for "everything is fine" is noise. */}
          {lowAgents > 0 && (
            <span className={styles.navCount} data-tone="warn">
              {lowAgents}
            </span>
          )}
        </button>
        <button type="button" className={styles.navItem} onClick={onOpenPlugins}>
          <PluginIcon size={15} className={styles.navIcon} />
          Plugins
          {pluginCount > 0 && (
            <span className={styles.navCount}>{pluginCount}</span>
          )}
        </button>
      </nav>

      {/* The list's own row: what the list is, the field that narrows it, and
          the two things you do to it. It sits outside the scroller so that
          filtering stays one click away however far down the list you are. */}
      <div className={styles.sectionLabel} {...(filtering ? { 'data-filtering': '' } : {})}>
        <span className={styles.sectionTitle}>Workspaces</span>
        <div className={styles.filter}>
          <FilterIcon className={styles.filterIcon} size={12} />
          <input
            className={styles.filterInput}
            placeholder={filtering ? 'Filter sessions' : ''}
            aria-label="Filter sessions"
            title="Narrow the list below. ⌘K searches everything."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setFilterFocused(true)}
            onBlur={() => setFilterFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('')
                event.currentTarget.blur()
              }
            }}
            spellCheck={false}
          />
        </div>
        <SessionListControls />
        <button
          type="button"
          className={styles.iconButton}
          onClick={onBrowseFolders}
          title="Open a project folder"
          aria-label="Open a project folder"
        >
          <PlusIcon size={13} />
        </button>
      </div>

      <div className={styles.list} ref={listRef} onScroll={onScroll}>
        {snapshot.history.length === 0 && !snapshot.historyLoading && (
          <p className={styles.empty}>
            {ready
              ? `No sessions yet. Start one to see it here${
                  runtime.presentation.historySource
                    ? ` — sessions you run in ${runtime.presentation.historySource} show up too`
                    : ''
                }.`
              : 'Connect a runtime to see your sessions.'}
          </p>
        )}
        <SessionTree now={now} />
      </div>

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
 * for the next chat, the project's context menu makes a permanent one. There
 * is no composer to hang the first off here until a conversation exists, and
 * the sidebar is where a person looks for "my other checkouts", so both live
 * on this one control.
 *
 * It stays visible in a folder that is not a repository, disabled and saying
 * why. A control that vanishes teaches nobody what it was.
 */
const WorktreeMenu = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const ready = snapshot.health?.state === 'ready'
  const isRepo = Boolean(snapshot.workspace?.git?.branch)
  const active = snapshot.activeSessionKey ? snapshot.sessions.get(snapshot.activeSessionKey) : undefined
  const mine = snapshot.worktrees.filter((entry) => entry.managed)

  if (!isRepo || !ready) {
    return (
      <button
        type="button"
        className={styles.navSecondary}
        disabled
        title={
          isRepo
            ? 'Connect an agent to work in a worktree.'
            : 'Worktrees need a git repository. This folder is not one.'
        }
        aria-label="Worktrees"
      >
        <BranchIcon size={14} />
      </button>
    )
  }

  return (
    <Popover
      title="Worktrees of this project"
      drop="down"
      align="right"
      triggerClassName={styles.navSecondary}
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
              <MenuLabel>Open one</MenuLabel>
              {mine.map((worktree) => (
                <MenuItem
                  key={worktree.path}
                  icon={<BranchIcon size={14} />}
                  label={worktree.branch ?? '(detached)'}
                  title={worktree.path}
                  value={active?.cwd === worktree.path ? 'here' : undefined}
                  onSelect={() => void store.newSession({ cwd: worktree.path })}
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
}

export const AccountFooter = ({
  onOpenSettings,
  onOpenUsage,
  onSignIn,
}: {
  onOpenSettings: () => void
  onOpenUsage: () => void
  /** Opens the sign-in screen, on one runtime when the caller knows which. */
  onSignIn: (runtime?: RuntimeId) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  // Outside every pane, so this is the default agent — the one ⌘N starts —
  // and not the focused conversation's.
  const runtime = useRuntime()
  const [open, setOpen] = useState(false)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) {
        setOpen(false)
        setConfirmingSignOut(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setConfirmingSignOut(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const seats: Seat[] = snapshot.runtimes.flatMap((info): Seat[] => {
    const status = snapshot.accountsByRuntime[info.id] ?? null
    const usage = snapshot.usage.filter((report) => report.runtime === info.id)
    const state = readinessOf({
      registered: true,
      // Every seat's own health: a dead agent used to sit here looking
      // normal unless it happened to be the active one.
      health: snapshot.healthByRuntime[info.id] ?? null,
      account: status,
      usage,
    })
    const report = usage[0] ?? null
    const view = report ? describeReport(report, { now: Date.now(), maxLanes: 1 }) : null
    const lane = view?.hero ?? null
    const figure =
      lane && lane.known && lane.remainingPercent !== null ? `${lane.remainingPercent}%` : null
    const tone = view?.blocked ? ('bad' as const) : (lane?.tone ?? ('good' as const))
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
          figure,
          tone,
          current,
        },
      ]
    }
    return accounts.map((account) => {
      const key = accountKey(info.id, account)
      return {
        key,
        info,
        account,
        name: accountName(account, snapshot.accountPrefs[key]),
        sub: accountIdentity(account) || info.presentation.name,
        state,
        figure,
        tone,
        current,
      }
    })
  })

  // The default agent's seat — its account, or its empty chair. Null only
  // with no agents at all, when the row is just the desk.
  const here = seats.find((seat) => seat.current) ?? null
  const signedIn = here?.account !== null && here?.account !== undefined
  const agentName = brandOf(runtime.presentation.name)
  const nextAs = here?.account ? `${agentName} · ${here.name}` : agentName

  const signOut = async (): Promise<void> => {
    if (!snapshot.activeRuntime) return
    setBusy(true)
    try {
      await store.signOutAgent(snapshot.activeRuntime)
      setOpen(false)
      setConfirmingSignOut(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.account} ref={wrap}>
      {open && (
        <div className={styles.accountMenu} role="menu">
          {/* The seat a HarnessDesk account would take. There is no such
              account yet, and a sign-in button for one would be a lie — so
              this says what is actually true of the app today. */}
          <div className={styles.menuSection}>
            <div className={styles.you} title="Nothing syncs between machines.">
              <span className={styles.youAvatar}>
                <HarnessMark size={13} />
              </span>
              <span className={styles.youText}>
                <span className={styles.youName}>
                  HarnessDesk
                  <span className={styles.youTag}>Local</span>
                </span>
              </span>
            </div>
          </div>

          <div className={styles.menuSection}>
            <div className={styles.menuLabel}>Run new sessions as</div>
            {seats.map((seat) => (
              <button
                key={seat.key}
                type="button"
                role="menuitem"
                className={styles.seat}
                {...(seat.current ? { 'data-current': '' } : {})}
                onClick={() => {
                  setOpen(false)
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
                >
                  <span
                    className={styles.seatAvatar}
                    data-tint={tintOf(seat.key, snapshot.accountPrefs)}
                  >
                    <RuntimeMark runtime={seat.info} size={13} />
                  </span>
                </AccountHoverCard>
                <span className={styles.seatText}>
                  <span className={styles.seatName}>{seat.name}</span>
                  <span className={styles.seatSub} data-state={seat.state}>
                    {seat.sub}
                  </span>
                </span>
                {seat.figure && (
                  <span className={styles.seatFigure} data-tone={seat.tone}>
                    {seat.figure}
                  </span>
                )}
                <span className={styles.seatTick}>
                  {seat.current ? <CheckIcon size={14} /> : null}
                </span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className={styles.accountMenuRow}
              onClick={() => {
                setOpen(false)
                // Opens the chooser rather than adding one here. "An account"
                // does not mean "another of this one": the agent is the first
                // question, and only picking one that is already connected
                // means a second credential home — which the sign-in screen
                // asks for explicitly, so a stray click cannot leave one
                // behind.
                onSignIn()
              }}
            >
              <span className={styles.accountMenuAction}>
                <PlusIcon size={13} />
                Add an account…
              </span>
            </button>
          </div>

          <div className={styles.menuSection}>
            <button
              type="button"
              role="menuitem"
              className={styles.accountMenuRow}
              onClick={() => {
                setOpen(false)
                onOpenSettings()
              }}
            >
              <span className={styles.accountMenuAction}>
                <SettingsIcon size={13} />
                Settings
              </span>
              <span className={styles.accountMenuMeta}>⌘,</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.accountMenuRow}
              onClick={() => {
                setOpen(false)
                onOpenUsage()
              }}
            >
              <span className={styles.accountMenuAction}>
                <UsageIcon size={13} />
                Dashboard
              </span>
              <span className={styles.accountMenuMeta}>⌘U</span>
            </button>
            {signedIn && !confirmingSignOut && (
              <button
                type="button"
                role="menuitem"
                className={`${styles.accountMenuRow} ${styles.accountMenuDanger}`}
                onClick={() => setConfirmingSignOut(true)}
              >
                <span className={styles.accountMenuAction}>
                  <SignOutIcon size={13} />
                  Sign out of {agentName}…
                </span>
              </button>
            )}
            {confirmingSignOut && (
              <div className={styles.accountMenuConfirm}>
                <div className={styles.accountMenuConfirmText}>
                  Sign out of {agentName}? You'll need to sign in again before the next turn.
                </div>
                <div className={styles.accountMenuConfirmActions}>
                  <button
                    type="button"
                    className={styles.accountMenuButton}
                    disabled={busy}
                    onClick={() => setConfirmingSignOut(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`${styles.accountMenuButton} ${styles.accountMenuButtonDanger}`}
                    disabled={busy}
                    onClick={() => void signOut()}
                  >
                    {busy ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        className={styles.accountRow}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(here ? { title: `New sessions run as ${nextAs}` } : {})}
        {...(open ? { 'data-open': '' } : {})}
        onClick={() => {
          setOpen((value) => !value)
          setConfirmingSignOut(false)
        }}
      >
        {/* You. The same drawing as the menu's top row, at the row's size. */}
        <span className={styles.avatar}>
          <HarnessMark size={11} />
        </span>
        <span className={styles.accountName}>HarnessDesk</span>
        {here?.figure && here.tone !== 'good' && (
          <span className={styles.accountMeta} data-tone={here.tone}>
            {here.figure}
          </span>
        )}
        {/* The pen: the default agent's mark in its account's ring — the
            same disc the menu's seats wear — and the name card on it says
            which account, on what plan, with how much left. The ring goes
            dark for a seat nobody has signed in to. */}
        {here && (
          <AccountHoverCard
            info={here.info}
            account={here.account}
            side="right"
            align="end"
            className={styles.seatTrigger}
            onOpenUsage={() => onOpenUsage()}
          >
            <span
              className={styles.seatAvatar}
              {...(signedIn
                ? { 'data-tint': tintOf(here.key, snapshot.accountPrefs) }
                : { 'data-off': '' })}
            >
              <RuntimeMark runtime={here.info} size={13} />
            </span>
          </AccountHoverCard>
        )}
        <span
          className={styles.statusDot}
          data-state={here?.state ?? 'unknown'}
          role="img"
          aria-label={here ? `${agentName}: ${READINESS_LABEL[here.state]}` : 'No agent'}
        />
      </button>
    </div>
  )
}
