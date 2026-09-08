import { describe, expect, test } from 'vitest'

import { sessionKey } from '@harnessdesk/protocol'

import {
  activeBrowserTab,
  addBrowserTab,
  assign,
  browserDevice,
  browserView,
  close,
  only,
  collapse,
  expand,
  settleExpansion,
  emptyLayout,
  findPane,
  focusedPane,
  open,
  openView,
  paneShowing,
  paneShowingTool,
  panes,
  prune,
  readLayout,
  readView,
  strayPanels,
  strayTerminals,
  resize,
  sameView,
  sessionOf,
  split,
  drivenBrowserTab,
  patchBrowserTab,
  removeBrowserTab,
  type BrowserView,
  type PaneView,
  type TerminalView,
} from './layout'

/**
 * The pane tree's invariants: one conversation on screen at a time, a
 * session is in one pane at most, the last pane is emptied rather than
 * removed, and focus always names a real pane.
 */

const A = sessionKey('codex', 'a')
const B = sessionKey('codex', 'b')
const A_OTHER = sessionKey('other', 'a')

const FILE: PaneView = { kind: 'file', path: '/w/a.ts', runtime: 'codex' as never }
const BROWSER: PaneView = browserView()

const conversations = (layout: ReturnType<typeof emptyLayout>) =>
  panes(layout.root).filter((pane) => pane.view.kind === 'conversation')

describe('open', () => {
  test('shows the session in the focused pane', () => {
    const layout = open(emptyLayout(), A)
    expect(sessionOf(focusedPane(layout))).toBe(A)
  })

  test('a second session replaces the first on screen; the same one is just focused', () => {
    let layout = open(emptyLayout(), A)
    const first = layout.focused
    layout = open(layout, B)
    expect(conversations(layout)).toHaveLength(1)
    expect(sessionOf(focusedPane(layout))).toBe(B)
    layout = open(layout, A)
    expect(layout.focused).toBe(first)
    expect(panes(layout.root).filter((pane) => sessionOf(pane) === A)).toHaveLength(1)
  })

  test('the same id in another runtime is a different conversation', () => {
    let layout = open(emptyLayout(), A)
    layout = open(layout, A_OTHER)
    expect(sessionOf(focusedPane(layout))).toBe(A_OTHER)
    expect(paneShowing(layout, A)).toBeUndefined()
  })

  test('a session asked for in a tool pane goes to the conversation pane', () => {
    let layout = openView(open(emptyLayout(), A), BROWSER, 'row')
    const browserPane = layout.focused
    expect(findPane(layout, browserPane)?.view.kind).toBe('browser')
    layout = open(layout, B)
    expect(findPane(layout, browserPane)?.view.kind).toBe('browser')
    expect(panes(layout.root).map((pane) => pane.view.kind)).toEqual(['conversation', 'browser'])
    expect(sessionOf(focusedPane(layout))).toBe(B)
  })
})

