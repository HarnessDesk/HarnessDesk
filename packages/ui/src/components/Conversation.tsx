import { fileLink, filePathInRoot } from '../lib/file-link'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { editorConversation } from '../editor'
import { sanitizeText } from '../lib/sanitize'
import { sessionUnavailable } from '../lib/session-unavailable'
import { isChatFolder } from '../lib/chats'
import { useInstalledAgents } from '../lib/first-run'
import { allItems, currentTurn, isBusy, isNoticeTurn, openingOfContent, type RuntimeId, type Session } from '@harnessdesk/protocol'

import {
  useActiveSession,
  usePane, PaneProvider,
  useRuntime,
  useRuntimeAccount,
  useRuntimeHealth,
  useSessionKey,
  useSnapshot,
  useStore,
} from '../state/context'
import { findPane } from '../state/layout'
import { shownView, sidebarPlacement } from '../state/workbench'
import { summonable } from '../panels/views'
import { toolOf } from '../state/frame-tools'
import { useTopBar, useTopBarMore, useWorkDetails } from '../panels/top-bar'
import { WorkTools } from '../panels/WorkTools'
import { ConversationDetails } from '../panels/work-details'
import { handOverToComposer } from '../lib/compose'
import { dismissOverlays } from '../lib/overlays'
import { Composer } from './Composer'
import {
  BranchIcon,
  BrainIcon,
  PencilIcon, ForkIcon, ArchiveIcon,
  UndoIcon,
  AgentIcon,
  CheckIcon,
  CommitIcon,
  CompactIcon,
  CrossIcon,
  DiffIcon,
  HistoryIcon,
  HomeIcon,
  LocalIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreIcon,
  ReviewIcon,
  TrashIcon,
  NewWorktreeIcon,
} from './Icons'
import { worktreeBranch } from '../lib/worktree-branch'
import { isRecordConversation, RECORD_REASON } from '../lib/team-record'
import { scriptedScrollBehavior } from '../lib/scripted-scroll'
import {
  Banner,
  Button,
  Chip,
  Dot, Dialog, Field, FormStack, Input, ActionError,
  ConfirmDialog,
  ComposerDock,
  ConversationEmptyState,
  InlineParts,
  Menu,
  MenuItem,
  MenuLabel,
  MenuToggle,
  PaneColumn, ReadingMeasure, Page,
  Popover,
  Separator,
  Spinner,
  Submenu,
  Text,
  useComposerHeightVar,
  type Tone,
} from '../design'
import { STATUS_LABEL, paneStatus, type PaneStatus } from '../lib/pane-status'
import { splitTurn } from '../lib/turn-view'
import { ItemView } from './Items'
import { BranchSwitcher } from './BranchSwitcher'
import { BranchCreateDialog } from './BranchCreateDialog'
import { TurnFiles } from './TurnFiles'
import { TurnWork } from './TurnWork'
import { GoalBar, JobsBar } from './SessionBars'
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
import { WindowControls } from './WindowControls'
import { SaveAsAgentDialog } from './SaveAsAgent'
import styles from './Conversation.module.css'

/** An empty-state title, taking the page role's size and weight together. */
const EmptyTitle = ({ children }: { children: ReactNode }) => (
  <Text as="div" role="page">
    {children}
  </Text>
)
/** An empty-state sentence, in the reading role. */
const EmptyBody = ({ children }: { children: ReactNode }) => (
  <Text as="p" role="prose" align="center" className="m-0 max-w-[460px]">
    {children}
  </Text>
)

