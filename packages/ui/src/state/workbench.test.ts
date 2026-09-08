import { describe, expect, test } from 'vitest'

import { sessionKey } from '@harnessdesk/protocol'

import { open, panes, sessionOf, split, strayPanels, type PaneView, type TerminalView } from './layout'
import {
  activate,
  activeTerminal,
  activeView,
  areaOf,
  areaVisible,
  collapseDock,
  cornerArea,
  dock,
  dockViews,
  emptyWorkbench,
  findView,
  focusView,
  focusedMount,
  mountOfTerminal,
  moveView,
  readWorkbench,
  removeAt,
  replaceView,
  resizeDock,
  viewAt,
  resizeDockSplit,
  settle,
  splitDock,
  stackOf,
  stackView,
  stacks,
  visibleViews,
  terminals,
  toggleDock,
  undock,
  visibleInspector,
  zoomArea,
  type AreaId,
  type DockBranch,
  type DockId,
  type DockStack,
  type Workbench,
} from './workbench'

/**
 * The panel model.
 *
 * Four areas, one currency. What is pinned here is everything the screen can
 * lie about if the model gets it wrong — and each of these was a real failure
 * mode of the four separate mechanisms this replaces:
 *
 *   Docking does not duplicate.   Two panels showing one thing would have to
 *                                 agree about scroll position, draft and
 *                                 focus, and the second would lose every time.
 *   `mounts` is enforced.         A view that says it does not belong in an
 *                                 area does not end up there, and a refused
 *                                 drop leaves it where it was rather than
 *                                 throwing or vanishing it.
 *   Closing hands the screen on.  A panel with tabs above an empty body is a
 *                                 panel that looks broken.
 *   A zoom cannot outlive its     A zoom pointed at a panel that has been
 *   subject.                      closed takes the window and fills it with
 *                                 nothing, and there is then no visible
 *                                 control to press to get back out.
 *   Old documents still open.     A layout saved before any of this existed
 *                                 restores as the main area, and its terminals
 *                                 come back as views.
 */

const A = sessionKey('codex' as never, 'a' as never)
const B = sessionKey('codex' as never, 'b' as never)

