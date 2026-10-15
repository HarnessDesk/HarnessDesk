import { effectiveWindowMode } from '../editor'
import { tileBrowserWorkbench } from '../lib/browser-tiles'
import { WorkDetailsOutlet, useRegisteredOwner } from './top-bar'
import { useShellHosts } from './shell-hosts'
import { RunDockProvider, RunDetailsView } from './run-dock'
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'

import { MainDestination, FRAME, FixedShell, ShellNoticeHost, FixedPanelFrame, FixedPanelBody, FixedToolLayer, TerminalShellTabs, Button, ToolBody, ToolBodySections, ToolFooterProvider, ToolFooterScope, ToolFooterOutlet, WorkbenchRail, WorkbenchScrim, useEscapeSurface } from '../design'
import { CrossIcon, ExpandIcon, SwapIcon } from '../components/Icons'
import { DockPanel, DockPanelBody, PanelSeam } from '../design'
import { dismissOverlays } from '../design'
import { ComposerMountsProvider, NoticeStripFallback, NoticeStripOutlet } from '../components/Notices'
import { Panes } from '../components/Panes'
import { terminalCwdForSnapshot } from '../lib/terminal-scope'
import { terminalName, terminalPathTitle } from '../lib/terminal-labels'
import { KeyboardHereContext, PaneProvider, useSnapshot, useStore, type PaneScope } from '../state/context'
import { findPane, sameView, type PaneView } from '../state/layout'
import type { TerminalView } from '../state/layout'
import {
  areaVisible,
  cornerArea,
  rightPanelOverlays,
  dockLimits,
  effectiveRightWidth,
  effectiveBottomHeight,
  MIN_READING,
  SEAM,
  dockViews,
  activeView,
  noticeArea,
  rightPanelDrawn,
  fixedSubject,
  sidebarPlacement,
  workRailOpen,
  workRailFloats,
  workPaneExpanded,
  type DockId,
  type Mounted,
} from '../state/workbench'
import { hasTrafficLights } from '../lib/desktop'
import { supportsFixedTool, toolOf } from '../state/frame-tools'
import { MountProvider } from './mount'
import { ViewHost } from './views'
import { FilesPane } from './FilesPane'
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
  sidebar: '--frame-left-drag',
  right: '--frame-right-drag',
  bottom: '--frame-bottom-drag',
}

const WorkActive = createContext(true)
const RightWorkActive = createContext(true)