describe('one conversation at a time', () => {
  test('a split asking for a second conversation opens the session in the one there is', () => {
    let layout = open(emptyLayout(), A)
    const first = layout.focused
    layout = split(layout, first, 'row', B)
    expect(layout.root.kind).toBe('pane')
    expect(layout.focused).toBe(first)
    expect(sessionOf(focusedPane(layout))).toBe(B)
  })

  test('a bare split beside a conversation is nothing to do', () => {
    const layout = open(emptyLayout(), A)
    expect(split(layout, layout.focused, 'row')).toBe(layout)
    expect(split(layout, layout.focused, 'column')).toBe(layout)
  })

  test('assigning a session to a tool pane moves it to the conversation pane instead', () => {
    let layout = openView(open(emptyLayout(), A), FILE, 'row')
    const filePane = layout.focused
    layout = assign(layout, filePane, B)
    expect(findPane(layout, filePane)?.view.kind).toBe('file')
    expect(conversations(layout)).toHaveLength(1)
    expect(sessionOf(conversations(layout)[0]!)).toBe(B)
  })

  test('when every pane is a tool, a conversation may split one', () => {
    let layout = openView(open(emptyLayout(), A), FILE, 'row')
    const conversation = conversations(layout)[0]!.id
    layout = close(layout, conversation)
    expect(conversations(layout)).toHaveLength(0)
    layout = split(layout, layout.focused, 'row', B)
    expect(panes(layout.root).map((pane) => pane.view.kind)).toEqual(['file', 'conversation'])
    expect(sessionOf(focusedPane(layout))).toBe(B)
  })

  test('a saved layout with two conversations comes back with one — the transcript, not a stray draft', () => {
    const raw = {
      root: {
        kind: 'split',
        id: 's1',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } },
        second: { kind: 'pane', id: 'p2', view: { kind: 'conversation', session: null } },
      },
      focused: 'p2',
    }
    const layout = readLayout(raw)!
    expect(layout.root).toEqual({ kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } })
    expect(layout.focused).toBe('p1')
    // Two transcripts: the focused one stays.
    const both = readLayout({
      ...raw,
      root: { ...raw.root, second: { kind: 'pane', id: 'p2', view: { kind: 'conversation', session: B } } },
    })!
    expect(sessionOf(focusedPane(both))).toBe(B)
    expect(panes(both.root)).toHaveLength(1)
    // Tool panes beside it are kept: decoding is faithful, and the middle's
    // invariant is imposed by `readWorkbench` — see `onlyMainViews`.
    const withTool = readLayout({
      ...raw,
      root: { ...raw.root, second: { kind: 'pane', id: 'p2', view: FILE } },
      focused: 'p1',
    })!
    expect(panes(withTool.root).map((pane) => pane.view.kind)).toEqual(['conversation', 'file'])
  })

  test('every keyed pane comes back as itself, not as an empty conversation', () => {
    // The board and the room shipped without a case here, so `#setLayout` wrote
    // them faithfully and the next launch read them back as a blank
    // conversation: both headline panes of the team plane vanished on restart,
    // silently, with the persisted state still correct on disk.
    const layout = readLayout({
      root: { kind: 'pane', id: 'p1', view: { kind: 'git', root: '/repo' } },
      focused: 'p1',
    })!
    expect(layout.root).toEqual({ kind: 'pane', id: 'p1', view: { kind: 'git', root: '/repo' } })

    for (const kind of ['board', 'room'] as const) {
      const kept = readLayout({
        root: { kind: 'pane', id: 'p1', view: { kind, room: 'r1' } },
        focused: 'p1',
      })!
      expect(kept.root).toEqual({ kind: 'pane', id: 'p1', view: { kind, room: 'r1' } })
    }
  })

  test('every inspector reads back by its kind, the background-task panel included', () => {
    // A parameterless view is its kind and nothing else, so a saved one
    // restores from that one word. A kind the reader does not know falls
    // back to an empty conversation, which is what a fifth inspector would
    // have done before it was added here.
    for (const kind of ['changes', 'trajectory', 'agents', 'activity', 'tasks'] as const) {
      expect(readView({ kind })).toEqual({ kind })
      expect(sameView({ kind }, { kind })).toBe(true)
    }
    expect(readView({ kind: 'inspector-nobody-has' })).toEqual({ kind: 'conversation', session: null })
  })

  test('a board or room saved before rooms had names comes back as nothing', () => {
    /* Those views were keyed by folder, and a project holds several rooms —
       so there is no honest way to say which of them the saved pane meant.
       Restoring as an empty conversation is the one answer that does not put
       somebody else's board in the middle of the window. */
    for (const kind of ['board', 'room'] as const) {
      const layout = readLayout({
        root: { kind: 'pane', id: 'p1', view: { kind, root: '/repo' } },
        focused: 'p1',
      })!
      expect((layout.root as { view: { kind: string } }).view.kind).toBe('conversation')
    }
  })

  test('a room comes back still watching the members it had up', () => {
    // `setRoomWatching` persists this, and the decoder used to rebuild a room
    // from its root alone — so an arrangement survived Back, which reads the
    // view held in memory, and was gone at the next launch.
    const watching = [sessionKey('codex' as never, 'c1' as never), sessionKey('cursor' as never, 'g1' as never)]
    const view = { kind: 'room' as const, room: 'r1', watching }
    const layout = readLayout(
      JSON.parse(JSON.stringify({ root: { kind: 'pane', id: 'p1', view }, focused: 'p1' })),
    )!
    expect(layout.root).toEqual({ kind: 'pane', id: 'p1', view })

    // Anything that is not a session key is not restored as one.
    const junk = readLayout({
      root: { kind: 'pane', id: 'p1', view: { kind: 'room', room: 'r1', watching: [7, '', null] } },
      focused: 'p1',
    })!
    expect(layout.root).not.toEqual(junk.root)
    expect((junk.root as { view: { watching?: unknown } }).view.watching).toBeUndefined()
  })

  test('a root-keyed pane whose root did not survive is not restored as a board of nothing', () => {
    for (const kind of ['git', 'board', 'room'] as const) {
      const layout = readLayout({
        root: { kind: 'pane', id: 'p1', view: { kind } },
        focused: 'p1',
      })!
      expect(layout.root).toEqual({
        kind: 'pane',
        id: 'p1',
        view: { kind: 'conversation', session: null },
      })
    }
  })
})

