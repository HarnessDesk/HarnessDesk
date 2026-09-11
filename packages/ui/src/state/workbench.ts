import type { UiArea } from '@harnessdesk/protocol'

import {
  close as closePane,
  emptyLayout,
  findPane,
  focus as focusPane,
  onlyMainViews,
  openView,
  panes,
  readLayout,
  readView,
  sameView,
  show as showInPane,
  type InspectorKind,
  type Layout,
  type PaneId,
  type PaneView,
  type TerminalView,
} from './layout'
import { INSPECTORS } from './layout'

/**
 * The workbench: where a feature is on screen, as data.
 *
 * Before this there were four layout mechanisms and no way to move anything
 * between them. `AppFrame` owned three grid columns whose widths lived in
 * `localStorage`; `layout.ts` owned the split tree in the middle; the terminal
 * dock owned a strip at the bottom; and the right-hand panel owned a closed set
 * of four tabs named by a `detailsTab` string. A feature was not placed
 * anywhere — it *was* its place. The Team surface is the proof: it existed
 * twice, once as a `Details` tab and once as a pane, because there was no way
 * to say "this view, over there".
 *
 * One vocabulary replaces all four:
 *
 *   **area**  — a place a panel can live: the sidebar, the main content area,
 *               the right edge, the bottom edge.
 *   **view**  — a mounted feature, as data. Its `view` field is the very same
 *               `PaneView` union the split tree already stores, so moving a
 *               feature from the middle to the bottom is moving a value, not
 *               translating between two shapes. That is the whole trick: with
 *               one currency, docking cannot drift.
 *   **dock**  — a stack of views along an edge, one on screen, with a size and
 *               a collapsed flag. The right panel, the bottom panel and the
 *               sidebar's lower stack are three instances of one thing.
 *   **zoom**  — one panel given the room, at one of two scopes.
 *
 * The main area keeps `layout.ts` exactly as it is: a binary tree of splits
 * whose ratios are already persisted, tested and load-bearing. This module
 * surrounds it rather than replacing it, so nothing that works today has to be
 * re-proven — and the split tree is what the main area *is*, in IDE terms: an
 * editor grid, while the docks are tool windows.
 *
 * Everything here is pure. The registry that knows which component draws a
 * `PaneView`, and where each may be mounted, lives in `panels/views.tsx` and is
 * reached through a `permits` predicate passed in — a model that imports a
 * component table is a model you cannot test without a DOM.
 */

// ------------------------------------------------------------------- areas

/**
 * The mount points. Adding one here is what "the panel system supports a new
 * place" means; every dock verb, the persistence and the zoom already work for
 * whatever this union says.
 *
 * It is the protocol's `UiArea` rather than a private copy, because a plugin
 * declares the areas its panel supports over the wire — and two spellings of
 * one vocabulary is how a plugin ends up asking for a place the renderer has
 * never heard of.
 */
export type AreaId = UiArea

export const AREAS: readonly AreaId[] = ['sidebar', 'main', 'right', 'bottom']

/** The docked areas — every area but the split tree. */
export type DockId = Exclude<AreaId, 'main'>

export const DOCKS: readonly DockId[] = ['sidebar', 'right', 'bottom']

/**
 * What each area is called in a sentence — "Move this panel *to the sidebar*".
 *
 * Here rather than beside the menu that reads it, because three files had a
 * copy and a fifth area would have needed four edits. The names belong with
 * `AREAS`, which is the list they have to stay in step with.
 */
export const AREA_NAME: Record<AreaId, string> = {
  sidebar: 'the sidebar',
  main: 'the main area',
  right: 'the right panel',
  bottom: 'the bottom panel',
}

/**
 * Which side each docked area draws its dividing rule on — the seam with
 * whatever it is beside.
 */
export const AREA_EDGE: Record<DockId, 'left' | 'right' | 'top' | 'bottom'> = {
  sidebar: 'top',
  right: 'left',
  bottom: 'top',
}

/**
 * The drag payload for a panel's tab: a mounted view's id, and nothing else.
 *
 * A MIME string that has to agree between the drag source and the drop target,
 * which is exactly the kind of constant that must not be typed twice.
 */
export const VIEW_DRAG_TYPE = 'application/x-harnessdesk-view'

/**
 * How far a dock may be dragged, and where it starts.
 *
 * Pixels rather than fractions, because these edges hold rows and lines: a
 * terminal wants 24 columns whatever the window is doing, and a file list at
 * 12% of a 3440px display is a different panel than at 12% of a laptop. The
 * split tree inside `main` keeps fractions for the opposite reason — two
 * documents side by side share the space they are given.
 */
const LIMITS: Record<DockId, { readonly min: number; readonly max: number; readonly start: number }> = {
  sidebar: { min: 120, max: 520, start: 240 },
  right: { min: 280, max: 900, start: 460 },
  bottom: { min: 80, max: 600, start: 220 },
}

/** The bounds a dock's size is held inside, for a handle that wants to draw them. */
export const dockLimits = (area: DockId): { readonly min: number; readonly max: number } => LIMITS[area]

const clampSize = (area: DockId, size: number): number =>
  Math.min(LIMITS[area].max, Math.max(LIMITS[area].min, Math.round(size)))

// ------------------------------------------------------------------- views

export type MountedId = string

/**
 * One feature, mounted.
 *
 * The id is the handle everything else uses — which tab is active, what is
 * zoomed, what a drag is carrying — and it survives a move between areas, so a
 * view dragged from the right panel to the bottom is recognisably the same
 * view and not a new one that happens to look alike.
 */
export interface Mounted {
  readonly id: MountedId
  readonly view: PaneView
}