export const Workbench = ({ sidebar, suspended = false, pages, pageActive = false }: { sidebar: ReactNode; suspended?: boolean; pages?: ReactNode; pageActive?: boolean }) => {
  const { topRef, mainRef } = useShellHosts('work')
  const store = useStore()
  const snapshot = useSnapshot()
  const workbench = tileBrowserWorkbench(snapshot)

  const shell = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const mainFocus = useRef<{ target: HTMLElement; paneId: string; view: PaneView } | null>(null)
  const rightPanelFocus = useRef<HTMLElement | null>(null)
  const wasRightPanelDrawn = useRef(false)
  const wasBottomPanelDrawn = useRef(false)

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
  const subject = fixedSubject(workbench.main)
  const intent = subject ? workbench.frameTools[subject] : undefined
  const pageTerminal = pageActive && intent?.open === true && intent.tool === 'terminal' && Boolean(terminalCwdForSnapshot(snapshot))
  const paneActive = !pageActive || pageTerminal
  const rightPanelOverlay = rightPanelOverlays(workbench, snapshot.windowWidth)
  const expanded = workPaneExpanded(workbench) && paneActive
  const pageKind = workbench.navigation.current.kind
  const mainTitle = pageActive ? pageKind[0]!.toUpperCase() + pageKind.slice(1).replaceAll('-', ' ') : 'Chat'

  useLayoutEffect(() => {
    if (suspended || pageActive) return
    const rightDrawn = rightPanelDrawn(workbench)
    const bottomDrawn = !workbench.bottom.collapsed && areaVisible(workbench, 'bottom') &&
      dockViews(workbench.bottom).some(one => one.view.kind === 'terminal')
    const rightClosed = wasRightPanelDrawn.current && !rightDrawn
    const bottomClosed = wasBottomPanelDrawn.current && !bottomDrawn
    wasRightPanelDrawn.current = rightDrawn
    wasBottomPanelDrawn.current = bottomDrawn
    if (!rightClosed && !bottomClosed) return
    // A right panel has no resting strip, so hiding it returns focus to the
    // conversation target it displaced. This covers both wide docks and the
    // narrow overlay; widening alone leaves the panel drawn.
    const saved = mainFocus.current
    mainFocus.current = null
    const active = document.activeElement
    const focusWasStranded = active === document.body || (
      active instanceof HTMLElement && (
        (rightClosed && active.matches('[data-work-panel-toggle]')) ||
        active === rightPanelFocus.current ||
        (!active.isConnected && rightPanelFocus.current?.contains(active) === true)
      )
    )
    rightPanelFocus.current = null
    if (!focusWasStranded) return
    const focused = findPane(snapshot.layout, snapshot.layout.focused)
    if (!focused || (snapshot.layout.expanded !== null && snapshot.layout.expanded !== focused.id)) return
    const pane = [...(main.current?.querySelectorAll<HTMLElement>('[data-pane-id]') ?? [])]
      .find((candidate) => candidate.dataset.paneId === focused.id) ?? null
    if (!pane || pane.closest('[data-hidden]') || getComputedStyle(pane).visibility === 'hidden') return
    const savedViewStillOwnsTarget = saved !== null && saved.paneId === focused.id && (
      sameView(saved.view, focused.view) || (
        saved.view.kind === 'conversation' && focused.view.kind === 'conversation' &&
        saved.view.session === null && focused.view.session === null
      )
    )
    const target = savedViewStillOwnsTarget && saved?.target.isConnected && pane?.contains(saved.target) &&
      !saved.target.hasAttribute('disabled') && !saved.target.closest('[data-hidden]') &&
      getComputedStyle(saved.target).visibility !== 'hidden'
      ? saved.target
      : null
    const firstFocusable = [...pane.querySelectorAll<HTMLElement>(
      'a[href], area[href], button, input, select, textarea, iframe, object, embed, summary, [contenteditable="true"], [tabindex]',
    )].find((candidate) =>
      candidate.tabIndex >= 0 && !candidate.matches(':disabled') &&
      !candidate.closest('[data-hidden], [hidden], [inert]') &&
      getComputedStyle(candidate).visibility !== 'hidden',
    )
    store.focusPane(focused.id)
    const back = target ?? firstFocusable ?? pane
    back?.focus({ preventScroll: true })
  }, [snapshot.layout, store, workbench, suspended, pageActive])

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
  const corner = hasTrafficLights() ? paneActive ? cornerArea(workbench, column, snapshot.windowWidth) : column ? 'sidebar' : 'main' : null

  const sidebarBox = useRef<HTMLDivElement>(null)
  useFloatingSidebar(floating && !suspended, sidebarBox, main)
  const standingSidebar = column ? workbench.sidebar.size : 0
  const rightWidth = paneActive ? effectiveRightWidth(workbench, snapshot.windowWidth, standingSidebar) : 0
  const bottomHeight = 0
  const railOpen = !suspended && !pageActive && workRailOpen(workbench)
  const railFloating = workRailFloats(workbench, snapshot.windowWidth, standingSidebar)
  const retainedRight = Math.min(workbench.right.size, Math.max(0, snapshot.windowWidth - FRAME.page.canvasGutter))
  const frameStyle = {
    '--frame-left-size': `${standingSidebar}px`, '--frame-left': 'var(--frame-left-drag, var(--frame-left-size))',
    '--frame-left-open': `${workbench.sidebar.size}px`,
    '--frame-right-size': !paneActive || !rightPanelDrawn(workbench) ? '0px' : `${workbench.right.size}px`, '--frame-right': 'var(--frame-right-effective)',
    '--frame-right-open': paneActive ? `${rightWidth || retainedRight}px` : '0px', '--frame-right-retained': `${retainedRight}px`,
    '--frame-bottom-size': `${bottomHeight}px`, '--frame-bottom': 'var(--frame-bottom-drag, var(--frame-bottom-size))',
    '--frame-bottom-retained': `${Math.max(FRAME.bottomPanel.min, Math.min(workbench.bottom.size, Math.floor(snapshot.windowHeight / 2)))}px`,
  } as CSSProperties
  return <WorkActive.Provider value={!suspended}><KeyboardHereContext.Provider value={suspended ? false : null}><RunDockProvider><ComposerMountsProvider><ShellContext.Provider value={shell}>
    <FixedShell ref={shell} viewportWidth={snapshot.windowWidth} style={frameStyle} className={styles.shell}
      leftFloating={narrow} panelFloating={paneActive && rightPanelOverlay} leftOpen={showSidebar} rightOpen={!suspended && paneActive && rightPanelDrawn(workbench)} bottomOpen={false} inert={suspended}
      railOpen={railOpen} railFloating={railFloating} paneExpanded={expanded}
      {...(corner ? { 'data-lights': corner } : {})} {...(narrow ? { 'data-narrow': '' } : {})}
      onFocusCapture={event => { rightPanelFocus.current = event.target instanceof HTMLElement && event.target.closest('[data-fixed-tool-frame]') ? event.target : null }}
      left={<><WorkbenchRail ref={sidebarBox} className={styles.sidebar}
        {...(showSidebar ? {} : { 'data-hidden': '' })}
        {...(floating ? { 'data-floating': '', tabIndex: -1, role: 'dialog', 'aria-label': 'Sidebar' } : {})}>
        {sidebar}
      </WorkbenchRail>{column && <AreaSeam area="sidebar" orientation="vertical" label="Resize the sidebar" direction={1} />}</>}
      top={<div ref={topRef} data-shell-host="top" />}
      main={<div ref={main} className={styles.main} data-slot="workbench-main" data-notice-bounds=""
        onFocusCapture={event => {
          if (!(event.target instanceof HTMLElement) || event.target === main.current) return
          const paneId = event.target.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId
          const pane = paneId ? findPane(snapshot.layout, paneId) : undefined
          if (pane) mainFocus.current = { target: event.target, paneId: pane.id, view: pane.view }
        }}><FixedPanelBody heading={expanded ? mainTitle : undefined} actions={expanded ? <>
          <Button variant="ghost" size="icon-sm" aria-label="Swap back" title="Swap back" onClick={() => store.swapWorkPane()}><SwapIcon size={16} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close pane" title="Close pane" onClick={() => store.toggleWorkPanel()}><CrossIcon size={16} /></Button>
        </> : undefined}><ShellNoticeHost ref={mainRef} /><NoticeStripFallback area="main" /><MainDestination page={pageActive} work={<KeyboardHereContext.Provider value={pageActive ? false : null}><Panes /></KeyboardHereContext.Provider>} pages={pages} /></FixedPanelBody></div>}
      rail={<WorkRail drawn={railOpen} />}
      right={<RightWorkActive.Provider value={paneActive}><RightPanel /></RightWorkActive.Provider>} bottom={null}>
      {narrow && <WorkbenchScrim className={styles.scrim} {...(floating ? { 'data-open': '' } : {})} aria-hidden
        onMouseDown={event => event.preventDefault()} onClick={() => store.closeFloatingSidebar()} />}
    </FixedShell>
  </ShellContext.Provider></ComposerMountsProvider></RunDockProvider></KeyboardHereContext.Provider></WorkActive.Provider>

}

