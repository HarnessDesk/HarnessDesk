import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'

import { ResizeHandle } from '../design/ui'
import {
  DockPanel,
  DockPanelActions,
  DockPanelBar,
  DockPanelBody,
  DockPanelTab,
  DockPanelTabs,
  PanelSeam,
} from '../design/patterns/DockPanel'
import { Menu, MenuItem, MenuLabel } from '../components/Menu'
import { Popover, dismissOverlays } from '../components/Popover'
import { CaretIcon, ExpandIcon, MoreIcon, RestoreIcon } from '../components/Icons'
import { Panes } from '../components/Panes'
import { PaneProvider, useSnapshot, useStore } from '../state/context'
import type { PaneView } from '../state/layout'
import {
  AREA_EDGE,
  AREA_NAME,
  VIEW_DRAG_TYPE,
  areaOfMount,
  areaVisible,
  cornerArea,
  dockLimits,
  dockViews,
  MAX_RATIO,
  MIN_RATIO,
  sidebarPlacement,
  stackOf,
  stackView,
  type AreaId,
  type DockBranch,
  type DockId,
  type DockNode,
  type DockStack,
  type Workbench as WorkbenchModel,
} from '../state/workbench'
import { hasTrafficLights } from '../lib/desktop'
import { beginResize, endResize, markDragging } from '../lib/resizing'
import { registerSlot } from '../slots/registry'
import { MountProvider } from './mount'
import { PanelActions } from './PanelActions'
import { ViewHost, iconOf, useViewTitle, views } from './views'
import styles from './Workbench.module.css'

import './builtins'

/**
 * The workbench, drawn.
 *
 * Four areas around one model. The sidebar is a column with the session tree at
 * the top and a stack of docked views beneath it; the main content area is the
 * split tree with the right panel beside it and the bottom panel under both.
 * Every seam between them is the same component, every panel is the same
 * component, and which feature is in which panel is a lookup — so adding a
 * fifth place to put things is a line in `AreaId` and a case here, rather than
 * a fourth layout mechanism.
 *
 * The prior art this follows, and where it departs:
 *
 *   VS Code       Primary sidebar / editor group / secondary sidebar / panel,
 *                 with a view container per area and extensions declaring
 *                 which container a view belongs to. That is exactly the model
 *                 here, down to `mounts` being a declaration the host enforces.
 *   JetBrains     Tool windows anchored to an edge, each with its own
 *                 maximise. Where the two disagree is the *scope* of maximise,
 *                 and JetBrains is right: filling the editor area and filling
 *                 the window are two different things a person wants, so both
 *                 are offered rather than one compromise.
 *   Zed           A `Panel` declares its allowed positions rather than the
 *                 workspace hard-coding them. Same idea as `mounts`.
 *
 * What is deliberately *not* copied is free-floating windows and arbitrary
 * nesting of stacks. Both are famous for producing layouts nobody can get back
 * out of, and neither answers a question this app's users are asking.
 */

const LABEL: Record<DockId, string> = {
  sidebar: 'Sidebar panels',
  right: 'Right panel',
  bottom: 'Bottom panel',
}

/** The drag payload, shared with every drop target — see `VIEW_DRAG_TYPE`. */
const DRAG_TYPE = VIEW_DRAG_TYPE

type Dragging = { readonly id: string; readonly view: PaneView } | null

/**
 * What is being dragged, if anything.
 *
 * A context rather than a prop because the sidebar's panels are rendered
 * through the slot registry — from inside `Sidebar`, where the account row can
 * stay at the bottom of the column where it belongs — and a prop cannot reach
 * across that. Reading it off the drag event is not an option either: the
 * specification hides `dataTransfer` outside `drop` for privacy, so a drop
 * zone that could not see the payload could not tell whether it would accept
 * it, and could not light up.
 */
const DragContext = createContext<{
  readonly dragging: Dragging
  readonly setDragging: (next: Dragging) => void
}>({ dragging: null, setDragging: () => undefined })