const CHANGES: PaneView = { kind: 'changes' }
const ACTIVITY: PaneView = { kind: 'activity' }
const AGENTS: PaneView = { kind: 'agents' }
const GIT: PaneView = { kind: 'git', root: '/repo' }
const TERM: TerminalView = { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/repo' }

/**
 * The mounting rules the tests run under.
 *
 * Deliberately a literal table rather than the real registry: the model takes
 * a predicate precisely so it can be tested without a component in sight, and
 * a test that imported the registry would be testing the app's docking policy
 * rather than the model's obedience to whatever policy it is given.
 */
const MOUNTS: Record<string, readonly AreaId[]> = {
  conversation: ['main'],
  changes: ['right', 'bottom', 'sidebar', 'main'],
  activity: ['right', 'bottom', 'sidebar', 'main'],
  agents: ['right', 'bottom', 'sidebar', 'main'],
  git: ['main', 'right', 'bottom'],
  terminal: ['bottom', 'main'],
}
const permits = (view: PaneView, area: AreaId): boolean => MOUNTS[view.kind]?.includes(area) ?? false

const ids = (workbench: Workbench, area: 'sidebar' | 'right' | 'bottom'): string[] =>
  dockViews(workbench[area]).map((entry) => entry.view.kind)

/** Every view a dock holds, by mount id, in reading order. */
const mountIds = (workbench: Workbench, area: 'sidebar' | 'right' | 'bottom'): string[] =>
  dockViews(workbench[area]).map((entry) => entry.id)

/** What `landingStack` will pick for the right panel — the control above. */
const landingStackOf = (workbench: Workbench): string => {
  const all = stacks(workbench.right.root)
  const focused = workbench.focus
    ? all.find((stack) => stack.views.some((e) => e.id === workbench.focus))
    : null
  return (focused ?? all[0]!).id
}

describe('docking', () => {
  test('a view mounts in an area and takes the screen', () => {
    const workbench = dock(emptyWorkbench(), 'right', CHANGES)
    expect(ids(workbench, 'right')).toEqual(['changes'])
    expect(activeView(workbench.right)?.view).toEqual(CHANGES)
    expect(workbench.right.collapsed).toBe(false)
  })

  test('a second view sits beside the first, and each can be brought forward', () => {
    let workbench = dock(dock(emptyWorkbench(), 'right', CHANGES), 'right', ACTIVITY)
    expect(ids(workbench, 'right')).toEqual(['changes', 'activity'])
    const first = mountIds(workbench, 'right')[0]!
    workbench = activate(workbench, 'right', first)
    expect(activeView(workbench.right)?.view).toEqual(CHANGES)
  })

  test('docking something already on screen moves it rather than copying it', () => {
    let workbench = dock(emptyWorkbench(), 'right', CHANGES)
    const id = mountIds(workbench, 'right')[0]!
    workbench = dock(workbench, 'bottom', CHANGES)
    expect(ids(workbench, 'right')).toEqual([])
    expect(ids(workbench, 'bottom')).toEqual(['changes'])
    // The same view, so the same id: a panel dragged across the window is
    // recognisably the thing that was dragged, not a new one that looks alike.
    expect(mountIds(workbench, 'bottom')[0]!).toBe(id)
  })

  test('a view in the split tree is taken out of it when it docks', () => {
    const main = open(emptyWorkbench().main, A)
    let workbench: Workbench = { ...emptyWorkbench(), main: split(main, main.focused, 'row', GIT) }
    expect(panes(workbench.main.root)).toHaveLength(2)
    workbench = dock(workbench, 'right', GIT)
    expect(ids(workbench, 'right')).toEqual(['git'])
    // The pane it left folds away; the conversation keeps its place.
    expect(panes(workbench.main.root).map(sessionOf)).toEqual([A])
  })

  test('closing a view hands the screen to its neighbour', () => {
    let workbench = dock(dock(emptyWorkbench(), 'bottom', CHANGES), 'bottom', ACTIVITY)
    const [first, second] = mountIds(workbench, 'bottom') as [string, string]
    workbench = undock(workbench, second)
    expect(activeView(workbench.bottom)?.id).toBe(first)
    workbench = undock(workbench, first)
    expect(dockViews(workbench.bottom)).toEqual([])
    expect(stacks(workbench.bottom.root)[0]!.active).toBeNull()
  })

  test('a swapped view keeps its place in the strip', () => {
    let workbench = dock(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', CHANGES)
    const id = mountIds(workbench, 'bottom')[0]!
    workbench = replaceView(workbench, id, { ...TERM, terminalId: 't9' })
    expect(mountOfTerminal(workbench, 't9')).toBe(id)
    expect(ids(workbench, 'bottom')).toEqual(['terminal', 'changes'])
  })
})

describe('splitting a panel', () => {
  /*
   * The question this answers is "two of these at once", which a flat strip of
   * tabs could not. Note what is *not* here: an `orientation` on the area. A
   * flag says the whole right-hand side is a column, and the next thing anyone
   * wants is a row inside one half of it — so the direction belongs to a
   * container, and a container has to be able to contain another one.
   */
  const twoUp = (area: DockId = 'right'): Workbench =>
    dock(dock(emptyWorkbench(), area, CHANGES), area, ACTIVITY)

  test('a split makes two stacks, and both are on screen', () => {
    const start = twoUp()
    const moved = mountIds(start, 'right')[1]!
    const after = splitDock(start, moved, 'row')

    expect(stacks(after.right.root)).toHaveLength(2)
    // Both showing: the plural is the whole point.
    expect(visibleViews(after.right).map((entry) => entry.view.kind).sort()).toEqual(['activity', 'changes'])
    // And the moved one holds the focus, because it is what was just asked for.
    expect(after.focus).toBe(moved)
  })

  test('the direction is the branch’s, and either can hold the other', () => {
    const start = twoUp()
    const [first, second] = mountIds(start, 'right') as [string, string]
    let after = splitDock(start, second, 'column')
    expect((after.right.root as DockBranch).direction).toBe('column')

    // A third view into the stack that stayed, split the other way: a row
    // inside a column, which is the arrangement a flag on the area cannot say.
    after = dock(focusView(after, first), 'right', AGENTS)
    after = splitDock(after, mountIds(after, 'right').find((id) => id !== first && id !== second)!, 'row')
    const root = after.right.root as DockBranch
    expect(root.direction).toBe('column')
    expect(stacks(after.right.root)).toHaveLength(3)
    expect(visibleViews(after.right)).toHaveLength(3)
  })

  test('a stack of one cannot split — there would be nothing on one side', () => {
    const one = dock(emptyWorkbench(), 'right', CHANGES)
    expect(splitDock(one, mountIds(one, 'right')[0]!, 'row')).toBe(one)
  })

  test('closing the last view in a half closes the half', () => {
    const start = twoUp()
    const moved = mountIds(start, 'right')[1]!
    const after = undock(splitDock(start, moved, 'row'), moved)
    // The branch goes with it: a seam beside nothing is a handle that resizes
    // nothing, next to a strip with no tabs.
    expect(after.right.root.kind).toBe('stack')
    expect(ids(after, 'right')).toEqual(['changes'])
  })

  test('a seam moves only its own branch, and is held away from the edges', () => {
    const start = twoUp()
    const after = splitDock(start, mountIds(start, 'right')[1]!, 'row')
    const branch = after.right.root as DockBranch
    expect(resizeDockSplit(after, 'right', branch.id, 0.7).right.root).toMatchObject({ ratio: 0.7 })
    expect(resizeDockSplit(after, 'right', branch.id, 0.01).right.root).toMatchObject({ ratio: 0.15 })
    expect(resizeDockSplit(after, 'right', 'ghost', 0.7).right.root).toMatchObject({ ratio: 0.5 })
  })

  test('bringing a tab forward in one half leaves the other alone', () => {
    let after = splitDock(twoUp(), mountIds(twoUp(), 'right')[1]!, 'row')
    // Rebuild deterministically: split, then add a second tab to the first half.
    const start = twoUp()
    const [first, second] = mountIds(start, 'right') as [string, string]
    after = dock(focusView(splitDock(start, second, 'row'), first), 'right', AGENTS)
    const agents = mountIds(after, 'right').find((id) => id !== first && id !== second)!
    expect(visibleViews(after.right).map((e) => e.view.kind)).toEqual(['agents', 'activity'])

    after = activate(after, 'right', first)
    expect(visibleViews(after.right).map((e) => e.view.kind)).toEqual(['changes', 'activity'])
    // The other half never moved.
    expect(stackOf(after.right, second)?.active).toBe(second)
    expect(agents).toBeTruthy()
  })

  test('a split arrangement survives being saved and read back', () => {
    const start = twoUp('bottom')
    const after = resizeDockSplit(
      splitDock(start, mountIds(start, 'bottom')[1]!, 'row'),
      'bottom',
      (splitDock(start, mountIds(start, 'bottom')[1]!, 'row').bottom.root as DockBranch).id,
      0.35,
    )
    expect(readWorkbench(JSON.parse(JSON.stringify(after)))).toEqual(after)
  })

  test('a dock saved before it could split reads back as one stack', () => {
    // The flat shape, exactly as it was written.
    const workbench = readWorkbench({
      main: { root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } }, focused: 'p1' },
      right: { views: [{ id: 'v1', view: { kind: 'changes' } }], active: 'v1', size: 400 },
    })
    expect(workbench!.right.root.kind).toBe('stack')
    expect(ids(workbench!, 'right')).toEqual(['changes'])
    expect(workbench!.right.size).toBe(400)
  })
})