/** Cards stay under the subject's bar, independent of whichever tool is open. */
const WorkRail = ({ drawn }: { drawn: boolean }) => {
  const snapshot = useSnapshot(), owner = snapshot.layout.focused
  const pane = findPane(snapshot.layout, owner)
  if (!pane) return null
  return <KeyboardHereContext.Provider value={drawn ? null : false}>
    <PaneProvider scope={{ paneId: owner, view: pane.view, sessionKey: pane.view.kind === 'conversation' ? pane.view.session : null }}>
      <ToolFooterProvider><ToolBody><ToolBodySections><WorkDetailsOutlet owner={owner} /></ToolBodySections></ToolBody></ToolFooterProvider>
    </PaneProvider>
  </KeyboardHereContext.Provider>
}

/** A retained cache captures provenance at admission, never from the newly focused work. */
const RetainedTool = ({ entry, shown, section = false }: { entry: ReturnType<typeof dockViews>[number]; shown: boolean; section?: boolean }) => {
  const store = useStore(), snapshot = useSnapshot()
  const owner = snapshot.workbench.toolOwners[entry.id]
  const remembered = owner ? snapshot.workbench.frameSubjects[owner] : undefined
  const admitted = supportsFixedTool(entry.view, snapshot.contributions)
  const captured = useRef<PaneScope | null>(null)
  if (remembered && admitted) captured.current = { paneId: remembered.paneId, keyboardMountId: entry.id, view: remembered.view,
    sessionKey: remembered.view.kind === 'conversation' ? remembered.view.session : null }
  const scope = captured.current
  if (!scope || !admitted) return null
  const visible = shown && Boolean(remembered)
  return <FixedToolLayer data-tool-mount={entry.id} section={section && visible} className={styles.layer}
    {...(visible ? {} : { 'data-hidden': '', inert: true })}
    onPointerDownCapture={() => { if (visible) store.focusView(entry.id) }}
    onFocusCapture={() => { if (visible) store.focusView(entry.id) }}>
    <KeyboardHereContext.Provider value={visible ? null : false}><PaneProvider scope={scope}>
      <MountProvider scope={{ area: 'right', id: entry.id, view: entry.view, fixed: true }}>
        <ToolFooterScope id={entry.id}><ViewHost view={entry.view} /></ToolFooterScope>
      </MountProvider>
    </PaneProvider></KeyboardHereContext.Provider>
  </FixedToolLayer>
}

