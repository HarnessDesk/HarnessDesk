import type { RuntimeId, SessionKey, UiDock } from '@harnessdesk/protocol'

/**
 * The pane layout: a binary tree of splits whose leaves each show one
 * conversation, or a tool. Pure functions over an immutable tree, so the
 * rules — **one conversation on screen at a time**, a session appears in one
 * pane at most, closing the last pane leaves an empty one, focus always names
 * a pane that exists — are tested without a DOM, and a layout can be
 * persisted per workspace and read back with the same validation a
 * hand-edited file gets.
 *
 * Why one conversation: two transcripts side by side meant two composers,
 * two agents to keep straight, and a second column of everything — and in
 * practice the second pane was always a stray "New session" opened by an
 * ⌥-click nobody meant. The sidebar is where the other conversations are.
 * Tool panes — a file, a preview, the browser — still open beside the
 * conversation; that is what a split is for.
 */

export type PaneId = string

/** The terminal, wherever it is shown. It lives in the dock, not the tree. */
export interface TerminalView {
  readonly kind: 'terminal'
  readonly terminalId: string
  readonly runtime: RuntimeId
  readonly cwd: string
  /** The conversation whose permissions it runs under, if any. */
  readonly session?: SessionKey
  readonly command?: readonly string[]
}

/**
 * What a pane shows. A conversation is the usual occupant; a file and a
 * preview are views of the same kind, so they split, close, resize and
 * persist exactly as conversations do. The terminal is deliberately NOT a
 * pane: it docks along the bottom, below the composer, the way every shell
 * expects to sit — old layouts that stored one as a pane are migrated on
 * read.
 */
/**
 * How large a page is shown, per tab.
 *
 * A preset sizes the guest's own box rather than emulating a device: the
 * `<webview>` is given the width and height below and centred, scaled down
 * only when the pane is narrower than the device. The page therefore
 * genuinely has that viewport, which is why the browser tools needed no
 * change — a screenshot comes back at exactly these pixels, and a click
 * coordinate means what it says.
 */
export type BrowserDevice = 'responsive' | 'mobile' | 'tablet' | 'desktop'

export interface BrowserDeviceSpec {
  readonly id: BrowserDevice
  readonly label: string
  /** null fills the pane; otherwise the CSS pixels the guest is given. */
  readonly size: { readonly width: number; readonly height: number } | null
  /** Set when a load-time device gate should see something other than a desktop. */
  readonly userAgent?: string
}

