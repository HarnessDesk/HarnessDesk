import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { allItems, currentTurn, isBusy, type RuntimeId, type Session } from '@harnessdesk/protocol'

import {
  useActiveSession,
  usePane,
  useRuntime,
  useRuntimeAccount,
  useRuntimeHealth,
  useSessionKey,
  useSnapshot,
  useStore,
} from '../state/context'
import { shownView, terminals } from '../state/workbench'
import { summonable } from '../panels/views'
import { Slot } from '../slots/registry'
import { Composer } from './Composer'
import {
  BranchIcon,
  CheckIcon,
  CommitIcon,
  CompactIcon,
  CrossIcon,
  DiffIcon,
  HistoryIcon,
  HomeIcon,
  LocalIcon,
  FolderIcon,
  MoreIcon,
  ReviewIcon,
  GlobeIcon,
  TerminalIcon,
  TrashIcon,
  UndoIcon,
} from './Icons'
import { Menu, MenuItem, MenuLabel, Submenu } from './Menu'
import { Popover, popoverStyles } from './Popover'
import { Badge } from '../design/ui/badge'
import { STATUS_LABEL, paneStatus } from '../lib/pane-status'
import { splitTurn } from '../lib/turn-view'
import { ItemView } from './Items'
import { BranchSwitcher } from './BranchSwitcher'
import { TurnFiles } from './TurnFiles'
import { TurnWork } from './TurnWork'
import { GoalBar, JobsBar } from './SessionBars'
import { splitTasks, tasksChipLabel } from '../lib/tasks'
import { MessageQueue } from './MessageQueue'
import { RemoveWorktree } from './RemoveWorktree'
import { BringHome } from './BringHome'
import { SetupDesk } from './SetupDesk'
import { TurnTail } from './TurnTail'
import { describeLimits } from '../lib/limits'
import { sessionLabel } from '../lib/sessions'
import { PlanMeters } from './PlanMeters'
import { WindowControls } from './WindowControls'
import styles from './Conversation.module.css'

/**
 * The transcript.
 *
 * Auto-scroll follows the tail only while the user is already at the bottom;
 * scrolling up to read must not be yanked away by a streaming token, which is
 * the single most irritating failure mode in a chat UI.
 */

const NEAR_BOTTOM_PX = 120

const EmptyState = ({
  onSignIn,
  onOpenAgents,
}: {
  onSignIn: (runtime?: RuntimeId) => void
  onOpenAgents: () => void
}) => {
  const snapshot = useSnapshot()
  const runtime = useRuntime()
  // This pane's agent's own health and account. The singular slots are the
  // default agent's, and a member column on another agent read them under
  // its own name once the default could differ from the pane's.
  const health = useRuntimeHealth()
  const account = useRuntimeAccount()
  const words = runtime.presentation
  /* A conversation that exists already has its folder. Telling its reader to
     pick one — which a room column did for a member with no turns yet — is a
     draft's sentence in the wrong pane. */
  const session = useActiveSession()
  const folder = session?.cwd ? (session.cwd.split('/').filter(Boolean).pop() ?? null) : null

  if (health && health.state === 'unavailable') {
    // Not just this agent's bad news: the whole desk, surveyed, with the one
    // next move per agent. A dead agent's empty pane is exactly where the
    // user is standing when they need to know what else would work.
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>{words.name} isn’t available</div>
        <p className={styles.emptyBody}>
          {health.message}
          {health.remediation ? ` ${health.remediation}` : ''}
        </p>
        <SetupDesk onSignIn={onSignIn} onOpenAgents={onOpenAgents} />
      </div>
    )
  }

  // Only meaningful for a runtime that has an account at all. A local model has
  // nothing to sign in to, and saying otherwise would be nonsense.
  if (runtime.capabilities.account && account && account.accounts.length === 0) {
    const driveable = account.signInMethods.some((method) => method.flow !== 'external')
    const external = account.signInMethods.find((method) => method.flow === 'external')
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>Sign in to {words.name}</div>
        <p className={styles.emptyBody}>
          HarnessDesk uses your existing {words.name} installation and never stores your
          credentials.
        </p>
        {driveable ? (
          /* This pane's agent, by name: an empty member column on another
             agent must not open the default's sign-in. */
          <button type="button" className={styles.emptyAction} onClick={() => onSignIn(runtime.id)}>
            Sign in
          </button>
        ) : (
          <p className={styles.emptyBody}>
            {external?.description ??
              (words.signIn?.command
                ? `Run ${words.signIn.command} in a terminal; this window updates on its own.`
                : `Sign in to ${words.name}; this window updates on its own.`)}
          </p>
        )}
      </div>
    )
  }

  // Plan windows are read for the default agent only, so a pane on another
  // agent says nothing here rather than the wrong agent's allowance.
  const blocked =
    runtime.capabilities.metered && runtime.id === snapshot.activeRuntime
      ? describeLimits(snapshot.limits)?.blocked
      : null
  if (blocked) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>{blocked.title}</div>
        <p className={styles.emptyBody}>
          {words.name} is signed in and healthy. {blocked.detail}
        </p>
      </div>
    )
  }

  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>What should we build?</div>
      <p className={styles.emptyBody}>
        {folder
          ? `Describe what you want done in ${folder}.`
          : 'Pick a project folder and describe what you want done.'}
        {words.historySource
          ? ` Sessions you start in ${words.historySource} appear in the sidebar too.`
          : ''}
      </p>
      {snapshot.runtimes.length === 1 && (
        /* The one-agent desk is the first-run desk. Said here rather than
           left for settings to reveal: the other agents on this machine can
           join without anyone hand-editing a file. */
        <p className={styles.emptyBody}>
          {words.name} is the only agent here.{' '}
          <button type="button" className={styles.emptyLink} onClick={onOpenAgents}>
            Add another agent…
          </button>
        </p>
      )}
    </div>
  )
}