describe('close', () => {
  test('the last pane is emptied, never removed', () => {
    const layout = close(open(emptyLayout(), A), emptyLayout().focused)
    expect(panes(layout.root)).toHaveLength(1)
  })

  test('closing a pane hands its space to the sibling and moves focus nearby', () => {
    let layout = open(emptyLayout(), A)
    const first = layout.focused
    layout = openView(layout, FILE, 'row')
    const second = layout.focused
    layout = close(layout, second)
    expect(panes(layout.root).map((pane) => pane.id)).toEqual([first])
    expect(layout.focused).toBe(first)
    expect(layout.root.kind).toBe('pane')
  })

  test('closing an unfocused pane leaves focus alone', () => {
    let layout = open(emptyLayout(), A)
    const first = layout.focused
    layout = openView(layout, FILE, 'row')
    const second = layout.focused
    layout = close(layout, first)
    expect(layout.focused).toBe(second)
  })

  test('closing an unknown pane is a no-op', () => {
    const layout = open(emptyLayout(), A)
    expect(close(layout, 'nope')).toBe(layout)
  })
})

describe('split and resize', () => {
  test('a split keeps both children usable', () => {
    const opened = open(emptyLayout(), A)
    const layout = split(opened, opened.focused, 'row', FILE)
    const root = layout.root
    expect(root.kind).toBe('split')
    if (root.kind !== 'split') return
    expect(resize(layout, root.id, 0.01).root).toMatchObject({ ratio: 0.15 })
    expect(resize(layout, root.id, 0.99).root).toMatchObject({ ratio: 0.85 })
    expect(resize(layout, root.id, 0.3).root).toMatchObject({ ratio: 0.3 })
  })

  test('splitting an unknown pane is a no-op', () => {
    const layout = emptyLayout()
    expect(split(layout, 'nope', 'row')).toBe(layout)
  })
})

describe('prune', () => {
  test('sessions the store no longer knows leave empty panes behind', () => {
    let layout = open(emptyLayout(), A)
    layout = openView(layout, FILE, 'row')
    const pruned = prune(layout, (session) => session === B)
    expect(panes(pruned.root).map(sessionOf)).toEqual([null, null])
    expect(panes(pruned.root).map((pane) => pane.view.kind)).toEqual(['conversation', 'file'])
  })
})

