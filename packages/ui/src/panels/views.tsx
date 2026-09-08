import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import type { IconProps } from '../components/Icons'
import type { AreaId } from '../state/workbench'
import type { PaneView } from '../state/layout'
import type { AppSnapshot } from '../state/store'
import { useSnapshot } from '../state/context'

/**
 * The view registry: which component draws a view, and where it may live.
 *
 * This is the seam the whole panel system exists for. `state/workbench.ts`
 * knows about areas, sizes and stacks and has never heard of React; the
 * features know about diffs and terminals and have never heard of areas. This
 * table is the only place the two meet, and it meets them by *kind* — a string
 * on a value — so neither side holds a reference to the other.
 *
 * What that buys, concretely: `Changes` is written once and can be the right
 * panel's tab, the bottom panel's tab, or a pane in the split tree, and it
 * cannot tell which it is. Before this, the same feature existed twice — the
 * Team surface was a `Details` tab *and* a pane, two implementations of one
 * idea, because there was no way to say "this view, over there".
 *
 * ### `mounts` is a declaration, not a hint
 *
 * A definition names the areas it supports and the panel system refuses the
 * rest: a drop onto an area a view does not declare leaves the view where it
 * was. This is the contract a plugin will be held to as well — the protocol's
 * `ui` contribution already names a component id the renderer resolves; giving
 * it a `mounts` list is the same idea one level up, and it means a plugin can
 * say "my panel belongs on an edge, never in the editor grid" and be believed.
 *
 * ### One registry, built-ins included
 *
 * The same rule `slots/registry.tsx` set: HarnessDesk's own views register here
 * beside contributed ones. A separate first-class path for built-ins is how an
 * extension surface rots — nobody notices it broken, because nothing they run
 * uses it.
 */

export interface ViewDefinition {
  /** The `PaneView` kind this draws. One definition per kind. */
  readonly kind: PaneView['kind']
  /** What menus and the "move to" list call it. */
  readonly label: string
  readonly icon: ComponentType<IconProps>
  /** Where this view may be mounted. A set — order carries no meaning. */
  readonly mounts: readonly AreaId[]
  /**
   * Where it opens when nothing says otherwise. Required, and separate from
   * `mounts`, because a default hidden in array order is a behaviour change
   * anyone can cause by tidying a list — and nothing would fail.
   */
  readonly defaultMount: AreaId
  /**
   * Its way in is the session tree, not the View menu.
   *
   * A third kind of door, and the reason it needs saying: the View menu is for
   * *panels* — things you put beside the work. A view that takes the middle is
   * a destination, and destinations live in the tree beside the conversations,
   * because that is where a person looks for something to open. Declaring it
   * here keeps the contract in `summon.test.ts` honest: every summonable view
   * still has to name a way in, this is simply one the menu cannot express.
   */
  readonly tree?: boolean
  /** Rendered with no props at all — its parameters come from the mount. */
  readonly component: ComponentType
  /**
   * What a tab says for one instance of the view, when the label is not
   * enough: a file panel says the file's name, a repository panel the folder's.
   *
   * `names` resolves things the view is keyed by but does not carry — a room
   * is an id on the view and a name on the board, and a tab reading
   * `Room — room-mf3k2-1` is a tab nobody can use.
   */
  readonly title?: (view: PaneView, names: ViewNames) => string
  /**
   * Set when the view paints its own frame — a header, a body, its own ground.
   * The panel then gives it the whole box and draws no header of its own,
   * which is what stops a conversation growing two title bars.
   */
  readonly bare?: boolean
  /**
   * Set when the view's own header renders `<PanelActions />`.
   *
   * Alone in a stack, such a view gets no strip above it at all: its header is
   * the only row, and the panel's verbs sit at the end of it. That is what
   * stops the browser showing a tab row above its tab row.
   *
   * It is deliberately *not* the same flag as `bare`. `bare` says "I paint my
   * own frame", which the conversation and the board also do — but neither has
   * anywhere to put an expand button, so a strip is exactly what they need.
   * This one is a promise to draw the controls, and a view that makes it and
   * does not keep it is a panel you cannot move, expand or close.
   */
  readonly ownsChrome?: boolean
  /**
   * How a person summons this view, when it takes no argument.
   *
   * The panel system said where a feature *lives* and left how you *reach* it
   * exactly as scattered as it was: Changes had six entry points and
   * Trajectory had one, the repository and the board had no header control at
   * all, and the header's View menu was a hand-written list that had already
   * drifted from the four it claimed to draw. All of that came from the
   * entry points being written where they were used rather than declared
   * where the view is.
   *
   * `command` is the slash name — one string, and ⌘K builds the entry. `menu`
   * puts it in the conversation header's View group. A view needing an
   * argument (a file, a path) declares neither and keeps its bespoke command,
   * because "open *what*" is not something a list can answer.
   */
  readonly command?: string
  readonly menu?: boolean
  /**
   * One sentence saying what is in there, for the doors that have room for it.
   *
   * The View menu shows it on hover and the palette searches it, which is how
   * "tokens" finds Trajectory and "sub-agent" finds Agents. These sentences
   * used to live in a `VIEWS` table in `Details.tsx` that the menu and the
   * palette both read; when both moved to this registry the sentences stayed
   * behind, so the menu's hover description quietly became nothing at all and
   * the palette lost every keyword but the view's own name. A description of a
   * view belongs with the view.
   */
  readonly hint?: string
  /**
   * Whether the view has something going on right now that a person would
   * want to look at — a task still running in the background, say.
   *
   * Every door to the view reads it and wears a small green dot when it
   * answers true: the ⋯ menu's item, the panel's tab while another tab is in
   * front or the panel is collapsed, and the conversation's row in the
   * sidebar. A view without a notion of "still going" leaves it out, and
   * the doors stay quiet. A predicate over the snapshot rather than a flag,
   * so the registry holds no state of its own and cannot drift from the
   * store's.
   */
  readonly live?: (snapshot: AppSnapshot) => boolean
}

