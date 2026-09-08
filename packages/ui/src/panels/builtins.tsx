import { Approvals } from '../components/Approvals'
import { BackgroundTasksView } from '../components/BackgroundTasks'
import { BrowserPane } from '../components/BrowserPane'
import { Conversation } from '../components/Conversation'
import { ActivityView, AgentsView, ChangesView, TrajectoryView } from '../components/Details'
import { FilePane } from '../components/FilePane'
import { GitPane } from '../components/GitPane'
import { PreviewPane } from '../components/PreviewPane'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { TerminalSurface, terminalName } from '../components/TerminalPane'
import {
  AgentIcon,
  BackgroundIcon,
  DiffIcon,
  FileIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  PlanIcon,
  RepositoryIcon,
  PluginIcon,
  SessionIcon,
  TeamIcon,
  TerminalIcon,
  TrajectoryIcon,
} from '../components/Icons'
import { useSnapshot } from '../state/context'
import { resolveComponent } from '../slots/registry'
import { EmptyState } from '../design/ui'
import { useMount } from './mount'
import { registerView, useShell } from './views'

/**
 * HarnessDesk's own features, registered as views.
 *
 * This file is the answer to "where does a feature say where it may live", and
 * it is deliberately the only place any feature says it. Read down the
 * `mounts` column and you have the whole product's docking rules on one screen
 * — which is a thing that could not be written down at all before, because the
 * rules were distributed across a switch statement in `Panes`, a `VIEWS`
 * table in `Details` and a component that owned the bottom of the window.
 *
 * Three rules decide the columns:
 *
 *   Main holds two things.          A conversation, or a room. Nothing else
 *                                    declares `main`, which is what makes the
 *                                    middle a fixed point rather than wherever
 *                                    the last click landed — read the column
 *                                    and it is one word twice.
 *   Lists get the sidebar.           Changes, Agents and Activity are lists of
 *                                    rows; a list is what a sidebar is for.
 *                                    Diffs, boards and terminals are not.
 *   Where it goes first is           `mounts[0]` is the default area, which is
 *   `mounts[0]`.                     why the inspectors lead with `right` and
 *                                    a terminal leads with `bottom`.
 *
 * Two entries constrain by *shape* rather than by preference, and both say so
 * where they are declared. The browser is right-only: the bottom dock trades
 * height for width, and a page a few rows tall is not a page. A terminal is the
 * same argument inverted, which is why it leads with `bottom`.
 *
 * A constraint here is enforced by *absence*, and it is worth being plain about
 * that rather than describing a kinder design than the one that is built: the
 * move menu lists `destinations`, which is `mounts` minus where the view
 * already is, so an area a view refuses is simply not offered — and when a
 * view refuses every other area, the menu is not drawn at all. The drag says it
 * the same way: a drop zone only lights up over an area the dragged view
 * declares. Both are quiet, and quiet is the cost of not having a reason to
 * print; whoever adds one to this table can make it loud.
 */

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/**
 * The conversation, and the approval dialog that belongs to it.
 *
 * The four shell actions come from a context rather than from props. That is
 * the whole difference between a feature that can be mounted anywhere and one
 * that can only be rendered where somebody remembered to thread its callbacks:
 * `Panes` used to carry these through three components so that a conversation
 * nested inside the team room could reach them.
 */
const ConversationView = () => {
  const shell = useShell()
  return (
    <>
      <Conversation
        onChooseProject={shell.chooseProject}
        onSignIn={shell.signIn}
        onOpenUsage={shell.openUsage}
        onOpenAgents={shell.openAgents}
      />
      <Approvals />
    </>
  )
}

/**
 * A room, keyed by the project it is a room for.
 *
 * Almost everything these panes hold is *about one root*: which conversations
 * are being watched, the roster filter, a half-written message and who it was
 * addressed to, how far behind the reader is, an open dialog about a card.
 * None of that is a prop, so pointing the same pane at another project carried
 * all of it across — a conversation from Room A still rendered as a column
 * under Room B's name, and then written back into Room B's `watching` field,
 * where the next launch would read it as its own.
 *
 * Keying is the fix rather than resetting each piece: a list of things to clear
 * on a root change is a list somebody has to remember to add to, and the two
 * that were found were found one at a time. A different project is a different
 * room, so it gets a different component.
 */
const RoomView = () => {
  const mount = useMount()
  const shell = useShell()
  if (mount?.view.kind !== 'room') return null
  return (
    <TeamRoomPane
      /* Keyed, so a different room is a different component. Everything
         these panes hold is about one room — the columns being watched, a
         half-written message and who it was addressed to, an open dialog
         about a card — and none of it is a prop. Main keyed this by root;
         by room is the same fix one notch finer, because two rooms in one
         project are exactly the case a root key cannot tell apart. */
      key={mount.view.room}
      room={mount.view.room}
      onChooseProject={shell.chooseProject}
      onSignIn={shell.signIn}
      onOpenUsage={shell.openUsage}
      onOpenAgents={shell.openAgents}
    />
  )
}