const WorkToolBodies = ({ drawn }: { drawn: boolean }) => {
  const store = useStore(), snapshot = useSnapshot()
  const subject = store.workSubject(), owner = snapshot.layout.focused
  const selected = subject ? snapshot.workbench.frameTools[subject] : undefined
  const entries = dockViews(snapshot.workbench.right)
  const focused = findPane(snapshot.layout, owner)
  const current = activeView(snapshot.workbench.right)
  const matching = entries.filter(entry => snapshot.workbench.toolOwners[entry.id] === subject &&
    toolOf(entry.view.kind) === selected?.tool && entry.view.kind === selected?.mode && supportsFixedTool(entry.view, snapshot.contributions))
  const active = matching.find(entry => entry.id === current?.id)?.id ?? matching[0]?.id ?? null
  const registered = useRegisteredOwner(owner)
  const open = Boolean(drawn && subject && focused && selected?.open)
  const editor = effectiveWindowMode(snapshot.windowMode, snapshot.workbench) === 'editor'
  const conversation = editor && focused?.view.kind === 'conversation' && focused.view.session !== null
  const conversationShown = open && selected?.tool === 'conversation'
  const details = open && registered && selected?.tool === 'details' && selected.mode !== 'agents'
  const detailsId = `details:${owner}`
  const plugin = details && selected?.mode === 'plugin' ? active : null
  const escapeTool = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
    event.preventDefault(); event.stopPropagation()
    store.toggleWorkPanel()
    requestAnimationFrame(() => {
      if (!subject || store.workSubject() !== subject) return
      const currentTool = store.getSnapshot().workbench.frameTools[subject]?.tool ?? 'details'
      const opener = document.querySelector<HTMLButtonElement>(`[data-work-tool="${currentTool}"]`)
      const target = opener && !opener.disabled && !opener.closest('[inert]') ? opener : document.querySelector<HTMLButtonElement>('[data-work-panel-toggle]')
      if (target && !target.closest('[inert]')) target.focus()
    })
  }
  return <ToolFooterProvider>
    <FixedPanelBody onKeyDown={escapeTool} data-slot="work-tools" data-open={open} data-tool={selected?.tool} inert={!open}>
      <DockPanelBody className={styles.layers}>
        {conversation && <FixedToolLayer className={styles.layer} data-conversation-tool="" {...(conversationShown ? {} : { 'data-hidden': '', inert: true })}
          onPointerDownCapture={() => store.focusPane(owner)} onFocusCapture={() => store.focusPane(owner)}>
          <KeyboardHereContext.Provider value={conversationShown ? null : false}>
            <PaneProvider scope={{ paneId: owner, view: focused.view, sessionKey: focused.view.session }}>
              <MountProvider scope={{ area: 'right', id: `conversation:${owner}`, view: focused.view, fixed: true }}>
                <ViewHost view={focused.view} />
              </MountProvider>
            </PaneProvider>
          </KeyboardHereContext.Provider>
        </FixedToolLayer>}
        <div className={styles.layer} {...(details ? {} : { 'data-hidden': '', inert: true })}>
          <KeyboardHereContext.Provider value={details ? null : false}>
            <ToolFooterScope id={detailsId}><ToolBody><ToolBodySections>
              {selected?.mode === 'run-details' && focused?.view.kind === 'room' && <PaneProvider scope={{ paneId: owner, view: focused.view, sessionKey: null }}><RunDetailsView inspectionOnly /></PaneProvider>}
              {entries.filter(entry => entry.view.kind === 'plugin').map(entry => <RetainedTool key={entry.id} entry={entry} shown={entry.id === plugin} section />)}
            </ToolBodySections></ToolBody></ToolFooterScope>
          </KeyboardHereContext.Provider>
        </div>
        {entries.filter(entry => entry.view.kind !== 'plugin').map(entry => <RetainedTool key={entry.id} entry={entry}
          shown={open && !details && entry.id === active} />)}
      </DockPanelBody>
      <ToolFooterOutlet id={open ? details ? plugin ?? detailsId : active : null} />
    </FixedPanelBody>
  </ToolFooterProvider>
}