class ViewRegistry {
  readonly #byKind = new Map<string, ViewDefinition>()

  register(definition: ViewDefinition): void {
    this.#byKind.set(definition.kind, definition)
  }

  get(kind: string): ViewDefinition | undefined {
    return this.#byKind.get(kind)
  }

  all(): readonly ViewDefinition[] {
    return [...this.#byKind.values()]
  }

  /**
   * Whether a view may be mounted in an area.
   *
   * An unregistered kind permits nothing. That is deliberate: a view the
   * renderer cannot draw must not be dockable into a panel that would then
   * show an empty box with a working close button and no way to tell what went
   * wrong.
   */
  permits(view: PaneView, area: AreaId): boolean {
    return this.mounts(view).includes(area)
  }

  /** The areas a view may move to, excluding the one it is in. */
  destinations(view: PaneView, from: AreaId): readonly AreaId[] {
    return this.mounts(view).filter((area) => area !== from)
  }

  /**
   * Where a view may be mounted.
   *
   * A plugin's panel answers for itself, from the list it was contributed
   * with. The alternative — looking the contribution up here — would mean a
   * restored layout could not say where its plugin panels may go until the
   * plugin host had come back and re-registered them, so for a moment every
   * one of them may go nowhere.
   */
  mounts(view: PaneView): readonly AreaId[] {
    if (view.kind === 'plugin') return view.mounts
    return this.#byKind.get(view.kind)?.mounts ?? []
  }
}

export const views = new ViewRegistry()

export const registerView = (definition: ViewDefinition): void => views.register(definition)

/** Whether a view may be mounted in an area — the predicate the model takes. */
export const permits = (view: PaneView, area: AreaId): boolean => views.permits(view, area)

/**
 * The views a person can summon by name, in the order they are offered.
 *
 * One list, read by ⌘K and by the conversation header's View group, so a view
 * registered once appears in both — and one removed disappears from both. The
 * entry points used to be written where they were used rather than declared
 * where the view is, which is why Changes had six of them and Trajectory had
 * one reachable only from a hand-written menu.
 */
export const summonable = (): readonly ViewDefinition[] =>
  views.all().filter((definition) => definition.command !== undefined || definition.menu === true)


/**
 * Where a view goes when nothing says otherwise.
 *
 * One answer, in one table, for the dozen call sites that open something. The
 * alternative is what the app had — each opener choosing a direction to split
 * in, so "where does the browser appear" had three answers depending on which
 * of them you reached it through.
 *
 * A plugin's panel is the one case that still falls back to the first area it
 * declares: the contribution may name a `defaultMount`, and asking authors to
 * repeat themselves when they have named one area is a worse trade than the
 * fallback. The registry's own definitions have no such excuse.
 */
export const defaultArea = (view: PaneView): AreaId | null => {
  if (view.kind === 'plugin') return view.mounts[0] ?? null
  const definition = views.get(view.kind)
  return definition ? definition.defaultMount : null
}

/**
 * What the app can look up on a view's behalf when a title needs it.
 *
 * Kept to a plain map rather than the snapshot so `titleOf` stays a pure
 * function of what it is given, and every caller that has no rooms to offer
 * still gets a title rather than an exception.
 */
export interface ViewNames {
  readonly rooms?: ReadonlyMap<string, string>
}

/** What a panel's tab says for this view. */
export const titleOf = (view: PaneView, names: ViewNames = {}): string => {
  const definition = views.get(view.kind)
  if (!definition) return 'Unknown'
  return definition.title?.(view, names) ?? definition.label
}

export const iconOf = (view: PaneView): ComponentType<IconProps> | null =>
  views.get(view.kind)?.icon ?? null

/**
 * `titleOf`, with the app's own rooms already resolved.
 *
 * Every tab in the app goes through one of a handful of call sites, and each
 * of them wants the same lookup. A hook keeps the resolution in one place
 * rather than four, so a tab in the pane strip and the same tab in the panel
 * header can never disagree about what a room is called.
 */
export const useViewTitle = (): ((view: PaneView) => string) => {
  const snapshot = useSnapshot()
  const rooms = useMemo(
    () => new Map([...snapshot.teams].map(([id, state]) => [id, state.name])),
    [snapshot.teams],
  )
  return useCallback((view: PaneView) => titleOf(view, { rooms }), [rooms])
}

// ------------------------------------------------------------------- shell

/**
 * The four things a view may need from the window it is inside: choose a
 * project, sign in, open Usage, open the agent settings.
 *
 * They are here, in a context, because they are the last thing that was passed
 * down through the layout as props — and props threaded through a layout are
 * exactly what couples a feature to its position. `Panes` carried all four
 * through three components so that a conversation nested inside the team room
 * could reach them; a view mounted in the bottom panel would have needed a
 * fifth path. One provider at the shell serves every mount point there will
 * ever be.
 */
export interface ShellActions {
  readonly chooseProject: () => void
  readonly signIn: (runtime?: RuntimeId) => void
  readonly openUsage: (runtime: RuntimeId) => void
  readonly openAgents: () => void
}

const NONE: ShellActions = {
  chooseProject: () => undefined,
  signIn: () => undefined,
  openUsage: () => undefined,
  openAgents: () => undefined,
}

const ShellContext = createContext<ShellActions>(NONE)

export const ShellProvider = ({
  actions,
  children,
}: {
  actions: ShellActions
  children: ReactNode
}) => <ShellContext.Provider value={actions}>{children}</ShellContext.Provider>

export const useShell = (): ShellActions => useContext(ShellContext)

/**
 * Draws whatever the registry says draws this view.
 *
 * The one place a `PaneView` becomes React. It lives here rather than in the
 * host because both the split tree and the docks need it, and a shared helper
 * in either of them would make the two import each other.
 *
 * An unregistered kind draws nothing, deliberately: a persisted layout naming
 * a view this build does not have should cost that panel, not the window.
 */
export const ViewHost = ({ view }: { view: PaneView }) => {
  const definition = views.get(view.kind)
  if (!definition) return null
  const Component = definition.component
  return <Component />
}
