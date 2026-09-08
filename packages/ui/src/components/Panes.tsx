import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { ResizeHandle } from '../design/ui'
import { DockPanelActions, DockPanelBar } from '../design/patterns/DockPanel'
import { beginResize, endResize, markDragging } from '../lib/resizing'
import { MountProvider } from '../panels/mount'
import { PanelActions } from '../panels/PanelActions'
import { ViewHost, useViewTitle, views } from '../panels/views'
import { PaneProvider, useSnapshot, useStore } from '../state/context'
import { sessionOf, type LayoutNode, type Pane as PaneNode, type Split } from '../state/layout'
import styles from './Panes.module.css'

/**
 * The main content area: the split tree, rendered.
 *
 * Each leaf is one mounted view — usually the conversation, sometimes a tool —
 * wrapped in the two scopes anything inside it might ask about. `PaneProvider`
 * answers "which conversation am I about", which is a pane's own question and
 * always has been. `MountProvider` answers "where am I, and what may act on
 * me", which is the panel system's, and is why the same components draw
 * correctly here and in the right or bottom panel without knowing which.
 *
 * What used to be here as well: a `switch` naming every feature the app has,
 * and four callbacks threaded through three components so that a conversation
 * nested inside the team room could reach the shell. Both are gone — the
 * switch is `panels/views.tsx`, the callbacks are a context — and what is left
 * is the geometry, which is all a split tree was ever about.
 */

export const Panes = () => {
  const snapshot = useSnapshot()
  return (
    <div className={styles.root}>
      <Node node={snapshot.layout.root} />
    </div>
  )
}

/**
 * Whether a pane has to be given a strip: the view draws no header of its own
 * and is not the conversation, which has the window's.
 */
const needsStrip = (view: PaneNode['view']): boolean =>
  view.kind !== 'conversation' && views.get(view.kind)?.ownsChrome !== true

const Node = ({ node }: { node: LayoutNode }) =>
  node.kind === 'pane' ? <PaneView pane={node} /> : <SplitView split={node} />

const PaneView = ({ pane }: { pane: PaneNode }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const titleOf = useViewTitle()
  const focused = snapshot.layout.focused === pane.id

  // Focus is tracked, not drawn: a ring around the focused pane was a
  // second thing to read on every screen, and with one conversation at a
  // time the headers already say which pane is which — neither Codex's nor
  // Claude's own app outlines the active pane.
  return (
    <PaneProvider scope={{ paneId: pane.id, view: pane.view, sessionKey: sessionOf(pane) }}>
      <MountProvider scope={{ area: 'main', id: pane.id, view: pane.view }}>
        <section
          className={styles.pane}
          /* A strip above the view is the row in the window's corner, so it is
             the one that leaves room for the window buttons and the view below
             it does not. See `--titlebar-inset` in `app.css`. */
          {...(needsStrip(pane.view) ? { 'data-strip': '' } : {})}
          // Any interaction inside a pane makes it the target of shortcuts and
          // commands; capture phase so a click on a control counts too.
          onPointerDownCapture={() => {
            if (!focused) store.focusPane(pane.id)
          }}
          onFocusCapture={() => {
            if (!focused) store.focusPane(pane.id)
          }}
        >
          {/*
            * A strip, for a view that brought no header of its own.
            *
            * The main area draws no chrome — a conversation has its own header
            * and a tool draws `PanelActions` in its — but the inspectors, the
            * board and the room have neither. Dropped into the middle they
            * arrived with no title, no close and no way back to an edge, which
            * is what "I dragged it here and now I can't close it" meant.
            */}
          {needsStrip(pane.view) && (
            <DockPanelBar>
              <span className={styles.paneTitle}>{titleOf(pane.view)}</span>
              <DockPanelActions>
                <PanelActions where="strip" />
              </DockPanelActions>
            </DockPanelBar>
          )}
          <ViewHost view={pane.view} />
        </section>
      </MountProvider>
    </PaneProvider>
  )
}

/** Whether a pane lives under this node — which side of a split an expansion is on. */
const contains = (node: LayoutNode, paneId: string): boolean =>
  node.kind === 'pane' ? node.id === paneId : contains(node.first, paneId) || contains(node.second, paneId)

/**
 * A resizable split.
 *
 * The ratio lives in the layout store, but a drag must not go through it: a
 * ratio written on every pointer-move frame re-renders both sides and
 * everything mounted inside them — a streaming transcript, a terminal, a
 * webview — sixty times a second, to land on one number. So the committed
 * ratio is a custom property on the split, the halves are sized off it in CSS,
 * and a drag writes that property straight to the DOM. Nothing re-renders
 * until the pointer comes up; see `lib/resizing.ts` for what else a drag has
 * to hold still.
 */