describe('readLayout', () => {
  test('round-trips a layout through JSON', () => {
    let layout = open(emptyLayout(), A)
    layout = split(layout, layout.focused, 'column', B)
    expect(readLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
  })

  test('rejects malformed trees instead of throwing', () => {
    expect(readLayout('x')).toBeNull()
    expect(readLayout({ root: { kind: 'split', id: 's' } })).toBeNull()
    expect(readLayout({ root: { kind: 'pane' } })).toBeNull()
  })

  test('a duplicated session or a dangling focus is repaired or refused', () => {
    const dup = {
      root: {
        kind: 'split',
        id: 's',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'pane', id: 'p1', session: A },
        second: { kind: 'pane', id: 'p2', session: A },
      },
      focused: 'p1',
    }
    expect(readLayout(dup)).toBeNull()
    const dangling = { root: { kind: 'pane', id: 'p1', session: null }, focused: 'gone' }
    expect(readLayout(dangling)?.focused).toBe('p1')
  })

  test('an out-of-range ratio is clamped on read', () => {
    const raw = {
      root: {
        kind: 'split',
        id: 's',
        direction: 'row',
        ratio: 5,
        first: { kind: 'pane', id: 'p1', session: null },
        second: { kind: 'pane', id: 'p2', view: FILE },
      },
      focused: 'p1',
    }
    expect(readLayout(raw)?.root).toMatchObject({ ratio: 0.85 })
  })
})

describe('tool views', () => {
  const file: PaneView = { kind: 'file', path: '/w/a.ts', runtime: 'codex' as never }
  const preview: PaneView = { kind: 'preview', path: '/w/a.html', runtime: 'codex' as never }

  test('a file opens beside the conversation and is not opened twice', () => {
    let layout = open(emptyLayout(), A)
    layout = openView(layout, file, 'row')
    expect(panes(layout.root).map((pane) => pane.view.kind)).toEqual(['conversation', 'file'])
    const second = openView(layout, file, 'row')
    expect(panes(second.root)).toHaveLength(2)
    expect(second.focused).toBe(layout.focused)
  })

  test('showing a view in another pane takes it from the first', () => {
    let layout = openView(open(emptyLayout(), A), file, 'row')
    const filePane = layout.focused
    layout = split(layout, filePane, 'column', file)
    expect(panes(layout.root).filter((pane) => pane.view.kind === 'file')).toHaveLength(1)
  })

  test('tool views round-trip through persistence, and the old shape still reads', () => {
    let layout = openView(open(emptyLayout(), A), preview, 'row')
    layout = openView(layout, file, 'column')
    expect(readLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    // And the same document names both tools as displaced from the middle, so
    // `readWorkbench` can dock them instead of dropping them.
    expect(strayPanels(JSON.parse(JSON.stringify(layout)))).toEqual([preview, file])
    const old = { root: { kind: 'pane', id: 'p1', session: A }, focused: 'p1' }
    expect(readLayout(old)?.root).toEqual({ kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } })
    const broken = { root: { kind: 'pane', id: 'p1', view: { kind: 'terminal' } }, focused: 'p1' }
    expect(readLayout(broken)?.root).toEqual({ kind: 'pane', id: 'p1', view: { kind: 'conversation', session: null } })
  })
})

describe('paneShowingTool', () => {
  test('finds the tool pane among conversations, and none when all panes converse', () => {
    let layout = emptyLayout()
    layout = open(layout, sessionKey('codex' as never, 'a' as never))
    expect(paneShowingTool(layout)).toBeNull()
    layout = split(layout, layout.focused, 'row', {
      kind: 'file',
      path: '/w/a.ts',
      runtime: 'codex' as never,
    })
    expect(paneShowingTool(layout)?.view.kind).toBe('file')
  })
})