export const BROWSER_DEVICES: readonly BrowserDeviceSpec[] = [
  { id: 'responsive', label: 'Responsive', size: null },
  {
    id: 'mobile',
    label: 'Mobile',
    size: { width: 375, height: 812 },
    // Width alone does not fool a gate that reads the user agent, and the
    // reload a UA change forces is the point: such gates run again.
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
  { id: 'tablet', label: 'Tablet', size: { width: 768, height: 1024 } },
  { id: 'desktop', label: 'Desktop', size: { width: 1280, height: 800 } },
]

/** The spec for a tab's device, defaulting to responsive for an absent or stale id. */
export const browserDevice = (id: BrowserDevice | undefined): BrowserDeviceSpec =>
  BROWSER_DEVICES.find((entry) => entry.id === id) ?? BROWSER_DEVICES[0]!

/** One page in the browser pane. `title` persists so a restored strip reads as itself. */
export interface BrowserTab {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly device?: BrowserDevice
}

export interface BrowserView {
  readonly kind: 'browser'
  /** Never empty: closing the last tab closes the pane. */
  readonly tabs: readonly BrowserTab[]
  /** The tab on screen, by id. */
  readonly active: string
  /**
   * The tab the browser tools drive, by id. Named rather than implied,
   * because an agent's turn must not depend on which tab the person
   * happened to be reading — `docs/browser-control.md`.
   */
  readonly driven: string
}

export const BLANK = 'about:blank'

export type PaneView =
  | { readonly kind: 'conversation'; readonly session: SessionKey | null }
  | TerminalView
  | { readonly kind: 'file'; readonly path: string; readonly runtime: RuntimeId }
  | { readonly kind: 'preview'; readonly path: string; readonly runtime: RuntimeId }
  /**
   * The browser: live pages, not files — what an agent's `browser_open`
   * shows and what the globe in the header opens. One browser per layout,
   * several tabs inside it; the whole set persists, so a restored layout
   * comes back on the same pages.
   */
  | BrowserView
  /**
   * A repository's history — log, graph, refs, commits — keyed by its root,
   * because the repository is the subject: the same pane serves whichever
   * conversations work in it, and a second project gets the pane re-pointed
   * rather than a second column (`#showView`'s one-tool-pane-per-kind rule).
   */
  | { readonly kind: 'git'; readonly root: string }
  /**
   * The team board &mdash; the intents in one room, in columns by state.
   *
   * Keyed by the room's id, not by a folder. A project holds as many rooms as
   * the work wants and each has a board of its own, so the repository no
   * longer addresses one: keyed by root, two rooms in a repository were one
   * pane that showed whichever board had most recently been written.
   *
   * It is a pane rather than a panel because a board needs width. The Details
   * panel is 360px and a column is 280; putting the board there would mean one
   * column at a time, which is a list with extra steps &mdash; and a list is
   * what this replaces.
   */
  | { readonly kind: 'board'; readonly room: string }
  /**
   * The team room — one room's channel, at conversation width.
   *
   * Keyed by the room's id like the board, and for the same reason. It is a
   * pane because reading a room is reading, and the Details panel's 360px
   * turns a review into thirty lines.
   */
  | {
      readonly kind: 'room'
      readonly room: string
      /**
       * The members whose transcripts are up as columns.
       *
       * On the view rather than in the pane's own state, because the middle is
       * a slot: opening a conversation replaces the room outright and unmounts
       * it. Kept in component state, two columns arranged on purpose were gone
       * the moment anything else was opened, and Back — which exists precisely
       * so the slot does not lose your place — brought back an empty room.
       * Here it rides in the layout, which is persisted per workspace, so the
       * arrangement survives the trip and the next launch.
       */
      readonly watching?: readonly SessionKey[]
    }
  /**
   * The four inspectors, which used to be a closed set of tabs on the
   * right-hand panel and nothing else.
   *
   * They are views like any other now, so the panel system can put them where
   * the reader wants them: Changes docked to the right beside the transcript,
   * or given the bottom edge across the full width when the diff is wide, or
   * split into the main area when it is the thing being worked on. Nothing in
   * `Changes`, `Trajectory`, `Agents` or `Activity` knows which of those
   * happened — that is the point of the move.
   *
   * They carry no parameters. Each follows the focused conversation, except
   * `activity`, which is about the repository; a view that reads its subject
   * from the app rather than from its own identity has nothing to key on, and
   * `sameView` says so below.
   */
  | { readonly kind: 'changes' }
  | { readonly kind: 'trajectory' }
  | { readonly kind: 'agents' }
  | { readonly kind: 'activity' }
  /**
   * The background tasks of the focused conversation: work the agent
   * started that outlives the turn, with the command and what it printed.
   * A fifth inspector, and an inspector rather than a strip above the
   * composer because the output is the point and a strip has no room for
   * it — the same reasoning that made Changes a panel.
   */
  | { readonly kind: 'tasks' }
  /**
   * A panel a plugin contributed.
   *
   * It carries its own label and its own list of areas rather than looking
   * them up, and that is deliberate: a saved layout must be able to restore a
   * plugin's panel — with a tab that says what it is, and the docking rules it
   * was given — before the plugin host has come back up and re-registered
   * anything. A panel that could not say where it may go until its plugin
   * loaded would be a panel that briefly may go nowhere.
   */
  | {
      readonly kind: 'plugin'
      /** The `ui` contribution's id. */
      readonly contribution: string
      readonly label: string
      readonly mounts: readonly UiDock[]
    }

/** The inspectors, which are views with no parameters. */
export type InspectorKind = 'changes' | 'trajectory' | 'agents' | 'activity' | 'tasks'

export const INSPECTORS: readonly InspectorKind[] = ['changes', 'trajectory', 'agents', 'activity', 'tasks']

export interface Pane {
  readonly kind: 'pane'
  readonly id: PaneId
  readonly view: PaneView
}

/** The conversation a pane shows, if it shows one. */
export const sessionOf = (pane: Pane): SessionKey | null =>
  pane.view.kind === 'conversation' ? pane.view.session : null

/** Whether two views are the same thing on screen — one pane per thing. */
export const sameView = (a: PaneView, b: PaneView): boolean => {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'conversation':
      return a.session !== null && a.session === (b as typeof a).session
    case 'terminal':
      return a.terminalId === (b as typeof a).terminalId
    case 'file':
    case 'preview':
      return a.path === (b as typeof a).path && a.runtime === (b as typeof a).runtime
    case 'browser':
      // There is one browser; a second "open" goes to it wherever it is.
      return true
    case 'git':
      // Belongs to a repository, so a second open re-points the pane rather
      // than growing a column.
      return a.root === (b as typeof a).root
    case 'board':
    case 'room':
      // The same, by room: two rooms in one project are two panes, and a
      // second open of *this* room re-points the one already showing it.
      return a.room === (b as typeof a).room
    case 'changes':
    case 'trajectory':
    case 'agents':
    case 'activity':
    case 'tasks':
      // Parameterless: there is one Changes, and a second open brings it
      // forward wherever it is docked rather than mounting a duplicate.
      return true
    case 'plugin':
      return a.contribution === (b as typeof a).contribution
  }
}