const RightPanel = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const workbench = tileBrowserWorkbench(snapshot)
  const workActive = useContext(WorkActive)
  const rightActive = useContext(RightWorkActive)
  const drawn = workActive && rightActive && rightPanelDrawn(workbench)
  const overlay = rightPanelOverlays(workbench, snapshot.windowWidth)
  const sized = !overlay
  const noticeHost = drawn && noticeArea(workbench, snapshot.windowWidth) === 'right'
  const min = dockLimits('right').min
  const subject = fixedSubject(workbench.main)
  const intent = subject ? workbench.frameTools[subject] : undefined
  const terminal = intent?.tool === 'terminal'
  const files = intent?.tool === 'files'
  const title = intent?.tool === 'changes' ? 'Changes' : terminal ? 'Terminal' : files ? 'Files' : intent?.tool === 'browser' ? 'Browser' : intent?.tool === 'conversation' ? 'Conversation' : intent?.tool === 'activity' ? 'Trajectory' : 'Details'
  const max = Math.max(min, Math.min(dockLimits('right').max, snapshot.windowWidth -
    (sidebarPlacement(snapshot) === 'column' ? workbench.sidebar.size + SEAM : 0) - SEAM - MIN_READING))
  return <>
    {drawn && sized && <AreaSeam area="right" orientation="vertical" label="Resize the right panel" direction={-1} max={max} />}
    <FixedPanelFrame edge="right" open={drawn} className={styles.right} data-fixed-tool-frame="" style={{ width: '100%', height: '100%' }}
      heading={title} actions={<>
        <Button variant="ghost" size="icon-sm" aria-label={overlay ? 'Return to main' : 'Swap pane into main'} title={overlay ? 'Return to main' : 'Swap pane into main'}
          onClick={() => overlay ? store.toggleWorkPanel() : store.swapWorkPane()}>{overlay ? <SwapIcon size={16} /> : <ExpandIcon size={16} />}</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close pane" title="Close pane" onClick={() => store.toggleWorkPanel()}><CrossIcon size={16} /></Button>
      </>}
       {...(noticeHost ? { 'data-notice-host': '' } : {})}>
      {noticeHost && <NoticeStripOutlet host area="right" hostId="workbench:right" />}
      {noticeHost && <NoticeStripFallback area="right" />}

      <div data-shell-tool-bodies>
        <div className={styles.layer} {...(terminal ? { 'data-hidden': '', inert: true } : {})}>
          {files && <DockPanel edge="bottom" data-shell-files-tree data-file-open={intent?.mode !== 'files'}><FilesPane /></DockPanel>}
          <div data-shell-file-body {...(files && intent?.mode === 'files' ? { 'data-hidden': '', inert: true } : {})}><WorkToolBodies drawn={drawn && !terminal} /></div>
        </div>
        <div className={styles.layer} {...(terminal && drawn ? {} : { 'data-hidden': '', inert: true })}><BottomPanel drawn={drawn && terminal} /></div>
      </div>
    </FixedPanelFrame>
  </>
}

