import { beforeEach, describe, expect, it } from 'vitest'

import { runtimeId, type EditorDocument, type WireNotification } from '@harnessdesk/protocol'

import { panes } from './layout'
import { AppStore } from './store'
/* The real registry, so `openFile` docks the way it does in the app rather
   than falling through to `#showOnly` — see `the plane, against the real
   registry` at the bottom of this file. */
import '../panels/builtins'
import { dockViews } from './workbench'

/**
 * The window's half of the editor plane.
 *
 * The plane is host state pushed down whole, and this projects it: opening a
 * pane for a document it has not already shown, and handing each pane the
 * marks for its own path. Two things it has to get right, both of them found
 * by running the real app rather than by reading the code.
 *
 * **A pane needs a runtime.** `editor/plane` arrives the moment the socket
 * opens — before `host/hello` has told this window which agents exist — so
 * the first projection routinely runs with `activeRuntime` still null and
 * nothing to open a file *into*. The first version marked each document as
 * shown before opening it, so that first failed attempt was remembered as
 * done and the file never appeared at all. In the app that looked like the
 * plane simply not working; nothing threw and nothing was logged.
 *
 * **It must not fight the person for a pane.** A linter re-decorating on
 * every keystroke pushes a new plane each time, and re-opening on each one
 * would take the focused pane away several times a second.
 */

let store: AppStore

/** A notification, as the host pushes it. Never connected; nothing reaches a wire. */
const push = (notification: WireNotification): void => {
  const transport = store.transport as unknown as {
    handlers: { onNotification(notification: WireNotification): void }
  }
  transport.handlers.onNotification(notification)
}

const plane = (...documents: readonly EditorDocument[]): void => {
  push({ method: 'editor/plane', params: { documents } })
}

const document = (path: string): EditorDocument => ({
  path,
  pluginId: 'linter',
  decorations: [{ fromLine: 2, severity: 'warning', message: 'unused' }],
  openedAt: 1,
})

/**
 * Sets the runtime without waiting on the wire.
 *
 * `selectRuntime` patches synchronously and then awaits `refreshRuntime`,
 * which never resolves against a socket that was never connected. The patch
 * is all these tests need.
 */
const selectCodex = (): void => void store.selectRuntime(runtimeId('codex'))

/**
 * Where the open files are — both places, because a file is docked now.
 *
 * This read used to be `panes(layout.root)` alone, and every test below was
 * green with it long after `openFile` had stopped putting files there. They
 * were green because this file did not import `panels/builtins`: with no
 * registry, `defaultArea` answers null for every view and `openFile` falls
 * through to `#showOnly`, which does put a file in the middle. The suite was
 * testing a path the product never takes, and nothing said so.
 */
const openFiles = (): string[] => [
  ...panes(store.getSnapshot().layout.root).flatMap((pane) =>
    pane.view.kind === 'file' ? [pane.view.path] : [],
  ),
  ...(['sidebar', 'right', 'bottom'] as const)
    .flatMap((area) => dockViews(store.getSnapshot().workbench[area]))
    .flatMap((mounted) => (mounted.view.kind === 'file' ? [mounted.view.path] : [])),
]

/** Closes whichever mount is holding a file, wherever it is. */
const closeTheFile = (): void => {
  const pane = panes(store.getSnapshot().layout.root).find((entry) => entry.view.kind === 'file')
  if (pane) {
    store.closePane(pane.id)
    return
  }
  for (const area of ['sidebar', 'right', 'bottom'] as const) {
    const held = dockViews(store.getSnapshot().workbench[area]).find(
      (mounted) => mounted.view.kind === 'file',
    )
    if (held) {
      store.closeView(held.id)
      return
    }
  }
}

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
})

describe('projecting the plane', () => {
  it('keeps the plane whole in the snapshot, replacing rather than merging', () => {
    plane(document('/w/a.ts'), document('/w/b.ts'))
    expect(store.getSnapshot().editorPlane.map((entry) => entry.path)).toEqual(['/w/a.ts', '/w/b.ts'])
    // The host sends every open document every time, so one that is missing
    // is one that was closed — not one that went unmentioned.
    plane(document('/w/b.ts'))
    expect(store.getSnapshot().editorPlane.map((entry) => entry.path)).toEqual(['/w/b.ts'])
  })

  it('opens no pane while there is no runtime, and opens one as soon as there is', () => {
    // The regression. Before the fix the first call marked `/w/a.ts` as shown
    // and the second did nothing, so the file was never opened at all.
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual([])

    selectCodex()
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual(['/w/a.ts'])
  })

  it('does not re-open a document on every push', () => {
    selectCodex()
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual(['/w/a.ts'])

    // A linter re-decorating as someone types pushes the plane again and
    // again; each one must be a no-op for the layout.
    closeTheFile()
    expect(openFiles()).toEqual([])
    plane(document('/w/a.ts'))
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual([])
  })

  it('shows a document again after it has left the plane and come back', () => {
    selectCodex()
    plane(document('/w/a.ts'))
    closeTheFile()

    // The plugin closed it and marked it again later — a fresh ask, not the
    // same one repeated, so the pane comes back.
    plane()
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual(['/w/a.ts'])
  })

  it('leaves a document open after the plugin drops it', () => {
    selectCodex()
    plane(document('/w/a.ts'))
    // The plugin has finished with the file. The person reading it has not,
    // and a pane vanishing under them would be the app taking away something
    // they were given.
    plane()
    expect(openFiles()).toEqual(['/w/a.ts'])
  })

  it('hands each path only its own marks', () => {
    selectCodex()
    plane(document('/w/a.ts'))
    expect(store.decorationsFor('/w/a.ts')).toHaveLength(1)
    expect(store.decorationsFor('/w/b.ts')).toEqual([])
  })
})