/**
 * The shell element, for the seams that resize against it.
 *
 * Every dock's size is a custom property on the shell, and a seam drags that
 * property rather than the store — the panel it sizes is its *sibling*, or its
 * sibling's sibling, so there is no prop that reaches it and no state it can
 * hold that would move it. A ref to the one element all three hang off is the
 * whole of the plumbing.
 *
 * Why the property and not the store: a size written to the store on every
 * pointer-move frame rebuilds the workbench, re-renders every mounted view and
 * queues a persist, sixty times a second, to land on one number. The store
 * hears the number the gesture stops on; the browser does the rest.
 */
const ShellContext = createContext<RefObject<HTMLDivElement | null>>({ current: null })

/**
 * Which property each dock's live drag writes. See `Workbench.module.css`.
 *
 * Not `--hd-`: that prefix names the design system's vocabulary, and these are
 * this component's own plumbing — where a box's edge happens to be right now,
 * not a decision anything else in the app should read or theme.
 */
const LIVE: Record<DockId, string> = {
  sidebar: '--panel-sidebar-drag',
  right: '--panel-right-drag',
  bottom: '--panel-bottom-drag',
}

export const Workbench = ({ sidebar }: { sidebar: ReactNode }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const { workbench } = snapshot
  const zoom = workbench.zoom

  const [dragging, setDragging] = useState<Dragging>(null)
  const shell = useRef<HTMLDivElement>(null)

  /*
   * Where the sidebar is, and whether it is on screen at all. A narrow window
   * floats it over the conversation instead of standing it beside; see
   * `sidebarPlacement`. The column is the only placement that takes room from
   * the content, so it is the only one with a seam and the only one that holds
   * the window's corner — a floating sidebar lies over the corner's row rather
   * than taking its place. A panel given the whole window makes it `away`
   * whatever its own state says.
   */
  const narrow = snapshot.narrowWindow
  const placement = sidebarPlacement(snapshot)
  const showSidebar = placement !== 'away'
  const floating = placement === 'floating'
  const column = placement === 'column'

  /*
   * Which area the macOS window buttons are sitting over, named on the shell
   * so the stylesheet can hand that area — and only that area — the room they
   * need. Absent in the browser build, where there are no buttons and no row
   * should be indented for them. See `--titlebar-inset` in `app.css`.
   *
   * A floating sidebar lies over that corner too — the desktop app zoomed in
   * can cross the narrow line — and the stylesheet gives it the same room
   * whenever there are buttons at all, while the area named here keeps it for
   * the row underneath.
   */
  const corner = hasTrafficLights() ? cornerArea(workbench, column) : null

  const sidebarBox = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useFloatingSidebar(floating, sidebarBox, content)

  return (
    <DragContext.Provider value={{ dragging, setDragging }}>
    <ShellContext.Provider value={shell}>
    <div
      ref={shell}
      className={styles.shell}
      /* Each dock's committed size, as a property the panel reads and a seam
         can override for the length of a drag without a render. */
      style={
        {
          '--panel-sidebar-w': `${workbench.sidebar.size}px`,
          '--panel-right-w': `${workbench.right.size}px`,
          '--panel-bottom-h': `${workbench.bottom.size}px`,
        } as CSSProperties
      }
      {...(zoom ? { 'data-zoom': zoom.scope } : {})}
      {...(corner ? { 'data-lights': corner } : {})}
      {...(dragging ? { 'data-dragging': '' } : {})}
      {...(narrow ? { 'data-narrow': '' } : {})}
    >
      {/* The dim behind a floating sidebar. Pressing it is the plainest way
          to put the sidebar away, and it is what keeps a press meant for the
          sidebar from landing on the conversation underneath. Before the
          sidebar in the markup, so the sidebar paints over it at one layer. */}
      {narrow && (
        <div
          className={styles.scrim}
          {...(floating ? { 'data-open': '' } : {})}
          aria-hidden
          /* Not a control, so a press on it keeps focus where it is: pressed
             while it still fades after Escape, it would otherwise drop the
             focus Escape has just given back. */
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => store.closeFloatingSidebar()}
        />
      )}
      <div
        ref={sidebarBox}
        className={styles.sidebar}
        /* The column animates to nothing; its contents keep the width they had
           and are clipped by it. Letting them reflow instead turns every
           collapse into a half-second of the sidebar rewrapping itself at
           widths nobody asked to see.

           The width is a name rather than a number so that a drag can move it
           without going anywhere near React — see `AreaSeam`. Still inline,
           though, and not moved into the stylesheet: a zoom already sets these
           boxes from `.shell[data-zoom] …`, which outranks a plain class rule,
           and the two would then be arguing about who decides a width.

           Floating, it keeps its width either way and slides instead: it
           covers the conversation rather than sharing the window with it, so
           there is nothing for a changing width to hand back. */
        style={{ width: showSidebar || narrow ? 'var(--panel-sidebar)' : 0 }}
        {...(showSidebar ? {} : { 'data-hidden': '' })}
        /* Floating, it is a surface laid over the page and it takes focus as
           one, so it says what it is — its role and its name — rather than
           arriving as an unnamed group. Not flagged as modal for assistive
           technology: what it covers is really inert, which is all that flag
           would say. */
        {...(floating ? { 'data-floating': '', tabIndex: -1, role: 'dialog', 'aria-label': 'Sidebar' } : {})}
      >
        {/* The sidebar's own panels are rendered from inside `Sidebar`, at the
            `sidebar.panel` slot it has always had — between the session list
            and the account row, so the account stays at the bottom of the
            column where a person looks for it. That slot is the plugin
            mounting point too, which is the arrangement worth keeping: the
            app's own panels arrive by the same door a plugin's will. */}
        {sidebar}
        <DropZone area="sidebar" />
      </div>
      {column && (
        <AreaSeam area="sidebar" orientation="vertical" label="Resize the sidebar" direction={1} />
      )}

      <div ref={content} className={styles.content}>
        {/* The row holding the split tree and the right panel. It collapses as
            a unit when neither is on screen — a zoomed bottom panel would
            otherwise sit under the empty space where they were, which reads as
            a panel that failed to expand rather than one that did. */}
        <div
          className={styles.middle}
          {...(areaVisible(workbench, 'main') || areaVisible(workbench, 'right')
            ? {}
            : { 'data-hidden': '' })}
        >
          <div
            className={styles.main}
            {...(areaVisible(workbench, 'main') ? {} : { 'data-hidden': '' })}
            /* Covered by a right panel that took a narrow window's width, the
               conversation is out of reach as well as out of sight, as it is
               under the floating sidebar: Tab from the panel walked into the
               composer and the header behind it. */
            {...(narrow && rightPanelDrawn(workbench) && areaVisible(workbench, 'main') ? { inert: true } : {})}
          >
            <Panes />
            <DropZone area="main" />
          </div>
          <RightPanel />
        </div>
        <BottomPanel />
      </div>
    </div>
    </ShellContext.Provider>
    </DragContext.Provider>
  )
}

