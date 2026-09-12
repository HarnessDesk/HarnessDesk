import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { useSnapshot, useStore } from '../state/context'
import type { PaneView } from '../state/layout'
import { stackOf, type AreaId, type DockId, type Zoom } from '../state/workbench'
import { views } from './views'

/**
 * Where a feature is mounted — and the controls that act on the panel holding
 * it, which are deliberately not the feature's own.
 *
 * The rule this enforces is the third requirement of the panel system:
 * **a feature must not depend on where it is drawn.** Before this, every tool
 * pane rendered its own expand and close buttons, wired to `layout.expanded`
 * and `closePane` — so a view could only ever be a pane, because those two
 * calls only mean something to the split tree. Moving the same component to
 * the bottom panel would have left two dead controls in its header.
 *
 * Now the header asks the mount. In a pane, `close` closes the pane; in a dock,
 * it takes the tab off the strip. The component is identical either way and
 * does not know which happened, which is exactly what "movable between
 * mounting points without changing its implementation" has to mean if it is to
 * mean anything.
 */

export interface MountScope {
  readonly area: AreaId
  /** The pane's id in `main`, the mounted view's id in a dock. */
  readonly id: string
  readonly view: PaneView
}

const MountContext = createContext<MountScope | null>(null)

export const MountProvider = ({ scope, children }: { scope: MountScope; children: ReactNode }) => (
  <MountContext.Provider value={scope}>{children}</MountContext.Provider>
)

/** Where this component is mounted, or null outside the panel system. */
export const useMount = (): MountScope | null => useContext(MountContext)

export interface MountControls {
  readonly area: AreaId
  readonly view: PaneView
  /** Whether anything would be given up by closing — a lone pane gives nothing. */
  readonly canClose: boolean
  readonly close: () => void
  /** The areas this view declares and is not already in. */
  readonly destinations: readonly AreaId[]
  readonly moveTo: (area: AreaId) => void
  /** The scope this mount's area currently holds, or null when it holds none. */
  readonly zoom: Zoom['scope'] | null
  /**
   * What "give this the room" means where this thing is mounted.
   *
   * A docked panel takes the **content** area: the sidebar stays, because
   * changing conversation is still a thing you do while reading a diff. The
   * main area cannot ask for that — it *is* the content area — so for it the
   * only scope that means anything is the **window**.
   *
   * Getting this wrong is not a subtle failure. A room fills the middle with
   * no dock open, and `content` then hid a right panel that was not there, a
   * bottom panel that was not there, and nothing else: the icon flipped to
   * "restore" and the screen did not move. Reported from the running app as
   * "the top right button doesn't work", which is exactly what it was.
   */
  readonly zoomScope: Zoom['scope']
  /** Presses the same scope again to hand the room back. */
  readonly setZoom: (scope: Zoom['scope']) => void
  /** Whether there is anything to split off — a stack of one has nothing. */
  readonly splittable: boolean
  readonly split: (direction: 'row' | 'column') => void
  readonly collapsed: boolean
  readonly toggleCollapse: () => void
  /**
   * Who draws this panel's controls.
   *
   * `panel` is the ordinary case: the strip above the view carries them, next
   * to the tabs. `own` is for a view that already draws a header of its own —
   * the browser's tab strip, a terminal's path line — and is *alone* in its
   * stack, so the strip above it would say nothing the view is not already
   * saying and would cost a second row to say it.
   *
   * The rule exists because both were true at once for a while: the browser
   * showed the panel's tabs above its own, and expand and close twice.
   */
  readonly chrome: 'own' | 'panel'
}

/**
 * The controls for whichever panel this component is inside.
 *
 * `null` outside the panel system, which is how a component rendered in the
 * design explorer, in a dialog, or on a preview page draws no panel furniture
 * rather than throwing.
 */
export const useMountControls = (): MountControls | null => {
  const store = useStore()
  const snapshot = useSnapshot()
  const scope = useMount()

  return useMemo(() => {
    if (!scope) return null
    const { area, id, view } = scope
    const dock = area === 'main' ? null : snapshot.workbench[area]
    const holding = dock ? stackOf(dock, id) : null
    const alone = holding ? holding.views.length === 1 : true
    const collapsed = dock?.collapsed ?? false
    // The view promises to draw the controls, and there is no tab strip worth
    // keeping. Both, and the panel steps back.
    const owns = views.get(view.kind)?.ownsChrome === true
    // In the split tree the last pane is not closable: closing it would leave
    // nowhere for the next conversation to open, so `layout.ts` empties it
    // instead — and a control that visibly does nothing is worse than no
    // control. A docked view is always closable; its panel goes with it.
    const canClose = area !== 'main' || snapshot.layout.root.kind === 'split'
    return {
      area,
      view,
      canClose,
      close: () => (area === 'main' ? store.closePane(id) : store.closeView(id)),
      destinations: views.destinations(view, area),
      moveTo: (to: AreaId) => store.moveView(id, to),
      splittable: holding ? holding.views.length > 1 : false,
      split: (direction: 'row' | 'column') => store.splitPanel(id, direction),
      collapsed,
      toggleCollapse: () => {
        if (area !== 'main') store.togglePanel(area)
      },
      /*
       * The main area never draws a strip, so a view there that owns its
       * header must always draw the verbs — `alone` is about whether there
       * are tabs above, and in the split tree there never are. Excluding
       * `main` here meant a panel dragged to the middle lost its close, its
       * expand and its way back out: reported from the running app as "there
       * is no way to close it".
       */
      /*
       * And collapsed, the chrome is the panel's whatever the view promised:
       * the view is not drawn at all then, so a header of its own is a header
       * nobody can see. `Workbench.tsx` draws the strip for the same reason —
       * were these two to disagree, the strip would print a ✕ on the tab and
       * `PanelActions` another beside it (#232).
       */
      chrome: owns && (area === 'main' || (alone && !collapsed)) ? 'own' : 'panel',
      zoom: snapshot.workbench.zoom?.area === area ? snapshot.workbench.zoom.scope : null,
      zoomScope: area === 'main' ? 'window' : 'content',
      setZoom: (next: Zoom['scope']) => {
        // Zoom names an area; inside `main` it is `expanded` that names the
        // pane. One press has to move both — and *unmove* both, because the
        // same press is what leaves. That was two store calls until review
        // pointed out that two calls are two chances to be seen half-done; the
        // middle has a verb of its own now, and the ordering question is the
        // store's rather than this component's.
        //
        // The bug it replaced is worth keeping in view: the second press
        // dropped the zoom and left `expanded` pointed at this pane, so the
        // pane it had been sharing the split with never came back.
        if (area === 'main') store.zoomMainPane(id, next)
        else store.zoomPanel(area, next)
      },
    }
  }, [scope, snapshot.layout.root.kind, snapshot.layout.expanded, snapshot.workbench, store])
}

/** What a docked area's own chrome needs, without a view in hand. */
export const usePanelControls = (
  area: DockId,
): {
  readonly collapsed: boolean
  readonly toggle: () => void
  readonly zoom: Zoom['scope'] | null
  readonly setZoom: (scope: Zoom['scope']) => void
} => {
  const store = useStore()
  const snapshot = useSnapshot()
  const zoom = snapshot.workbench.zoom
  return {
    collapsed: snapshot.workbench[area].collapsed,
    toggle: () => store.togglePanel(area),
    zoom: zoom?.area === area ? zoom.scope : null,
    setZoom: (scope) => store.zoomPanel(area, scope),
  }
}