/**
 * The conversation-level actions a runtime offers beyond a turn: memory, undo,
 * compaction, review. Each item appears only when the runtime declares the
 * capability, so a backend without one shows a shorter menu rather than a
 * disabled row — and no item is keyed to a runtime id.
 */
const ConversationMenu = () => {
  const store = useStore()
  const runtime = useRuntime()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const capabilities = runtime.capabilities
  const [confirmUndo, setConfirmUndo] = useState(false)
  if (!session) return null
  const memoryOn = session.memory === true

  const pane = usePane()
  const several = snapshot.layout.root.kind === 'split'

  return (
    <Popover
      align="right"
      title="Conversation"
      label={<MoreIcon size={15} />}
    >
      {(close) => (
        <>
          {capabilities.memory && (
            <button
              type="button"
              className={popoverStyles.option}
              role="menuitemcheckbox"
              aria-checked={memoryOn}
              onClick={() => {
                void store.setMemoryMode(!memoryOn)
                close()
              }}
            >
              <span className={popoverStyles.optionCheck}>{memoryOn && <CheckIcon size={13} />}</span>
              <span className={popoverStyles.optionBody}>
                <span className={popoverStyles.optionLabel}>Remember this conversation</span>
                <span className={popoverStyles.optionHint}>
                  Let {runtime.presentation.name} carry what it learns here into new ones.
                </span>
              </span>
            </button>
          )}
          {capabilities.compaction && (
            <button
              type="button"
              className={popoverStyles.option}
              onClick={() => {
                void store.compact()
                close()
              }}
            >
              <span className={popoverStyles.optionIcon}>
                <CompactIcon size={13} />
              </span>
              <span className={popoverStyles.optionBody}>
                <span className={popoverStyles.optionLabel}>Compact now</span>
                <span className={popoverStyles.optionHint}>Summarise older turns to free up context.</span>
              </span>
            </button>
          )}
          {capabilities.undo &&
            (confirmUndo ? (
              <div className={popoverStyles.option} style={{ cursor: 'default', display: 'block' }}>
                <div className={popoverStyles.optionLabel}>Undo the last turn?</div>
                <div className={popoverStyles.optionHint} style={{ margin: '2px 0 6px' }}>
                  Drops it from history. Files it changed on disk are <strong>not</strong> reverted.
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className={styles.headerButton} onClick={() => setConfirmUndo(false)}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className={styles.headerButton}
                    data-active=""
                    onClick={() => {
                      void store.rollback(1)
                      setConfirmUndo(false)
                      close()
                    }}
                  >
                    Undo turn
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={popoverStyles.option}
                onClick={() => setConfirmUndo(true)}
              >
                <span className={popoverStyles.optionIcon}>
                  <UndoIcon size={13} />
                </span>
                <span className={popoverStyles.optionBody}>
                  <span className={popoverStyles.optionLabel}>Undo the last turn</span>
                  <span className={popoverStyles.optionHint}>History only — files are left as they are.</span>
                </span>
              </button>
            ))}
          {/* Every view of this conversation, so the panel's own tab row is
              not the only way to reach one — it cannot be seen until the panel
              is open. Changes is the exception: it belongs to the workspace
              chip beside this menu, which carries the file count with it, and
              a second copy here would be the same row twice in one header.

              The descriptions ride on hover rather than under each label: a
              view is one click away and one click back, so guessing wrong
              costs nothing, and three lines of prose under three names is
              what turned this group into a wall. */}
          <div className={popoverStyles.groupLabel}>View</div>
          {summonable()
            /* Changes is the exception: it belongs to the workspace chip beside
               this menu, which carries the file count with it, and a second
               copy here would be the same row twice in one header. */
            .filter((definition) => definition.menu === true && definition.kind !== 'changes')
            .map((definition) => {
              const Glyph = definition.icon
              const open = shownView(snapshot.workbench, definition.kind)
              return (
                <button
                  key={definition.kind}
                  type="button"
                  className={popoverStyles.option}
                  role="menuitemcheckbox"
                  aria-checked={open}
                  /* The description the comment above promises. It rode on a
                     `hint` in `Details`'s own table until this menu was
                     rebuilt from the registry, and then on nothing at all —
                     the sentence stayed in a file neither door read any
                     more. It is the view's own now. */
                  title={definition.hint}
                  onClick={() => {
                    store.showView(definition.kind)
                    close()
                  }}
                >
                  <span className={open ? popoverStyles.optionCheck : popoverStyles.optionIcon}>
                    {open ? <CheckIcon size={13} /> : <Glyph size={13} />}
                  </span>
                  <span className={popoverStyles.optionBody}>
                    <div className={popoverStyles.optionLabel}>
                      {definition.label}
                      {/* The view has something still going — a task in the
                          background. A dot on its door, so the menu says
                          there is something to look at before it is opened. */}
                      {definition.live?.(snapshot) === true && (
                        <span
                          className={popoverStyles.optionLive}
                          role="img"
                          aria-label="Something is still running"
                          title="Something is still running"
                        />
                      )}
                    </div>
                  </span>
                </button>
              )
            })}
          {pane && several && (
            <button
              type="button"
              className={popoverStyles.option}
              onClick={() => {
                store.closePane(pane.paneId)
                close()
              }}
            >
              <span className={popoverStyles.optionIcon}>
                <CrossIcon size={13} />
              </span>
              <span className={popoverStyles.optionBody}>
                <div className={popoverStyles.optionLabel}>Close this pane</div>
                <div className={popoverStyles.optionHint}>⌘W. The conversation stays in the sidebar.</div>
              </span>
            </button>
          )}
        </>
      )}
    </Popover>
  )
}