/** Whether the right panel draws a panel at all, rather than only its drop zone. */
const rightPanelDrawn = (workbench: WorkbenchModel): boolean =>
  dockViews(workbench.right).length > 0 && areaVisible(workbench, 'right') && !workbench.right.collapsed

const RightPanel = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const workbench = snapshot.workbench
  // A panel with nothing in it is not a panel. Its seam, its strip and its
  // border would all be furniture around an empty box — and the way back is
  // the control that put something there in the first place.
  // Collapsed means gone, for this one area. The bottom panel and the sidebar
  // stack collapse to their tab strips because a horizontal strip is a
  // legitimate resting state; a column has none — a vertical panel showing
  // only a row of tabs is a column of nothing with a border. The way back is
  // the control that opened it, which is where it has always been.
  // An area with nothing in it draws no panel — but it must still be a place
  // you can drag something to, or the only way to fill it is the ⋯ menu and
  // the drag is a gesture that silently does nothing.
  if (!rightPanelDrawn(workbench)) return <EdgeDropZone area="right" />
  // A zoomed panel takes the room rather than its remembered width, and the
  // seam goes with it: there is nothing on the other side of it to resize
  // against, and a handle that moves nothing is a handle that looks broken.
  const zoomed = workbench.zoom?.area === 'right'
  // A narrow window has no room for a panel beside the conversation, so the
  // panel takes the conversation's width while it is open, and the seam goes
  // for the same reason it goes in a zoom: nothing beside it to trade with.
  const sized = !zoomed && !snapshot.narrowWindow
  return (
    <>
      {sized && (
        <AreaSeam area="right" orientation="vertical" label="Resize the right panel" direction={-1} />
      )}
      <div className={styles.right} style={sized ? { width: 'var(--panel-right)' } : undefined}>
        <PanelArea area="right" />
      </div>
    </>
  )
}