describe('moving between areas', () => {
  test('a view moves to an area it declares, and keeps its identity', () => {
    let workbench = dock(emptyWorkbench(), 'right', CHANGES)
    const id = mountIds(workbench, 'right')[0]!
    workbench = moveView(workbench, id, 'bottom', permits)
    expect(areaOf(workbench, id)).toBe('bottom')
    expect(activeView(workbench.bottom)?.id).toBe(id)
  })

  test('a move to an area the view does not declare changes nothing', () => {
    const workbench = dock(emptyWorkbench(), 'bottom', TERM)
    const id = mountIds(workbench, 'bottom')[0]!
    // A terminal declares bottom and main; the sidebar is not on its list.
    const after = moveView(workbench, id, 'sidebar', permits)
    expect(after).toBe(workbench)
    expect(areaOf(after, id)).toBe('bottom')
  })

  test('a docked tool can be moved into the split tree', () => {
    const start: Workbench = { ...emptyWorkbench(), main: open(emptyWorkbench().main, A) }
    let workbench = dock(start, 'right', GIT)
    const id = mountIds(workbench, 'right')[0]!
    workbench = moveView(workbench, id, 'main', permits)
    expect(ids(workbench, 'right')).toEqual([])
    expect(findView(workbench, GIT)).toMatchObject({ area: 'main' })
    // And the conversation is still there beside it — the tool split off the
    // focused pane rather than replacing what was reading.
    expect(panes(workbench.main.root).map(sessionOf)).toContain(A)
  })

  test('a tool pane can be moved out of the split tree onto an edge', () => {
    const main = open(emptyWorkbench().main, A)
    const withTool = split(main, main.focused, 'row', GIT)
    const pane = panes(withTool.root).find((entry) => entry.view.kind === 'git')!
    const workbench = moveView({ ...emptyWorkbench(), main: withTool }, pane.id, 'bottom', permits)
    expect(ids(workbench, 'bottom')).toEqual(['git'])
    expect(activeView(workbench.bottom)?.view).toEqual(GIT)
    expect(panes(workbench.main.root).map(sessionOf)).toEqual([A])
  })

  test('the conversation is never docked away', () => {
    // It is the one view with nowhere else to be: `layout.ts` guarantees there
    // is exactly one, and closing its pane to make room would end its place on
    // screen with no way to say so.
    const workbench: Workbench = { ...emptyWorkbench(), main: open(emptyWorkbench().main, A) }
    const pane = panes(workbench.main.root)[0]!
    expect(moveView(workbench, pane.id, 'bottom', permits)).toBe(workbench)
  })
})

/**
 * The way out of a split, which for a while there was not one.
 *
 * `splitDock` divides a panel in two and every drop target in the other half
 * lit up and accepted the drop — and then did nothing, because a move whose
 * source and destination are the same *area* was read as "already where you
 * asked". Closing every view in one half was the only thing that put the two
 * back together, which is not a way out of a split, it is a loss.
 */
describe('moving within one area', () => {
  const twoStacks = (): { workbench: Workbench; first: string; second: string; moved: string } => {
    const start = dock(dock(dock(emptyWorkbench(), 'right', CHANGES), 'right', ACTIVITY), 'right', AGENTS)
    const moved = mountIds(start, 'right')[2]!
    const workbench = splitDock(start, moved, 'row')
    const [first, second] = stacks(workbench.right.root).map((stack) => stack.id)
    return { workbench, first: first!, second: second!, moved }
  }

  test('a view moves into the other half of its own panel', () => {
    const { workbench, first, moved } = twoStacks()
    const after = moveView(workbench, moved, 'right', permits, first)
    // One stack again: the emptied half took its branch with it.
    expect(stacks(after.right.root)).toHaveLength(1)
    expect(ids(after, 'right')).toEqual(['changes', 'activity', 'agents'])
    // And it is the tab on screen, because a drop is a request to look at it.
    expect(activeView(after.right)?.id).toBe(moved)
  })

  test('dropping a view back into the stack it is already in changes nothing', () => {
    const { workbench, second, moved } = twoStacks()
    expect(moveView(workbench, moved, 'right', permits, second)).toBe(workbench)
  })

  test('and a move within an area that names no stack still changes nothing', () => {
    // The area-wide drop zones — the sidebar column, the empty-panel edge —
    // pass no stack, and "move this to the area it is in" is not a request.
    const { workbench, moved } = twoStacks()
    expect(moveView(workbench, moved, 'right', permits)).toBe(workbench)
  })

  test('a stack that is not in the area is refused rather than minted', () => {
    const { workbench, moved } = twoStacks()
    expect(moveView(workbench, moved, 'right', permits, 'no-such-stack')).toBe(workbench)
  })
})

