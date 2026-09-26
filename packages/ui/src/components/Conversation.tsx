import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

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
import { findPane } from '../state/layout'
import { shownView, sidebarPlacement, terminals } from '../state/workbench'
import { summonable } from '../panels/views'
import { Slot } from '../slots/registry'
import { Composer } from './Composer'
import {
  BranchIcon,
  BriefIcon,
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
  NewWorktreeIcon,
} from './Icons'
import { worktreeBranch } from '../lib/worktree-branch'
import {
  Bar,
  Button,
  Chip,
  ConversationEmptyState,
  Menu,
  MenuItem,
  MenuLabel,
  Popover,
  PopoverGroupLabel,
  PopoverOption,
  PopoverOptionBody,
  PopoverOptionHint,
  PopoverOptionLabel,
  PopoverOptionLive,
  PopoverOptionMark,
  Separator,
  Spinner,
  Submenu,
  Text,
  ToolPaneHeaderDivider,
  dotTone,
  type Tone,
} from '../design'
import { Badge } from '../design'
import { STATUS_LABEL, paneStatus, type PaneStatus } from '../lib/pane-status'
import { splitTurn } from '../lib/turn-view'
import { ItemView } from './Items'
import { BranchSwitcher } from './BranchSwitcher'
import { TurnFiles } from './TurnFiles'
import { TurnWork } from './TurnWork'
import { GoalBar, JobsBar } from './SessionBars'
import { splitTasks, tasksChipLabel } from '../lib/tasks'
import { ConversationMap } from './ConversationMap'
import { MessageQueue } from './MessageQueue'
import { RemoveWorktree } from './RemoveWorktree'
import { BringHome } from './BringHome'
import { FolderGone } from './FolderGone'
import { FrontDoor } from './FrontDoor'
import { SetupDesk } from './SetupDesk'
import { TurnTail } from './TurnTail'
import { describeLimits } from '../lib/limits'
import { sessionLabel } from '../lib/sessions'
import { ledBy } from '../lib/agents'
import { useSeatAgent } from '../state/seat-agent'
import { PlanMeters } from './PlanMeters'
import { WindowControls } from './WindowControls'
import { SaveAsAgentDialog } from './SaveAsAgent'
import styles from './Conversation.module.css'

/** Scroll padding: top clears the notice banner, sides set the reading column's
 *  gutter (matching what the scrollbar-gutter reserves), bottom clears the
 *  floating composer. No shared scroll or column part owns this exact mix —
 *  the notice inset and the composer's own measured height are this pane's,
 *  and TeamRoomPane already zeroes the first rather than duplicate it. */
const SCROLL_PADDING = 'calc(8px + var(--hd-notice-inset, 0px)) 24px calc(var(--composer-h, 150px) + 16px)'
/** The strip above the composer, inset to the same gutter ComposerDock uses —
 *  but ComposerDock also carries its own bottom padding for the composer box
 *  it wraps, which this strip must not add above it, so it stays its own. */
const BARS_PADDING = '0 calc(24px + var(--hd-scrollbar-width, 8px))'

/** An empty-state title, in the page role at its own weight. */
const EmptyTitle = ({ children }: { children: ReactNode }) => (
  <Text as="div" role="page" weight="medium">
    {children}
  </Text>
)
/** An empty-state sentence, in the reading role. */
const EmptyBody = ({ children }: { children: ReactNode }) => (
  <Text as="p" role="prose" className="m-0 max-w-[460px]">
    {children}
  </Text>
)

/** The dot's own tone: brand while a turn is running, so the one moving mark
    is the one that says so. */
const STATUS_TONE: Record<PaneStatus, Tone> = {
  running: 'brand',
  waiting: 'warning',
  failed: 'danger',
  idle: 'neutral',
}

/**
 * The pill's own ground — its own judgement, not the dot's.
 *
 * Running is the most common live state, so its pill stays the neutral tone
 * idle already wears; only the dot inside it turns brand. A pill that also
 * went brand while running left the header shouting through most of a turn,
 * and named only "failed" as worth a colour of its own.
 */
const STATUS_PILL_TONE: Record<PaneStatus, Tone> = {
  running: 'neutral',
  waiting: 'warning',
  failed: 'danger',
  idle: 'neutral',
}