const BottomPanel = () => {
  const store = useStore()
  const workbench = useSnapshot().workbench
  const dock = workbench.bottom
  const shown = areaVisible(workbench, 'bottom')
  if (dockViews(dock).length === 0 || !shown) return <EdgeDropZone area="bottom" />
  const zoomed = workbench.zoom?.area === 'bottom'
  const height = dock.collapsed || zoomed ? undefined : 'var(--panel-bottom)'
  return (
    <>
      {!dock.collapsed && !zoomed && (
        <AreaSeam area="bottom" orientation="horizontal" label="Resize the bottom panel" direction={-1} />
      )}
      <div className={styles.bottom} style={height ? { height } : undefined}>
        <PanelArea area="bottom" />
      </div>
    </>
  )
}

/**
 * A sidebar floating over a narrow window behaves like the thing on top that
 * it is: focus goes into it, what it covers cannot be reached until it goes,
 * Escape puts it away, and focus comes back to where it was.
 *
 * Escape is heard on the window, in the bubble phase — after everything inside
 * the sidebar has had its turn. A menu, a filter field or a rename that spends
 * the key says so with `preventDefault`, and then the sidebar stays: one press
 * closes one thing. A dialog opened from the sidebar never lets the key get
 * this far at all (see `Dialog`).
 */
const useFloatingSidebar = (
  floating: boolean,
  sidebar: RefObject<HTMLDivElement | null>,
  content: RefObject<HTMLDivElement | null>,
): void => {
  const store = useStore()
  const opener = useRef<HTMLElement | null>(null)
  // So that putting it away is told apart from never having opened it.
  const floated = useRef(false)
  useLayoutEffect(() => {
    if (floating) {
      floated.current = true
      /*
       * A menu the conversation had open goes first, as it does for a dialog.
       * Menus are drawn above the modal layer, so one left open lay over the
       * sidebar, in reach, with its trigger inert beneath it — and ⌘B is not
       * a press outside it, so nothing else closed it. First, and asking for
       * focus back: a menu holding focus then gives it to its trigger as it
       * goes, and that trigger is what focus should come back to.
       */
      dismissOverlays({ returnFocus: true })
      // Taken before the content goes inert: making the focused control inert
      // moves focus to the page, and then there is nothing to come back to.
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      /*
       * Everything it lies over: the workbench's own content, and whatever the
       * app marks as floating over the conversation — the standing notices,
       * drawn under the dim, whose buttons Tab would otherwise walk into
       * behind it. Found by that mark, not by where they sit, so wrapping the
       * workbench or giving the page another layer cannot quietly uncover
       * them or cover something else. A toast is not so marked and stays in
       * reach, drawn above the sidebar: it is so often the answer to something
       * done in the sidebar itself — an archive's Undo. Most leave on their
       * own; an error stays until it is dismissed, and its × is in reach for
       * the same reason.
       *
       * Only what this makes inert is given back: something already inert
       * for its own reasons stays so.
       */
      const beside = Array.from(document.querySelectorAll('[data-over-conversation]'))
      const covered = [content.current, ...beside].filter(
        (element): element is HTMLElement => element instanceof HTMLElement && !element.hasAttribute('inert'),
      )
      for (const element of covered) element.setAttribute('inert', '')
      // The surface, as a dialog does, rather than the first row in it: landing
      // on a row means a stray Return opens a conversation nobody chose.
      sidebar.current?.focus({ preventScroll: true })
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        store.closeFloatingSidebar()
      }
      window.addEventListener('keydown', onKeyDown)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        for (const element of covered) element.removeAttribute('inert')
      }
    }
    if (!floated.current) return
    floated.current = false
    /*
     * Put away: its own menus go with it — one left open hung over the
     * conversation with nothing under it that had opened it — and focus goes
     * back to what opened it. Both here, once the commit has settled, and not
     * in the cleanup above: React puts focus back on whatever held it before a
     * commit's changes once they are made, which is after a cleanup runs, so a
     * cleanup's `focus()` came straight back undone whenever the key had been
     * pressed on a control inside the sidebar, or inside one of its menus.
     *
     * Only when nothing else has taken focus in the meantime: a row that opened
     * a conversation has already said where the reader is. A menu that held
     * focus has just given it to its trigger, which is in the sidebar.
     */
    dismissOverlays({ returnFocus: true })
    const back = opener.current
    opener.current = null
    if (!back) return
    const active = document.activeElement
    const stranded = active === null || active === document.body || sidebar.current?.contains(active) === true
    if (stranded && back.isConnected) back.focus({ preventScroll: true })
  }, [floating, sidebar, content, store])
}