export interface Split {
  readonly kind: 'split'
  readonly id: string
  /** `row` puts the children side by side; `column` stacks them. */
  readonly direction: 'row' | 'column'
  /** Fraction of the space the first child takes, clamped to keep both usable. */
  readonly ratio: number
  readonly first: LayoutNode
  readonly second: LayoutNode
}

export type LayoutNode = Pane | Split

export interface Layout {
  readonly root: LayoutNode
  readonly focused: PaneId
  /**
   * A tool pane given the whole pane area, its siblings kept mounted but off
   * screen — a diff mid-read or a browser's pages must survive the zoom out
   * and back. Never a conversation pane: the way to give the conversation
   * the room is to close the tools. The invariant `settleExpansion` holds is
   * that the expanded pane exists, is a tool, and has the focus — anything
   * that moves the focus elsewhere is a request to see that pane, so the
   * expansion ends rather than hiding what was asked for.
   */
  readonly expanded: PaneId | null
}

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

let counter = 0
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`

const EMPTY: PaneView = { kind: 'conversation', session: null }

/** A pane with no conversation yet — the composer starts one on first send. */
export const emptyView = (): PaneView => EMPTY

export const emptyLayout = (): Layout => {
  const id = nextId('pane')
  return { root: { kind: 'pane', id, view: EMPTY }, focused: id, expanded: null }
}

// ----------------------------------------------------------------- browser

export const newBrowserTab = (url: string = BLANK): BrowserTab => ({ id: nextId('tab'), url })

/** A browser showing one page — what `openBrowser` starts from. */
export const browserView = (url: string = BLANK): BrowserView => {
  const tab = newBrowserTab(url)
  return { kind: 'browser', tabs: [tab], active: tab.id, driven: tab.id }
}

/** The tab on screen. Falls back to the first, so a stale id cannot blank the pane. */
export const activeBrowserTab = (view: BrowserView): BrowserTab =>
  view.tabs.find((tab) => tab.id === view.active) ?? view.tabs[0]!

/** The tab the tools drive, by the same rule. */
export const drivenBrowserTab = (view: BrowserView): BrowserTab =>
  view.tabs.find((tab) => tab.id === view.driven) ?? activeBrowserTab(view)

/**
 * Replaces one tab. Anything the pane learns about a page — where it
 * navigated to, what it is called, which device it is shown at — arrives
 * this way, so there is one path from a webview event into the layout.
 */
export const patchBrowserTab = (view: BrowserView, tabId: string, patch: Partial<Omit<BrowserTab, 'id'>>): BrowserView =>
  view.tabs.some((tab) => tab.id === tabId)
    ? { ...view, tabs: view.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)) }
    : view

/** Adds a tab after the active one and shows it, as every browser does. */
export const addBrowserTab = (view: BrowserView, url: string = BLANK): BrowserView => {
  const tab = newBrowserTab(url)
  const index = view.tabs.findIndex((entry) => entry.id === view.active)
  const tabs = [...view.tabs.slice(0, index + 1), tab, ...view.tabs.slice(index + 1)]
  return { ...view, tabs, active: tab.id }
}

/** Moves a tab to an index, for dragging one along the strip. */
export const moveBrowserTab = (view: BrowserView, tabId: string, to: number): BrowserView => {
  const from = view.tabs.findIndex((tab) => tab.id === tabId)
  const target = Math.min(Math.max(to, 0), view.tabs.length - 1)
  if (from === -1 || from === target) return view
  const tabs = [...view.tabs]
  tabs.splice(target, 0, ...tabs.splice(from, 1))
  return { ...view, tabs }
}

/** A copy of a tab, on the same page, beside it — a browser's "duplicate". */
export const duplicateBrowserTab = (view: BrowserView, tabId: string): BrowserView => {
  const index = view.tabs.findIndex((tab) => tab.id === tabId)
  const source = view.tabs[index]
  if (!source) return view
  const copy: BrowserTab = { ...source, id: nextId('tab') }
  return { ...view, tabs: [...view.tabs.slice(0, index + 1), copy, ...view.tabs.slice(index + 1)], active: copy.id }
}

/**
 * Keeps only the tabs `keep` says to. The driven mark and the screen follow
 * a tab that survives, so neither can end up naming a tab that is gone.
 */
export const keepBrowserTabs = (view: BrowserView, keep: (tab: BrowserTab, index: number) => boolean): BrowserView => {
  const tabs = view.tabs.filter(keep)
  if (tabs.length === view.tabs.length) return view
  if (tabs.length === 0) return view
  const survives = (id: string): boolean => tabs.some((tab) => tab.id === id)
  return {
    ...view,
    tabs,
    active: survives(view.active) ? view.active : tabs[tabs.length - 1]!.id,
    driven: survives(view.driven) ? view.driven : tabs[tabs.length - 1]!.id,
  }
}

/**
 * Closes a tab; its neighbour takes the screen. Returns null for the last
 * one, which means "close the pane" — the caller owns the tree.
 *
 * The driven mark never disappears: closing the agent's tab hands it to
 * whichever tab takes its place, so there is always exactly one.
 */
export const removeBrowserTab = (view: BrowserView, tabId: string): BrowserView | null => {
  const index = view.tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return view
  if (view.tabs.length === 1) return null
  const tabs = view.tabs.filter((tab) => tab.id !== tabId)
  const neighbour = tabs[Math.min(index, tabs.length - 1)]!
  return {
    ...view,
    tabs,
    active: view.active === tabId ? neighbour.id : view.active,
    driven: view.driven === tabId ? neighbour.id : view.driven,
  }
}

/** Every pane, left to right and top to bottom. */
export const panes = (node: LayoutNode): Pane[] =>
  node.kind === 'pane' ? [node] : [...panes(node.first), ...panes(node.second)]

export const findPane = (layout: Layout, id: PaneId): Pane | undefined =>
  panes(layout.root).find((pane) => pane.id === id)

export const focusedPane = (layout: Layout): Pane =>
  findPane(layout, layout.focused) ?? panes(layout.root)[0]!

export const paneShowing = (layout: Layout, session: SessionKey): Pane | undefined =>
  panes(layout.root).find((pane) => sessionOf(pane) === session)

export const paneShowingView = (layout: Layout, view: PaneView): Pane | undefined =>
  panes(layout.root).find((pane) => sameView(pane.view, view))

const mapNode = (node: LayoutNode, fn: (pane: Pane) => LayoutNode): LayoutNode =>
  node.kind === 'pane'
    ? fn(node)
    : { ...node, first: mapNode(node.first, fn), second: mapNode(node.second, fn) }

/** The pane showing a conversation — the one there is, by the rule above. */
export const conversationPane = (layout: Layout): Pane | undefined =>
  panes(layout.root).find((pane) => pane.view.kind === 'conversation')

/**
 * Points a pane at a view. The thing shown leaves any other pane it was in:
 * two views of one transcript would have to agree on scroll position, draft
 * and focus, and the second would lose every time.
 *
 * A conversation asked for in a tool pane goes to the conversation pane
 * instead, and takes the focus there: turning the browser into a second
 * transcript is never what a click on a session row meant.
 */
export const show = (layout: Layout, paneId: PaneId, view: PaneView): Layout => {
  const asked = findPane(layout, paneId)
  const redirect =
    view.kind === 'conversation' && asked && asked.view.kind !== 'conversation' ? conversationPane(layout) : undefined
  const target = redirect?.id ?? paneId
  return {
    ...layout,
    ...(redirect ? { focused: redirect.id } : {}),
    root: mapNode(layout.root, (pane) => {
      if (pane.id === target) return { ...pane, view }
      if (sameView(pane.view, view)) return { ...pane, view: EMPTY }
      return pane
    }),
  }
}

/**
 * Collapses a layout to one conversation pane. Layouts saved before the
 * rule, or edited by hand, come back through here. The pane kept is the
 * focused one if it shows a conversation, else the first that does, else
 * the focused: a stray empty "New session" never wins over a transcript.
 */
export const singleConversation = (layout: Layout): Layout => {
  const conversations = panes(layout.root).filter((pane) => pane.view.kind === 'conversation')
  if (conversations.length <= 1) return layout
  const focused = conversations.find((pane) => pane.id === layout.focused)
  const keep =
    (focused && sessionOf(focused) !== null ? focused : undefined) ??
    conversations.find((pane) => sessionOf(pane) !== null) ??
    focused ??
    conversations[0]!
  const collapsed = conversations.filter((pane) => pane !== keep).reduce((acc, pane) => close(acc, pane.id), layout)
  return focused && keep !== focused ? focus(collapsed, keep.id) : collapsed
}

/** Points a pane at a session, or clears it. */
export const assign = (layout: Layout, paneId: PaneId, session: SessionKey | null): Layout =>
  show(layout, paneId, { kind: 'conversation', session })

export const focus = (layout: Layout, paneId: PaneId): Layout =>
  findPane(layout, paneId) ? { ...layout, focused: paneId } : layout

/**
 * Opens a view: focuses the pane already showing it, or shows it in the
 * focused pane — or, with `direction`, in a new pane split off the focused one.
 */
/** The pane showing a tool view — terminal, file or preview — if any. */
export const paneShowingTool = (layout: Layout): Pane | null =>
  panes(layout.root).find((pane) => pane.view.kind !== 'conversation') ?? null

/**
 * Main, holding one thing.
 *
 * The middle shows a conversation or a room and nothing else, and it shows one
 * of them — so opening either *replaces* what is there rather than splitting
 * beside it. Everything that used to want the middle now declares an edge
 * (`panels/builtins.tsx`), which left the split tree able to produce exactly
 * one pair: a conversation next to a room. That pair is the thing the rule
 * forbids, so the tree has no legal use left and this is what takes its place.
 *
 * A slot cannot be split, cannot be emptied into a frame with a close button,
 * and cannot restore as a shape nobody chose. Those were three separate
 * guards; this is none of them, because there is nothing left to guard.
 */
export const only = (layout: Layout, view: PaneView): Layout => {
  const existing = panes(layout.root).find((pane) => sameView(pane.view, view))
  const id = existing?.id ?? nextId('pane')
  return { root: { kind: 'pane', id, view }, focused: id, expanded: null }
}

export const openView = (
  layout: Layout,
  view: PaneView,
  direction?: Split['direction'],
  place: 'before' | 'after' = 'after',
): Layout => {
  const existing = paneShowingView(layout, view)
  if (existing) return focus(layout, existing.id)
  if (direction) return split(layout, layout.focused, direction, view, place)
  return show(layout, layout.focused, view)
}

/** Opens a session in the focused pane, or focuses the pane already showing it. */
export const open = (layout: Layout, session: SessionKey): Layout =>
  openView(layout, { kind: 'conversation', session })

/**
 * Splits a pane in two; the new pane takes `view` (or nothing) and the focus.
 *
 * Never into a second conversation: a session asked for beside the
 * conversation opens *in* it, and a bare split beside one is nothing to do.
 * Only when no pane converses — every pane is a tool — does a conversation
 * get a pane of its own this way.
 */
export const split = (
  layout: Layout,
  paneId: PaneId,
  direction: Split['direction'],
  view: PaneView | SessionKey | null = null,
  /**
   * Which side the new pane takes.
   *
   * `after` is what splitting has always meant here and stays the default, so
   * nothing that does not ask moves. `before` exists for the room: a channel
   * belongs between the list of sessions and the conversation you are reading,
   * the way every chat application has arranged those three for twenty years.
   * Opening it to the right would put it past the thread it is about.
   */
  place: 'before' | 'after' = 'after',
): Layout => {
  if (!findPane(layout, paneId)) return layout
  const wanted: PaneView = view === null ? EMPTY : typeof view === 'string' ? { kind: 'conversation', session: view } : view
  if (wanted.kind === 'conversation') {
    const existing = conversationPane(layout)
    if (existing) return view === null ? layout : focus(show(layout, existing.id, wanted), existing.id)
  }
  const fresh: Pane = { kind: 'pane', id: nextId('pane'), view: EMPTY }
  const withSplit = mapNode(layout.root, (pane) =>
    pane.id === paneId
      ? {
          kind: 'split',
          id: nextId('split'),
          direction,
          ratio: 0.5,
          first: place === 'before' ? fresh : pane,
          second: place === 'before' ? pane : fresh,
        }
      : pane,
  )
  const next = { ...layout, root: withSplit, focused: fresh.id }
  if (view === null) return next
  return show(next, fresh.id, typeof view === 'string' ? { kind: 'conversation', session: view } : view)
}

/**
 * Closes a pane. Its sibling takes its place; the last pane is emptied rather
 * than removed, so there is always somewhere to open the next conversation.
 * Focus moves to the nearest remaining pane.
 */
export const close = (layout: Layout, paneId: PaneId): Layout => {
  const all = panes(layout.root)
  const index = all.findIndex((pane) => pane.id === paneId)
  if (index === -1) return layout
  if (all.length === 1) return show(layout, paneId, EMPTY)

  const remove = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'pane') return node.id === paneId ? null : node
    const first = remove(node.first)
    const second = remove(node.second)
    if (!first) return second
    if (!second) return first
    return { ...node, first, second }
  }
  const root = remove(layout.root) ?? all[index === 0 ? 1 : index - 1]!
  const remaining = panes(root)
  const focused =
    layout.focused === paneId
      ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? remaining[0]!.id)
      : layout.focused
  return { ...layout, root, focused, expanded: layout.expanded === paneId ? null : layout.expanded }
}

/**
 * Gives one tool pane the whole pane area and the focus. A conversation
 * never expands this way — closing the tool panes is that gesture — and a
 * pane that does not exist cannot.
 */
export const expand = (layout: Layout, paneId: PaneId): Layout => {
  const pane = findPane(layout, paneId)
  if (!pane || pane.view.kind === 'conversation') return layout
  return { ...layout, expanded: paneId, focused: paneId }
}

/** Hands the room back; every pane returns exactly as it was. */
export const collapse = (layout: Layout): Layout =>
  layout.expanded === null ? layout : { ...layout, expanded: null }

/**
 * The expansion invariant, applied wherever a layout is about to be shown:
 * the expanded pane must exist, be a tool, and hold the focus. Focus moving
 * anywhere else means something else was asked onto the screen — a session
 * row clicked, a view opened, the expanded pane closed — and an expansion
 * kept through that would be hiding the very thing the user asked for.
 */
export const settleExpansion = (layout: Layout): Layout => {
  if (layout.expanded === null) return layout
  const pane = findPane(layout, layout.expanded)
  if (!pane || pane.view.kind === 'conversation' || layout.focused !== layout.expanded) {
    return { ...layout, expanded: null }
  }
  return layout
}

export const resize = (layout: Layout, splitId: string, ratio: number): Layout => {
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
  const visit = (node: LayoutNode): LayoutNode =>
    node.kind === 'pane'
      ? node
      : node.id === splitId
        ? { ...node, ratio: clamped }
        : { ...node, first: visit(node.first), second: visit(node.second) }
  return { ...layout, root: visit(layout.root) }
}

/** Drops sessions the caller no longer has, leaving their panes empty. */
export const prune = (layout: Layout, known: (session: SessionKey) => boolean): Layout => ({
  ...layout,
  root: mapNode(layout.root, (pane) => {
    const session = sessionOf(pane)
    return session && !known(session) ? { ...pane, view: EMPTY } : pane
  }),
})

// -------------------------------------------------------------- persistence

/**
 * Reads a layout back from app state, validating every node: the state file
 * is a plain JSON document a person can edit, and a broken layout should cost
 * them the layout, not the window.
 */
/**
 * What the middle can hold: one conversation, or one room.
 *
 * Named here rather than asked of the view registry, which is a layer above
 * this one — and pinned against the registry's own declarations by a test, so
 * the two cannot drift. Decoding stays faithful; `readWorkbench` is where this
 * is applied, because that is the one place a saved main area is restored.
 */
export const holdsMain = (kind: PaneView['kind']): boolean =>
  kind === 'conversation' || kind === 'room'

/**
 * A saved main area, reduced to the one thing the middle can hold.
 *
 * Applied by `readWorkbench`, not by `readLayout`: decoding stays faithful, and
 * this is the invariant, imposed at the one place a saved main area becomes the
 * main area. `strayPanels` reads the same document for what was displaced, so
 * the caller can dock those views rather than lose them.
 *
 * One *pane*, not merely one legal kind per pane. Emptying the displaced views
 * and leaving the split standing restored a main area of two — two blank
 * conversations where a conversation and a repository view had been — and left
 * a saved conversation-beside-room split completely alone, because both halves
 * are legal on their own. Either is a shape `only()` cannot produce and this
 * branch says cannot exist. The focused pane's view is kept when the middle may
 * hold it, since that is what the person was last looking at; otherwise the
 * first that may be held; otherwise nothing.
 */
export const onlyMainViews = (layout: Layout): Layout => {
  const all = panes(layout.root)
  const first = all[0]
  if (all.length === 1 && first && holdsMain(first.view.kind)) return layout
  const focused = all.find((pane) => pane.id === layout.focused)?.view
  const kept =
    focused && holdsMain(focused.kind)
      ? focused
      : (all.find((pane) => holdsMain(pane.view.kind))?.view ?? EMPTY)
  return only(layout, kept)
}

export const readLayout = (raw: unknown): Layout | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  let root = readNode(record['root'])
  if (!root) return null
  const sessions = panes(root).map(sessionOf).filter((s) => s !== null)
  if (new Set(sessions).size !== sessions.length) return null

  // A terminal is never a pane. It belongs on the bottom edge, below every
  // composer, the way a shell sits in every workbench — so a document written
  // before that was true has its terminal panes emptied here, and
  // `strayTerminals` below hands the processes themselves to the bottom panel.
  if (panes(root).some((pane) => pane.view.kind === 'terminal')) {
    root = mapNode(root, (pane) => (pane.view.kind === 'terminal' ? { ...pane, view: EMPTY } : pane))
  }

  const ids = new Set(panes(root).map((pane) => pane.id))
  const focused =
    typeof record['focused'] === 'string' && ids.has(record['focused'])
      ? record['focused']
      : panes(root)[0]!.id
  const expanded =
    typeof record['expanded'] === 'string' && ids.has(record['expanded']) ? record['expanded'] : null
  return settleExpansion(singleConversation({ root, focused, expanded }))
}

/**
 * Every terminal in a saved document, wherever that document kept them.
 *
 * Three shapes have existed: a terminal as a pane, a one-terminal `dock`, and
 * a `dock` with tabs. All three restore into the bottom panel, because the
 * process behind each of them is still running on the host and a person who
 * upgrades should find their shells, not a note about a new layout engine.
 * Reading is the only place that history has to be known; nothing downstream
 * of here has heard of a dock.
 */
export const strayTerminals = (raw: unknown): readonly TerminalView[] => {
  if (typeof raw !== 'object' || raw === null) return []
  const record = raw as Record<string, unknown>
  const found: TerminalView[] = []
  const take = (value: unknown): void => {
    const view = readView(value)
    if (view.kind === 'terminal' && !found.some((entry) => entry.terminalId === view.terminalId)) {
      found.push(view)
    }
  }
  const dock = record['dock']
  if (typeof dock === 'object' && dock !== null) {
    const stored = dock as Record<string, unknown>
    for (const entry of Array.isArray(stored['terminals']) ? stored['terminals'] : []) take(entry)
    take(stored['view'])
  }
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const entry = node as Record<string, unknown>
    if (entry['kind'] === 'pane') take(entry['view'])
    walk(entry['first'])
    walk(entry['second'])
  }
  walk(record['root'])
  return found
}

/**
 * The tools a saved main area held that main can no longer hold.
 *
 * The counterpart to `strayTerminals`: `readLayout` empties these panes, and
 * this hands back what was in them so the caller can dock each one instead of
 * dropping it. Terminals are excluded — they have their own path, and their
 * processes are still running.
 */
export const strayPanels = (raw: unknown): readonly PaneView[] => {
  if (typeof raw !== 'object' || raw === null) return []
  const record = raw as Record<string, unknown>
  const found: PaneView[] = []
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const entry = node as Record<string, unknown>
    if (entry['kind'] === 'pane') {
      const view = readView(entry['view'])
      if (!holdsMain(view.kind) && view.kind !== 'terminal') found.push(view)
    }
    walk(entry['first'])
    walk(entry['second'])
  }
  walk('main' in record ? (record['main'] as Record<string, unknown>)?.['root'] : record['root'])
  return found
}

const readNode = (raw: unknown): LayoutNode | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record['kind'] === 'pane') {
    if (typeof record['id'] !== 'string') return null
    return { kind: 'pane', id: record['id'], view: readView(record['view'] ?? record) }
  }
  if (record['kind'] === 'split') {
    const first = readNode(record['first'])
    const second = readNode(record['second'])
    if (!first || !second || typeof record['id'] !== 'string') return null
    if (record['direction'] !== 'row' && record['direction'] !== 'column') return null
    const ratio = typeof record['ratio'] === 'number' ? record['ratio'] : 0.5
    return {
      kind: 'split',
      id: record['id'],
      direction: record['direction'],
      ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)),
      first,
      second,
    }
  }
  return null
}

/**
 * A browser from persisted state, including from before it had tabs: a
 * layout written as `{ kind: 'browser', url }` comes back as one tab on that
 * URL, so nobody loses their page to the upgrade. Anything malformed
 * degrades to a blank tab rather than to no browser.
 */
const readBrowser = (record: Record<string, unknown>): BrowserView => {
  const raw = Array.isArray(record['tabs']) ? record['tabs'] : []
  const tabs = raw.flatMap((entry): BrowserTab[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const tab = entry as Record<string, unknown>
    const id = typeof tab['id'] === 'string' ? tab['id'] : null
    if (!id) return []
    const device = BROWSER_DEVICES.some((spec) => spec.id === tab['device'])
      ? (tab['device'] as BrowserDevice)
      : undefined
    return [
      {
        id,
        url: typeof tab['url'] === 'string' ? tab['url'] : BLANK,
        ...(typeof tab['title'] === 'string' ? { title: tab['title'] } : {}),
        ...(device ? { device } : {}),
      },
    ]
  })
  if (tabs.length === 0) return browserView(typeof record['url'] === 'string' ? record['url'] : BLANK)
  const has = (id: unknown): id is string => typeof id === 'string' && tabs.some((tab) => tab.id === id)
  return {
    kind: 'browser',
    tabs,
    active: has(record['active']) ? record['active'] : tabs[0]!.id,
    driven: has(record['driven']) ? record['driven'] : tabs[0]!.id,
  }
}

/**
 * A view from persisted state. Anything unrecognised becomes an empty
 * conversation pane — including the pre-view shape that stored a bare
 * `session`, which is read for what it meant.
 *
 * Exported because the workbench persists views outside the pane tree — a
 * panel docked to the bottom holds the same union — and two readers of one
 * union is how a view ends up restorable in a pane and not in a panel.
 */
export const readView = (raw: unknown): PaneView => {
  if (typeof raw !== 'object' || raw === null) return EMPTY
  const record = raw as Record<string, unknown>
  const str = (key: string): string | null => (typeof record[key] === 'string' ? (record[key] as string) : null)
  switch (record['kind']) {
    case 'terminal': {
      const terminalId = str('terminalId')
      const runtime = str('runtime')
      const cwd = str('cwd')
      if (!terminalId || !runtime || !cwd) return EMPTY
      const session = str('session')
      const command = Array.isArray(record['command']) ? record['command'].filter((e): e is string => typeof e === 'string') : null
      return {
        kind: 'terminal',
        terminalId,
        runtime: runtime as RuntimeId,
        cwd,
        ...(session ? { session: session as SessionKey } : {}),
        ...(command && command.length > 0 ? { command } : {}),
      }
    }
    case 'file':
    case 'preview': {
      const path = str('path')
      const runtime = str('runtime')
      if (!path || !runtime) return EMPTY
      return { kind: record['kind'], path, runtime: runtime as RuntimeId }
    }
    case 'browser':
      return readBrowser(record)
    case 'git': {
      // Keyed by its repository and nothing else. A pane whose root did not
      // survive is not a pane — it is a surface pointed at no project — so it
      // falls through to the empty conversation rather than restoring as a
      // history of nothing.
      const root = str('root')
      return root ? { kind: 'git', root } : EMPTY
    }
    case 'board': {
      /* Keyed by room. A layout written before rooms had names says `root`
         and no `room`, and there is no honest way to pick which of a
         project's rooms it meant — so it restores as nothing rather than as
         somebody else's board. */
      const room = str('room')
      return room ? { kind: 'board', room } : EMPTY
    }
    case 'room': {
      const room = str('room')
      if (!room) return EMPTY
      /* And the members it had up as columns, which a room is no longer keyed
         without. Dropped on the way in, `watching` survived Back — which reads
         the view still held in memory — and vanished at the next launch, so
         the arrangement was persisted everywhere except where persistence is
         the whole point. Anything that is not a non-empty string is not a
         session key and is left out rather than restored as one. */
      const held = Array.isArray(record['watching']) ? record['watching'] : []
      const watching = held.filter(
        (entry): entry is SessionKey => typeof entry === 'string' && entry !== '',
      )
      return watching.length > 0 ? { kind: 'room', room, watching } : { kind: 'room', room }
    }
    case 'changes':
    case 'trajectory':
    case 'agents':
    case 'activity':
    case 'tasks':
      return { kind: record['kind'] }
    case 'plugin': {
      const contribution = str('contribution')
      const label = str('label')
      /* `main` was a legal mount before the middle became a two-valued slot,
         so a layout saved then can still name it. It is filtered out rather
         than rejected, and a panel left with nothing is re-homed to the right
         edge rather than dropped: a person cannot tell a panel that migrated
         silently from one that vanished, and only one of those is a bug they
         would think to report. */
      const mounts = (Array.isArray(record['mounts']) ? record['mounts'] : []).filter(
        (entry): entry is UiDock =>
          entry === 'sidebar' || entry === 'right' || entry === 'bottom',
      )
      const homed = mounts.length > 0 ? mounts : (['right'] as const)
      return contribution && label ? { kind: 'plugin', contribution, label, mounts: homed } : EMPTY
    }
    default: {
      const session = str('session')
      return { kind: 'conversation', session: session ? (session as SessionKey) : null }
    }
  }
}