/**
 * What a docked area holds: a tree of tab stacks, split horizontally or
 * vertically.
 *
 * A dock used to be one flat list — a strip of tabs with one view showing.
 * That answered "several things in this panel, one at a time" and could not
 * answer "two of them at once", which is the question that comes up the moment
 * you want the diff *and* the terminal, or two agents' transcripts beside each
 * other in the same column.
 *
 * The answer is not an `orientation` flag on the area. A flag says the whole
 * right-hand side is a column, and then the very next thing anyone wants is a
 * row inside one half of it, which a flag cannot express. Direction belongs to
 * a *container*, and a container has to be able to contain another one — so it
 * is a tree, and the direction sits on the branch.
 *
 * This is the same shape `dockview` and `rc-dock` converged on, and the same
 * shape `layout.ts` already uses for the main area. Naming it separately here
 * is a staging decision, not a fork: the main area's tree has invariants of its
 * own that are load-bearing and heavily tested (one conversation, a session in
 * one pane at most), and moving it onto this type is a second change worth
 * making on its own. The types are deliberately the same shape so that it can.
 */
export type DockNode = DockStack | DockBranch

/** A stack's own handle — what a drop names when it means "this half". */
export type StackId = string

/** A group of tabs, one of them showing. The leaves of the tree. */
export interface DockStack {
  readonly kind: 'stack'
  readonly id: StackId
  readonly views: readonly Mounted[]
  /** The tab on screen, by id. Null only when the stack is empty. */
  readonly active: MountedId | null
}

/** Two nodes sharing the space, with a seam between them. */
export interface DockBranch {
  readonly kind: 'branch'
  readonly id: string
  /** `row` puts them side by side; `column` stacks them. */
  readonly direction: 'row' | 'column'
  /** Fraction of the space the first child takes, clamped to keep both usable. */
  readonly ratio: number
  readonly first: DockNode
  readonly second: DockNode
}

export interface Dock {
  readonly root: DockNode
  /** Width for `right` and `sidebar`, height for `bottom`. Pixels. */
  readonly size: number
  /** Shown as its tab strip alone. Distinct from empty: the views are still there. */
  readonly collapsed: boolean
}

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

const clampRatio = (ratio: number): number => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

/**
 * A panel given the room.
 *
 * Two scopes rather than one because the two gestures answer different
 * questions. `content` fills the main content area and leaves the sidebar
 * standing — the reader still wants to change conversation. `window` takes
 * everything, which is what you press when the diff is the only thing that
 * matters for the next ten minutes. Every IDE worth copying has both (VS Code:
 * Maximize Panel, then Zen Mode; JetBrains: Maximize Tool Window, then
 * Distraction-Free); collapsing them into one control is the mistake that makes
 * people drag panels instead.
 */
export interface Zoom {
  readonly area: AreaId
  readonly scope: 'content' | 'window'
}

/**
 * Zoom names an *area*, never a view, and that is why it composes with what is
 * already there. Which pane inside the main area is zoomed is a question
 * `Layout.expanded` has answered correctly for as long as there have been
 * splits; asking it a second time here would be two fields that can disagree
 * about one screen. So: `expanded` picks the pane, `zoom` picks how much of the
 * window its area is given, and `{ area: 'main', scope: 'window' }` on top of an
 * expanded pane is one tool, alone, filling everything — composed from two
 * facts rather than enumerated as a third.
 */

export interface Workbench {
  /** The stack below the session tree: extra sections, and plugin views. */
  readonly sidebar: Dock
  /** The split tree. Unchanged from `layout.ts`; this is the editor grid. */
  readonly main: Layout
  readonly right: Dock
  readonly bottom: Dock
  readonly zoom: Zoom | null
  /**
   * The docked view that last took focus, if a docked view did.
   *
   * `layout.focused` names a pane and is what splitting, closing and expanding
   * act on; it cannot name something outside the tree. This is the wider
   * question — *which panel am I working in* — and it exists because a
   * conversation can now be docked to an edge. Without it, clicking into that
   * transcript would leave the sidebar, the command palette and the window
   * title all still pointed at the one in the middle.
   *
   * Null means "the main area", which is both the default and what it falls
   * back to whenever the panel it named goes away.
   */
  readonly focus: MountedId | null
}

let counter = 0
const nextId = (): MountedId => `view-${Date.now().toString(36)}-${(counter += 1).toString(36)}`

const emptyStack = (): DockStack => ({ kind: 'stack', id: nextId(), views: [], active: null })

export const emptyDock = (area: DockId): Dock => ({
  root: emptyStack(),
  size: LIMITS[area].start,
  collapsed: false,
})

export const emptyWorkbench = (): Workbench => ({
  sidebar: emptyDock('sidebar'),
  main: emptyLayout(),
  right: emptyDock('right'),
  bottom: emptyDock('bottom'),
  zoom: null,
  focus: null,
})

// ------------------------------------------------------------------ reading

export const dockOf = (workbench: Workbench, area: DockId): Dock => workbench[area]

/** Every stack in a dock, left to right and top to bottom. */
export const stacks = (node: DockNode): readonly DockStack[] =>
  node.kind === 'stack' ? [node] : [...stacks(node.first), ...stacks(node.second)]

/** Every view a dock holds, in reading order. */
export const dockViews = (dock: Dock): readonly Mounted[] =>
  stacks(dock.root).flatMap((stack) => stack.views)

/**
 * The view a stack is showing, falling back to the first so a stale id cannot
 * blank it.
 */
export const stackView = (stack: DockStack): Mounted | null =>
  stack.views.find((entry) => entry.id === stack.active) ?? stack.views[0] ?? null

/**
 * Everything a dock has on screen — one view per stack, not one per dock.
 *
 * The plural is the whole point of splitting a panel. Anything that asks "what
 * is showing" has to ask it of the area rather than of a single strip, or the
 * second stack is a panel the app does not know is being looked at: its
 * inspector would not light its button, its terminal would not be found.
 */