/**
 * The header's word on background work.
 *
 * A background task outlives the turn, and its panel is not always open —
 * so the header carries a chip while any are listed: a turning mark and the
 * count while something runs, a quiet count once everything has ended. It
 * sits with the status, because it states a fact about this conversation,
 * and pressing it summons the panel the way the ⋯ menu would. Nothing when
 * there is nothing: an agent without the concept never shows it.
 */
const TasksChip = () => {
  const store = useStore()
  const key = useSessionKey()
  const snapshot = useSnapshot()
  const tasks = key ? snapshot.tasks.get(key) : undefined
  if (!tasks || tasks.length === 0) return null
  const split = splitTasks(tasks)
  const live = split.running.length > 0
  const open = shownView(snapshot.workbench, 'tasks')
  return (
    <button
      type="button"
      className={`${styles.tasksChip} hd-no-drag`}
      data-testid="tasks-chip"
      {...(live ? { 'data-live': '' } : {})}
      aria-pressed={open}
      title={
        live
          ? 'Work that keeps going after the turn. Opens the Background tasks panel, with the output.'
          : 'Work that ran after a turn ended. Opens the Background tasks panel, with the output.'
      }
      onClick={() => store.showView('tasks')}
    >
      {live ? <span className={styles.tasksSpinner} aria-hidden="true" /> : <CheckIcon size={11} />}
      {tasksChipLabel(split)}
    </button>
  )
}

