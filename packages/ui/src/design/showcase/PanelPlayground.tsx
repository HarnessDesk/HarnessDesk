import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'

import { ResizeHandle } from '../ui/resize-handle'
import {
  DockPanel,
  DockPanelActions,
  DockPanelBar,
  DockPanelBody,
  DockPanelTab,
  DockPanelTabs,
  PanelSeam,
} from '../patterns/DockPanel'
import { Btn } from '../primitives/Kit'
import {
  AgentIcon,
  BranchIcon,
  CaretIcon,
  DiffIcon,
  ExpandIcon,
  HistoryIcon,
  RestoreIcon,
  SessionIcon,
  SplitDownIcon,
  SplitIcon,
  TerminalIcon,
  type IconProps,
} from '../../components/Icons'
import { panes, sessionOf, type PaneView } from '../../state/layout'
import {
  AREA_EDGE,
  AREA_NAME,
  VIEW_DRAG_TYPE,
  areaVisible,
  dock,
  dockLimits,
  emptyWorkbench,
  moveView,
  dockViews,
  resizeDock,
  resizeDockSplit,
  splitDock,
  stackView,
  toggleDock,
  undock,
  zoomArea,
  activate,
  type AreaId,
  type DockBranch,
  type DockId,
  type DockNode,
  type DockStack,
  type Workbench,
} from '../../state/workbench'
import styles from './panel-playground.module.css'

/**
 * The panel system, driven by nothing but itself.
 *
 * Every panel on this page is the real `DockPanel` chrome over the real
 * `state/workbench.ts` model — the same reducers the app runs — with `useState`
 * where the app has a store, and eight coloured stubs where the app has
 * features. That is the whole point of it being here rather than being a
 * picture: **the behaviour is the thing being reviewed**, and behaviour cannot
 * be drawn.
 *
 * It is also the argument for the design, made by construction. If docking,
 * resizing, collapsing and zooming all work on this page — with no store, no
 * socket, no agent, and views that are literally a coloured rectangle with a
 * name — then the model owes nothing to the features, and a feature owes
 * nothing to its position. Neither claim could be checked in the app, where a
 * working panel might always be working because of something the feature
 * inside it happens to do.
 *
 * Things worth trying, because each was a decision:
 *
 *   Drag a tab onto another area.   Only areas the view declares light up. A
 *                                   Conversation refuses every edge; a
 *                                   Terminal refuses the sidebar.
 *   Expand, then expand again.      One control takes the room and hands it
 *                                   back. Hold ⌥ for the window scope, which
 *                                   takes the sidebar too.
 *   Collapse the bottom panel.      The tab strip stays: that is the way back,
 *                                   and it is where the way in was.
 *   Drag a seam to the end.         Every panel has a floor, per area, because
 *                                   a shell wants rows and a document wants a
 *                                   readable column.
 */

// ------------------------------------------------------------------- stubs

/**
 * The stand-in features.
 *
 * Deliberately inert and deliberately identical to each other apart from a
 * name, an icon and a hue: a stub that did something would make it possible
 * for a panel to look correct because of what was inside it.
 */
const STUBS: Record<string, { readonly label: string; readonly icon: (props: IconProps) => ReactNode; readonly tint: string }> = {
  conversation: { label: 'Conversation', icon: SessionIcon, tint: 'blue' },
  changes: { label: 'Changes', icon: DiffIcon, tint: 'green' },
  activity: { label: 'Activity', icon: HistoryIcon, tint: 'violet' },
  agents: { label: 'Agents', icon: AgentIcon, tint: 'amber' },
  git: { label: 'Repository', icon: BranchIcon, tint: 'teal' },
  terminal: { label: 'Terminal', icon: TerminalIcon, tint: 'sky' },
}

/** The same declaration the app makes in `panels/builtins.tsx`, for the stubs. */
const MOUNTS: Record<string, readonly AreaId[]> = {
  conversation: ['main', 'right'],
  changes: ['right', 'bottom', 'sidebar', 'main'],
  activity: ['right', 'bottom', 'sidebar', 'main'],
  agents: ['right', 'bottom', 'sidebar', 'main'],
  git: ['right', 'main', 'bottom'],
  terminal: ['bottom', 'main'],
}