export const visibleViews = (dock: Dock): readonly Mounted[] =>
  stacks(dock.root).flatMap((stack) => {
    const shown = stackView(stack)
    return shown ? [shown] : []
  })

/** The first view a dock is showing, for the callers that only want one. */
export const activeView = (dock: Dock): Mounted | null => visibleViews(dock)[0] ?? null

/** The stack holding a view, by id. */
export const stackOf = (dock: Dock, id: MountedId): DockStack | null =>
  stacks(dock.root).find((stack) => stack.views.some((entry) => entry.id === id)) ?? null

/** Every mounted view outside the split tree, with the area holding it. */
export const mountedViews = (
  workbench: Workbench,
): readonly { readonly area: DockId; readonly mounted: Mounted }[] =>
  DOCKS.flatMap((area) => dockViews(workbench[area]).map((mounted) => ({ area, mounted })))

/** Where a docked view is, by id. Null for a pane in the split tree. */
export const areaOf = (workbench: Workbench, id: MountedId): DockId | null =>
  DOCKS.find((area) => dockViews(workbench[area]).some((entry) => entry.id === id)) ?? null

/** The area holding an id, counting the split tree — `main` for a pane. */
export const areaOfMount = (workbench: Workbench, id: string): AreaId =>
  areaOf(workbench, id) ?? 'main'

/** The mounted record for an id, wherever it is docked. */
export const mountedView = (workbench: Workbench, id: MountedId): Mounted | null => {
  for (const area of DOCKS) {
    const found = dockViews(workbench[area]).find((entry) => entry.id === id)
    if (found) return found
  }
  return null
}

/**
 * Where a thing already is on screen, if anywhere.
 *
 * `sameView` is the app's existing answer to "are these two the same thing" —
 * one browser, one board per repository, one file per path — and asking it
 * across every area is what stops a second open growing a duplicate somewhere
 * else instead of bringing the first one forward.
 */
export const findView = (
  workbench: Workbench,
  view: PaneView,
): { readonly area: DockId; readonly mounted: Mounted } | { readonly area: 'main'; readonly pane: PaneId } | null => {
  for (const area of DOCKS) {
    const found = dockViews(workbench[area]).find((entry) => sameView(entry.view, view))
    if (found) return { area, mounted: found }
  }
  const pane = panes(workbench.main.root).find((entry) => sameView(entry.view, view))
  return pane ? { area: 'main', pane: pane.id } : null
}

// ------------------------------------------------------------------ writing

/** Rewrites every stack in a tree. The one way the tree is edited. */
const mapStacks = (node: DockNode, fn: (stack: DockStack) => DockStack): DockNode =>
  node.kind === 'stack'
    ? fn(node)
    : { ...node, first: mapStacks(node.first, fn), second: mapStacks(node.second, fn) }

/**
 * Drops stacks that have emptied, and the branches left holding one child.
 *
 * A split whose half is empty is a seam with nothing on one side of it — a
 * handle that resizes nothing, next to a strip with no tabs. Closing the last
 * view in a stack has to take the stack with it, and the branch above it.
 * The root is the exception: an area with nothing in it keeps one empty stack,
 * because that is what the next thing docks into.
 */