const SplitView = ({ split }: { split: Split }) => {
  const store = useStore()
  const container = useRef<HTMLDivElement>(null)
  const grab = useRef<{ readonly at: number; readonly ratio: number; readonly span: number } | null>(
    null,
  )
  const live = useRef(split.ratio)

  const clear = (): void => {
    container.current?.style.removeProperty('--split-drag')
  }

  /* The committed ratio has landed, so the drag's override goes — in the same
     paint, or there is a frame of the split back where it started. */
  /* Wrapped, not passed: `removeProperty` answers with the value it removed,
     and a layout effect that returns a string is a cleanup function as far
     as React is concerned. */
  useLayoutEffect(() => {
    clear()
  }, [split.ratio])

  const show = (next: number): void => {
    live.current = next
    /* Four decimals is finer than any display can resolve a split, and it
       keeps `0.15000000000000002` out of the CSSOM and the inspector. */
    container.current?.style.setProperty('--split-drag', next.toFixed(4))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const bounds = container.current?.getBoundingClientRect()
    if (!bounds) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    markDragging(event.currentTarget, true)
    markDragging(container.current, true)
    beginResize(split.direction === 'row' ? 'vertical' : 'horizontal')
    live.current = split.ratio
    grab.current = {
      at: split.direction === 'row' ? event.clientX : event.clientY,
      ratio: split.ratio,
      span: split.direction === 'row' ? bounds.width : bounds.height,
    }
  }

  /*
   * A delta from where the pointer went down, not the pointer's position in
   * the box. The handle is a nine-pixel hit area around a one-pixel line, so
   * measuring absolutely made the seam jump to centre itself under the pointer
   * the instant you took hold of its edge — every drag started with a twitch.
   */
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = grab.current
    if (!start || start.span === 0) return
    const now = split.direction === 'row' ? event.clientX : event.clientY
    show(Math.min(0.85, Math.max(0.15, start.ratio + (now - start.at) / start.span)))
  }

  /**
   * The end of a gesture, however it ended, and only once.
   *
   * Four things reach this now — pointer up, pointer cancel, capture lost, and
   * the split unmounting under the pointer — and releasing the capture raises
   * `lostpointercapture` for the gesture that just ended, so it must be safe
   * to call twice. The `grab` guard comes first for that reason: `endResize`
   * is counted, and giving back a suppression this drag never took would
   * unbalance the window for the next one.
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
    /* A drag that ends where it started commits a ratio the store already
       holds, so nothing re-renders and the layout effect above never runs —
       the override would sit on the node for the rest of the session,
       shadowing every later change to this split. Clearing it here is safe
       precisely because the value did not move: what the override was
       painting is what the committed ratio paints. */
    if (live.current === split.ratio) clear()
    else store.resizeSplit(split.id, live.current)
  }

  /* Taken off the screen mid-drag — a pane closed, a view moved to an edge —
     the pointer events that would have ended this gesture go to an element
     that no longer exists. The teardown is owed to the unmount as well, or the
     window keeps `data-hd-resizing` for the rest of the session. */
  const onUnmount = useRef(stop)
  onUnmount.current = stop
  useEffect(() => () => onUnmount.current(null, false), [])

  // An expansion zooms one pane: the side holding it takes the whole split
  // and the other keeps its state off screen. Splits that do not contain the
  // expanded pane at all sit inside a hidden side themselves, so they need
  // no opinion of their own.
  const expanded = useSnapshot().layout.expanded
  const zoom =
    expanded === null ? null : contains(split.first, expanded) ? 'first' : contains(split.second, expanded) ? 'second' : null
  /* Only a zoom sizes a side from here. Everything else is the ratio, and the
     ratio is CSS's — see the stylesheet. */
  const basis = (side: 'first' | 'second'): { flexBasis: string } | undefined =>
    zoom ? { flexBasis: zoom === side ? '100%' : '0%' } : undefined

  return (
    <div
      ref={container}
      className={styles.split}
      data-direction={split.direction}
      style={{ '--split-ratio': split.ratio } as CSSProperties}
    >
      <div
        className={styles.child}
        data-side="first"
        {...(zoom === 'second' ? { 'data-hidden': '' } : {})}
        style={basis('first')}
      >
        <Node node={split.first} />
      </div>
      {/* The handle is the design system's now. The drag stays here, because
          the ratio belongs to the layout store; what the component adds is the
          keyboard &mdash; arrows to nudge, Home/End to the extremes, Enter to
          collapse and back &mdash; and the `aria-valuenow` that lets the split
          be read out loud. See design/ui/resize-handle.tsx for why the library
          shadcn wraps was not taken with it. */}
      <ResizeHandle
        className={styles.handle}
        {...(zoom ? { 'data-hidden': '' } : {})}
        orientation={split.direction === 'row' ? 'vertical' : 'horizontal'}
        value={split.ratio}
        onChange={show}
        onCommit={(next) => store.resizeSplit(split.id, next)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => stop(event.currentTarget, true)}
        onPointerCancel={(event) => stop(event.currentTarget, false)}
        onLostPointerCapture={(event) => stop(event.currentTarget, true)}
      />
      <div
        className={styles.child}
        data-side="second"
        {...(zoom === 'first' ? { 'data-hidden': '' } : {})}
        style={basis('second')}
      >
        <Node node={split.second} />
      </div>
    </div>
  )
}