/**
 * One docked area: a tab strip, the panel's controls, and every view it holds.
 *
 * Every view stays mounted and the ones not on screen are hidden rather than
 * unmounted — `visibility`, not `display`. A terminal under `display: none`
 * measures zero columns and reflows its whole screen when it comes back; a
 * `<webview>` tears down its rendering surface and returns blank. Hiding costs
 * a little memory and keeps a diff's scroll position, a shell's screen and a
 * page's history exactly where they were.
 */
const PanelArea = ({ area }: { area: DockId }) => {
  const dock = useSnapshot().workbench[area]
  if (dockViews(dock).length === 0) return null
  return <DockNodeView area={area} node={dock.root} collapsed={dock.collapsed} />
}

/**
 * A dock's tree, drawn.
 *
 * A stack is a panel; a branch is two of them sharing the space with a seam
 * between. Collapsed, the branch layout is dropped and the strips are stacked
 * in a column — two half-width tab bars side by side would be a puzzle, and
 * the strip's only job while collapsed is to be the way back.
 */
const DockNodeView = ({
  area,
  node,
  collapsed,
}: {
  area: DockId
  node: DockNode
  collapsed: boolean
}) =>
  node.kind === 'stack' ? (
    <StackPanel area={area} stack={node} collapsed={collapsed} />
  ) : collapsed ? (
    <div className={styles.strips}>
      <DockNodeView area={area} node={node.first} collapsed />
      <DockNodeView area={area} node={node.second} collapsed />
    </div>
  ) : (
    <DockSplit area={area} branch={node} />
  )

/**
 * The seam between two halves of a panel.
 *
 * A ratio rather than pixels, because this is a split *within* an area whose
 * own size is already settled: the two halves share what the area was given,
 * the way two documents share a column.
 *
 * The ratio is a custom property on the split, and the halves are sized off it
 * in CSS — so a drag is one property write per frame and the browser does the
 * arithmetic, rather than a `setState` that re-renders both panels and
 * everything mounted inside them. The store hears the number it lands on.
 */