const pruneNode = (node: DockNode): DockNode | null => {
  if (node.kind === 'stack') return node.views.length > 0 ? node : null
  const first = pruneNode(node.first)
  const second = pruneNode(node.second)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

const prunedDock = (dock: Dock): Dock => {
  /* An area that pruned to nothing keeps the stack it had rather than being
     given a fresh one. Minting a new id here made reading a saved layout back
     differ from the layout that was saved — by nothing that means anything,
     which is the worst kind of difference to have to explain. */
  const root = pruneNode(dock.root) ?? (dock.root.kind === 'stack' ? dock.root : emptyStack())
  return root === dock.root ? dock : { ...dock, root }
}

const patchDock = (workbench: Workbench, area: DockId, dock: Dock): Workbench => ({ ...workbench, [area]: dock })

/**
 * Ends a zoom that would hide the area something was just put into.
 *
 * Asking for a thing and being shown nothing is the worst failure a layout
 * has, because there is no error and nothing to press. A real one: a zoom
 * restored with the project had the main area filling the window; opening the
 * browser docked it to the right, correctly, where the zoom hid it — so the
 * button did nothing, twice, and then a third time.
 *
 * The same rule `settleExpansion` already applies to panes: **anything asked
 * onto the screen outranks an expansion**, because the expansion is a view of
 * the layout and the request is a change to it.
 */
const reveal = (workbench: Workbench, area: AreaId): Workbench =>
  areaVisible(workbench, area) ? workbench : { ...workbench, zoom: null }

/**
 * Mounts a view in a dock and brings it to the front.
 *
 * A view already mounted anywhere — including in the split tree — moves rather
 * than duplicating. Two panels showing one transcript would have to agree about
 * scroll position, draft and focus, and the second would lose every time; the
 * rule `layout.ts` already holds for panes holds across the whole workbench.
 */
export const dock = (workbench: Workbench, area: DockId, view: PaneView): Workbench => {
  const existing = findView(workbench, view)
  /*
   * Already docked in this area: bring it forward *where it is*.
   *
   * The general path below detaches and re-appends, which for a view already
   * in this strip is a move to the end of it — so summoning Trajectory a
   * second time reordered the whole panel, and the tab a person had just been
   * given always landed in the one position the strip cannot show without
   * scrolling. `activate` is the verb for this, and it leaves the other half
   * of a split alone.
   */
  if (existing && existing.area === area) return activate(workbench, area, existing.mounted.id)
  const id = existing && existing.area !== 'main' ? existing.mounted.id : nextId()
  const detached = reveal(existing ? detach(workbench, existing) : workbench, area)
  const current = detached[area]
  // Into the stack being worked in, when that stack is in this area — a panel
  // opened while you are reading one half of a split belongs in the half you
  // are reading, not in whichever the tree happens to list first.
  const target = landingStack(detached, area)
  return patchDock(detached, area, {
    ...current,
    root: mapStacks(current.root, (stack) =>
      stack.id === target.id ? { ...stack, views: [...stack.views, { id, view }], active: id } : stack,
    ),
    collapsed: false,
  })
}

/**
 * Puts a mounted view on the end of one named stack and shows it.
 *
 * The last step of every dock and every move, factored out because the three
 * of them wrote it three times and a fourth was about to.
 */
const landIn = (
  workbench: Workbench,
  area: DockId,
  mounted: Mounted,
  stackId: StackId,
): Workbench =>
  settle(
    patchDock(reveal(workbench, area), area, {
      ...workbench[area],
      root: mapStacks(workbench[area].root, (stack) =>
        stack.id === stackId
          ? { ...stack, views: [...stack.views, mounted], active: mounted.id }
          : stack,
      ),
      collapsed: false,
    }),
  )

/**
 * The stack a new view lands in: the one the drop named, else the focused one
 * if it is here, else the first.
 *
 * `into` is the half a drop actually pointed at. Honouring it only for a move
 * *within* one area — which is how this started — meant a tab dragged from the
 * bottom panel onto the lower half of a split right panel landed in the upper
 * one. The zone that lit up was the lower half's, because a zone is rendered
 * per stack, so the drop went somewhere the gesture did not point: the same
 * defect the same-area case was fixed for, on the other side of one `if`.
 *
 * A named half that is not in this area is ignored rather than obeyed. It is
 * a stale id, not a request, and minting a stack for it would put the view
 * somewhere nothing is drawn.
 */
const landingStack = (workbench: Workbench, area: DockId, into?: StackId): DockStack => {
  const all = stacks(workbench[area].root)
  const named = into === undefined ? null : (all.find((stack) => stack.id === into) ?? null)
  if (named) return named
  const focused = workbench.focus ? all.find((stack) => stack.views.some((e) => e.id === workbench.focus)) : null
  return focused ?? all[0]!
}

/**
 * Splits the stack holding a view, and moves that view into the new half.
 *
 * This is what makes a panel able to show two things at once. `direction` is
 * the branch's, not the area's: `row` puts the halves side by side, `column`
 * stacks them, and either can sit inside the other because the container is a
 * tree. `place` says which half the view moves to, so "split right" and "split
 * left" are one verb.
 */
export const splitDock = (
  workbench: Workbench,
  id: MountedId,
  direction: DockBranch['direction'],
  place: 'before' | 'after' = 'after',
): Workbench => {
  const area = areaOf(workbench, id)
  if (!area) return workbench
  const current = workbench[area]
  const from = stackOf(current, id)
  // A stack of one has nothing to split off: the result would be an empty
  // stack beside a full one, which is a seam with nothing on one side.
  if (!from || from.views.length < 2) return workbench
  const moving = from.views.find((entry) => entry.id === id)
  if (!moving) return workbench

  const kept = from.views.filter((entry) => entry.id !== id)
  const stays: DockStack = {
    ...from,
    views: kept,
    active: from.active === id ? (kept[kept.length - 1]?.id ?? null) : from.active,
  }
  const fresh: DockStack = { kind: 'stack', id: nextId(), views: [moving], active: moving.id }
  const branch: DockBranch = {
    kind: 'branch',
    id: nextId(),
    direction,
    ratio: 0.5,
    first: place === 'before' ? fresh : stays,
    second: place === 'before' ? stays : fresh,
  }
  const graft = (node: DockNode): DockNode =>
    node.kind === 'stack'
      ? node.id === from.id
        ? branch
        : node
      : { ...node, first: graft(node.first), second: graft(node.second) }
  return settle(
    focusView(patchDock(workbench, area, { ...current, root: graft(current.root), collapsed: false }), moving.id),
  )
}

/** Drags the seam between two halves of a dock. */
export const resizeDockSplit = (
  workbench: Workbench,
  area: DockId,
  branchId: string,
  ratio: number,
): Workbench => {
  const visit = (node: DockNode): DockNode =>
    node.kind === 'stack'
      ? node
      : node.id === branchId
        ? { ...node, ratio: clampRatio(ratio) }
        : { ...node, first: visit(node.first), second: visit(node.second) }
  return patchDock(workbench, area, { ...workbench[area], root: visit(workbench[area].root) })
}

/**
 * Takes a view off the screen, wherever it was.
 *
 * A pane is *closed*, not emptied. Emptying it means writing an empty
 * conversation into it, and `show` reads that as "put the conversation here" —
 * so it redirects to the pane the transcript is already in and blanks that
 * instead. Docking a tool would have silently closed the conversation beside
 * it, which is exactly the sort of thing a shared currency makes easy to get
 * wrong and easy to fix once.
 */
const detach = (
  workbench: Workbench,
  where: NonNullable<ReturnType<typeof findView>>,
): Workbench =>
  where.area === 'main'
    ? { ...workbench, main: closePane(workbench.main, where.pane) }
    : undock(workbench, where.mounted.id)

/**
 * Closes one docked view. Its neighbour takes the screen, which is what every
 * tab strip does and what stops a close leaving a blank panel with tabs above it.
 */
export const undock = (workbench: Workbench, id: MountedId): Workbench => {
  const area = areaOf(workbench, id)
  if (!area) return workbench
  const current = workbench[area]
  const root = mapStacks(current.root, (stack) => {
    if (!stack.views.some((entry) => entry.id === id)) return stack
    const index = stack.views.findIndex((entry) => entry.id === id)
    const views = stack.views.filter((entry) => entry.id !== id)
    return {
      ...stack,
      views,
      active: stack.active === id ? (views[Math.min(index, views.length - 1)]?.id ?? null) : stack.active,
    }
  })
  // An emptied stack takes its branch with it, so the space closes up rather
  // than leaving a seam beside nothing.
  return settle(patchDock(workbench, area, prunedDock({ ...current, root })))
}

/**
 * Docking, as a verb: the same view, a different area — or the other half of
 * the one it is in.
 *
 * `permits` is passed in rather than imported so this file stays a model. It
 * answers whether a definition allows an area — a conversation belongs in the
 * main area and nowhere else, a terminal belongs at the bottom or in the middle
 * — and a move it refuses is a no-op, not a throw: the panel system's job at a
 * bad drop is to leave the panel where it was.
 *
 * `into` names a *stack*, which is what makes a split panel reversible.
 * `splitDock` divides a panel in two and, without this, nothing put the halves
 * back: `from === to` returned the workbench untouched, so the drop zone in the
 * other half lit up, accepted the drop and did nothing — the one failure the
 * drop zones were written to avoid. The only way out of a split was to close
 * every view in one half, which is not a way out, it is a loss.
 */
export const moveView = (
  workbench: Workbench,
  id: MountedId,
  to: AreaId,
  permits: (view: PaneView, area: AreaId) => boolean,
  into?: StackId,
): Workbench => {
  const from = areaOf(workbench, id)
  if (!from) return moveFromMain(workbench, id, to, permits, into)
  const mounted = dockViews(workbench[from]).find((entry) => entry.id === id)
  if (!mounted || !permits(mounted.view, to)) return workbench
  if (from === to) {
    // Same area: only a named stack other than the one it is already in means
    // anything. No stack and its own stack are both a gesture asking for the
    // arrangement already on screen. (`from` is a dock, so `to` is one too —
    // a pane in the middle came in through `moveFromMain` above.)
    if (into === undefined) return workbench
    if (stackOf(workbench[from], id)?.id === into) return workbench
    if (!stacks(workbench[from].root).some((stack) => stack.id === into)) return workbench
    return landIn(undock(workbench, id), from, mounted, into)
    /* Deliberately not `landingStack` here: within one area a drop that names
       no half, or its own half, is a gesture asking for the arrangement
       already on screen, and must change nothing at all — where a *cross-area*
       drop with no half still has to land somewhere. Same word, two questions. */
  }

  const removed = undock(workbench, id)
  if (to === 'main') {
    const revealed = reveal(removed, 'main')
    return settle({ ...revealed, main: openInMain(revealed.main, mounted.view) })
  }
  return landIn(removed, to, mounted, landingStack(removed, to, into).id)
}

/** The other direction: a pane in the split tree docked to an edge. */
const moveFromMain = (
  workbench: Workbench,
  paneId: PaneId,
  to: AreaId,
  permits: (view: PaneView, area: AreaId) => boolean,
  into?: StackId,
): Workbench => {
  const pane = findPane(workbench.main, paneId)
  if (!pane || to === 'main' || !permits(pane.view, to)) return workbench
  // A conversation is never docked away: the main area is where it reads, and
  // `layout.ts` guarantees there is exactly one. Closing its pane instead would
  // silently end the session's place on screen.
  if (pane.view.kind === 'conversation') return workbench
  const closed = { ...workbench, main: closePane(workbench.main, paneId) }
  const mounted: Mounted = { id: nextId(), view: pane.view }
  return landIn(closed, to, mounted, landingStack(closed, to, into).id)
}

/**
 * Puts a view into the split tree.
 *
 * One tool pane per kind, which is the rule the app already keeps: a second
 * file takes the file pane rather than slicing the window into ever-narrower
 * columns. Only a kind with no pane yet earns a split, and it splits off the
 * focused pane rather than replacing it — replacing would put a panel where
 * the conversation was reading.
 */
const openInMain = (layout: Layout, view: PaneView): Layout => {
  const sameKind = panes(layout.root).find((pane) => pane.view.kind === view.kind)
  if (sameKind) return focusPane(showInPane(layout, sameKind.id, view), sameKind.id)
  return openView(layout, view, 'row')
}

/**
 * What is mounted at an id, wherever that id lives.
 *
 * The two kinds of id — a pane's and a docked view's — are both strings, and
 * on purpose: a feature addressed by id must not have to know which kind it
 * got. The browser's tab verbs are the case that proved it. They took a
 * `PaneId` and looked it up in the split tree, so the browser could only ever
 * be a pane; the moment it was allowed onto an edge, every one of them would
 * have been handed an id the tree had never heard of.
 */
export const viewAt = (workbench: Workbench, id: string): PaneView | null =>
  mountedView(workbench, id)?.view ?? findPane(workbench.main, id)?.view ?? null

/**
 * Swaps what is mounted at an id, keeping its place — in a strip or in a split.
 *
 * A restarted terminal is the case this exists for: the process behind the tab
 * is new, the tab is not. Re-docking would send it to the end of the strip and
 * take the screen from whatever the person had moved to.
 */
export const replaceView = (workbench: Workbench, id: MountedId, view: PaneView): Workbench => {
  const area = areaOf(workbench, id)
  if (!area) {
    return findPane(workbench.main, id)
      ? { ...workbench, main: showInPane(workbench.main, id, view) }
      : workbench
  }
  const current = workbench[area]
  return patchDock(workbench, area, {
    ...current,
    root: mapStacks(current.root, (stack) => ({
      ...stack,
      views: stack.views.map((entry) => (entry.id === id ? { ...entry, view } : entry)),
    })),
  })
}

/** Takes whatever is at an id off the screen, in a strip or in a split. */
export const removeAt = (workbench: Workbench, id: string): Workbench =>
  areaOf(workbench, id) !== null
    ? undock(workbench, id)
    : findPane(workbench.main, id)
      ? settle({ ...workbench, main: closePane(workbench.main, id) })
      : workbench

export const activate = (workbench: Workbench, area: DockId, id: MountedId): Workbench => {
  const current = workbench[area]
  const holding = stackOf(current, id)
  if (!holding) return workbench
  // Only the stack holding it changes. A split panel has one active tab per
  // stack, and bringing a tab forward in one half must not disturb the other.
  return patchDock(reveal(workbench, area), area, {
    ...current,
    root: mapStacks(current.root, (stack) => (stack.id === holding.id ? { ...stack, active: id } : stack)),
    collapsed: false,
  })
}

/**
 * The mount being worked in, wherever it is.
 *
 * Two fields hold this between them — `workbench.focus` for a docked panel,
 * `layout.focused` for a pane — and everything that asks "am I the one with
 * the focus" has to ask it of both or it is wrong for half the app. Asking
 * only `layout.focused` is what left a docked conversation permanently
 * unfocused: its composer ignored `harnessdesk:compose`, its approvals never
 * took the keyboard, and the browser's ⌘T / ⌘L / ⌘1-9 stopped arming the
 * moment it moved to the right-hand edge, which is now where it opens.
 */
export const focusedMount = (workbench: Workbench): string =>
  workbench.focus ?? workbench.main.focused

/**
 * Marks a docked view as the one being worked in; null hands focus back to the
 * main area. A view that is not docked cannot take it — the split tree has
 * `layout.focused` for that, and two fields naming one pane would drift.
 */
export const focusView = (workbench: Workbench, id: MountedId | null): Workbench =>
  id === null || areaOf(workbench, id) !== null ? { ...workbench, focus: id } : workbench

export const resizeDock = (workbench: Workbench, area: DockId, size: number): Workbench =>
  patchDock(workbench, area, { ...workbench[area], size: clampSize(area, size) })

/**
 * Collapses a dock to its tab strip.
 *
 * The views stay mounted. A diff mid-read, a terminal's scrollback and a
 * browser's pages must all survive being put away and taken out again, which is
 * the difference between collapsing a panel and closing one.
 */
export const collapseDock = (workbench: Workbench, area: DockId, collapsed: boolean): Workbench =>
  settle(patchDock(workbench, area, { ...workbench[area], collapsed }))

/** Collapses a dock if it is open, opens it if it is not — the one control on a toggle. */
export const toggleDock = (workbench: Workbench, area: DockId): Workbench =>
  collapseDock(workbench, area, !workbench[area].collapsed)

// --------------------------------------------------------------- terminals

/**
 * The terminals, and where they are.
 *
 * A terminal is a view like any other now — it was already a `PaneView`, it
 * simply had a container of its own — so the bottom panel holds them the way it
 * holds anything else and these three helpers are the whole of what the shell
 * verbs need. What used to be a `Dock` type, five reducers and a component's
 * own tab strip is this.
 */
const isTerminal = (view: PaneView): view is TerminalView => view.kind === 'terminal'

export const terminals = (workbench: Workbench): readonly TerminalView[] =>
  dockViews(workbench.bottom).map((entry) => entry.view).filter(isTerminal)

/**
 * The terminal on screen, if the bottom panel is showing one.
 *
 * "On screen" is plural now that a panel can be split, so this asks every
 * visible stack before falling back — a shell in the right-hand half of a
 * split bottom panel is as visible as one in the left.
 */
export const activeTerminal = (workbench: Workbench): TerminalView | null => {
  const shown = visibleViews(workbench.bottom).find((entry) => isTerminal(entry.view))
  return shown ? (shown.view as TerminalView) : (terminals(workbench)[0] ?? null)
}

/** The mount holding a given process, for the verbs that speak in terminal ids. */
export const mountOfTerminal = (workbench: Workbench, terminalId: string): MountedId | null =>
  dockViews(workbench.bottom).find(
    (entry) => isTerminal(entry.view) && entry.view.terminalId === terminalId,
  )?.id ?? null

// -------------------------------------------------------------- inspectors

/**
 * The inspector a person can see right now, if any — Changes, Trajectory,
 * Agents or Activity.
 *
 * Every control that opens one also lights up while it is open, and that needs
 * one answer no matter where the view ended up: the right panel it starts in,
 * the bottom panel someone dragged it to, or a pane in the split tree. Asking
 * "is the right panel on `changes`" was the old answer, and it went wrong the
 * moment the view could be somewhere else.
 */
export const visibleInspector = (workbench: Workbench): InspectorKind | null => {
  const inspector = (view: PaneView): InspectorKind | null =>
    (INSPECTORS as readonly string[]).includes(view.kind) ? (view.kind as InspectorKind) : null
  for (const area of DOCKS) {
    const held = workbench[area]
    if (held.collapsed) continue
    // Every visible stack, not just the first. A split dock showing a terminal
    // on the left and Changes on the right had an inspector plainly on screen
    // that this reported as absent, so every control that lights up while
    // Changes is open stayed dark.
    for (const shown of visibleViews(held)) {
      const found = inspector(shown.view)
      if (found) return found
    }
  }
  for (const pane of panes(workbench.main.root)) {
    const found = inspector(pane.view)
    if (found) return found
  }
  return null
}

/**
 * Whether a kind is on screen anywhere — any visible stack, or the split tree.
 *
 * The View menu ticks what is already open, and "open" cannot mean "the right
 * panel is on this tab" once a panel can be split and a view can be moved. It
 * means what a person means by it: I can see it.
 */
export const shownView = (workbench: Workbench, kind: PaneView['kind']): boolean => {
  for (const area of DOCKS) {
    const held = workbench[area]
    if (held.collapsed) continue
    if (visibleViews(held).some((entry) => entry.view.kind === kind)) return true
  }
  return panes(workbench.main.root).some((pane) => pane.view.kind === kind)
}

// -------------------------------------------------------------------- zoom

/**
 * Gives a panel the room, or hands it back.
 *
 * Pressing the same scope on the same panel twice is a request to leave, which
 * is what makes one key both take and return the room. A different scope on the
 * same panel widens or narrows it rather than dropping out first.
 */
export const zoomArea = (workbench: Workbench, area: AreaId, scope: Zoom['scope']): Workbench => {
  const current = workbench.zoom
  const same = current?.area === area && current.scope === scope
  return settle({ ...workbench, zoom: same ? null : { area, scope } })
}

export const unzoom = (workbench: Workbench): Workbench =>
  workbench.zoom === null ? workbench : { ...workbench, zoom: null }

/** Whether an area is the one currently given the room. */
export const zoomedArea = (workbench: Workbench, area: AreaId): boolean => workbench.zoom?.area === area

// ------------------------------------------------------------- invariants

/**
 * Everything that must be true before a workbench is shown, in one place.
 *
 * Each of these was a way for the screen to lie. An `active` naming a view that
 * was just closed shows a panel with tabs and no body. A dock collapsed with
 * nothing in it draws a strip of furniture around nothing. A zoom pointed at a
 * panel that is gone — closed, undocked, collapsed — takes the whole window and
 * fills it with nothing at all, which is the worst of the three because there
 * is no visible control to press to get out.
 */
export const settle = (workbench: Workbench): Workbench => {
  let next = workbench
  for (const area of DOCKS) {
    const current = next[area]
    const pruned = prunedDock(current)
    const root = mapStacks(pruned.root, (stack) => {
      const active =
        stack.active !== null && stack.views.some((entry) => entry.id === stack.active)
          ? stack.active
          : (stack.views[0]?.id ?? null)
      return active === stack.active ? stack : { ...stack, active }
    })
    const collapsed = dockViews(pruned).length === 0 ? false : pruned.collapsed
    if (root !== pruned.root || pruned !== current || collapsed !== current.collapsed) {
      next = patchDock(next, area, { ...pruned, root, collapsed })
    }
  }
  // Focus never names a panel that has gone; it falls back to the main area,
  // which is the one place that is always there.
  if (next.focus !== null && areaOf(next, next.focus) === null) next = { ...next, focus: null }
  const zoom = next.zoom
  if (zoom === null) return next
  // The main area is always there. A dock given the room must have something in
  // it and must not be collapsed, or the zoom takes the window and fills it
  // with nothing — the worst failure of the three, because there is then no
  // visible control to press to get back out.
  if (zoom.area === 'main') return next
  const held = next[zoom.area]
  return dockViews(held).length > 0 && !held.collapsed ? next : { ...next, zoom: null }
}

/**
 * Whether an area is on screen right now.
 *
 * A zoom hides its rivals rather than closing them: everything stays mounted,
 * so a diff mid-read, a terminal's scrollback and a browser's pages all come
 * back exactly as they were. `content` leaves the sidebar standing because
 * changing conversation is still a thing you do; `window` takes that too.
 */
export const areaVisible = (workbench: Workbench, area: AreaId): boolean => {
  const zoom = workbench.zoom
  if (zoom === null) return true
  if (zoom.area === area) return true
  return zoom.scope === 'content' && area === 'sidebar'
}

/**
 * Which area holds the window's top-left corner.
 *
 * macOS draws its own close, minimise and zoom buttons there, over whatever
 * the app puts underneath — so exactly one row in the window has to leave room
 * for them, and *which* row it is moves. It is the sidebar's title bar while
 * the sidebar is up; with the sidebar away it is the top-left of the main
 * area; and a panel zoomed to fill the window takes the corner with it.
 *
 * Answered here rather than in the component so it is one rule with one test,
 * instead of a `sidebarCollapsed &&` written out again in every header that
 * might find itself in the corner — which is what left the repository's own
 * header printing "History" under the buttons.
 *
 * The last two branches lean on `settle`: the middle is only ever off screen
 * because a zoom is hiding it — `areaVisible` reads nothing else — and a zoom
 * whose dock is empty or collapsed does not survive `settle`, which every zoom
 * passes through, `readWorkbench` included. So a document that was saved with
 * the room given to a panel since emptied restores with no zoom at all, and
 * whichever dock is left here is one with something in it. `dockViews` is asked
 * anyway, so that if some later change hides the middle another way the corner
 * lands on a panel that is actually drawn rather than on an empty one. Both
 * halves of that are pinned in `workbench.test.ts`.
 */
export const cornerArea = (workbench: Workbench, sidebarShown: boolean): AreaId =>
  sidebarShown
    ? 'sidebar'
    : areaVisible(workbench, 'main')
      ? 'main'
      : areaVisible(workbench, 'right') && dockViews(workbench.right).length > 0
        ? 'right'
        : 'bottom'

// ---------------------------------------------------------- narrow windows

/**
 * The narrowest window that still gives the sidebar a column.
 *
 * It is the desktop window's own minimum (`minWidth` in the shell's
 * `electron/main.mjs`), so every width the desktop app can take at its
 * ordinary zoom keeps the layout it has always had. A browser goes narrower —
 * a phone, a tab dragged thin — and so does the desktop app zoomed in, whose
 * window is measured in CSS pixels and is then narrower than it looks; the
 * narrow layout is right there too, since everything on it is bigger. Below
 * the line a 240px column left the conversation 135px: a composer wrapping its
 * placeholder a word to a line and a header whose title was one pixel wide. Below this line the sidebar floats over the conversation
 * instead of standing beside it, and a panel docked on the right takes the
 * conversation's whole width while it is open.
 */
export const NARROW_WINDOW = 720

/**
 * Where the sidebar is drawn.
 *
 *   column    beside the conversation, the way it always has been
 *   floating  over the conversation, in a window too narrow for a column
 *   away      not on screen
 *
 * Two pieces of state feed it, because the two widths are asked different
 * questions. `sidebarCollapsed` is the column's: a choice about a wide window,
 * which a person expects to find again when the window is wide again.
 * `sidebarFloating` is the narrow window's, and it is closed whichever way the
 * line is crossed — a sidebar that opened itself over the conversation the
 * moment a window got narrow would be the column's choice, carried somewhere
 * it no longer fits.
 *
 * And a panel given the whole window hides the sidebar whatever either says,
 * which is `away` too — so a control that shows the sidebar never claims it is
 * already on screen while nothing is.
 */
export type SidebarPlacement = 'column' | 'floating' | 'away'

export const sidebarPlacement = (state: {
  readonly narrowWindow: boolean
  readonly sidebarCollapsed: boolean
  readonly sidebarFloating: boolean
  readonly workbench: Workbench
}): SidebarPlacement =>
  !areaVisible(state.workbench, 'sidebar')
    ? 'away'
    : state.narrowWindow
      ? state.sidebarFloating
        ? 'floating'
        : 'away'
      : state.sidebarCollapsed
        ? 'away'
        : 'column'

// ------------------------------------------------------------- persistence

/**
 * Reads a workbench back, including from before there was one.
 *
 * The saved shape used to be a bare `Layout`. Such a document still restores
 * — as the main area, with empty docks — because a person who upgrades should
 * find their panes where they left them, not an empty window with a note about
 * a new layout engine. A malformed document costs the layout, never the window.
 */
export const readWorkbench = (raw: unknown): Workbench | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>

  // The old shape: a Layout, saved directly. It has a `root`; a workbench has a
  // `main`. That one key is the whole discriminator, and it cannot collide.
  const read = readLayout('main' in record ? record['main'] : record)
  if (!read) return null

  /* Git, the browser, files, previews and the rest were all legal in the middle
     before it became a two-valued slot, and a document written then restores
     verbatim — so an existing user could open into a state the invariant says
     is impossible, with the repository view occupying the slot and no verb that
     could have put it there. `strayPanels` hands the same views back so the
     caller can re-dock them, because a person cannot tell a panel that migrated
     from one that vanished and only one of those is a bug they would report. */
  const main = onlyMainViews(read)

  return settle({
    sidebar: readDock('sidebar', record['sidebar']),
    main,
    right: readDock('right', record['right']),
    bottom: readDock('bottom', record['bottom']),
    zoom: readZoom(record['zoom']),
    focus: typeof record['focus'] === 'string' ? record['focus'] : null,
  })
}