/** The board alone, keyed for the same reason: a title half-typed into one
    project's quick-add is not a draft belonging to the next one. */
const BoardView = () => {
  const mount = useMount()
  return mount?.view.kind === 'board' ? (
    <TeamBoardPane key={mount.view.room} room={mount.view.room} />
  ) : null
}

/**
 * A panel a plugin contributed.
 *
 * The contribution names a component the *renderer* publishes — `hd.panel`,
 * the data-driven block vocabulary — and this resolves that name and hands it
 * the contribution. No plugin code runs here; the render tree is never handed
 * over, which is the property `slots/registry.tsx` was built to keep and this
 * inherits rather than re-decides.
 *
 * A plugin that has gone — uninstalled, disabled, or not yet loaded after a
 * restart — leaves the panel saying so rather than an empty box with a working
 * close button and no explanation.
 */
const PluginView = () => {
  const mount = useMount()
  const snapshot = useSnapshot()
  const view = mount?.view.kind === 'plugin' ? mount.view : null
  const contribution = snapshot.contributions.find(
    (entry) => entry.kind === 'ui' && String(entry.id) === view?.contribution,
  )
  const Component = contribution?.kind === 'ui' ? resolveComponent(contribution.component) : undefined
  if (!view) return null
  if (!contribution || !Component) {
    return (
      <EmptyState
        icon={<PluginIcon />}
        title={view.label}
        description="The plugin that provides this panel is not running. It will fill in when the plugin loads; closing the panel forgets it."
      />
    )
  }
  return <Component contribution={contribution} />
}

registerView({
  kind: 'plugin',
  label: 'Plugin panel',
  icon: PluginIcon,
  /* Overridden per view: a plugin's panel carries its own `mounts`, and the
     registry asks the value rather than this list. What stays here is the
     superset, so nothing is refused before the value is consulted. */
  mounts: ['right', 'bottom', 'sidebar'],
  defaultMount: 'right',
  component: PluginView,
  title: (view) => (view.kind === 'plugin' ? view.label : 'Plugin panel'),
})

registerView({
  kind: 'conversation',
  label: 'Conversation',
  icon: SessionIcon,
  /* Main, and nowhere else. Reading a *second* harness while you work with the
     first is a real need and the right-dock mount used to serve it — but it
     served it by making a conversation a thing that moves, and then main was no
     longer a fixed point. The need is met inside the room instead, where the
     member columns show several transcripts at once under one roof, capped and
     headed by who they belong to. One place two transcripts can meet, and it is
     a view rather than a loose pane. */
  mounts: ['main'],
  defaultMount: 'main',
  component: ConversationView,
  bare: true,
})

registerView({
  kind: 'file',
  ownsChrome: true,
  label: 'File',
  icon: FileIcon,
  mounts: ['right', 'bottom'],
  defaultMount: 'right',
  component: FilePane,
  title: (view) => (view.kind === 'file' ? basename(view.path) : 'File'),
  bare: true,
})

registerView({
  kind: 'preview',
  ownsChrome: true,
  label: 'Preview',
  icon: ImageIcon,
  mounts: ['right', 'bottom'],
  defaultMount: 'right',
  component: PreviewPane,
  title: (view) => (view.kind === 'preview' ? basename(view.path) : 'Preview'),
  bare: true,
})

registerView({
  kind: 'browser',
  /* `/open` already exists and takes a path; this one only joins the menu. */
  menu: true,
  ownsChrome: true,
  label: 'Browser',
  hint: 'A page beside the conversation, and the one agents drive.',
  icon: GlobeIcon,
  /* Right, and only right. A page is something the work is done *from*, so it
     belongs beside the conversation rather than in place of it — and the bottom
     dock is the one edge that cannot hold it at all: bottom trades height for
     width, and a page rendered a few rows tall is not a page. This is the first
     entry to declare a *shape* constraint rather than a preference, and because
     it is the only one that leaves a view with nowhere else to go, it is also
     the one that leaves a lone browser with no move menu at all. */
  mounts: ['right'],
  defaultMount: 'right',
  component: BrowserPane,
  bare: true,
})

registerView({
  kind: 'terminal',
  /* `/terminal` already exists and takes a working directory. */
  menu: true,
  ownsChrome: true,
  label: 'Terminal',
  hint: "A shell in this conversation's directory.",
  icon: TerminalIcon,
  mounts: ['bottom', 'right'],
  defaultMount: 'bottom',
  component: TerminalSurface,
  title: (view) => (view.kind === 'terminal' ? terminalName(view) : 'Terminal'),
  bare: true,
})