/**
 * The dock's on/off switch. One press opens a terminal beside the
 * conversation; the next puts the dock away — including the press that lands
 * while the first shell is still opening, which is what the second half of a
 * double click is. A second shell is the dock's own + tab; this button never
 * means "one more terminal", so no press of it can leave one behind.
 */
export const TerminalToggle = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [opening, setOpening] = useState(false)
  // Asked-for counts as on. Otherwise the press that arrives before the
  // runtime has answered reads the dock as empty and opens a second shell.
  const on = terminals(snapshot.workbench).length > 0 || opening
  return (
    <button
      type="button"
      className={`${styles.headerButton} hd-no-drag`}
      {...(on ? { 'data-active': '' } : {})}
      onClick={() => {
        if (on) {
          // Cancels a still-opening shell too: the store bumps the dock epoch,
          // and the terminal it was waiting on is closed as it arrives.
          setOpening(false)
          store.closeTerminalDock()
          return
        }
        setOpening(true)
        void store.openTerminal().finally(() => setOpening(false))
      }}
      title={
        on
          ? 'Close the terminal'
          : 'Open a terminal beside this conversation, in its directory and under its permissions'
      }
      aria-label={on ? 'Close terminal' : 'Open terminal'}
    >
      <TerminalIcon size={14} />
    </button>
  )
}