/**
 * A dock from persisted state, including from before it could split.
 *
 * The flat shape — `{ views, active }` — reads back as a single stack, because
 * that is exactly what it was. Nobody loses their panels to the upgrade, and
 * the migration is one branch rather than a version field.
 */
const readDock = (area: DockId, raw: unknown): Dock => {
  if (typeof raw !== 'object' || raw === null) return emptyDock(area)
  const record = raw as Record<string, unknown>
  const root = readDockNode(record['root']) ?? readStack(record) ?? emptyStack()
  return prunedDock({
    root,
    size: clampSize(area, typeof record['size'] === 'number' ? record['size'] : LIMITS[area].start),
    collapsed: record['collapsed'] === true,
  })
}

const readDockNode = (raw: unknown): DockNode | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record['kind'] === 'branch') {
    const first = readDockNode(record['first'])
    const second = readDockNode(record['second'])
    if (!first || !second || typeof record['id'] !== 'string') return null
    if (record['direction'] !== 'row' && record['direction'] !== 'column') return null
    return {
      kind: 'branch',
      id: record['id'],
      direction: record['direction'],
      ratio: clampRatio(typeof record['ratio'] === 'number' ? record['ratio'] : 0.5),
      first,
      second,
    }
  }
  return readStack(record)
}

const readStack = (record: Record<string, unknown>): DockStack | null => {
  if (!Array.isArray(record['views'])) return null
  const views = record['views'].flatMap((entry): Mounted[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const mounted = entry as Record<string, unknown>
    const id = typeof mounted['id'] === 'string' ? mounted['id'] : null
    if (!id) return []
    const view = readMountedView(mounted['view'])
    return view ? [{ id, view }] : []
  })
  const active =
    typeof record['active'] === 'string' && views.some((entry) => entry.id === record['active'])
      ? record['active']
      : (views[0]?.id ?? null)
  return {
    kind: 'stack',
    id: typeof record['id'] === 'string' ? record['id'] : nextId(),
    views,
    active,
  }
}

/**
 * A docked view's payload, validated by the pane reader.
 *
 * `readView` already validates every `PaneView` there is; borrowing it is what
 * keeps one union with one reader. Two readers is how a kind ends up restorable
 * in a pane and not in a panel.
 */
const readMountedView = (raw: unknown): PaneView | null => {
  const view = readView(raw)
  // An empty conversation is what `readView` returns for a payload that did not
  // survive, and it is also not something a dock should ever hold: the docks
  // take tools, and the conversation lives in the main area.
  return view.kind === 'conversation' && view.session === null ? null : view
}

const readZoom = (raw: unknown): Zoom | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const area = AREAS.find((entry) => entry === record['area'])
  if (!area) return null
  return { area, scope: record['scope'] === 'window' ? 'window' : 'content' }
}