/**
 * The transcript.
 *
 * Auto-scroll follows the tail only while the user is already at the bottom;
 * scrolling up to read must not be yanked away by a streaming token, which is
 * the single most irritating failure mode in a chat UI.
 */

const NEAR_BOTTOM_PX = 120

const ConversationEmpty = ({
  onSignIn,
  onOpenRuntimes,
}: {
  onSignIn: (runtime?: RuntimeId) => void
  onOpenRuntimes: () => void
}) => {
  const store = useStore()
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
  const [startingTeam, setStartingTeam] = useState(false)

  if (health && health.state === 'unavailable') {
    // Not just this agent's bad news: the whole desk, surveyed, with the one
    // next move per agent. A dead agent's empty pane is exactly where the
    // user is standing when they need to know what else would work.
    return (
      <ConversationEmptyState>
        <EmptyTitle>{words.name} isn’t available</EmptyTitle>
        <EmptyBody>
          {health.message}
          {health.remediation ? ` ${health.remediation}` : ''}
        </EmptyBody>
        <SetupDesk onSignIn={onSignIn} onOpenRuntimes={onOpenRuntimes} />
      </ConversationEmptyState>
    )
  }

  // Only meaningful for a runtime that has an account at all. A local model has
  // nothing to sign in to, and saying otherwise would be nonsense.
  if (runtime.capabilities.account && account && account.accounts.length === 0) {
    const driveable = account.signInMethods.some((method) => method.flow !== 'external')
    const external = account.signInMethods.find((method) => method.flow === 'external')
    return (
      <ConversationEmptyState>
        <EmptyTitle>Sign in to {words.name}</EmptyTitle>
        <EmptyBody>
          HarnessDesk uses your existing {words.name} installation and never stores your
          credentials.
        </EmptyBody>
        {driveable ? (
          /* This pane's agent, by name: an empty member column on another
             agent must not open the default's sign-in. */
          <Button type="button" variant="quiet" size="content" onClick={() => onSignIn(runtime.id)}>
            Sign in
          </Button>
        ) : (
          <EmptyBody>
            {external?.description ??
              (words.signIn?.command
                ? `Run ${words.signIn.command} in a terminal; this window updates on its own.`
                : `Sign in to ${words.name}; this window updates on its own.`)}
          </EmptyBody>
        )}
      </ConversationEmptyState>
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
      <ConversationEmptyState>
        <EmptyTitle>{blocked.title}</EmptyTitle>
        <EmptyBody>
          {words.name} is signed in and healthy. {blocked.detail}
        </EmptyBody>
      </ConversationEmptyState>
    )
  }

  return (
    <ConversationEmptyState>
      <EmptyTitle>What should we build?</EmptyTitle>
      <EmptyBody>
        {folder
          ? `Describe what you want done in ${folder}.`
          : 'Pick a project folder and describe what you want done.'}
        {words.historySource
          ? ` Sessions you start in ${words.historySource} appear in the sidebar too.`
          : ''}
      </EmptyBody>
      {/* This pane already knows its folder — the front door reads the same
          root. With none chosen yet there is no catalogue to read, so the
          text above stays the whole of the pitch; opening a folder is what
          the composer, ⌘O and the palette already offer. */}
      {session?.cwd && (
        <EmptyBody>
          <Button type="button" variant="link" size="content" onClick={() => setStartingTeam(true)}>
            Start with a team…
          </Button>{' '}
          to choose a shape this project ships instead.
        </EmptyBody>
      )}
      {snapshot.runtimes.length === 1 && (
        /* The one-agent desk is the first-run desk. Said here rather than
           left for settings to reveal: the other agents on this machine can
           join without anyone hand-editing a file. */
        <EmptyBody>
          {words.name} is the only runtime here.{' '}
          <Button type="button" variant="link" size="content" onClick={onOpenRuntimes}>
            Add another runtime…
          </Button>
        </EmptyBody>
      )}
      {startingTeam && session?.cwd && (
        <FrontDoor
          context={{ kind: 'project', root: session.cwd }}
          onClose={() => setStartingTeam(false)}
          onStarted={(execution) => {
            store.openGoal(execution.goal)
            setStartingTeam(false)
          }}
        />
      )}
    </ConversationEmptyState>
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
  const [saving, setSaving] = useState(false)
  if (!session) return null
  const memoryOn = session.memory === true

  const pane = usePane()
  const several = snapshot.layout.root.kind === 'split'

  return (
    <>
      <Popover
        align="right"
        title="Conversation"
        label={<MoreIcon size={15} />}
      >
        {(close) => (
          <>
          {capabilities.memory && (
            <PopoverOption
              role="menuitemcheckbox"
              aria-checked={memoryOn}
              onClick={() => {
                void store.setMemoryMode(!memoryOn)
                close()
              }}
            >
              <PopoverOptionMark checked>{memoryOn && <CheckIcon size={13} />}</PopoverOptionMark>
              <PopoverOptionBody>
                <PopoverOptionLabel>Remember this conversation</PopoverOptionLabel>
                <PopoverOptionHint>
                  Let {runtime.presentation.name} carry what it learns here into new ones.
                </PopoverOptionHint>
              </PopoverOptionBody>
            </PopoverOption>
          )}
          {capabilities.compaction && (
            <PopoverOption
              onClick={() => {
                void store.compact()
                close()
              }}
            >
              <PopoverOptionMark>
                <CompactIcon size={13} />
              </PopoverOptionMark>
              <PopoverOptionBody>
                <PopoverOptionLabel>Compact now</PopoverOptionLabel>
                <PopoverOptionHint>Summarise older turns to free up context.</PopoverOptionHint>
              </PopoverOptionBody>
            </PopoverOption>
          )}
          {capabilities.undo &&
            (confirmUndo ? (
              <PopoverOption as="div" style={{ cursor: 'default', display: 'block' }}>
                <PopoverOptionLabel>Undo the last turn?</PopoverOptionLabel>
                <PopoverOptionHint className="my-0.5 mb-1.5">
                  Drops it from history. Files it changed on disk are <strong>not</strong> reverted.
                </PopoverOptionHint>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmUndo(false)}>
                    Keep
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      void store.rollback(1)
                      setConfirmUndo(false)
                      close()
                    }}
                  >
                    Undo turn
                  </Button>
                </div>
              </PopoverOption>
            ) : (
              <PopoverOption
                onClick={() => setConfirmUndo(true)}
              >
                <PopoverOptionMark>
                  <UndoIcon size={13} />
                </PopoverOptionMark>
                <PopoverOptionBody>
                  <PopoverOptionLabel>Undo the last turn</PopoverOptionLabel>
                  <PopoverOptionHint>History only — files are left as they are.</PopoverOptionHint>
                </PopoverOptionBody>
              </PopoverOption>
            ))}
            <PopoverOption
              onClick={() => {
                setSaving(true)
                close()
              }}
            >
              <PopoverOptionMark>
                <BriefIcon size={13} />
              </PopoverOptionMark>
              <PopoverOptionBody>
                <PopoverOptionLabel>Save as an Agent…</PopoverOptionLabel>
                <PopoverOptionHint>This seat, a brief and a ceiling, under a name to start again.</PopoverOptionHint>
              </PopoverOptionBody>
            </PopoverOption>
            {/* Every view of this conversation, so the panel's own tab row is
              not the only way to reach one — it cannot be seen until the panel
              is open. Changes is the exception: it belongs to the workspace
              chip beside this menu, which carries the file count with it, and
              a second copy here would be the same row twice in one header.

              The descriptions ride on hover rather than under each label: a
              view is one click away and one click back, so guessing wrong
              costs nothing, and three lines of prose under three names is
              what turned this group into a wall. */}
          <PopoverGroupLabel>View</PopoverGroupLabel>
          {summonable()
            /* Changes is the exception: it belongs to the workspace chip beside
               this menu, which carries the file count with it, and a second
               copy here would be the same row twice in one header. */
            .filter((definition) => definition.menu === true && definition.kind !== 'changes')
            .map((definition) => {
              const Glyph = definition.icon
              const open = shownView(snapshot.workbench, definition.kind)
              return (
                <PopoverOption
                  key={definition.kind}
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
                  <PopoverOptionMark checked={open}>
                    {open ? <CheckIcon size={13} /> : <Glyph size={13} />}
                  </PopoverOptionMark>
                  <PopoverOptionBody>
                    <PopoverOptionLabel>
                      {definition.label}
                      {/* The view has something still going — a task in the
                          background. A dot on its door, so the menu says
                          there is something to look at before it is opened. */}
                      {definition.live?.(snapshot) === true && (
                        <PopoverOptionLive />
                      )}
                    </PopoverOptionLabel>
                  </PopoverOptionBody>
                </PopoverOption>
              )
            })}
          {pane && several && (
            <PopoverOption
              onClick={() => {
                store.closePane(pane.paneId)
                close()
              }}
            >
              <PopoverOptionMark>
                <CrossIcon size={13} />
              </PopoverOptionMark>
              <PopoverOptionBody>
                <PopoverOptionLabel>Close this pane</PopoverOptionLabel>
                <PopoverOptionHint>⌘W. The conversation stays in the sidebar.</PopoverOptionHint>
              </PopoverOptionBody>
            </PopoverOption>
          )}
          </>
        )}
      </Popover>
      {/* Outside the menu: the menu closes as the dialog opens. */}
      {saving && <SaveAsAgentDialog session={session} onClose={() => setSaving(false)} />}
    </>
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
    <Button variant="quiet" size="inline" className={`${styles.tasksChip} hd-no-drag`}
      data-testid="tasks-chip"
      {...(live ? { 'data-live': '' } : {})}
      aria-pressed={open}
      /* Led by the chip's own words, which a narrow header folds down to its
         mark: hover is where they are still read. */
      title={`${tasksChipLabel(split)}. ${
        live
          ? 'Work that keeps going after the turn. Opens the Background tasks panel, with the output.'
          : 'Work that ran after a turn ended. Opens the Background tasks panel, with the output.'
      }`}
      onClick={() => store.showView('tasks')}
    >
      {live ? <Spinner size="sm" tone="success" aria-hidden="true" /> : <CheckIcon size={11} />}
      <span className={styles.tasksLabel}>{tasksChipLabel(split)}</span>
    </Button>
  )
}