/** Only process documents share the bottom frame; closing the region retains every xterm. */
const BottomPanel = ({ drawn }: { drawn: boolean }) => {
  const store = useStore(), snapshot = useSnapshot()
  const workbench = tileBrowserWorkbench(snapshot), dock = workbench.bottom
  const subject = fixedSubject(workbench.main)
  const entries = dockViews(dock).filter((entry): entry is Mounted & { readonly view: TerminalView } => entry.view.kind === 'terminal')
  const owned = entries.filter(entry => !workbench.toolOwners[entry.id] || workbench.toolOwners[entry.id] === subject)
  const current = activeView(dock)
  const active = owned.find(entry => entry.id === current?.id) ?? owned[0]
  const activeTerminal = active?.view.kind === 'terminal' ? active.view : undefined
  const occurrences = new Map<string, number>()
  const terminalTabs = owned.map(entry => {
    const name = terminalName(entry.view)
    const occurrence = (occurrences.get(name) ?? 0) + 1
    occurrences.set(name, occurrence)
    return {
      id: entry.id,
      label: terminalName(entry.view, occurrence),
      title: terminalPathTitle(entry.view.cwd, snapshot.home),
      onClose: () => store.closeTerminal(entry.view.terminalId),
    }
  })
  const workActive = useContext(WorkActive)
  const shown = drawn && workActive && Boolean(terminalCwdForSnapshot(snapshot))
  const noticeHost = shown && noticeArea(workbench, snapshot.windowWidth) === 'bottom'
  const terminalFrame = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!shown || !active) return
    // Retained xterms do not attach again when their pane reopens. Give the
    // selected shell the keyboard after the door or menu has returned focus.
    const frame = requestAnimationFrame(() => {
      const input = terminalFrame.current?.querySelector<HTMLTextAreaElement>('[data-terminal-mount]:not([data-hidden]) .xterm-helper-textarea')
      if (input && !input.closest('[hidden], [data-hidden], [inert]')) input.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [shown, active?.id])
  return <>
    <FixedPanelFrame ref={terminalFrame} edge="right" open={shown} className={styles.bottom} data-terminal-frame=""
       {...(noticeHost ? { 'data-notice-host': '' } : {})}>
      {noticeHost && <NoticeStripOutlet host area="bottom" hostId="workbench:bottom" />}
      {noticeHost && <NoticeStripFallback area="bottom" />}
      {activeTerminal && <TerminalShellTabs
        tabs={terminalTabs}
        value={active?.id ?? null}
        newShellTitle={`New shell in ${terminalPathTitle(activeTerminal.cwd, snapshot.home)}`}
        onValueChange={id => store.activateView('bottom', id)}
        onNewShell={() => void store.openTerminal({ cwd: activeTerminal.cwd })}
        onCloseTerminal={() => store.closeTerminalDock(subject ?? undefined)}
      />}
      <DockPanelBody className={styles.layers}>
        {entries.map(entry => <div key={entry.id} data-terminal-mount={entry.id} className={styles.layer}
          {...(shown && entry.id === active?.id ? {} : { 'data-hidden': '', inert: true })}>
          <KeyboardHereContext.Provider value={shown && entry.id === active?.id ? null : false}>
            <MountProvider scope={{ area: 'bottom', id: entry.id, view: entry.view, fixed: true }}><ViewHost view={entry.view} /></MountProvider>
          </KeyboardHereContext.Provider>
        </div>)}
      </DockPanelBody>
    </FixedPanelFrame>
  </>
}