/**
 * The pill's own ground — its own judgement, not the dot's.
 *
 * Running and idle stay neutral. A waiting approval or a failure keeps its
 * tone while it needs the person.
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
  height,
  onSignIn,
  onOpenRuntimes,
}: {
  height?: 'pane' | 'content'
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
  const sessionRuntime = session
    ? snapshot.runtimes.find((entry) => entry.id === session.runtime)
    : undefined
  const sessionHealth = session
    ? snapshot.healthByRuntime[session.runtime] ?? (session.runtime === snapshot.activeRuntime ? snapshot.health : null)
    : null
  const unavailableSessionMessage = session && !sessionRuntime
    ? "This conversation can't be read because its runtime isn't installed. Add it in Settings, then reopen this conversation."
    : sessionHealth?.state === 'unavailable'
      ? `${sessionHealth.message}${sessionHealth.remediation ? ` ${sessionHealth.remediation}` : ' Check the runtime in Settings, then reopen this conversation.'}`
      : null
  const folderPath = session?.cwd || snapshot.workspace?.path || null
  const folder = folderPath ? folderPath.split('/').filter(Boolean).pop() ?? null : null
  const [startingTeam, setStartingTeam] = useState(false)
  const installed = useInstalledAgents(store, snapshot.runtimes)
  const installedOffer = installed.offers.length > 0 ? (
    <InlineParts role="group" aria-label="Installed on this Mac">
      <Text as="span" role="meta">Installed on this Mac</Text>
      {installed.offers.map(template => (
        <InlineParts key={template.key}><Text as="span" role="row">{template.name}</Text><Button type="button" variant="secondary" size="sm"
          aria-label={`Add ${template.name}`} disabled={installed.busy !== null}
          onClick={() => void installed.add(template.key)}>
          {installed.busy === template.key ? 'Adding…' : 'Add'}
        </Button></InlineParts>
      ))}
    </InlineParts>
  ) : null

  if (session && unavailableSessionMessage) {
    return (
      <ConversationEmptyState height={height}>
        <EmptyBody>{unavailableSessionMessage}</EmptyBody>
      </ConversationEmptyState>
    )
  }

  if (health && health.state === 'unavailable') {
    // Not just this agent's bad news: the whole desk, surveyed, with the one
    // next move per agent. A dead agent's empty pane is exactly where the
    // user is standing when they need to know what else would work.
    return (
      <ConversationEmptyState height={height}>
        <EmptyTitle>{words.name} isn’t available</EmptyTitle>
        <EmptyBody>
          {health.message}
          {health.remediation ? ` ${health.remediation}` : ''}
        </EmptyBody>
        <SetupDesk onSignIn={onSignIn} onOpenRuntimes={onOpenRuntimes} />
        {installedOffer}
      </ConversationEmptyState>
    )
  }

  // Only meaningful for a runtime that has an account at all. A local model has
  // nothing to sign in to, and saying otherwise would be nonsense.
  // And only once the agent has said so: one not checked yet may well be
  // signed in, and its first conversation is what asks it.
  if (runtime.capabilities.account && account && account.accounts.length === 0 && !account.unchecked) {
    const driveable = account.signInMethods.some((method) => method.flow !== 'external')
    const external = account.signInMethods.find((method) => method.flow === 'external')
    return (
      <ConversationEmptyState height={height}>
        <EmptyTitle>Sign in to {words.name}</EmptyTitle>
        <EmptyBody>
          HarnessDesk uses your existing {words.name} installation and never stores your
          credentials.
        </EmptyBody>
        {driveable ? (
          /* This pane's agent, by name: an empty member column on another
             agent must not open the default's sign-in. */
          <Button type="button" onClick={() => onSignIn(runtime.id)}>
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
        {installedOffer}
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
      <ConversationEmptyState height={height}>
        <EmptyTitle>{blocked.title}</EmptyTitle>
        <EmptyBody>
          {words.name} is signed in and healthy. {blocked.detail}
        </EmptyBody>
        {installedOffer}
      </ConversationEmptyState>
    )
  }

  return (
    <ConversationEmptyState height={height}>
      <EmptyTitle>What should we build?</EmptyTitle>
      <EmptyBody>
        {session ? `Describe what you want done in ${folder}.` : 'Describe a task.'}
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
      {session && snapshot.runtimes.length === 1 && (
        /* The one-agent desk is the first-run desk. Said here rather than
           left for settings to reveal: the other agents on this machine can
           join without anyone hand-editing a file. */
        <EmptyBody>
          {snapshot.runtimes[0]!.presentation.name} is the only runtime here.{' '}
          <Button type="button" variant="link" size="content" onClick={onOpenRuntimes}>
            Add another runtime…
          </Button>
        </EmptyBody>
      )}
      {installedOffer}
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
const ConversationMenu = ({ owner, folderActions }: { owner?: string; folderActions?: (close: () => void) => ReactNode }) => {
  const store = useStore()
  const runtime = useRuntime()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  // This menu's own conversation, which is also the one its verbs act on: a
  // wrapped Team's record is refused by the host, so the row says so up front.
  const key = useSessionKey()
  const record = isRecordConversation(snapshot.goals.values(), key)
  const capabilities = runtime.capabilities
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [saving, setSaving] = useState(false)
  const pane = usePane()
  const unavailable = sessionUnavailable(snapshot, session)
  const refusal = record ? RECORD_REASON : unavailable
  const memoryOn = session?.memory === true
  const several = snapshot.layout.root.kind === 'split'
  const menuBody = (close: () => void) => <>
    {capabilities.memory && <MenuToggle icon={<BrainIcon size={16} />} label="Remember this conversation"
      title={refusal ?? `Let ${runtime.presentation.name} carry what it learns here into new ones.`} disabled={refusal ?? false} checked={memoryOn}
      onChange={() => { void store.setMemoryMode(!memoryOn, key); close() }} />}
    {capabilities.compaction && <MenuItem icon={<CompactIcon size={16} />} label="Compact now"
      title="Summarise older turns to free up context." disabled={record ? RECORD_REASON : sessionUnavailable(snapshot, session) ?? false}
      onSelect={() => void store.compact(key)} />}
    {capabilities.undo && <MenuItem icon={<UndoIcon size={16} />} label="Undo the last turn"
      hint="Files are left as they are." disabled={refusal ?? false} onSelect={() => setConfirmUndo(true)} />}
    <MenuItem icon={<AgentIcon size={16} />} label="Save as an Agent…"
      title="This seat, a brief and a ceiling, under a name to start again." onSelect={() => setSaving(true)} />
    {folderActions?.(close)}
    <MenuLabel>View</MenuLabel>
    {summonable().filter(definition => definition.menu === true && toolOf(definition.kind) === null && definition.kind !== 'run-steps' && definition.kind !== 'terminal').map(definition => {
      const Glyph = definition.icon
      return <MenuItem key={definition.kind} icon={<Glyph size={16} />} label={definition.label} title={definition.hint}
        selected={shownView(snapshot.workbench, definition.kind)} badge={definition.live?.(snapshot) === true ? 'Live' : undefined}
        onSelect={() => store.showView(definition.kind)} />
    })}
    {pane && several && <MenuItem icon={<CrossIcon size={16} />} label="Close this pane" shortcut="⌘W"
      hint="The conversation stays in the sidebar." onSelect={() => store.closePane(pane.paneId)} />}
  </>
  useTopBarMore(owner ?? pane?.paneId ?? '', menuBody, Boolean(session && pane))
  return <>
    {confirmUndo && <ConfirmDialog title="Undo the last turn?" confirmLabel="Undo turn" cancelLabel="Keep" onCancel={() => setConfirmUndo(false)}
      onConfirm={() => { void store.rollback(1, key); setConfirmUndo(false) }}>
      Drops it from history. Files it changed on disk are not reverted.
    </ConfirmDialog>}
    {saving && session && <SaveAsAgentDialog session={session} onClose={() => setSaving(false)} />}
  </>
}


export const Conversation = ({
  onChooseProject,
  onSignIn,
  onOpenUsage,
  onOpenRuntimes,
  header = true,
  composer = true,
  teamMenuOwner,
  mainContent,
}: {
  onChooseProject: () => void | Promise<boolean>
  onSignIn: (runtime?: RuntimeId) => void
  onOpenUsage: (runtime: RuntimeId) => void
  onOpenRuntimes: () => void
  /** False where something else already heads this conversation — a Side
      by side tile's own bar names the member, its state and its ⋯, and a
      second header under it would repeat the title and the plan meters in
      every tile. */
  header?: boolean
  /** False where one composer elsewhere speaks for several conversations — a
      Side by side grid of two or more tiles — so this one draws none. */
  composer?: boolean
  /** Selected member actions augment its Team bar, retaining the conversation scope. */
  teamMenuOwner?: string
  /** Main can read files while this conversation continues owning its frame slots. */
  mainContent?: ReactNode
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const key = useSessionKey()
  const pane = usePane()
  const scroll = useRef<HTMLDivElement>(null)
  const transcriptContent = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const status = paneStatus(session, snapshot.approvals, key)
  const worktree = session
    ? snapshot.worktrees.find((entry) => entry.managed && entry.path === session.cwd)
    : undefined
  const [removingWorktree, setRemovingWorktree] = useState(false)
  const [bringingHome, setBringingHome] = useState(false)
  const [creatingBranchRoot, setCreatingBranchRoot] = useState<string | null>(null)
  const loading = key ? snapshot.loadingSessions.has(key) : false
  const sessionRuntime = session ? snapshot.runtimes.find((entry) => entry.id === session.runtime) : undefined
  const sessionHealth = session
    ? snapshot.healthByRuntime[session.runtime] ?? (session.runtime === snapshot.activeRuntime ? snapshot.health : null)
    : null
  const sessionCannotRun = Boolean(session && (!sessionRuntime || sessionHealth?.state === 'unavailable'))
  const unavailableSessionMessage = session && !sessionRuntime
    ? "This conversation can't be read because its runtime isn't installed. Add it in Settings, then reopen this conversation."
    : sessionHealth?.state === 'unavailable'
      ? `${sessionHealth.message}${sessionHealth.remediation ? ` ${sessionHealth.remediation}` : ' Check the runtime in Settings, then reopen this conversation.'}`
      : null
  /* Keyed on the folder rather than on this conversation: the fact belongs to
     the folder, and every conversation that ran in it is in the same state. */
  const folderGone = session ? (snapshot.foldersGone.get(session.cwd) ?? null) : null

  const items = useMemo(() => (session ? allItems(session) : []), [session])
  const hasRealTurn = session?.turns.some(turn => !isNoticeTurn(turn)) ?? false
  const emptyHeight = !hasRealTurn && items.length > 0 ? 'content' : 'pane'
  const emptyState = session && sessionCannotRun && unavailableSessionMessage && items.length === 0 ? (
    <ConversationEmptyState height={emptyHeight}>
      <EmptyBody>{unavailableSessionMessage}</EmptyBody>
    </ConversationEmptyState>
  ) : session && session.itemsLoaded && session.updatedAt > session.createdAt ? (
    <ConversationEmptyState height={emptyHeight}>
      <EmptyTitle>Nothing to show</EmptyTitle>
      <EmptyBody>
        {snapshot.runtimes.find((entry) => entry.id === session.runtime)?.presentation.name ?? 'The runtime'}{' '}
        couldn’t restore this conversation’s messages. Sending a message continues the same session.
      </EmptyBody>
    </ConversationEmptyState>
  ) : <ConversationEmpty height={emptyHeight} onSignIn={onSignIn} onOpenRuntimes={onOpenRuntimes} />
  const busy = session ? isBusy(session) : false
  const live = session ? currentTurn(session) : undefined

  // The auto-scroll below sets `scrollTop` itself, and that assignment fires
  // its own native `scroll` event a frame later — indistinguishable, to a
  // plain listener, from the reader scrolling back to the bottom. Without
  // this mark that delayed event re-pinned every release a frame after it
  // landed, so a selection made the instant a token streamed in snapped
  // straight back. One event (or one frame, whichever comes first) is
  // swallowed per programmatic scroll, the same way shadcn's own
  // `data-autoscrolling` does it.
  const onScroll = useCallback(() => {
    const element = scroll.current
    if (!element) return
    if (element.dataset.autoscrolling) {
      delete element.dataset.autoscrolling
      return
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setPinned(distance < NEAR_BOTTOM_PX)
  }, [])

  // A reader who is selecting a word out of a streaming answer must not have
  // it yanked out from under the cursor by the next token — release follow
  // the moment the selection lands inside this transcript, the same way
  // scrolling away from the bottom already does. Scoped to the transcript's
  // own content: the empty-state pitches share this ref while they are what
  // is mounted, and a selection made in "Nothing to show" is not a reason to
  // stop following a conversation that has not started streaming anything.
  useEffect(() => {
    const onSelectionChange = () => {
      const element = scroll.current
      const selection = document.getSelection()
      if (!element || !element.hasAttribute('data-live-transcript')) return
      if (!selection || selection.isCollapsed) return
      if (selection.anchorNode && element.contains(selection.anchorNode)) setPinned(false)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  // A link's own click does not move the scroll position, so `onScroll`
  // never sees it — but opening one is exactly the kind of thing a streamed
  // token should not scroll out from under. `element.contains` (real DOM
  // ancestry, not React's tree) keeps this from firing on a portalled hover
  // card's own link — its node lives outside this box no matter which
  // component rendered it — and `a[href]` skips a row's own clickable
  // wrapper, which is an anchor with nowhere to go.
  const onScrollClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const element = scroll.current
    const link = (event.target as HTMLElement).closest?.('a[href]')
    if (element && link && element.contains(link)) {
      setPinned(false)
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !key || !session) return
      const target = fileLink(link.getAttribute('href') ?? '')
      const path = target && filePathInRoot(target.path, session.cwd)
      if (path && target) {
        event.preventDefault()
        store.enterEditorFile(key, path, { view: 'source', line: target.line })
      }
    }
  }, [store, key, session])

  // Layout effect so the jump happens in the same frame the content grows,
  // rather than as a visible lurch afterwards.
  useLayoutEffect(() => {
    if (!pinned) return
    const element = scroll.current
    if (!element) return
    let frame = 0
    const follow = () => {
      element.dataset.autoscrolling = 'true'
      element.scrollTop = element.scrollHeight
      // A no-op assignment fires no event; do not swallow the reader's next scroll.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => delete element.dataset.autoscrolling)
    }
    follow()
    // A tile can finish laying out after its transcript mounts. Dock padding,
    // viewport changes and late text layout also change the bottom without a
    // new item. Observe both boxes while following; a reader's release stops it.
    const observer = new ResizeObserver(follow)
    observer.observe(element)
    if (transcriptContent.current) observer.observe(transcriptContent.current)
    return () => {observer.disconnect(); cancelAnimationFrame(frame)}
  }, [items, pinned, session?.id, Boolean(mainContent)])

  // Switching sessions always starts at the bottom of the new transcript.
  useEffect(() => {
    setPinned(true)
  }, [session?.id])

  // A turn that was not there a moment ago is either a message the reader
  // just sent or a fresh reply starting — either way the point of sending is
  // to see what comes back, so a release from reading an earlier answer does
  // not survive it.
  const lastTurnId = session?.turns[session.turns.length - 1]?.id ?? null
  useEffect(() => {
    if (lastTurnId != null) setPinned(true)
  }, [lastTurnId])

  // The transcript scrolls behind the floating composer; its measured height
  // becomes the scroll padding, so the last message always clears it — even
  // as the textarea grows. `useComposerHeightVar` owns the observing and the
  // `--composer-h` custom property it flows through; this pane only wires
  // the two refs to its own markup.
  const conversationRoot = useRef<HTMLDivElement>(null)
  const dockArea = useComposerHeightVar(conversationRoot)

  const jumpToBottom = useCallback(() => {
    const element = scroll.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: scriptedScrollBehavior() })
    setPinned(true)
  }, [])

  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameSubject = async () => {
    if (!rename.trim() || !key) return
    try { await store.renameSession(rename.trim(), key); setRenaming(false) }
    catch (cause) { setRenameError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const activeFile = mainContent && key ? editorConversation(snapshot.editorState, `session:${key}`).active : null
  const filePlace = activeFile && session?.cwd && activeFile.startsWith(`${session.cwd}/`)
    ? activeFile.slice(session.cwd.length + 1) : activeFile
  useTopBar(pane?.paneId ?? '', {
    lead: <WindowControls />,
    place: filePlace ? sanitizeText(filePlace) : <HeaderTitle session={session} />,
    parent: filePlace ? { label: titleOf(session), run: () => store.setWindowMode('conversation') } : undefined,
    state: session ? <Dot tone={STATUS_PILL_TONE[status]} pulse={status === 'running'} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} /> : undefined,
    placeMenu: session ? close => <>
      <MenuItem icon={<PencilIcon />} label="Rename" onSelect={() => { setRename(session.title ?? ''); setRenameError(null); setRenaming(true); close() }} />
      <MenuItem icon={<ForkIcon />} label="Fork" disabled={isRecordConversation(snapshot.goals.values(), key) ? RECORD_REASON : sessionUnavailable(snapshot, session) ?? false} onSelect={() => { void store.forkSession(key); close() }} />
      <MenuItem icon={<ArchiveIcon />} label="Archive" onSelect={() => { void store.archiveSession(session.id, session.runtime, titleOf(session)); close() }} />
    </> : undefined,
    tools: <WorkTools draft={!session} />,
    terminal: true,
    more: session ? () => null : () => <MenuItem icon={<FolderOpenIcon size={16} />} label="Choose a project folder…" onSelect={onChooseProject} />,
    corner: sidebarPlacement(snapshot) !== 'column',
  }, header && pane !== null)
  useWorkDetails(pane?.paneId ?? '', <ConversationDetails session={session}
    placeAction={<GitControl onCreateBranch={setCreatingBranchRoot} onRemoveWorktree={() => setRemovingWorktree(true)} onBringHome={() => setBringingHome(true)} />} />,
    header && pane !== null)

  return (
    <div className={styles.conversation} ref={conversationRoot}>
      {renaming && <Dialog title="Rename conversation" onClose={() => setRenaming(false)} footer={<>
        <Button disabled={!rename.trim()} onClick={() => void renameSubject()}>Rename</Button>
        <Button variant="quiet" onClick={() => setRenaming(false)}>Cancel</Button>
      </>}><FormStack><Field label="Name">{control => <Input {...control} value={rename} onChange={event => setRename(event.target.value)} autoFocus
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void renameSubject() } }} />}</Field></FormStack>
        {renameError && <ActionError>{renameError}</ActionError>}
      </Dialog>}
      {(header || teamMenuOwner) && session && <ConversationMenu owner={teamMenuOwner} folderActions={teamMenuOwner
        ? close => pane && <PaneProvider scope={pane}><GitControl menu menuClose={close} onCreateBranch={setCreatingBranchRoot} onRemoveWorktree={() => setRemovingWorktree(true)} onBringHome={() => setBringingHome(true)} /></PaneProvider> : undefined} />}

      {mainContent ?? <>
      <div className={styles.body}>
        {/* Beside the transcript, not in it: the rail is a picture of the
            scroller and must not scroll with what it pictures. */}
        {session && <ConversationMap turns={session.turns} scroll={scroll} />}
        {loading && items.length === 0 ? (
          // In the same column as every other empty state here, clear of the
          // composer. Pane-filling empty states keep the word in place;
          // notice-only restores move the explanation up beside their notice.
          <PaneColumn inset="reading" clearComposer className={styles.scroll} ref={scroll} onScroll={onScroll}>
            <ConversationEmptyState row>
              <Spinner size="sm" tone="brand" />
              <Text role="prose" ink="muted">Loading transcript…</Text>
            </ConversationEmptyState>
          </PaneColumn>
        ) : session && items.length > 0 ? (
          <PaneColumn
            inset="reading"
            clearComposer
            className={styles.scroll}
            ref={scroll}
            onScroll={onScroll}
            onClick={onScrollClick}
            data-transcript
            data-live-transcript
          >
            {session.worktreeWarning && <Banner tone="neutral" compact>{session.worktreeWarning}</Banner>}
            {!hasRealTurn && emptyState}
            <div ref={transcriptContent} data-transcript-content><Page width="reading" gutter="none">
            {session.deskCopy && <ReadingMeasure><Text as="div" role="prose" ink="secondary">HarnessDesk’s copy — {snapshot.runtimes.find(entry => entry.id === session.runtime)?.presentation.name ?? 'The runtime'}’s own record is unavailable.</Text></ReadingMeasure>}
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
            </Page></div>
          </PaneColumn>
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
          <PaneColumn inset="reading" clearComposer className={styles.scroll} ref={scroll} onScroll={onScroll}>
            {emptyState}
          </PaneColumn>
        ) : (
          <PaneColumn inset="reading" clearComposer className={styles.scroll} ref={scroll} onScroll={onScroll}>
            {emptyState}
          </PaneColumn>
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

      {/* `ComposerDock`'s `floating` fade: no other pane holds a scrolling
          transcript under a dock that floats over it — the room's own
          composer sits in flow below its stream instead. */}
      <ComposerDock floating className={styles.dockArea} ref={dockArea}>
        {/* Stacked by lifetime, shortest first: the jobs strip goes when this
            turn does, the queue happens after it. That order puts the thing
            you can act on nearest the composer and the transcript's own
            narration nearest the transcript. Background tasks — the work that
            outlives the turn — are not a strip any more: they have a panel,
            summoned from the ⋯ menu, and the header wears a chip while any
            are listed. */}
        <PaneColumn inset="bars" className={styles.bars}>
          <JobsBar />
          <GoalBar />
          <MessageQueue />
        </PaneColumn>
        {/* The composer, or the reason there is not one. A conversation whose
            folder has been deleted cannot be added to by anybody — so the box
            that implies it can is replaced by the note saying so, rather than
            left sitting there to be typed into and refused. */}
        {!composer ? null : folderGone && session ? (
          <FolderGone folder={session.cwd} said={folderGone} />
        ) : sessionCannotRun ? (items.length > 0 && <ComposerDock><ReadingMeasure><Text as="div" role="prose" ink="secondary">{unavailableSessionMessage}</Text></ReadingMeasure></ComposerDock>) : (
          <Composer onChooseProject={onChooseProject} />
        )}
      </ComposerDock>
      </>}
      {removingWorktree && worktree && (
        <RemoveWorktree worktree={worktree} onClose={() => setRemovingWorktree(false)} />
      )}
      {bringingHome && worktree && <BringHome worktree={worktree} onClose={() => setBringingHome(false)} />}
      {creatingBranchRoot && <BranchCreateDialog root={creatingBranchRoot} onDone={() => {}} onClose={() => setCreatingBranchRoot(null)} />}
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
  menu = false,
  menuClose,
  onCreateBranch,
}: {
  onRemoveWorktree: () => void
  onBringHome: () => void
} & ({ menu: true; menuClose: () => void; onCreateBranch: (root: string) => void } | { menu?: false; menuClose?: never; onCreateBranch?: (root: string) => void })) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  // This control's own conversation — a room column's member, not whichever
  // one the window has focused — so a review is of the changes it names.
  const key = useSessionKey()
  const pane = usePane()
  const record = isRecordConversation(snapshot.goals.values(), key)
  const runtime = useRuntime()
  const [creatingBranch, setCreatingBranch] = useState(false)
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
  // Repository rows go only where the folder is known not to be a repository:
  // a managed chat, or the open workspace once the host has read it as none
  // (`repo: null`; absent means unread). A folder this window has no read for
  // (a Team member's clone, a runtime that reports no git) keeps them.
  const here = cwd === snapshot.workspace?.path ? snapshot.workspace : null
  const knownNotRepository = isChatFolder(cwd, snapshot.chatsFolderRoots) || (here?.repo === null && !here.git)
  const hasRepository = Boolean(branch || checkout || session?.git || summary?.repo) || !knownNotRepository
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

  // An armed draft's path is its source folder, not a worktree made yet.
  // The accessible name and the grouped card must describe the same place.
  const placeTitle = armed
    ? `${branch} · new worktree off ${cwd}`
    : `${branch ?? folder}${linked ? ' · worktree' : ''} — ${cwd}`

  const menuBody = (close: () => void) => <>
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
            ) : hasRepository && (
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
                  <Submenu icon={<BranchIcon size={16} />} label={<span data-git-branch-row="">{branch}</span>} wide icons="all">
                    <BranchSwitcher root={cwd} onDone={close} onCreate={() => onCreateBranch ? onCreateBranch(cwd) : setCreatingBranch(true)} />
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
            {hasRepository && session && key && runtime.capabilities.review && (
              <MenuItem
                icon={<ReviewIcon size={16} />}
                label="Review uncommitted changes"
                title="On a side thread, leaving this one as it is."
                disabled={record ? RECORD_REASON : sessionUnavailable(snapshot, session) ?? false}
                onSelect={() => void store.review({ type: 'uncommitted', delivery: 'detached' }, key)}
              />
            )}
            {hasRepository && session && !sessionUnavailable(snapshot, session) && (
              <MenuItem
                icon={<CommitIcon size={16} />}
                label="Commit the changes"
                title="Asks the runtime, in this conversation; you send it."
                onSelect={() => {
                  dismissOverlays({ returnFocus: false })
                  if (pane) store.focusPane(pane.paneId.split(':')[0]!)
                  void handOverToComposer({
                    paneId: pane?.paneId,
                    text: 'Commit the changes from this conversation with a clear message, then tell me the commit hash.',
                  }).then(taken => {
                    if (!taken) store.notice('warning', 'The message box did not take it — click into the conversation and try again.')
                  })
                }}
              />
            )}
          </>
  return menu ? <Submenu label="Folder actions" icon={<FolderIcon size={16} />} icons="all">{menuBody(menuClose!)}</Submenu>
    : <>
    <Popover title="Folder actions" icons="all" align="right" label={<MoreIcon />} triggerVariant={{ variant: 'ghost', size: 'icon-sm' }}>
      {close => <Menu close={close}>{menuBody(close)}</Menu>}
    </Popover>
    {creatingBranch && <BranchCreateDialog root={cwd} onDone={() => {}} onClose={() => setCreatingBranch(false)} />}
    </>
}

const titleOf = (session: Session | null): string => {
  if (!session) return 'New session'
  const firstMessage = session.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === 'userMessage')
  const spoken =
    firstMessage?.type === 'userMessage'
      ? openingOfContent(firstMessage.content)
      : null
  const label = sessionLabel(session.title, session.preview, '') || spoken || 'New session'
  // A first message is a paragraph; a title is a line.
  return label.length > 72 ? `${label.slice(0, 71).trimEnd()}…` : label
}

/** The header's title: the conversation's own, led by the Agent it was seated as. */
const HeaderTitle = ({ session }: { readonly session: Session | null }) => {
  const seated = useSeatAgent(session)
  return <>{ledBy(seated?.name ?? null, titleOf(session))}</>
}