registerView({
  kind: 'git',
  command: 'history',
  menu: true,
  ownsChrome: true,
  label: 'Repository',
  hint: "The repository's commits, branches and working tree.",
  icon: RepositoryIcon,
  /* History is a thing you consult, so it opens beside the conversation. It
     keeps the middle as a destination because the graph, the refs rail and a
     commit's diff genuinely want the width when the repository *is* the work. */
  mounts: ['right', 'bottom'],
  defaultMount: 'right',
  component: GitPane,
  title: (view) => (view.kind === 'git' ? basename(view.root) : 'Repository'),
  bare: true,
})

registerView({
  kind: 'board',
  /* No command and no menu item. The board is a *view inside the Room* — the
     rail's first entry — and a second door that opens it alone would make
     "where is my board" have two answers, one of which drops the chat and the
     members on the floor. It stays registered because a layout saved when it
     was a destination still names it, and a kind the registry cannot draw is a
     panel with a close button and nothing in it. */
  label: 'Board',
  icon: PlanIcon,
  mounts: ['right', 'bottom'],
  defaultMount: 'right',
  component: BoardView,
  title: (view, names) =>
    view.kind === 'board' ? `Board — ${names.rooms?.get(view.room) ?? 'room'}` : 'Board',
  bare: true,
})

registerView({
  kind: 'room',
  command: 'room',
  /* Reached from the tree, where the things you open live — not from a View
     menu, which is for panels, and this is not one: opening it takes the
     middle. The command stays for ⌘K, which is a search over destinations. */
  tree: true,
  label: 'Room',
  hint: "The board, the roster and every member's transcript, in one place.",
  icon: TeamIcon,
  /* Main, because the room *is* the work whenever it is open. Its board is
     five fixed states in columns and its member view puts transcripts side by
     side; neither survives a 300px edge. This is the second and last thing
     main can hold, and the pair is the whole rule: one conversation, or one
     room. */
  mounts: ['main'],
  defaultMount: 'main',
  component: RoomView,
  title: (view, names) =>
    view.kind === 'room' ? `Room — ${names.rooms?.get(view.room) ?? 'room'}` : 'Room',
  bare: true,
  /* The room draws the verbs on its own top row, so it gets no strip above it.
     It used to get one, and the strip printed `Room — <name>` over a rail that
     printed `<name>` — the same room named twice, in two rows, with a lone
     expand button at the end of the upper one. The room's row was already the
     better place for both; all it was missing was the promise to draw them.
     `chrome.test.ts` holds this to it. */
  ownsChrome: true,
})

registerView({
  kind: 'changes',
  command: 'changes',
  menu: true,
  label: 'Changes',
  hint: 'What this conversation edited, and what the tree looks like now.',
  icon: DiffIcon,
  mounts: ['right', 'bottom', 'sidebar'],
  defaultMount: 'right',
  component: ChangesView,
})

registerView({
  kind: 'trajectory',
  command: 'trajectory',
  menu: true,
  label: 'Trajectory',
  hint: 'Where the time and tokens went, turn by turn.',
  icon: TrajectoryIcon,
  mounts: ['right', 'bottom'],
  defaultMount: 'right',
  component: TrajectoryView,
})

registerView({
  kind: 'agents',
  command: 'agents',
  menu: true,
  label: 'Agents',
  hint: 'Every sub-agent this session started, and what it was asked.',
  icon: AgentIcon,
  mounts: ['right', 'bottom', 'sidebar'],
  defaultMount: 'right',
  component: AgentsView,
})

registerView({
  kind: 'activity',
  command: 'activity',
  menu: true,
  label: 'Activity',
  hint: 'What every agent did in this repository this week.',
  icon: HistoryIcon,
  mounts: ['right', 'bottom', 'sidebar'],
  defaultMount: 'right',
  component: ActivityView,
})

registerView({
  kind: 'tasks',
  command: 'tasks',
  menu: true,
  label: 'Background tasks',
  hint: 'Work this conversation started that keeps going after the turn, with its output.',
  icon: BackgroundIcon,
  /* Work that outlives the turn, with what it printed. Consulted beside the
     conversation like the other inspectors — it used to be a strip above the
     composer, which had room for a label and a clock and none for the output
     that is the reason anyone looks. */
  mounts: ['right', 'bottom', 'sidebar'],
  defaultMount: 'right',
  component: BackgroundTasksView,
  /* Something is still running for the conversation on screen: every door to
     this panel wears a dot, so a task that outlives the turn is noticed even
     with the panel closed. */
  live: (snapshot) => {
    const key = snapshot.activeSessionKey
    return key ? (snapshot.tasks.get(key) ?? []).some((task) => task.state === 'running') : false
  },
})