/**
 * A sidebar floating over a narrow window behaves like the thing on top that
 * it is: focus goes into it, what it covers cannot be reached until it goes,
 * Escape puts it away, and focus comes back to where it was.
 *
 * Escape joins the shared surface stack. A menu, a filter field or a rename
 * registered above it gets the key first and keeps the sidebar open: one press
 * closes one thing. A dialog opened from the sidebar never lets the key get
 * this far at all (see `Dialog`).
 */
const useFloatingSidebar = (
  floating: boolean,
  sidebar: RefObject<HTMLDivElement | null>,
  content: RefObject<HTMLDivElement | null>,
): void => {
  const store = useStore()
  useEscapeSurface(floating, () => store.closeFloatingSidebar())
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
      const regions = content.current?.closest('[data-slot="fixed-shell"]')?.querySelectorAll('[data-frame-region="top"], [data-frame-region="rail"], [data-frame-region="right"], [data-frame-region="bottom"]') ?? []
      const covered = [content.current, ...regions, ...beside].filter(
        (element): element is HTMLElement => element instanceof HTMLElement && !element.hasAttribute('inert'),
      )
      for (const element of covered) element.setAttribute('inert', '')
      // The surface, as a dialog does, rather than the first row in it: landing
      // on a row means a stray Return opens a conversation nobody chose.
      sidebar.current?.focus({ preventScroll: true })
      const cycleFocus = (event: KeyboardEvent): void => {
        const surface = sidebar.current
        const active = document.activeElement
        // Portalled menus own their keys; wrap only the sidebar's own boundary.
        if (event.key !== 'Tab' || event.defaultPrevented || !surface || !surface.contains(active)) return
        const controls = [...surface.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
          .filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
            && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0
            && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden')
        const first = controls[0], last = controls.at(-1)
        if (!first || !last) { event.preventDefault(); surface.focus(); return }
        if (active === surface || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus({ preventScroll: true })
        }
      }
      document.addEventListener('keydown', cycleFocus)
      return () => {
        document.removeEventListener('keydown', cycleFocus)
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
  max: maxOverride,
}: {
  area: DockId
  orientation: 'vertical' | 'horizontal'
  label: string
  direction: 1 | -1
  max?: number
}) => {
  const store = useStore()
  const shell = useContext(ShellContext)
  const snapshot = useSnapshot()
  const requested = snapshot.workbench[area].size
  const limits = dockLimits(area, snapshot.windowHeight)
  const max = maxOverride === undefined ? limits.max : Math.min(limits.max, maxOverride)
  const landing = (next: number) => Math.min(max, Math.max(limits.min, Math.round(next)))
  const size = landing(requested)
  useLayoutEffect(() => { shell.current?.style.removeProperty(LIVE[area]) }, [shell, area, requested, max, snapshot.windowWidth, snapshot.windowHeight])
  const commit = (next: number) => {
    const value = landing(next)
    // Keep the live projection until the requested-size layout effect paints
    // its replacement; removing it here briefly restores the previous width.
    if (value !== requested) store.resizePanel(area, value)
    else shell.current?.style.removeProperty(LIVE[area])
  }
  const defaults = { sidebar: FRAME.sidebar.width, right: FRAME.rightPanel.width, bottom: FRAME.bottomPanel.height }
  return <PanelSeam orientation={orientation} label={label} size={size} min={limits.min} max={max} direction={direction}
    onResize={next => shell.current?.style.setProperty(LIVE[area], `${landing(next)}px`)}
    onCancel={() => shell.current?.style.removeProperty(LIVE[area])}
    onCommit={commit} onDoubleClick={() => commit(defaults[area])} />
}