/**
 * The plane, against the registry the app actually loads.
 *
 * Everything above ran with no `panels/builtins` import, so `defaultArea`
 * answered null for every view and `openFile` fell through to `#showOnly` —
 * a file in the middle, which is the one place the app never puts one. The
 * suite was green about a code path the product does not take.
 *
 * With the registry loaded, a file docks. That moves the plane's "is this
 * already on screen" question to the same place `#roomToShow` had to move it:
 * a read of `layout.root` alone can no longer see a file, so a document the
 * person had already opened themselves was treated as unseen every time.
 */
describe('the plane, against the real registry', () => {
  it('opens a document on the edge a file declares, not in the middle', () => {
    selectCodex()
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual(['/w/a.ts'])
    expect(panes(store.getSnapshot().layout.root).some((pane) => pane.view.kind === 'file')).toBe(false)
  })

  it('leaves a document the person already opened where it is', () => {
    // The guard this exercises read `panes(layout.root)` only, so once a file
    // docked it could never be true: every plane push counted an open file as
    // unseen and re-opened it, stealing the panel's active tab from whatever
    // the person had moved to.
    selectCodex()
    store.openFile('/w/a.ts')
    store.openFile('/w/b.ts')
    expect(openFiles()).toEqual(['/w/a.ts', '/w/b.ts'])
    const before = store.getSnapshot().workbench.right
    plane(document('/w/a.ts'))
    expect(openFiles()).toEqual(['/w/a.ts', '/w/b.ts'])
    // And the tab in front is still the one the person left in front.
    expect(store.getSnapshot().workbench.right.root).toEqual(before.root)
  })
})

/**
 * Where the two file openers put things, asked directly.
 *
 * All three reviewers of the change that moved them named this gap, and they
 * were right: the board's placement was pinned in `store.team.test.ts` and the
 * model's docking rules are covered thoroughly in `workbench.test.ts`, but the
 * two entry points a person actually uses — `/open` and `/preview` — were
 * covered only through the editor plane, which reaches `openFile` by a
 * different road and would go on passing if these were reverted.
 */
describe('where a file and a preview open', () => {
  const dockedKinds = (): string[] =>
    (['sidebar', 'right', 'bottom'] as const)
      .flatMap((area) => dockViews(store.getSnapshot().workbench[area]))
      .map((mounted) => mounted.view.kind)

  it('a file docks on the edge it declares, and does not take the middle', () => {
    selectCodex()
    store.openFile('/w/a.ts')
    expect(dockedKinds()).toEqual(['file'])
    expect(store.getSnapshot().workbench.right.root).toMatchObject({ kind: 'stack' })
    // The middle is a conversation or a room, and this is neither.
    expect(panes(store.getSnapshot().layout.root).map((pane) => pane.view.kind)).toEqual([
      'conversation',
    ])
  })

  it('and so does a preview', () => {
    selectCodex()
    store.openPreview('/w/index.html')
    expect(dockedKinds()).toEqual(['preview'])
    expect(panes(store.getSnapshot().layout.root).map((pane) => pane.view.kind)).toEqual([
      'conversation',
    ])
  })

  it('but an explicit split still means the middle, because a person said so', () => {
    // `/open --split` is the one caller that asks for a pane, and the escape
    // hatch is the reason the registry's default is not a prohibition.
    selectCodex()
    store.openFile('/w/a.ts', { split: 'row' })
    expect(dockedKinds()).toEqual([])
    expect(panes(store.getSnapshot().layout.root).map((pane) => pane.view.kind)).toContain('file')
  })

  it('opening the same file twice brings the one that is open forward', () => {
    selectCodex()
    store.openFile('/w/a.ts')
    store.openFile('/w/b.ts')
    store.openFile('/w/a.ts')
    // Two files, not three, and no duplicate of the first.
    expect(dockedKinds()).toEqual(['file', 'file'])
  })
})