export const Conversation = ({
  onChooseProject,
  onSignIn,
  onOpenUsage,
  onOpenAgents,
}: {
  onChooseProject: () => void
  onSignIn: (runtime?: RuntimeId) => void
  onOpenUsage: (runtime: RuntimeId) => void
  onOpenAgents: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const key = useSessionKey()
  const pane = usePane()
  const scroll = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const status = paneStatus(session, snapshot.approvals, key)
  const worktree = session
    ? snapshot.worktrees.find((entry) => entry.managed && entry.path === session.cwd)
    : undefined
  const [removingWorktree, setRemovingWorktree] = useState(false)
  const [bringingHome, setBringingHome] = useState(false)
  const loading = key ? snapshot.loadingSessions.has(key) : false

  const items = useMemo(() => (session ? allItems(session) : []), [session])
  const busy = session ? isBusy(session) : false
  const live = session ? currentTurn(session) : undefined

  const onScroll = useCallback(() => {
    const element = scroll.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setPinned(distance < NEAR_BOTTOM_PX)
  }, [])

  // Layout effect so the jump happens in the same frame the content grows,
  // rather than as a visible lurch afterwards.
  useLayoutEffect(() => {
    if (!pinned) return
    const element = scroll.current
    if (element) element.scrollTop = element.scrollHeight
  }, [items, pinned, session?.id])

  // Switching sessions always starts at the bottom of the new transcript.
  useEffect(() => {
    setPinned(true)
  }, [session?.id])

  // The transcript scrolls behind the floating composer; its measured height
  // becomes the scroll padding, so the last message always clears it — even
  // as the textarea grows.
  const dockArea = useRef<HTMLDivElement>(null)
  const conversationRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dock = dockArea.current
    const rootElement = conversationRoot.current
    if (!dock || !rootElement) return
    const apply = (): void =>
      rootElement.style.setProperty('--composer-h', `${dock.offsetHeight}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [])

  const jumpToBottom = useCallback(() => {
    const element = scroll.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    setPinned(true)
  }, [])

  return (
    <div className={styles.conversation} ref={conversationRoot}>
      {/* Room for the macOS window buttons is not asked for here: the header
          leaves whatever `--titlebar-inset` says its box needs, which is
          the width of the buttons only when this header is the row actually
          under them. This used to test the collapsed sidebar and the platform
          itself, and that was wrong twice over — it indented this header when
          a tool pane was in the corner instead, and it left every other header
          in the app printing its title under the buttons. */}
      <header className={`${styles.header} hd-drag`}>
        {snapshot.sidebarCollapsed && <WindowControls />}
        <span className={styles.title}>{titleOf(session)}</span>
        {session && (
          <span className={`${styles.status} hd-no-drag`} data-status={status} title={STATUS_LABEL[status]}>
            <span className={styles.statusDot} />
            {status !== 'idle' && STATUS_LABEL[status]}
          </span>
        )}
        {session && <TasksChip />}
        <div className="hd-no-drag">
          <GitControl
            onRemoveWorktree={() => setRemovingWorktree(true)}
            onBringHome={() => setBringingHome(true)}
          />
        </div>
        {/* Empty when nothing is registered — and an empty box in a flex row
            still takes the row's gap, which left a hole in the header that
            looked like a control had failed to draw. */}
        <div className={`${styles.headerSlot} hd-no-drag`}>
          <Slot name="session.header" />
        </div>
        {/* What every signed-in plan has left. Ambient, so it sits with the
            status rather than with the buttons that do something. */}
        <PlanMeters onOpen={onOpenUsage} onSignIn={onSignIn} />
        {/* Everything to the left of this states a fact; everything to the
            right does something. Without the rule they ran together as one
            undifferentiated row of chrome. */}
        {pane && <span className={styles.headerRule} />}
        {pane && (
          <button
            type="button"
            className={`${styles.headerButton} hd-no-drag`}
            onClick={() => store.openBrowser()}
            title="Open the browser beside this conversation — the page agents' browser tools drive"
            aria-label="Open browser"
          >
            <GlobeIcon size={14} />
          </button>
        )}
        {pane && session && <TerminalToggle />}
        {session && <ConversationMenu />}
      </header>

      <div className={styles.body}>
        {loading && items.length === 0 ? (
          <div className={styles.loading}>
            <span className={styles.loadingSpinner} />
            Loading transcript…
          </div>
        ) : session && items.length > 0 ? (
          <div className={styles.scroll} ref={scroll} onScroll={onScroll}>
            {session.turns.map((turn, turnIndex) => {
              // The prompt, the work folded under how long it took, the
              // answer, then what changed on disk — the order a reader wants,
              // which is not the order the events arrived in.
              const view = splitTurn(turn)
              const streamingId =
                busy && turn.id === live?.id ? (turn.items[turn.items.length - 1]?.id ?? null) : null
              return (
                <div key={turn.id}>
                  {turnIndex > 0 && <div className={styles.turnDivider} />}
                  {view.prompt.map((item) => (
                    <ItemView key={item.id} item={item} root={session.cwd} sentAt={turn.startedAt ?? undefined} />
                  ))}
                  <TurnWork turn={turn} work={view.work} root={session.cwd} streamingItemId={streamingId} />
                  {view.answer.map((item) => (
                    <ItemView key={item.id} item={item} root={session.cwd} streaming={streamingId === item.id} />
                  ))}
                  {view.trailing.map((item) => (
                    <ItemView key={item.id} item={item} root={session.cwd} />
                  ))}
                  {view.changes.length > 0 && <TurnFiles turn={turn} changes={view.changes} root={session.cwd} />}
                  {turn.status !== 'inProgress' && (
                    <TurnTail
                      turn={turn}
                      session={session}
                      hideFiles={view.changes.length > 0}
                      answer={view.answer
                        .map((item) => (item.type === 'assistantMessage' ? item.text : ''))
                        .join('\n\n')}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : session && session.itemsLoaded && session.updatedAt > session.createdAt ? (
          // An existing conversation whose messages could not be restored —
          // an agent that keeps no serving store, with no host copy either.
          // The "what should we build?" pitch here would claim the
          // conversation never happened; a plain sentence tells the truth.
          //
          // A conversation that has never been *used* is the other case, and
          // it used to land here too: start a session and the first thing it
          // said was that the agent could not restore its messages, of which
          // there were none. Nothing failed — nothing has happened yet — so
          // the pitch below is the honest answer, and `updatedAt` moving past
          // `createdAt` is what separates the two.
          <div className={styles.scroll} ref={scroll} onScroll={onScroll}>
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>Nothing to show</div>
              <p className={styles.emptyBody}>
                {snapshot.runtimes.find((entry) => entry.id === session.runtime)?.presentation.name ?? 'The agent'}{' '}
                couldn’t restore this conversation’s messages. Sending a message continues the
                same session.
              </p>
            </div>
          </div>
        ) : (
          <div className={styles.scroll} ref={scroll} onScroll={onScroll}>
            <EmptyState onSignIn={onSignIn} onOpenAgents={onOpenAgents} />
          </div>
        )}

        {!pinned && items.length > 0 && (
          <button type="button" className={styles.jumpButton} onClick={jumpToBottom}>
            Jump to latest
          </button>
        )}
      </div>

      <div className={styles.dockArea} ref={dockArea}>
        {/* Stacked by lifetime, shortest first: the jobs strip goes when this
            turn does, the queue happens after it. That order puts the thing
            you can act on nearest the composer and the transcript's own
            narration nearest the transcript. Background tasks — the work that
            outlives the turn — are not a strip any more: they have a panel,
            summoned from the ⋯ menu, and the header wears a chip while any
            are listed. */}
        <div className={styles.bars}>
          <JobsBar />
          <GoalBar />
          <MessageQueue />
        </div>
        <Composer onChooseProject={onChooseProject} />
      </div>
      {removingWorktree && worktree && (
        <RemoveWorktree worktree={worktree} onClose={() => setRemovingWorktree(false)} />
      )}
      {bringingHome && worktree && <BringHome worktree={worktree} onClose={() => setBringingHome(false)} />}
    </div>
  )
}

/**
 * Where this conversation works — the repository's folder and branch — and
 * what git has to say about it, in one control, the way Codex puts it. The
 * label is the branch; the menu opens the Changes panel, shows the folder,
 * and offers the git actions a turn tends to end with. A draft shows the
 * workspace it will start in; *choosing* somewhere else — a worktree — is
 * the composer's Work in control, because that is a decision about the
 * message being written, not a fact about a conversation that exists.
 *
 * Exported for its own test (`Conversation.git.test.tsx`); nothing else
 * mounts it.
 */
export const GitControl = ({
  onRemoveWorktree,
  onBringHome,
}: {
  onRemoveWorktree: () => void
  onBringHome: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const runtime = useRuntime()
  // A draft pointed at a worktree will start there, so that is where this
  // says it works — this chip and the composer's Work in control must never
  // name two folders for one draft.
  const pointed = !session && snapshot.draftPlace?.kind === 'existing' ? snapshot.draftPlace.path : null
  const cwd = session?.cwd ?? pointed ?? snapshot.workspace?.path ?? null
  if (!cwd) return null
  const folder = cwd.split('/').filter(Boolean).at(-1) ?? cwd
  // The workspace's branch is read fresh by the host and follows a switch;
  // the session's is what the runtime recorded when the thread began. ACP
  // agents report no git at all, so the workspace is the usual source —
  // and for a conversation in a worktree, the repository's own list of its
  // checkouts, without which that chip named the folder rather than the
  // branch the worktree is on.
  const checkout = snapshot.worktrees.find((entry) => entry.path === cwd)
  const branch =
    (cwd === snapshot.workspace?.path ? snapshot.workspace?.git?.branch ?? null : null) ??
    checkout?.branch ??
    session?.git?.branch ??
    null
  const worktree = session ? snapshot.worktrees.find((entry) => entry.managed && entry.path === session.cwd) : undefined
  // The tag says what the folder *is*, and a linked checkout the person made
  // themselves is as much a worktree as one HarnessDesk cut — only the verbs
  // below (bring it back, remove it) are limited to HarnessDesk's own.
  const summary = session
    ? snapshot.history.find((entry) => entry.runtime === session.runtime && entry.id === session.id)
    : undefined
  const linked =
    Boolean(worktree) ||
    (checkout !== undefined && !checkout.isMain) ||
    (cwd === snapshot.workspace?.path ? snapshot.workspace?.repo?.worktree === true : summary?.repo?.worktree === true)
  const touched = session
    ? new Set(
        session.turns
          .flatMap((turn) => turn.items)
          .flatMap((item) =>
            item.type === 'fileChange'
              ? item.changes.map((change) => change.path)
              : item.type === 'toolCall' && typeof item.args === 'object' && item.args !== null
                ? [(item.args as Record<string, unknown>)['file_path']].filter((value): value is string => typeof value === 'string')
                : [],
          ),
      ).size
    : 0

  return (
    <Popover
      title={`${linked ? 'Worktree' : 'Local'} — ${cwd}`}
      align="right"
      label={
        <>
          {/* The glyph says where, so it can stand alone when a narrow header
              folds the words away: a branch for a worktree, a laptop for the
              main checkout, a folder for one that is not a repository. */}
          {linked ? <BranchIcon size={13} /> : branch ? <LocalIcon size={13} /> : <FolderIcon size={13} />}
          <span className={styles.gitWords}>
            <span className={styles.gitLabel}>{branch ?? folder}</span>
            {linked && (
              <Badge variant="secondary" className={styles.gitBadge}>
                worktree
              </Badge>
            )}
          </span>
        </>
      }
    >
      {(close) => (
        <Menu close={close}>
          <MenuLabel>{folder}</MenuLabel>
          {session && (
            <MenuItem
              icon={<DiffIcon size={16} />}
              label={`Changes${touched > 0 ? ` · ${touched} file${touched === 1 ? '' : 's'}` : ''}`}
              title="What this conversation edited, as diffs."
              onSelect={() => store.setDetailsTab('changes')}
            />
          )}
          <MenuItem
            icon={<HistoryIcon size={16} />}
            label="History"
            title="The repository's commits, branches and tags, in a pane."
            onSelect={() => store.openGitHistory(cwd)}
          />
          {/* The branch is one row, and the branches are behind it — Codex
              hangs its list off the branch rather than repeating it as a
              heading over a second list of the same names. */}
          {branch ? (
            <Submenu icon={<BranchIcon size={16} />} label={branch} width={340}>
              <BranchSwitcher root={cwd} onDone={close} />
            </Submenu>
          ) : (
            <MenuItem icon={<BranchIcon size={16} />} label="Not a git branch" disabled={cwd} onSelect={() => {}} />
          )}
          {worktree?.branch && (
            <MenuItem
              icon={<HomeIcon size={16} />}
              label="Bring it back to the main checkout…"
              title="Checks its branch out in the main checkout; the worktree's folder goes."
              onSelect={onBringHome}
            />
          )}
          {worktree && (
            <MenuItem
              icon={<TrashIcon size={16} />}
              label="Remove this worktree…"
              title="Lists what would be lost first. The branch stays."
              onSelect={onRemoveWorktree}
            />
          )}
          {session && runtime.capabilities.review && (
            <MenuItem
              icon={<ReviewIcon size={16} />}
              label="Review uncommitted changes"
              title="On a side thread, leaving this one as it is."
              onSelect={() => void store.review({ type: 'uncommitted', delivery: 'detached' })}
            />
          )}
          {session && (
            <MenuItem
              icon={<CommitIcon size={16} />}
              label="Commit the changes"
              title="Asks the agent, in this conversation; you send it."
              onSelect={() =>
                window.dispatchEvent(
                  new CustomEvent('harnessdesk:compose', {
                    detail:
                      'Commit the changes from this conversation with a clear message, then tell me the commit hash.',
                  }),
                )
              }
            />
          )}
        </Menu>
      )}
    </Popover>
  )
}

/**
 * What the header calls the conversation. A fresh session has no stored
 * preview until the list is re-read, so the first thing the user wrote stands
 * in — the same line the sidebar shows — rather than "New session" for the
 * whole first turn.
 */
const titleOf = (session: Session | null): string => {
  if (!session) return 'New session'
  const firstMessage = session.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === 'userMessage')
  const spoken =
    firstMessage?.type === 'userMessage'
      ? firstMessage.content
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('\n')
      : null
  const label = sessionLabel(session.title, session.preview ?? spoken, 'New session')
  // A first message is a paragraph; a title is a line.
  return label.length > 72 ? `${label.slice(0, 71).trimEnd()}…` : label
}