const permits = (view: PaneView, area: AreaId): boolean => MOUNTS[view.kind]?.includes(area) ?? false

const label = (view: PaneView): string => STUBS[view.kind]?.label ?? view.kind

const view = (kind: string): PaneView => ({ kind }) as PaneView

/* The same three the app reads. A prototype that kept its own copies would
   stop predicting the app the first time one of them changed. */
const EDGE = AREA_EDGE
const DRAG_TYPE = VIEW_DRAG_TYPE

// ------------------------------------------------------------------- page

const START = (): Workbench => {
  let workbench = dock(emptyWorkbench(), 'right', view('changes'))
  workbench = dock(workbench, 'right', view('agents'))
  workbench = dock(workbench, 'bottom', view('terminal'))
  workbench = dock(workbench, 'sidebar', view('activity'))
  return workbench
}

export const PanelPlayground = () => {
  const [workbench, setWorkbench] = useState<Workbench>(START)
  const [dragging, setDragging] = useState<PaneView | null>(null)
  const [scope, setScope] = useState<'content' | 'window'>('content')

  const undocked = useMemo(
    () =>
      Object.keys(STUBS).filter(
        (kind) =>
          kind !== 'conversation' &&
          !(['sidebar', 'right', 'bottom'] as DockId[]).some((area) =>
            dockViews(workbench[area]).some((entry) => entry.view.kind === kind),
          ),
      ),
    [workbench],
  )

  const zoom = workbench.zoom

  return (
    <div className={styles.page}>
      <div className={styles.controls}>
        <span className={styles.hint}>Add a panel</span>
        {undocked.length === 0 ? (
          <span className={styles.hint}>everything is docked</span>
        ) : (
          undocked.map((kind) => (
            <Btn
              key={kind}
              onClick={() =>
                setWorkbench((current) =>
                  dock(current, (MOUNTS[kind]?.[0] ?? 'right') as DockId, view(kind)),
                )
              }
            >
              {STUBS[kind]?.label}
            </Btn>
          ))
        )}
        <span className={styles.spacer} />
        {/* The scope a zoom uses. A switch here rather than a modifier key,
            because a page for reviewing behaviour should not hide half of it
            behind something you have to be told about. */}
        <span className={styles.hint}>Expand fills</span>
        <Btn onClick={() => setScope('content')} {...(scope === 'content' ? { 'data-on': '' } : {})}>
          the content area
        </Btn>
        <Btn onClick={() => setScope('window')} {...(scope === 'window' ? { 'data-on': '' } : {})}>
          the window
        </Btn>
        {zoom && <Btn onClick={() => setWorkbench((c) => zoomArea(c, zoom.area, zoom.scope))}>Reset zoom</Btn>}
      </div>

      <div className={styles.window} {...(dragging ? { 'data-dragging': '' } : {})}>
        <div
          className={styles.sidebar}
          style={{ width: areaVisible(workbench, 'sidebar') ? workbench.sidebar.size : 0 }}
          {...(areaVisible(workbench, 'sidebar') ? {} : { 'data-hidden': '' })}
        >
          <div className={styles.tree}>
            <span className={styles.treeTitle}>Sessions</span>
            {['Migrate auth callers', 'Integration tests', 'Ship the docs'].map((row) => (
              <span key={row} className={styles.treeRow}>
                {row}
              </span>
            ))}
          </div>
          <Area
            area="sidebar"
            workbench={workbench}
            setWorkbench={setWorkbench}
            dragging={dragging}
            setDragging={setDragging}
            scope={scope}
          />
          <Drop area="sidebar" dragging={dragging} onDrop={(id) => setWorkbench((c) => moveView(c, id, 'sidebar', permits))} />
        </div>
        {areaVisible(workbench, 'sidebar') && (
          <PanelSeam
            orientation="vertical"
            label="Resize the sidebar"
            size={workbench.sidebar.size}
            {...dockLimits('sidebar')}
            direction={1}
            onResize={(next) => setWorkbench((c) => resizeDock(c, 'sidebar', next))}
          />
        )}

        <div className={styles.content}>
          <div
            className={styles.middle}
            {...(areaVisible(workbench, 'main') || areaVisible(workbench, 'right')
              ? {}
              : { 'data-hidden': '' })}
          >
            <div
              className={styles.main}
              {...(areaVisible(workbench, 'main') ? {} : { 'data-hidden': '' })}
            >
              {/* The split tree, so that a drop into the main area is visible
                  rather than a panel that appears to vanish. Drawn flat and
                  without seams: the tree's own splitting and resizing is the
                  app's existing behaviour with its own tests, and repeating it
                  here would be reviewing the wrong thing. */}
              <div className={styles.panes}>
                {panes(workbench.main.root).map((pane) => (
                  <div key={pane.id} className={styles.pane}>
                    <Stub kind={sessionOf(pane) !== null || pane.view.kind === 'conversation' ? 'conversation' : pane.view.kind} />
                  </div>
                ))}
              </div>
              <Drop area="main" dragging={dragging} onDrop={(id) => setWorkbench((c) => moveView(c, id, 'main', permits))} />
            </div>
            {dockViews(workbench.right).length > 0 && !workbench.right.collapsed && areaVisible(workbench, 'right') && (
              <>
                {zoom?.area !== 'right' && (
                  <PanelSeam
                    orientation="vertical"
                    label="Resize the right panel"
                    size={workbench.right.size}
                    {...dockLimits('right')}
                    direction={-1}
                    onResize={(next) => setWorkbench((c) => resizeDock(c, 'right', next))}
                  />
                )}
                <div
                  className={styles.right}
                  style={zoom?.area === 'right' ? { flex: 1 } : { width: workbench.right.size }}
                >
                  <Area
                    area="right"
                    workbench={workbench}
                    setWorkbench={setWorkbench}
                    dragging={dragging}
                    setDragging={setDragging}
                    scope={scope}
                  />
                </div>
              </>
            )}
          </div>
          {dockViews(workbench.bottom).length > 0 && areaVisible(workbench, 'bottom') && (
            <>
              {!workbench.bottom.collapsed && zoom?.area !== 'bottom' && (
                <PanelSeam
                  orientation="horizontal"
                  label="Resize the bottom panel"
                  size={workbench.bottom.size}
                  {...dockLimits('bottom')}
                  direction={-1}
                  onResize={(next) => setWorkbench((c) => resizeDock(c, 'bottom', next))}
                />
              )}
              <div
                className={styles.bottom}
                style={
                  zoom?.area === 'bottom'
                    ? { flex: 1 }
                    : workbench.bottom.collapsed
                      ? undefined
                      : { height: workbench.bottom.size }
                }
              >
                <Area
                  area="bottom"
                  workbench={workbench}
                  setWorkbench={setWorkbench}
                  dragging={dragging}
                  setDragging={setDragging}
                  scope={scope}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const Area = ({
  area,
  workbench,
  setWorkbench,
  dragging,
  setDragging,
  scope,
}: {
  area: DockId
  workbench: Workbench
  setWorkbench: (next: (current: Workbench) => Workbench) => void
  dragging: PaneView | null
  setDragging: (next: PaneView | null) => void
  scope: 'content' | 'window'
}) => {
  const held = workbench[area]
  if (dockViews(held).length === 0) return null
  return (
    <Node
      area={area}
      node={held.root}
      collapsed={held.collapsed}
      workbench={workbench}
      setWorkbench={setWorkbench}
      dragging={dragging}
      setDragging={setDragging}
      scope={scope}
    />
  )
}

type NodeProps = {
  area: DockId
  node: DockNode
  collapsed: boolean
  workbench: Workbench
  setWorkbench: (next: (current: Workbench) => Workbench) => void
  dragging: PaneView | null
  setDragging: (next: PaneView | null) => void
  scope: 'content' | 'window'
}

/** A dock's tree: a stack is a panel, a branch is two of them sharing the space. */
const Node = (props: NodeProps) =>
  props.node.kind === 'stack' ? (
    <Stack {...props} stack={props.node} />
  ) : props.collapsed ? (
    <div className={styles.strips}>
      <Node {...props} node={props.node.first} />
      <Node {...props} node={props.node.second} />
    </div>
  ) : (
    <Split {...props} branch={props.node} />
  )

const Split = ({ branch, ...rest }: NodeProps & { branch: DockBranch }) => {
  const [preview, setPreview] = useState<number | null>(null)
  const ratio = preview ?? branch.ratio
  const box = useRef<HTMLDivElement>(null)
  /* The seam's pointer half, as the workbench wires it: a delta from where
     the pointer went down, clamped as the workbench clamps it. Without it the
     seam wore the resize cursor and moved only for the keyboard (review of
     #183, round 5). */
  const grab = useRef<{ at: number; ratio: number; span: number; live: number } | null>(null)
  const along = (event: { clientX: number; clientY: number }) => (branch.direction === 'row' ? event.clientX : event.clientY)
  const commit = (next: number) => {
    rest.setWorkbench((c) => resizeDockSplit(c, rest.area, branch.id, next))
    setPreview(null)
  }
  const stop = (seam: HTMLElement, keep: boolean) => {
    const held = grab.current
    if (!held) return
    grab.current = null
    seam.removeAttribute('data-dragging')
    if (keep) commit(held.live)
    else setPreview(null)
  }
  return (
    <div ref={box} className={styles.split} data-direction={branch.direction}>
      <div className={styles.half} style={{ flexBasis: `${ratio * 100}%` }}>
        <Node {...rest} node={branch.first} collapsed={false} />
      </div>
      <ResizeHandle
        className={styles.splitSeam}
        orientation={branch.direction === 'row' ? 'vertical' : 'horizontal'}
        label="Resize these panels"
        value={ratio}
        onChange={setPreview}
        onCommit={commit}
        onPointerDown={(event) => {
          const bounds = box.current?.getBoundingClientRect()
          if (!bounds) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          event.currentTarget.setAttribute('data-dragging', '')
          const span = branch.direction === 'row' ? bounds.width : bounds.height
          grab.current = { at: along(event), ratio, span, live: ratio }
        }}
        onPointerMove={(event) => {
          const held = grab.current
          if (!held || held.span === 0) return
          held.live = Math.min(0.85, Math.max(0.15, held.ratio + (along(event) - held.at) / held.span))
          setPreview(held.live)
        }}
        onPointerUp={(event) => stop(event.currentTarget, true)}
        onPointerCancel={(event) => stop(event.currentTarget, false)}
        onLostPointerCapture={(event) => stop(event.currentTarget, true)}
      />
      <div className={styles.half} style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <Node {...rest} node={branch.second} collapsed={false} />
      </div>
    </div>
  )
}

const Stack = ({
  area,
  stack,
  collapsed,
  workbench,
  setWorkbench,
  dragging,
  setDragging,
  scope,
}: NodeProps & { stack: DockStack }) => {
  const shown = stackView(stack)
  const zoomed = workbench.zoom?.area === area
  return (
    <DockPanel edge={EDGE[area]} collapsed={collapsed} className={styles.panel}>
      <DockPanelBar>
        <DockPanelTabs
          label={`${AREA_NAME[area]} panels`}
          value={shown?.id ?? null}
          onValueChange={(id) => setWorkbench((c) => activate(c, area, id))}
        >
          {stack.views.map((mounted) => {
            const Glyph = STUBS[mounted.view.kind]?.icon
            return (
              <span
                key={mounted.id}
                draggable
                onDragStart={(event: DragEvent<HTMLSpanElement>) => {
                  event.dataTransfer.setData(DRAG_TYPE, mounted.id)
                  setDragging(mounted.view)
                }}
                onDragEnd={() => setDragging(null)}
              >
                <DockPanelTab
                  value={mounted.id}
                  label={label(mounted.view)}
                  icon={Glyph ? <Glyph size={14} /> : undefined}
                  onClose={() => setWorkbench((c) => undock(c, mounted.id))}
                />
              </span>
            )
          })}
        </DockPanelTabs>
        <DockPanelActions>
          {/* Splitting needs something to split off, so it appears on a stack
              of two or more. Both directions, because the direction belongs to
              the split rather than to the area. */}
          {shown && stack.views.length > 1 && (
            <>
              <button
                type="button"
                className={styles.action}
                title="Show this beside the others"
                aria-label="Split side by side"
                onClick={() => setWorkbench((c) => splitDock(c, shown.id, 'row'))}
              >
                <SplitIcon size={13} />
              </button>
              <button
                type="button"
                className={styles.action}
                title="Show this below the others"
                aria-label="Split one above the other"
                onClick={() => setWorkbench((c) => splitDock(c, shown.id, 'column'))}
              >
                <SplitDownIcon size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.action}
            title={zoomed ? 'Back to the layout' : `Fill ${scope === 'window' ? 'the window' : 'the content area'}`}
            aria-label={zoomed ? 'Restore panel' : 'Expand panel'}
            onClick={() => setWorkbench((c) => zoomArea(c, area, scope))}
          >
            {zoomed ? <RestoreIcon size={13} /> : <ExpandIcon size={13} />}
          </button>
          <button
            type="button"
            className={styles.action}
            title={collapsed ? 'Show this panel' : 'Collapse to the tabs'}
            aria-label={collapsed ? 'Show panel' : 'Collapse panel'}
            onClick={() => setWorkbench((c) => toggleDock(c, area))}
          >
            <span className={styles.caret} data-collapsed={collapsed ? '' : undefined}>
              <CaretIcon size={13} />
            </span>
          </button>
        </DockPanelActions>
      </DockPanelBar>
      {!collapsed && (
        <DockPanelBody className={styles.layers}>
          {stack.views.map((mounted) => (
            <div
              key={mounted.id}
              className={styles.layer}
              {...(mounted.id === shown?.id ? {} : { 'data-hidden': '' })}
            >
              <Stub kind={mounted.view.kind} />
            </div>
          ))}
          <Drop
            area={area}
            dragging={dragging}
            onDrop={(id) => setWorkbench((c) => moveView(c, id, area, permits))}
          />
        </DockPanelBody>
      )}
    </DockPanel>
  )
}

/** One inert feature: a name, a hue, and nothing that could make a panel look right. */
const Stub = ({ kind }: { kind: string }) => {
  const stub = STUBS[kind]
  const Glyph = stub?.icon
  return (
    /* The tint is inline rather than a custom property: it identifies the
       stub, so it is data about this instance rather than a value the design
       system has an opinion about. `-fill`, `-edge` and `-ink` together,
       because a tinted panel that keeps the default ink is a panel below AA. */
    <div
      className={styles.stub}
      style={{
        background: `var(--hd-tint-${stub?.tint ?? 'blue'}-fill)`,
        boxShadow: `inset 3px 0 0 var(--hd-tint-${stub?.tint ?? 'blue'}-edge)`,
        color: `var(--hd-tint-${stub?.tint ?? 'blue'}-ink)`,
      }}
    >
      <span className={styles.stubName} style={{ color: 'inherit' }}>
        {Glyph ? <Glyph size={14} /> : null}
        {stub?.label ?? kind}
      </span>
      <span className={styles.stubNote}>
        The same component, wherever it is docked. It is not told which panel it is in.
      </span>
    </div>
  )
}

const Drop = ({
  area,
  dragging,
  onDrop,
}: {
  area: AreaId
  dragging: PaneView | null
  onDrop: (id: string) => void
}) => {
  const [over, setOver] = useState(false)
  if (!dragging || !permits(dragging, area)) return null
  return (
    <div
      className={styles.drop}
      {...(over ? { 'data-over': '' } : {})}
      aria-hidden
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const id = event.dataTransfer.getData(DRAG_TYPE)
        if (id) onDrop(id)
      }}
    >
      <span className={styles.dropLabel}>Dock in {AREA_NAME[area]}</span>
    </div>
  )
}