describe('terminals are not panes', () => {
  const term: TerminalView = { kind: 'terminal', terminalId: 't1', runtime: 'codex' as never, cwd: '/w' }

  /*
   * The terminal used to have a container of its own bolted to the bottom of
   * this module — a `Dock` type, five reducers and a height nothing else could
   * use. It is a view in the bottom panel now (state/workbench.ts), so what is
   * left here is the one thing the split tree still owes it: a terminal never
   * becomes a pane, and a document that says otherwise is read for what it
   * meant rather than obeyed.
   */

  test('a saved terminal pane is emptied, and the process is still found', () => {
    const old = {
      root: {
        kind: 'split',
        id: 's',
        direction: 'row',
        ratio: 0.5,
        first: { kind: 'pane', id: 'p1', view: { kind: 'conversation', session: A } },
        second: { kind: 'pane', id: 'p2', view: term },
      },
      focused: 'p2',
    }
    const migrated = readLayout(old)
    // The emptied terminal pane folds into the conversation: one pane, the transcript.
    expect(panes(migrated!.root).map(sessionOf)).toEqual([A])
    expect(migrated?.focused).toBe('p1')
    // And the shell itself is not lost: the bottom panel re-docks it.
    expect(strayTerminals(old)).toEqual([term])
  })

  test('every shape a dock was ever written in gives its terminals up', () => {
    // The one-terminal dock, before it grew tabs.
    expect(strayTerminals({ dock: { view: term, height: 200 } })).toEqual([term])
    // The dock with tabs.
    const second = { ...term, terminalId: 't2' }
    expect(strayTerminals({ dock: { terminals: [term, second], active: 't2' } })).toEqual([term, second])
    // A document holding one twice gives it up once: the tab strip must not
    // grow a duplicate of a process there is only one of.
    expect(
      strayTerminals({
        dock: { terminals: [term] },
        root: { kind: 'pane', id: 'p1', view: term },
      }),
    ).toEqual([term])
  })
})