const DockSplit = ({ area, branch }: { area: DockId; branch: DockBranch }) => {
  const store = useStore()
  const container = useRef<HTMLDivElement>(null)
  const grab = useRef<{ readonly at: number; readonly ratio: number; readonly span: number } | null>(
    null,
  )
  const live = useRef(branch.ratio)

  const clear = (): void => {
    container.current?.style.removeProperty('--split-drag')
  }

  /* The committed ratio is in; the drag's override goes, in the same paint. */
  /* Wrapped, not passed: `removeProperty` answers with the value it removed,
     and a layout effect that returns a string is a cleanup function as far
     as React is concerned. */
  useLayoutEffect(() => {
    clear()
  }, [branch.ratio])

  const show = (next: number): void => {
    live.current = next
    /* Four decimals: finer than a split can be seen, and it keeps
       `0.15000000000000002` out of the CSSOM and the inspector. */
    container.current?.style.setProperty('--split-drag', next.toFixed(4))
  }

  /**
   * The end of a gesture, however it ended, and only once — see `SplitView`
   * in `Panes.tsx`, which carries the same four entry points for the same
   * reasons. The guard is first because `endResize` is counted.
   */
  const stop = (node: Element | null, commit: boolean): void => {
    if (grab.current === null) return
    grab.current = null
    markDragging(node, false)
    markDragging(container.current, false)
    endResize()
    if (!commit) {
      clear()
      return
    }
    // Ending where it started commits a ratio the store already holds, so
    // nothing re-renders and the layout effect never fires; the override has
    // to come off here or it outlives the gesture and shadows this split for
    // the rest of the session.
    if (live.current === branch.ratio) clear()
    else store.resizePanelSplit(area, branch.id, live.current)
  }

  const onUnmount = useRef(stop)
  onUnmount.current = stop
  useEffect(() => () => onUnmount.current(null, false), [])

  return (
    <div
      ref={container}
      className={styles.split}
      data-direction={branch.direction}
      style={{ '--split-ratio': branch.ratio } as CSSProperties}
    >
      <div className={styles.half} data-side="first">
        <DockNodeView area={area} node={branch.first} collapsed={false} />
      </div>
      <ResizeHandle
        className={styles.splitSeam}
        orientation={branch.direction === 'row' ? 'vertical' : 'horizontal'}
        label="Resize these panels"
        value={branch.ratio}
        min={MIN_RATIO}
        max={MAX_RATIO}
        onChange={show}
        onCommit={(next) => store.resizePanelSplit(area, branch.id, next)}
        onPointerDown={(event) => {
          const bounds = container.current?.getBoundingClientRect()
          if (!bounds) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          markDragging(event.currentTarget, true)
          markDragging(container.current, true)
          beginResize(branch.direction === 'row' ? 'vertical' : 'horizontal')
          live.current = branch.ratio
          grab.current = {
            at: branch.direction === 'row' ? event.clientX : event.clientY,
            ratio: branch.ratio,
            span: branch.direction === 'row' ? bounds.width : bounds.height,
          }
        }}
        /* A delta from where the pointer went down, not the pointer's own
           position in the box: the seam is nine pixels of hit area around a
           one-pixel line, and measuring absolutely made it jump to centre
           itself under the pointer the instant you grabbed its edge. */
        onPointerMove={(event) => {
          const start = grab.current
          if (!start || start.span === 0) return
          const now = branch.direction === 'row' ? event.clientX : event.clientY
          show(Math.min(MAX_RATIO, Math.max(MIN_RATIO, start.ratio + (now - start.at) / start.span)))
        }}
        onPointerUp={(event) => stop(event.currentTarget, true)}
        onPointerCancel={(event) => stop(event.currentTarget, false)}
        onLostPointerCapture={(event) => stop(event.currentTarget, true)}
      />
      <div className={styles.half} data-side="second">
        <DockNodeView area={area} node={branch.second} collapsed={false} />
      </div>
    </div>
  )
}