/**
 * A drop names a half, wherever it came from.
 *
 * `into` was honoured only when the view was already in that area, so a tab
 * dragged from the bottom panel onto the *lower* half of a split right panel
 * landed in the upper one. The zone that lit up was the lower half's — it is
 * rendered per stack — so the drop went somewhere the gesture did not point,
 * which is the same defect the same-area case was fixed for, on the other
 * side of one `if`.
 */
describe('moving into one half of a split, from elsewhere', () => {
  /*
   * The focus is put on the *first* half deliberately: `landingStack` answers
   * with the focused stack, so without this the fixture's default landing and
   * the half under test are the same stack and every assertion below passes
   * whatever `moveView` does with `into`. Two of these four were written that
   * way first and were green before the fix.
   */
  const splitRight = (): { workbench: Workbench; first: string; second: string } => {
    const start = dock(dock(emptyWorkbench(), 'right', CHANGES), 'right', ACTIVITY)
    const divided = splitDock(start, mountIds(start, 'right')[1]!, 'row')
    const [first, second] = stacks(divided.right.root).map((stack) => stack.id)
    const held = stacks(divided.right.root).find((stack) => stack.id === first)!.views[0]!.id
    return { workbench: focusView(divided, held), first: first!, second: second! }
  }

  /** Which half of the right panel a view ended up in. */
  const halfHolding = (workbench: Workbench, matches: (view: PaneView) => boolean): string | null =>
    stacks(workbench.right.root).find((stack) => stack.views.some((e) => matches(e.view)))?.id ?? null

  test('the fixture lands in the first half unless told otherwise', () => {
    // The control the three below lean on. Without it they cannot fail.
    const { workbench, first } = splitRight()
    expect(landingStackOf(workbench)).toBe(first)
  })

  test('a view dragged in from another area lands in the half it was dropped on', () => {
    const { workbench, first, second } = splitRight()
    const withAgents = dock(workbench, 'bottom', AGENTS)
    const id = mountIds(withAgents, 'bottom')[0]!
    const after = moveView(withAgents, id, 'right', permits, second)
    const landed = stacks(after.right.root).find((stack) => stack.views.some((e) => e.id === id))
    expect(landed?.id).toBe(second)
    expect(landed?.id).not.toBe(first)
    // And it is the tab on screen there, because a drop is a request to look.
    expect(stackView(landed!)?.id).toBe(id)
  })

  test('and a pane dragged out of the middle does the same', () => {
    const { workbench, first, second } = splitRight()
    const main = open(emptyWorkbench().main, A)
    const withTool = split(main, main.focused, 'row', GIT)
    const pane = panes(withTool.root).find((entry) => entry.view.kind === 'git')!
    const after = moveView({ ...workbench, main: withTool }, pane.id, 'right', permits, second)
    expect(halfHolding(after, (view) => view.kind === 'git')).toBe(second)
    expect(halfHolding(after, (view) => view.kind === 'git')).not.toBe(first)
  })

  test('naming no half still lands where it always did', () => {
    // Every area-wide zone — the sidebar column, the empty-panel edge — passes
    // no stack, and must keep landing in the focused-or-first stack.
    const { workbench, first } = splitRight()
    const withAgents = dock(workbench, 'bottom', AGENTS)
    const id = mountIds(withAgents, 'bottom')[0]!
    const after = moveView(withAgents, id, 'right', permits)
    expect(halfHolding(after, (view) => view.kind === 'agents')).toBe(first)
  })

  test('a half that is not in the destination is ignored rather than obeyed', () => {
    const { workbench, first } = splitRight()
    const withAgents = dock(workbench, 'bottom', AGENTS)
    const id = mountIds(withAgents, 'bottom')[0]!
    const after = moveView(withAgents, id, 'right', permits, 'no-such-stack')
    expect(halfHolding(after, (view) => view.kind === 'agents')).toBe(first)
  })
})

/**
 * Summoning something already on screen brings it forward where it is.
 *
 * The general path detaches and re-appends, which within one strip is a move
 * to the end of it: pressing Trajectory in the View menu a second time
 * reordered the whole panel, and the tab the person had just asked for landed
 * in the one position a narrow strip cannot show without scrolling.
 */
describe('docking something that is already here', () => {
  test('the strip keeps its order', () => {
    const start = dock(dock(dock(emptyWorkbench(), 'right', CHANGES), 'right', ACTIVITY), 'right', AGENTS)
    const after = dock(start, 'right', CHANGES)
    expect(ids(after, 'right')).toEqual(['changes', 'activity', 'agents'])
    expect(activeView(after.right)?.view).toEqual(CHANGES)
    expect(mountIds(after, 'right')).toEqual(mountIds(start, 'right'))
  })

  test('and only the half holding it is disturbed', () => {
    const start = dock(dock(dock(emptyWorkbench(), 'right', CHANGES), 'right', ACTIVITY), 'right', AGENTS)
    const split = splitDock(start, mountIds(start, 'right')[2]!, 'row')
    const after = dock(split, 'right', CHANGES)
    const [left, right] = stacks(after.right.root)
    expect(left!.active).toBe(mountIds(after, 'right')[0]!)
    expect(right!.active).toBe(stacks(split.right.root)[1]!.active)
  })

  test('a collapsed panel is opened rather than left holding the answer', () => {
    const start = collapseDock(dock(emptyWorkbench(), 'right', CHANGES), 'right', true)
    expect(dock(start, 'right', CHANGES).right.collapsed).toBe(false)
  })
})