describe('browser view', () => {
  const readBack = (view: unknown): BrowserView | null => {
    const parsed = readLayout(JSON.parse(JSON.stringify({ root: { kind: 'pane', id: 'p1', view }, focused: 'p1' })))
    const root = parsed?.root
    return root?.kind === 'pane' && root.view.kind === 'browser' ? root.view : null
  }

  test('the browser is one view: any two browser panes are the same thing', () => {
    const a = browserView('http://localhost:3000/')
    const b = browserView('https://example.com/')
    expect(sameView(a, b)).toBe(true)
    const layout = openView(emptyLayout(), a, 'row')
    const again = openView(layout, b)
    expect(panes(again.root).filter((pane) => pane.view.kind === 'browser').length).toBe(1)
  })

  test('a browser opens on one tab, which is both shown and driven', () => {
    const view = browserView('http://localhost:3000/')
    expect(view.tabs).toHaveLength(1)
    expect(activeBrowserTab(view).url).toBe('http://localhost:3000/')
    expect(view.active).toBe(view.driven)
    expect(drivenBrowserTab(view)).toEqual(activeBrowserTab(view))
  })

  test('a new tab lands after the one you were on, and takes the screen', () => {
    const first = browserView('https://a/')
    const second = addBrowserTab(first, 'https://b/')
    const third = addBrowserTab(second, 'https://c/')
    expect(third.tabs.map((tab) => tab.url)).toEqual(['https://a/', 'https://b/', 'https://c/'])
    expect(activeBrowserTab(third).url).toBe('https://c/')
    // Opening tabs never moves the mark; the agent keeps its page.
    expect(drivenBrowserTab(third).url).toBe('https://a/')
  })

  test('closing a tab hands the screen — and the mark — to its neighbour', () => {
    const view = addBrowserTab(addBrowserTab(browserView('https://a/'), 'https://b/'), 'https://c/')
    const closed = removeBrowserTab(view, view.driven)!
    expect(closed.tabs.map((tab) => tab.url)).toEqual(['https://b/', 'https://c/'])
    // There is always exactly one driven tab, and it still exists.
    expect(closed.tabs.some((tab) => tab.id === closed.driven)).toBe(true)
    expect(closed.tabs.some((tab) => tab.id === closed.active)).toBe(true)
  })

  test('closing the last tab means closing the pane', () => {
    const view = browserView('https://a/')
    expect(removeBrowserTab(view, view.tabs[0]!.id)).toBeNull()
    expect(removeBrowserTab(view, 'no-such-tab')).toBe(view)
  })

  test('a stale active or driven id falls back to the first tab rather than blanking the pane', () => {
    const view = { ...browserView('https://a/'), active: 'gone', driven: 'gone' }
    expect(activeBrowserTab(view).url).toBe('https://a/')
    expect(drivenBrowserTab(view).url).toBe('https://a/')
  })

  test('a tab learns where it went, what it is called, and how large it is shown', () => {
    const view = browserView('https://a/')
    const id = view.tabs[0]!.id
    const next = patchBrowserTab(patchBrowserTab(view, id, { url: 'https://b/', title: 'B' }), id, { device: 'mobile' })
    expect(next.tabs[0]).toEqual({ id, url: 'https://b/', title: 'B', device: 'mobile' })
    // A patch for a tab that is gone changes nothing.
    expect(patchBrowserTab(next, 'gone', { url: 'https://c/' })).toBe(next)
  })

  test('a device names a viewport, and only the phone changes the user agent', () => {
    expect(browserDevice('responsive').size).toBeNull()
    expect(browserDevice('mobile').size).toEqual({ width: 375, height: 812 })
    expect(browserDevice('tablet').size).toEqual({ width: 768, height: 1024 })
    expect(browserDevice('desktop').size).toEqual({ width: 1280, height: 800 })
    expect(browserDevice('mobile').userAgent).toMatch(/Mobile/)
    expect(browserDevice('tablet').userAgent).toBeUndefined()
    // Anything unrecognised is the pane filling itself, not a crash.
    expect(browserDevice(undefined).id).toBe('responsive')
    expect(browserDevice('phablet' as never).id).toBe('responsive')
  })

  test('tabs, and which one is shown and driven, survive a round trip', () => {
    const view = patchBrowserTab(addBrowserTab(browserView('https://a/'), 'https://b/'), 'x', {})
    const back = readBack(view)
    expect(back).toEqual(view)
  })

  test('a layout written before tabs comes back as one tab on the same page', () => {
    const back = readBack({ kind: 'browser', url: 'http://x/' })
    expect(back?.tabs.map((tab) => tab.url)).toEqual(['http://x/'])
    expect(back?.active).toBe(back?.tabs[0]!.id)
    expect(back?.driven).toBe(back?.tabs[0]!.id)
    // And one written with nothing at all is a blank tab, not a lost pane.
    expect(readBack({ kind: 'browser' })?.tabs.map((tab) => tab.url)).toEqual(['about:blank'])
  })

  test('a hand-mangled browser degrades rather than disappearing', () => {
    // Tabs with no id, a stale active, and a device nobody has heard of.
    const back = readBack({
      kind: 'browser',
      tabs: [{ url: 'https://a/' }, { id: 't2', url: 'https://b/', device: 'watch' }, { id: 't3' }],
      active: 'gone',
      driven: 't3',
    })
    expect(back?.tabs).toEqual([
      { id: 't2', url: 'https://b/' },
      { id: 't3', url: 'about:blank' },
    ])
    expect(back?.active).toBe('t2')
    expect(back?.driven).toBe('t3')
    // Every tab thrown away leaves a browser, not an empty pane.
    expect(readBack({ kind: 'browser', tabs: [{ url: 'https://a/' }] })?.tabs).toHaveLength(1)
  })
})

describe('git view', () => {
  const GIT: PaneView = { kind: 'git', root: '/w/repo' }

  test('is the same view exactly when it shows the same repository', () => {
    expect(sameView(GIT, { kind: 'git', root: '/w/repo' })).toBe(true)
    expect(sameView(GIT, { kind: 'git', root: '/w/other' })).toBe(false)
    expect(sameView(GIT, FILE)).toBe(false)
  })

  test('opens beside the conversation and survives a persistence round-trip', () => {
    const layout = openView(open(emptyLayout(), A), GIT, 'row')
    const read = readLayout(JSON.parse(JSON.stringify(layout)))
    expect(read).not.toBeNull()
    expect(panes(read!.root).map((pane) => pane.view.kind)).toEqual(['conversation', 'git'])
  })

  test('a git view missing its root reads back as an empty pane, not a broken one', () => {
    const layout = openView(open(emptyLayout(), A), GIT, 'row')
    const raw = JSON.parse(JSON.stringify(layout)) as { root: { second: { view: { root?: string } } } }
    delete raw.root.second.view.root
    const read = readLayout(raw)
    expect(read).not.toBeNull()
    expect(panes(read!.root).every((pane) => pane.view.kind === 'conversation')).toBe(true)
  })
})