/** One stack of tabs: the thing a person calls "a panel". */
const StackPanel = ({
  area,
  stack,
  collapsed,
}: {
  area: DockId
  stack: DockStack
  collapsed: boolean
}) => {
  const store = useStore()
  const { setDragging } = useContext(DragContext)
  const snapshot = useSnapshot()
  const workbench = snapshot.workbench
  const titleOf = useViewTitle()
  const shown = stackView(stack)

  /*
   * A strip above the view answers two questions: what else is in here, and
   * what can I do to this panel. When the stack holds one view that draws its
   * own header — the browser's tab row, a terminal's path line — it answers
   * neither: the first has no other answer, and the second moves into that
   * header. Drawing it anyway is what put a tab row above the browser's tab
   * row, with expand and close in both.
   */
  const owns = shown ? views.get(shown.view.kind)?.ownsChrome === true : false
  const strip = !(owns && stack.views.length === 1)

  return (
    <DockPanel edge={AREA_EDGE[area]} collapsed={collapsed} className={styles.panel}>
      {strip && (
      <DockPanelBar>
        <DockPanelTabs
          label={LABEL[area]}
          value={shown?.id ?? null}
          onValueChange={(id) => store.activateView(area, id)}
        >
          {stack.views.map((mounted) => {
            const Glyph = iconOf(mounted.view)
            return (
              <span
                key={mounted.id}
                draggable
                onDragStart={(event: DragEvent<HTMLSpanElement>) => {
                  event.dataTransfer.setData(DRAG_TYPE, mounted.id)
                  event.dataTransfer.effectAllowed = 'move'
                  setDragging({ id: mounted.id, view: mounted.view })
                }}
                onDragEnd={() => setDragging(null)}
              >
                <DockPanelTab
                  value={mounted.id}
                  label={titleOf(mounted.view)}
                  icon={Glyph ? <Glyph size={14} /> : undefined}
                  live={views.get(mounted.view.kind)?.live?.(snapshot) === true}
                  onClose={() => store.closeView(mounted.id)}
                />
              </span>
            )
          })}
        </DockPanelTabs>
        <DockPanelActions>
          {/* The actions act on the view the strip is showing, so they are
              given its mount to read — the same one the view itself gets. */}
          {shown && (
            <MountProvider scope={{ area, id: shown.id, view: shown.view }}>
              <PanelActions where="strip" />
            </MountProvider>
          )}
        </DockPanelActions>
      </DockPanelBar>
      )}
      {!collapsed && (
        /* Under a strip, the views are no longer in the window's corner — the
           strip is — so the room reserved for the window buttons is spent
           there and put back to zero here. Without a strip this panel's one
           view draws the corner row itself and keeps it. */
        <DockPanelBody className={styles.layers} {...(strip ? { 'data-under-bar': '' } : {})}>
          {stack.views.map((mounted) => (
            <div
              key={mounted.id}
              className={styles.layer}
              {...(mounted.id === shown?.id ? {} : { 'data-hidden': '' })}
              // Working in a panel makes it the one the sidebar, the palette
              // and the window title are about. Capture phase, so a click on a
              // control inside it counts too.
              onPointerDownCapture={() => store.focusView(mounted.id)}
              onFocusCapture={() => store.focusView(mounted.id)}
            >
              <MountProvider scope={{ area, id: mounted.id, view: mounted.view }}>
                <Scoped view={mounted.view} id={mounted.id}>
                  <ViewHost view={mounted.view} />
                </Scoped>
              </MountProvider>
            </div>
          ))}
          <DropZone area={area} stack={stack.id} />
        </DockPanelBody>
      )}
    </DockPanel>
  )
}

/**
 * The session scope a docked panel gets — for a conversation, and only for a
 * conversation.
 *
 * A docked transcript is about *its own* session: its composer sends there,
 * its approvals belong to it, its header names it. Every other panel is about
 * whichever conversation is in front — Changes shows what *that* one edited —
 * and giving those a scope of their own would pin them to nothing, because
 * `useSessionKey` reads the scope first and only falls back to the focused
 * conversation when there is none.
 *
 * So the rule is exactly one line long, and it is this one.
 */
const Scoped = ({
  view,
  id,
  children,
}: {
  view: PaneView
  id: string
  children: ReactNode
}) =>
  view.kind === 'conversation' ? (
    <PaneProvider scope={{ paneId: id, view, sessionKey: view.session }}>{children}</PaneProvider>
  ) : (
    <>{children}</>
  )

/**
 * A seam between two areas: dragged on the DOM, committed once.
 *
 * The size used to go straight to the store on every pointer-move frame, and
 * each one built a new workbench, re-rendered every panel and queued a write —
 * sixty times a second, to land on one number. Then it went to local state
 * instead, which fixed the cost and broke the drag: the panel being resized is
 * this component's *sibling*, and it reads the store, so a preview kept here
 * moved nothing at all. The sidebar, the right panel and the bottom panel all
 * sat still under the pointer and jumped to their new size on release — the
 * sidebar animating the jump, because it has a width transition for collapse.
 *
 * So the live value is neither: it is a custom property on the shell, which
 * the panel's own width already reads. Nothing re-renders while the pointer
 * moves, the panel tracks it exactly, and the store hears the number the
 * gesture stopped on.
 */