/**
 * The dock's on/off switch. One press opens a terminal beside the
 * conversation; the next puts the dock away — including the press that lands
 * while the first shell is still opening, which is what the second half of a
 * double click is. A second shell is the dock's own + tab; this button never
 * means "one more terminal", so no press of it can leave one behind.
 *
 * `folds` lets a narrow header fold it into ⋯ › View. The header says so,
 * because only the header knows whether there is a ⋯ beside it to fold into.
 */
export const TerminalToggle = ({ folds = false }: { folds?: boolean } = {}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [opening, setOpening] = useState(false)
  // Asked-for counts as on. Otherwise the press that arrives before the
  // runtime has answered reads the dock as empty and opens a second shell.
  const on = terminals(snapshot.workbench).length > 0 || opening
  return (
    <span className={styles.headerButtonWrap} {...(folds ? { 'data-folds': '' } : {})}>
      <Button
      variant="ghost" size="icon-sm" className={`${styles.headerButton} hd-no-drag`}
      {...(folds ? { 'data-folds': '' } : {})}
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
      </Button>
    </span>
  )
}

export const Conversation = ({
  onChooseProject,
  onSignIn,
  onOpenUsage,
  onOpenRuntimes,
}: {
  onChooseProject: () => void
  onSignIn: (runtime?: RuntimeId) => void
  onOpenUsage: (runtime: RuntimeId) => void
  onOpenRuntimes: () => void
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
  /* Keyed on the folder rather than on this conversation: the fact belongs to
     the folder, and every conversation that ran in it is in the same state. */
  const folderGone = session ? (snapshot.foldersGone.get(session.cwd) ?? null) : null

  const items = useMemo(() => (session ? allItems(session) : []), [session])
  const busy = session ? isBusy(session) : false
  const live = session ? currentTurn(session) : undefined

  const onScroll = useCallback(() => {
    const element = scroll.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setPinned(distance < NEAR_BOTTOM_PX)
  }, [])

  // A reader who is selecting a word out of a streaming answer must not have
  // it yanked out from under the cursor by the next token — release follow
  // the moment the selection lands inside this transcript, the same way
  // scrolling away from the bottom already does.
  useEffect(() => {
    const onSelectionChange = () => {
      const element = scroll.current
      const selection = document.getSelection()
      if (!element || !selection || selection.isCollapsed) return
      if (selection.anchorNode && element.contains(selection.anchorNode)) setPinned(false)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  // A link's own click does not move the scroll position, so `onScroll`
  // never sees it — but opening one is exactly the kind of thing a streamed
  // token should not scroll out from under.
  const onScrollClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest?.('a')) setPinned(false)
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
      <Bar as="header" corner inset="ink" rule="bottom" className={`${styles.header} hd-drag`}>
        {/* The window's own controls, whenever the sidebar is not standing
            beside this header to carry them: put away, or floating over the
            conversation in a narrow window. Only the middle's own header takes
            them — a conversation docked beside it, or a member's column in a
            room, drew a second set a few inches from the first. */}
        {pane && findPane(snapshot.layout, pane.paneId) && sidebarPlacement(snapshot) !== 'column' && (
          <WindowControls />
        )}
        <HeaderTitle session={session} />        {session && <span className="hd-no-drag inline-flex flex-none"><HeaderCeiling session={session} /></span>}
        {session && (
          <Chip
            tone={STATUS_PILL_TONE[status]}
            className={`hd-no-drag${status === 'idle' ? ` ${styles.statusIdle}` : ''}`}
            title={STATUS_LABEL[status]}
          >
            {/* The dot disagrees with the pill on purpose while running: Chip's
                own rule has a dot borrow its chip's ink so the two never
                disagree, which this one live indicator must do anyway, so it
                draws its own mark instead of the shared Dot. */}
            <span className={`${styles.statusDot} h-[7px] rounded-full ${dotTone({ tone: STATUS_TONE[status] })} ${status === 'running' ? 'animate-[hd-pulse_var(--hd-duration-pulse)_ease-in-out_infinite]' : ''}`} />
            {status !== 'idle' && <span className={styles.statusLabel}>{STATUS_LABEL[status]}</span>}
          </Chip>
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
            right does something — the tool header's own divider, drawn for
            the same reason between a tool's controls and its panel's. Wrapped
            only so the phone-width fold below can hide it: the shared marker
            takes no className of its own. */}
        {pane && (
          <span className={styles.headerRuleWrap}>
            <ToolPaneHeaderDivider />
          </span>
        )}
        {/* A door to a view folds into ⋯ › View at a phone's width — where
            there is a ⋯ to fold into. A draft has none, so its browser button
            stays: folded, it was a door closed with nothing in its place. */}
        {pane && (
          <span className={styles.headerButtonWrap} {...(session ? { 'data-folds': '' } : {})}>
            <Button
            variant="ghost" size="icon-sm" className={`${styles.headerButton} hd-no-drag`}
            {...(session ? { 'data-folds': '' } : {})}
            onClick={() => store.openBrowser()}
            title="Open the browser beside this conversation — the page agents' browser tools drive"
            aria-label="Open browser"
          >
            <GlobeIcon size={14} />
            </Button>
          </span>
        )}
        {pane && session && <TerminalToggle folds />}
        {session && <ConversationMenu />}
      </Bar>

      <div className={styles.body}>
        {/* Beside the transcript, not in it: the rail is a picture of the
            scroller and must not scroll with what it pictures. */}
        {session && <ConversationMap turns={session.turns} scroll={scroll} />}
        {loading && items.length === 0 ? (
          // Shares its padding with ConversationEmptyState's, but not its
          // shape: that pattern stacks a title over a sentence, and a spinner
          // beside its word is a row, not a column — forcing one onto the
          // other would flip which way this reads while it is loading.
          <div className={`${styles.loading} p-10`}>
            <Spinner size="sm" tone="brand" />
            <Text role="prose" ink="muted">Loading transcript…</Text>
          </div>
        ) : session && items.length > 0 ? (
          <div className={styles.scroll} ref={scroll} onScroll={onScroll} onClick={onScrollClick} style={{ padding: SCROLL_PADDING }}>
            {session.turns.map((turn, turnIndex) => {
              // The prompt, the work folded under how long it took, the
              // answer, then what changed on disk — the order a reader wants,
              // which is not the order the events arrived in.
              const view = splitTurn(turn)
              const streamingId =
                busy && turn.id === live?.id ? (turn.items[turn.items.length - 1]?.id ?? null) : null
              return (
                <div key={turn.id} data-turn={turn.id}>
                  {turnIndex > 0 && <Separator className={styles.turnDivider} />}
                  {/* The two halves are marked separately because the rail on the
                      left has a dash for each, and a dash that previews the answer
                      has to land on the answer rather than on the top of the turn
                      that contains it. */}
                  {view.prompt.length > 0 && (
                    <div data-turn={turn.id} data-part="prompt">
                      {view.prompt.map((item) => (
                        <ItemView key={item.id} item={item} root={session.cwd} sentAt={turn.startedAt ?? undefined} />
                      ))}
                    </div>
                  )}
                  <TurnWork turn={turn} work={view.work} root={session.cwd} streamingItemId={streamingId} />
                  {view.answer.length > 0 && (
                    <div data-turn={turn.id} data-part="answer">
                      {view.answer.map((item) => (
                        <ItemView key={item.id} item={item} root={session.cwd} streaming={streamingId === item.id} />
                      ))}
                    </div>
                  )}
                  {view.trailing.map((item) => (
                    <ItemView key={item.id} item={item} root={session.cwd} />
                  ))}
                  {view.changes.length > 0 && <TurnFiles turn={turn} changes={view.changes} root={session.cwd} />}
                  {turn.status !== 'inProgress' && (
                    <TurnTail
                      turn={turn}
                      session={session}
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
          <div className={styles.scroll} ref={scroll} onScroll={onScroll} style={{ padding: SCROLL_PADDING }}>
            <ConversationEmptyState>
              <EmptyTitle>Nothing to show</EmptyTitle>
              <EmptyBody>
                {snapshot.runtimes.find((entry) => entry.id === session.runtime)?.presentation.name ?? 'The agent'}{' '}
                couldn’t restore this conversation’s messages. Sending a message continues the
                same session.
              </EmptyBody>
            </ConversationEmptyState>
          </div>
        ) : (
          <div className={styles.scroll} ref={scroll} onScroll={onScroll} style={{ padding: SCROLL_PADDING }}>
            <ConversationEmpty onSignIn={onSignIn} onOpenRuntimes={onOpenRuntimes} />
          </div>
        )}

        {!pinned && items.length > 0 && (
          <span className={styles.jumpButton}>
            <Button
              type="button"
              variant="floating"
              size="sm"
              onClick={jumpToBottom}
            >
              Jump to latest
            </Button>
          </span>
        )}
      </div>

      {/* The fade this pane sits on is its own: no other screen holds a
          scrolling transcript under a floating dock, so there is nowhere
          else this gradient belongs yet. */}
      <div className={`${styles.dockArea} pt-(--hd-space-4) bg-[linear-gradient(to_bottom,transparent,var(--hd-background,var(--hd-card))_26%)]`} ref={dockArea}>
        {/* Stacked by lifetime, shortest first: the jobs strip goes when this
            turn does, the queue happens after it. That order puts the thing
            you can act on nearest the composer and the transcript's own
            narration nearest the transcript. Background tasks — the work that
            outlives the turn — are not a strip any more: they have a panel,
            summoned from the ⋯ menu, and the header wears a chip while any
            are listed. */}
        <div className={styles.bars} style={{ padding: BARS_PADDING }}>
          <JobsBar />
          <GoalBar />
          <MessageQueue />
        </div>
        {/* The composer, or the reason there is not one. A conversation whose
            folder has been deleted cannot be added to by anybody — so the box
            that implies it can is replaced by the note saying so, rather than
            left sitting there to be typed into and refused. */}
        {folderGone && session ? (
          <FolderGone folder={session.cwd} said={folderGone} />
        ) : (
          <Composer onChooseProject={onChooseProject} />
        )}
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
  // This control's own conversation — a room column's member, not whichever
  // one the window has focused — so a review is of the changes it names.
  const key = useSessionKey()
  const runtime = useRuntime()
  // A draft pointed at a worktree will start there, and one armed with a new
  // worktree will start in the one it cuts — so that is where this says it
  // works: this chip and the composer's Work in control must never name two
  // places for one draft.
  const pointed = !session && snapshot.draftPlace?.kind === 'existing' ? snapshot.draftPlace.path : null
  const armed = !session && snapshot.draftPlace?.kind === 'worktree' ? snapshot.draftPlace : null
  // A draft pointed at a worktree, or armed to cut one, names a folder the
  // host will not read until a conversation runs there — or, armed, one that
  // does not exist yet. Git verbs from here would act on some other folder,
  // so the menu has none: where the draft starts is chosen in the composer.
  const pointedAway = pointed !== null && pointed !== snapshot.workspace?.path
  const elsewhere = pointedAway || armed !== null
  const cwd = session?.cwd ?? pointed ?? armed?.root ?? snapshot.workspace?.path ?? null
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
    (armed ? worktreeBranch(armed.name) : null) ??
    // A pointed draft carries its worktree's branch. The list it was chosen
    // from is emptied by any failed read, and the chip must not lose it then.
    (pointedAway && snapshot.draftPlace?.kind === 'existing' ? snapshot.draftPlace.branch : null) ??
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
    armed !== null ||
    pointedAway ||
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
      /* What the chip says, then where it is. The words fold to the glyph in a
         narrow header, and hover is where they are still read — the path alone
         was not the word that folded. A worktree says so, as its badge does,
         and a draft armed with a new one names the folder it will be cut from:
         its worktree is not at that path yet. */
      title={
        armed
          ? `${branch} · new worktree off ${cwd}`
          : `${branch ?? folder}${linked ? ' · worktree' : ''} — ${cwd}`
      }
      align="right"
      label={
        <>
          {/* The glyph says where, so it can stand alone when a narrow header
              folds the words away: a branch for a worktree, a branch with a
              plus for one a draft will cut, a laptop for the main checkout,
              a folder for one that is not a repository. */}
          {armed ? (
            <NewWorktreeIcon size={13} />
          ) : linked ? (
            <BranchIcon size={13} />
          ) : branch ? (
            <LocalIcon size={13} />
          ) : (
            <FolderIcon size={13} />
          )}
          <span className={styles.gitWords}>
            <Text as="span" role="navigation" className={styles.gitLabel}>{branch ?? folder}</Text>
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
          {elsewhere ? (
            <MenuItem
              icon={armed ? <NewWorktreeIcon size={16} /> : <BranchIcon size={16} />}
              label={armed ? 'The worktree is made when the message goes' : 'Starts in this worktree when the message goes'}
              title="Where it starts is chosen in the composer, under Work in."
              disabled
              onSelect={() => {}}
            />
          ) : (
            <>
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
            </>
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
          {session && key && runtime.capabilities.review && (
            <MenuItem
              icon={<ReviewIcon size={16} />}
              label="Review uncommitted changes"
              title="On a side thread, leaving this one as it is."
              onSelect={() => void store.review({ type: 'uncommitted', delivery: 'detached' }, key)}
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

import { CeilingChip } from './CeilingChip'
import { seatCeilingOf } from '../lib/ceilings'

/** The ceiling governing this conversation, or nothing on the plain path. */
const HeaderCeiling = ({ session }: { readonly session: Session }) => {
  const snapshot = useSnapshot()
  const runs = useMemo(() => [...snapshot.flowRuns.values()].flat(), [snapshot.flowRuns])
  const shown = seatCeilingOf(session.settings, runs, String(session.runtime), String(session.id))
  return shown ? <CeilingChip ceiling={shown.ceiling} note={shown.note} /> : null
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

/** The header's title: the conversation's own, led by the Agent it was seated as. */
const HeaderTitle = ({ session }: { readonly session: Session | null }) => {
  const seated = useSeatAgent(session)
  return <Text as="span" role="subject" className={styles.title}>{ledBy(seated?.name ?? null, titleOf(session))}</Text>
}