describe('expansion', () => {
  const GIT: PaneView = { kind: 'git', root: '/w/repo' }

  const withTool = () => {
    const layout = openView(open(emptyLayout(), A), GIT, 'row')
    const pane = paneShowingTool(layout)!
    return { layout, pane }
  }

  test('expands a tool pane and takes the focus there', () => {
    const { layout, pane } = withTool()
    const expanded = expand(layout, pane.id)
    expect(expanded.expanded).toBe(pane.id)
    expect(expanded.focused).toBe(pane.id)
    expect(settleExpansion(expanded)).toBe(expanded)
  })

  test('never expands a conversation pane, or a pane that is not there', () => {
    const { layout } = withTool()
    const conversation = panes(layout.root).find((pane) => pane.view.kind === 'conversation')!
    expect(expand(layout, conversation.id).expanded).toBeNull()
    expect(expand(layout, 'missing').expanded).toBeNull()
  })

  test('collapse hands the room back and keeps the tree', () => {
    const { layout, pane } = withTool()
    const collapsed = collapse(expand(layout, pane.id))
    expect(collapsed.expanded).toBeNull()
    expect(panes(collapsed.root)).toHaveLength(2)
  })

  test('closing the expanded pane ends the expansion', () => {
    const { layout, pane } = withTool()
    const closed = close(expand(layout, pane.id), pane.id)
    expect(closed.expanded).toBeNull()
  })

  test('focus moving off the expanded pane settles the expansion away', () => {
    const { layout, pane } = withTool()
    const conversation = panes(layout.root).find((entry) => entry.view.kind === 'conversation')!
    const expanded = expand(layout, pane.id)
    // A session row clicked while expanded: the conversation takes the focus,
    // and keeping the zoom would hide the very thing that was asked for.
    const asked = open(expanded, B)
    expect(asked.focused).toBe(conversation.id)
    expect(settleExpansion(asked).expanded).toBeNull()
  })

  test('expansion persists, and a stale pane id reads back as no expansion', () => {
    const { layout, pane } = withTool()
    const expanded = expand(layout, pane.id)
    const read = readLayout(JSON.parse(JSON.stringify(expanded)))
    expect(read!.expanded).toBe(pane.id)
    const raw = JSON.parse(JSON.stringify(expanded)) as { expanded: string }
    raw.expanded = 'gone'
    expect(readLayout(raw)!.expanded).toBeNull()
  })
})

/**
 * Main is a slot.
 *
 * Reported from the running app: opening the Room drew it *beside* the
 * conversation, so the middle held both — a conversation on the left, a room on
 * the right, and no way to have only one. The `mounts` change had already
 * stopped anything else from declaring main, which left the split tree able to
 * produce exactly one pair, and that pair is the one the rule forbids.
 */
describe('only', () => {
  const room = { kind: 'room', room: 'r1' } as const
  const chat = { kind: 'conversation', session: sessionKey('codex', 'c1') } as const

  test('replaces what the middle held rather than splitting beside it', () => {
    const start = only(emptyLayout(), chat)
    const next = only(start, room)
    expect(panes(next.root)).toHaveLength(1)
    expect(panes(next.root)[0]?.view).toEqual(room)
    // And back again: a jump, not an accumulation.
    expect(panes(only(next, chat).root)).toHaveLength(1)
  })

  test('keeps the pane id when the same view is shown again', () => {
    // Re-showing what is already there must not read as a different pane to
    // anything keyed on the id — a webview would remount and come back blank.
    const start = only(emptyLayout(), room)
    expect(only(start, room).root.id).toBe(start.root.id)
  })

  test('leaves nothing expanded, and the one pane focused', () => {
    const next = only(emptyLayout(), room)
    expect(next.expanded).toBeNull()
    expect(next.focused).toBe(next.root.id)
  })
})