const AreaSeam = ({
  area,
  orientation,
  label,
  direction,
}: {
  area: DockId
  orientation: 'vertical' | 'horizontal'
  label: string
  direction: 1 | -1
}) => {
  const store = useStore()
  const shell = useContext(ShellContext)
  const size = useSnapshot().workbench[area].size

  /*
   * The committed size has landed, so the drag's override has to go — or it
   * outranks every later change and the panel stops answering to anything but
   * its own seam. A layout effect, so the removal and the new committed value
   * are the same paint and there is no frame showing the old width.
   */
  useLayoutEffect(() => {
    shell.current?.style.removeProperty(LIVE[area])
  }, [shell, area, size])

  const limits = dockLimits(area)
  /* What the store will hold once it is told `next` — the same clamp and the
     same rounding `resizeDock` applies, so the two can be compared. */
  const landing = (next: number): number =>
    Math.min(limits.max, Math.max(limits.min, Math.round(next)))

  return (
    <PanelSeam
      orientation={orientation}
      label={label}
      size={size}
      {...limits}
      direction={direction}
      onResize={(next) => shell.current?.style.setProperty(LIVE[area], `${Math.round(next)}px`)}
      /* Abandoned: the override is the only thing holding the size the pointer
         reached, and no commit is coming to replace it. */
      onCancel={() => shell.current?.style.removeProperty(LIVE[area])}
      onCommit={(next) => {
        /* A drag that ends on the size the store already holds changes
           nothing, so this component never re-renders and the layout effect
           above never runs — the override would stay on the shell for the rest
           of the session and shadow every later change to this panel. It is
           safe to drop it here for the one reason that matters: the value did
           not move, so what the override paints is what the committed size
           paints. Anything that *did* move is left to the effect, which clears
           it in the same paint the new size arrives — never a frame earlier,
           or the panel flicks back to where the drag began. */
        if (landing(next) === size) shell.current?.style.removeProperty(LIVE[area])
        else store.resizePanel(area, next)
      }}
    />
  )
}

/**
 * The landing strip for an area that has nothing in it yet.
 *
 * A dock with no views draws no panel, which left the right and bottom edges
 * un-droppable: you could only put something there through the ⋯ menu, and the
 * drag — the gesture everyone reaches for first — did nothing at all. This is
 * a thin band along the edge, present only while a drag that it would accept
 * is in flight.
 */
const EdgeDropZone = ({ area }: { area: DockId }) => {
  const { dragging } = useContext(DragContext)
  if (!dragging || !views.permits(dragging.view, area)) return null
  return (
    <div className={styles.edgeDrop} data-area={area}>
      <DropZone area={area} />
    </div>
  )
}

/**
 * Where a dragged tab may be dropped.
 *
 * Inert and invisible until a drag is in flight, and then only over areas the
 * dragged view actually declares — a zone that lights up and then refuses the
 * drop is worse than no zone at all, because the person learns the wrong rule
 * and tries again.
 *
 * `stack` is set for the zone covering one stack's body, and it is what makes a
 * split panel reversible: without it a drop into the other half of the right
 * panel was a move from `right` to `right`, which the model reads as "already
 * where you asked" and answers by doing nothing. The zone lit up, took the
 * drop and left the tab where it was — the very failure the paragraph above
 * describes, at the one target a person reaches for to undo a split.
 *
 * Which is also why the same id decides whether to light up at all: a drop
 * that would land a view exactly where it already is now draws no zone.
 */
const DropZone = ({ area, stack }: { area: AreaId; stack?: string }) => {
  const store = useStore()
  const workbench = useSnapshot().workbench
  const { dragging } = useContext(DragContext)
  const [over, setOver] = useState(false)

  const from = dragging ? areaOfMount(workbench, dragging.id) : null
  const fromStack =
    dragging && from !== null && from !== 'main' ? (stackOf(workbench[from], dragging.id)?.id ?? null) : null
  const accepts =
    dragging !== null &&
    views.permits(dragging.view, area) &&
    (area !== from || (stack !== undefined && stack !== fromStack))

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setOver(false)
      const id = event.dataTransfer.getData(DRAG_TYPE)
      if (id) store.moveView(id, area, stack)
    },
    [area, stack, store],
  )

  if (!accepts) return null

  return (
    <div
      className={styles.drop}
      data-area={area}
      {...(over ? { 'data-over': '' } : {})}
      aria-hidden
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={onDrop}
    >
      <span className={styles.dropLabel}>Dock in {AREA_NAME[area]}</span>
    </div>
  )
}

/**
 * The sidebar's panels, registered into the slot the sidebar already had.
 *
 * Registered here, at module scope, rather than in `builtins.tsx`: that file is
 * imported by this one, and a registration living there would have to import
 * `PanelArea` back out of it.
 */
registerSlot('sidebar.panel', 'hd.panels', () => <PanelArea area="sidebar" />, { order: 50 })