describe('size and visibility', () => {
  test('a size is held inside the area’s own bounds', () => {
    const workbench = dock(emptyWorkbench(), 'bottom', TERM)
    expect(resizeDock(workbench, 'bottom', 10).bottom.size).toBe(80)
    expect(resizeDock(workbench, 'bottom', 10_000).bottom.size).toBe(600)
    // The right panel holds a document, so its floor is a readable column
    // rather than a shell's eighty rows — the bounds are per area on purpose.
    expect(resizeDock(workbench, 'right', 10).right.size).toBe(280)
  })

  test('collapsing keeps the views; closing takes them', () => {
    const workbench = collapseDock(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', true)
    expect(workbench.bottom.collapsed).toBe(true)
    expect(ids(workbench, 'bottom')).toEqual(['terminal'])
    expect(toggleDock(workbench, 'bottom').bottom.collapsed).toBe(false)
  })

  test('an empty area is never collapsed — there is nothing to collapse to', () => {
    const workbench = collapseDock(emptyWorkbench(), 'right', true)
    expect(workbench.right.collapsed).toBe(false)
  })

  test('docking into a collapsed area opens it, since something was just asked for', () => {
    const workbench = dock(collapseDock(dock(emptyWorkbench(), 'right', CHANGES), 'right', true), 'right', ACTIVITY)
    expect(workbench.right.collapsed).toBe(false)
  })
})

describe('zoom', () => {
  test('an area can take the content area, and the sidebar stays', () => {
    const workbench = zoomArea(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', 'content')
    expect(areaVisible(workbench, 'bottom')).toBe(true)
    expect(areaVisible(workbench, 'sidebar')).toBe(true)
    expect(areaVisible(workbench, 'main')).toBe(false)
    expect(areaVisible(workbench, 'right')).toBe(false)
  })

  test('or the whole window, and then the sidebar goes too', () => {
    const workbench = zoomArea(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', 'window')
    expect(areaVisible(workbench, 'sidebar')).toBe(false)
    expect(areaVisible(workbench, 'bottom')).toBe(true)
  })

  test('the same scope twice hands the room back; a different scope re-aims it', () => {
    const start = dock(emptyWorkbench(), 'bottom', TERM)
    const zoomed = zoomArea(start, 'bottom', 'content')
    expect(zoomArea(zoomed, 'bottom', 'content').zoom).toBeNull()
    expect(zoomArea(zoomed, 'bottom', 'window').zoom).toEqual({ area: 'bottom', scope: 'window' })
  })

  test('putting something into an area a zoom is hiding ends the zoom', () => {
    /*
     * A real failure, found in the running app: a zoom restored with the
     * project had the main area filling the window; opening the browser docked
     * it to the right, correctly, where the zoom hid it — so the button
     * appeared to do nothing. Asking for a thing and being shown nothing is
     * the worst thing a layout can do, because there is no error to read and
     * no control to press.
     */
    const zoomed = zoomArea(dock(emptyWorkbench(), 'bottom', TERM), 'main', 'content')
    expect(areaVisible(zoomed, 'right')).toBe(false)

    const opened = dock(zoomed, 'right', CHANGES)
    expect(opened.zoom).toBeNull()
    expect(areaVisible(opened, 'right')).toBe(true)

    // The same for a move, and for bringing a tab forward in a hidden panel.
    const withChanges = zoomArea(dock(emptyWorkbench(), 'bottom', CHANGES), 'main', 'content')
    const moved = moveView(withChanges, mountIds(withChanges, 'bottom')[0]!, 'right', permits)
    expect(moved.zoom).toBeNull()
    const twoUp = zoomArea(dock(dock(emptyWorkbench(), 'right', CHANGES), 'right', ACTIVITY), 'main', 'content')
    expect(activate(twoUp, 'right', mountIds(twoUp, 'right')[0]!).zoom).toBeNull()
  })

  test('a zoom on a panel that empties, or is put away, ends', () => {
    let workbench = zoomArea(dock(emptyWorkbench(), 'right', CHANGES), 'right', 'window')
    expect(workbench.zoom).not.toBeNull()
    // Collapsed: the panel is not on screen, so neither is anything to zoom.
    expect(collapseDock(workbench, 'right', true).zoom).toBeNull()
    workbench = undock(workbench, mountIds(workbench, 'right')[0]!)
    expect(workbench.zoom).toBeNull()
    // Without this the window would be filled by an empty panel, with no
    // visible control anywhere on it to press to get back out.
    expect(areaVisible(workbench, 'main')).toBe(true)
  })
})

describe('the window buttons', () => {
  /*
   * macOS draws close, minimise and zoom over the window's top-left corner,
   * on top of whatever is underneath — so exactly one row in the app has to
   * leave room for them, and which row that is moves with the layout. The
   * shell names the area here and its stylesheet hands that area the room.
   *
   * The bug this is here for: a repository zoomed to fill the window printed
   * "History — checkout-api" underneath the three buttons, because the only
   * two headers that reserved anything asked `sidebarCollapsed` themselves and
   * no header outside the sidebar and the conversation asked at all.
   */
  test('the sidebar has the corner whenever it is up', () => {
    expect(cornerArea(emptyWorkbench(), true)).toBe('sidebar')
    // Even zoomed, as long as the scope leaves the sidebar standing.
    const zoomed = zoomArea(dock(emptyWorkbench(), 'right', GIT), 'right', 'content')
    expect(cornerArea(zoomed, true)).toBe('sidebar')
  })

  test('with the sidebar away it passes to the main area', () => {
    expect(cornerArea(emptyWorkbench(), false)).toBe('main')
    // A zoom on the middle is still the middle.
    expect(cornerArea(zoomArea(emptyWorkbench(), 'main', 'window'), false)).toBe('main')
  })

  test('a panel zoomed to fill the window takes the corner with it', () => {
    const right = zoomArea(dock(emptyWorkbench(), 'right', GIT), 'right', 'window')
    expect(cornerArea(right, false)).toBe('right')
    const bottom = zoomArea(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', 'window')
    expect(cornerArea(bottom, false)).toBe('bottom')
  })

  test('the fallback to the bottom is never a panel with nothing in it', () => {
    /*
     * The last two branches are only reached while a zoom is hiding the middle,
     * and `settle` will not keep a zoom on a dock that is empty or put away —
     * so the dock that is left always has something drawn in it. Both halves
     * are asserted, because the fallback is only safe while both hold.
     */
    expect(zoomArea(emptyWorkbench(), 'right', 'window').zoom).toBeNull()
    expect(cornerArea(zoomArea(emptyWorkbench(), 'right', 'window'), false)).toBe('main')

    // And the reachable one: the bottom panel, alone, filling the window.
    const bottom = zoomArea(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', 'window')
    expect(dockViews(bottom.right)).toEqual([])
    expect(cornerArea(bottom, false)).toBe('bottom')

    /*
     * The path that could have got round all of it: a zoom is persisted, and
     * the panel it named is empty by the time the project is opened again.
     * `readWorkbench` settles too, so what restores has no zoom and the middle
     * is back — which is what makes "every zoom has passed `settle`" true of a
     * restored document and not only of a live one.
     */
    const save = (workbench: Workbench): unknown => JSON.parse(JSON.stringify(workbench))
    const emptied = readWorkbench(save({ ...emptyWorkbench(), zoom: { area: 'right', scope: 'window' } }))!
    expect(emptied.zoom).toBeNull()
    expect(cornerArea(emptied, false)).toBe('main')

    // And the same document with the panel still occupied, so the assertion
    // above is `settle` dropping a zoom rather than the reader never seeing one.
    const kept = readWorkbench(save({ ...dock(emptyWorkbench(), 'right', CHANGES), zoom: { area: 'right', scope: 'window' } }))!
    expect(kept.zoom).toEqual({ area: 'right', scope: 'window' })
    expect(cornerArea(kept, false)).toBe('right')
  })

  test('and a collapsed sidebar under a content zoom leaves the panel in it', () => {
    // `content` hides the middle without hiding the sidebar — but the person
    // has put the sidebar away themselves, so the panel is the corner after
    // all. The two conditions are separate and both have to be asked.
    const workbench = zoomArea(dock(emptyWorkbench(), 'right', GIT), 'right', 'content')
    expect(areaVisible(workbench, 'sidebar')).toBe(true)
    expect(cornerArea(workbench, false)).toBe('right')
  })
})

describe('terminals live in the bottom panel', () => {
  test('they dock, and the panel names which one is on screen', () => {
    let workbench = dock(emptyWorkbench(), 'bottom', TERM)
    const second: TerminalView = { ...TERM, terminalId: 't2' }
    workbench = dock(workbench, 'bottom', second)
    expect(terminals(workbench).map((view) => view.terminalId)).toEqual(['t1', 't2'])
    expect(activeTerminal(workbench)?.terminalId).toBe('t2')
    expect(mountOfTerminal(workbench, 't1')).toBe(mountIds(workbench, 'bottom')[0]!)
  })

  test('a panel showing something that is not a terminal still finds one', () => {
    // The bottom panel is not the terminal's any more, so "the active
    // terminal" cannot simply mean "the active tab": with Changes in front,
    // ⌘-clicking a dev-server link must still reach the shell behind it.
    const workbench = dock(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', CHANGES)
    expect(activeView(workbench.bottom)?.view).toEqual(CHANGES)
    expect(activeTerminal(workbench)?.terminalId).toBe('t1')
  })
})

describe('focus, across both halves', () => {
  /*
   * Focus lives in two fields — `workbench.focus` for a docked panel,
   * `layout.focused` for a pane — and everything that asks "am I the focused
   * one" has to ask both. Asking only the layout left a docked conversation
   * permanently unfocused: its composer ignored every compose event, its
   * approvals never took the keyboard, and the browser's shortcuts stopped
   * arming the day the browser started opening on the right.
   */
  test('a docked panel outranks the main area while it holds the focus', () => {
    const workbench = dock(emptyWorkbench(), 'right', CHANGES)
    const id = mountIds(workbench, 'right')[0]!
    expect(focusedMount(workbench)).toBe(workbench.main.focused)
    expect(focusedMount(focusView(workbench, id))).toBe(id)
  })

  test('and hands it back when the panel goes', () => {
    const workbench = focusView(dock(emptyWorkbench(), 'right', CHANGES), mountIds(dock(emptyWorkbench(), 'right', CHANGES), 'right')[0]!)
    const docked = dock(emptyWorkbench(), 'right', CHANGES)
    const id = mountIds(docked, 'right')[0]!
    const closed = undock(focusView(docked, id), id)
    expect(focusedMount(closed)).toBe(closed.main.focused)
    expect(workbench).toBeTruthy()
  })
})

describe('the visible inspector', () => {
  test('is found wherever it was docked', () => {
    expect(visibleInspector(dock(emptyWorkbench(), 'right', CHANGES))).toBe('changes')
    expect(visibleInspector(dock(emptyWorkbench(), 'bottom', ACTIVITY))).toBe('activity')
    expect(visibleInspector(dock(emptyWorkbench(), 'sidebar', CHANGES))).toBe('changes')
  })

  test('is found in the second half of a split, not only the first', () => {
    // A split dock showing a terminal on the left and Changes on the right
    // had an inspector plainly on screen that this reported as absent, so
    // every control that lights up while Changes is open stayed dark.
    const start = dock(dock(emptyWorkbench(), 'bottom', TERM), 'bottom', CHANGES)
    const split = splitDock(start, mountIds(start, 'bottom')[1]!, 'row')
    expect(visibleViews(split.bottom)).toHaveLength(2)
    expect(visibleInspector(split)).toBe('changes')
  })

  test('a collapsed panel is not showing anything', () => {
    const workbench = collapseDock(dock(emptyWorkbench(), 'right', CHANGES), 'right', true)
    expect(visibleInspector(workbench)).toBeNull()
  })

  test('and a tool is not an inspector', () => {
    expect(visibleInspector(dock(emptyWorkbench(), 'bottom', TERM))).toBeNull()
  })
})

describe('persistence', () => {
  const roundTrip = (workbench: Workbench): Workbench | null =>
    readWorkbench(JSON.parse(JSON.stringify(workbench)))

  test('an arrangement comes back as it was', () => {
    let workbench = dock(dock(emptyWorkbench(), 'right', CHANGES), 'bottom', TERM)
    workbench = resizeDock(collapseDock(workbench, 'bottom', true), 'right', 520)
    expect(roundTrip(workbench)).toEqual(workbench)
  })

  test('a document written before there were panels restores as the main area', () => {
    // The bare `Layout` that used to be saved. It has a `root`; a workbench has
    // a `main`, and that one key is the whole discriminator.
    const old = {
      root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } },
      focused: 'p1',
      dock: { terminals: [TERM], active: 't1', height: 240, collapsed: false },
    }
    const workbench = readWorkbench(old)
    expect(panes(workbench!.main.root).map(sessionOf)).toEqual([A])
    // The docks come back empty; the store re-docks the terminals it finds,
    // because the processes behind them are still running on the host.
    expect(dockViews(workbench!.bottom)).toEqual([])
  })

  test('a panel holding something unreadable loses the panel, not the window', () => {
    const workbench = readWorkbench({
      main: { root: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: B } }, focused: 'p1' },
      right: { views: [{ id: 'v1', view: { kind: 'git' } }, { id: 'v2' }], active: 'v1', size: 400 },
    })
    // `git` with no root is a panel pointed at no project, and an entry with no
    // view at all is nothing: both are dropped, and the layout still opens.
    expect(dockViews(workbench!.right)).toEqual([])
    expect(panes(workbench!.main.root).map(sessionOf)).toEqual([B])
  })

  test('nonsense is refused outright rather than half-read', () => {
    expect(readWorkbench(null)).toBeNull()
    expect(readWorkbench({ main: { focused: 'p1' } })).toBeNull()
  })
})

describe('an id is an id, wherever it lives', () => {
  /*
   * The browser is why this matters. Its tab verbs are all addressed by id and
   * used to look that id up in the split tree, so the browser could only ever
   * be a pane — the moment it was allowed onto an edge, every one of them
   * would have been handed an id the tree had never heard of.
   */
  const inTree = (): Workbench => {
    const main = open(emptyWorkbench().main, A)
    return { ...emptyWorkbench(), main: split(main, main.focused, 'row', GIT) }
  }

  test('a pane and a docked view are both found, replaced and removed by id', () => {
    const workbench = inTree()
    const pane = panes(workbench.main.root).find((entry) => entry.view.kind === 'git')!
    expect(viewAt(workbench, pane.id)).toEqual(GIT)
    expect(replaceView(workbench, pane.id, CHANGES)).not.toBe(workbench)
    expect(viewAt(replaceView(workbench, pane.id, CHANGES), pane.id)).toEqual(CHANGES)
    expect(panes(removeAt(workbench, pane.id).main.root).map(sessionOf)).toEqual([A])

    const docked = dock(emptyWorkbench(), 'right', GIT)
    const id = mountIds(docked, 'right')[0]!
    expect(viewAt(docked, id)).toEqual(GIT)
    expect(viewAt(replaceView(docked, id, CHANGES), id)).toEqual(CHANGES)
    expect(dockViews(removeAt(docked, id).right)).toEqual([])
  })

  test('an id nothing holds changes nothing', () => {
    const workbench = inTree()
    expect(viewAt(workbench, 'ghost')).toBeNull()
    expect(replaceView(workbench, 'ghost', CHANGES)).toBe(workbench)
    expect(removeAt(workbench, 'ghost')).toBe(workbench)
  })
})

describe('focus across areas', () => {
  const CONVERSATION: PaneView = { kind: 'conversation', session: B }

  test('a docked panel can hold the focus, and only a docked one can', () => {
    const workbench = dock(emptyWorkbench(), 'right', CONVERSATION)
    const id = mountIds(workbench, 'right')[0]!
    expect(focusView(workbench, id).focus).toBe(id)
    // A pane is `layout.focused`'s business; two fields naming one pane drift.
    expect(focusView(workbench, panes(workbench.main.root)[0]!.id).focus).toBeNull()
    expect(focusView(focusView(workbench, id), null).focus).toBeNull()
  })

  test('focus falls back to the main area when the panel it named goes', () => {
    // Otherwise the sidebar, the palette and the window title stay pointed at
    // a conversation that is no longer on screen anywhere.
    const workbench = focusView(dock(emptyWorkbench(), 'right', CONVERSATION), null)
    const docked = dock(emptyWorkbench(), 'right', CONVERSATION)
    const id = mountIds(docked, 'right')[0]!
    expect(undock(focusView(docked, id), id).focus).toBeNull()
    expect(workbench.focus).toBeNull()
  })

  test('a second conversation docks beside the first rather than replacing it', () => {
    // The rule the split tree keeps — one transcript in the middle — is about
    // the middle. Reading what another harness is doing is the case it could
    // never serve, and it is what the right edge is for.
    const workbench = dock({ ...emptyWorkbench(), main: open(emptyWorkbench().main, A) }, 'right', CONVERSATION)
    expect(panes(workbench.main.root).map(sessionOf)).toEqual([A])
    expect(dockViews(workbench.right).map((entry) => entry.view)).toEqual([CONVERSATION])
  })
})

describe('settling', () => {
  test('an active id naming a view that is gone is repaired', () => {
    const workbench = dock(emptyWorkbench(), 'right', CHANGES)
    const broken: Workbench = {
      ...workbench,
      right: {
        ...workbench.right,
        root: { ...(workbench.right.root as DockStack), active: 'ghost' },
      },
    }
    expect(stacks(settle(broken).right.root)[0]!.active).toBe(mountIds(workbench, 'right')[0]!)
  })
})

describe('a main area saved when it could hold tools', () => {
  test('restores with only what the middle may hold, and names what it displaced', () => {
    // Git, the browser, files and terminals were all legal in the middle before
    // it became a two-valued slot. A document written then restored verbatim,
    // so an existing user could open with the repository view occupying the
    // slot — a state no verb in the app can produce and the invariant says is
    // impossible.
    const saved = {
      main: {
        root: {
          kind: 'split',
          id: 's1',
          direction: 'row',
          ratio: 0.5,
          first: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: null } },
          second: { kind: 'pane', id: 'p2', view: { kind: 'git', root: '/repo' } },
        },
        focused: 'p2',
      },
    }
    const workbench = readWorkbench(saved)!
    // One pane, not two blank ones: emptying the displaced view and leaving
    // the split standing is still a shape `only()` cannot produce.
    expect(panes(workbench.main.root)).toHaveLength(1)
    expect(workbench.main.root).toMatchObject({
      kind: 'pane',
      view: { kind: 'conversation', session: null },
    })
    // And the tool is offered back, so the caller docks it rather than losing it.
    expect(strayPanels(saved)).toEqual([{ kind: 'git', root: '/repo' }])
  })

  test('a conversation saved beside a room comes back as one of them', () => {
    // Both halves are legal on their own, so a per-pane rule left this split
    // entirely alone — a main area of two, which is the thing this branch says
    // cannot exist. The focused one is kept: it is what was last looked at.
    const saved = {
      main: {
        root: {
          kind: 'split',
          id: 's1',
          direction: 'row',
          ratio: 0.5,
          first: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } },
          second: { kind: 'pane', id: 'p2', view: { kind: 'room', room: 'r1' } },
        },
        focused: 'p2',
      },
    }
    const main = readWorkbench(saved)!.main
    expect(panes(main.root)).toHaveLength(1)
    expect(main.root).toMatchObject({ view: { kind: 'room', room: 'r1' } })
    // Nothing was displaced — both were legal — so nothing is re-docked.
    expect(strayPanels(saved)).toEqual([])
  })

  test('an unfocused legal view is kept when the focused pane holds a tool', () => {
    const saved = {
      main: {
        root: {
          kind: 'split',
          id: 's1',
          direction: 'row',
          ratio: 0.5,
          first: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } },
          second: { kind: 'pane', id: 'p2', view: { kind: 'browser', tabs: [], active: 0, driven: 0 } },
        },
        focused: 'p2',
      },
    }
    const main = readWorkbench(saved)!.main
    expect(panes(main.root)).toHaveLength(1)
    expect(sessionOf(panes(main.root)[0]!)).toBe(A)
  })

  test('a main area that was already legal is left exactly alone', () => {
    const saved = {
      main: {
        root: { kind: 'pane', id: 'p1', view: { kind: 'room', room: 'r1' } },
        focused: 'p1',
      },
    }
    expect(readWorkbench(saved)?.main.root).toEqual({
      kind: 'pane',
      id: 'p1',
      view: { kind: 'room', room: 'r1' },
    })
    expect(strayPanels(saved)).toEqual([])
  })
})
