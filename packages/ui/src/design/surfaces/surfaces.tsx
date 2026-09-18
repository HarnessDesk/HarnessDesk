import type { ReactNode } from 'react'

import { BrowserPane } from '../../components/BrowserPane'
import { Composer } from '../../components/Composer'
import { FilePane } from '../../components/FilePane'
import { Conversation } from '../../components/Conversation'
import { GitPane } from '../../components/GitPane'
import { Sidebar } from '../../components/Sidebar'
import { TeamBoardPane } from '../../components/TeamBoardPane'
import { TeamRoomPane } from '../../components/TeamRoomPane'
import { TerminalSurface as TerminalPane } from '../../components/TerminalPane'
import { Usage } from '../../components/Usage'
import { MountProvider } from '../../panels/mount'
import { Workbench } from '../../panels/Workbench'
import { dock, emptyWorkbench } from '../../state/workbench'
import { PaneProvider } from '../../state/context'
import { Mount, PREVIEW_ROOM, PREVIEW_SESSION_KEY, previewStore } from '../../preview/harness'
import { PREVIEW_ROOT } from '../../preview/sidebar-fixture'
import styles from './surfaces.module.css'

/**
 * The catalogue's whole-screen entries — each one the screen the app ships.
 *
 * Every board above this file shows a *part*: a button in its sizes, a dialog
 * in its states. These answer the question a part cannot, which is whether the
 * set of parts makes a screen. For a long time they answered it with drawings
 * — a `ConversationPage` beside the real `Conversation`, a `GitHistoryPage`
 * beside the real `GitPane` — and a drawing can only ever be right on the day
 * it is drawn. Change the shipped conversation and the catalogue kept showing
 * the old one, confidently, in every palette.
 *
 * So there is nothing here but a frame and a mount. The screen is imported
 * from `components/`, it brings its own stylesheet, and it renders through the
 * same store stub `/preview.html` uses (`preview/harness`) because a screen
 * without a store does not render a simpler version of itself — it throws.
 * `script/check-ui-system.mjs` holds this: every surface row in the catalogue
 * names the shipped module it mounts — a screen in `components/`, or the
 * workbench in `panels/` — and the check walks the import graph from that
 * row's own export here, not from this file: walked from the file, a surface
 * that stopped mounting its screen passed on a sibling that mounts the same
 * one. The explorer tab for the row has to load that export, too.
 *
 * The frames are the only judgement this file makes, and they are about room
 * rather than looks — see `surfaces.module.css`.
 */

const Frame = ({
  height = 'pane',
  children,
}: {
  height?: 'pane' | 'page' | 'window'
  children: ReactNode
}) => (
  <div className={styles.frame} data-height={height}>
    {children}
  </div>
)

/**
 * The conversation, scoped exactly the way the workbench scopes it.
 *
 * `PaneProvider` is not decoration here: the transcript reads its session from
 * the pane, and the composer under it asks whether its pane has focus. Mount
 * it without one and you are looking at a branch the app never shows.
 */
export const ConversationSurface = () => (
  <Mount>
    <Frame height="page">
      <PaneProvider
        scope={{
          paneId: 'design' as never,
          view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
          sessionKey: PREVIEW_SESSION_KEY,
        }}
      >
        <Conversation
          onChooseProject={() => {}}
          onSignIn={() => {}}
          onOpenUsage={() => {}}
          onOpenAgents={() => {}}
        />
      </PaneProvider>
    </Frame>
  </Mount>
)

/**
 * The composer alone, at the width the conversation column gives it.
 *
 * It is the one control a user touches every turn, and it is worth seeing
 * without the transcript above it competing for the judgement — but it is the
 * same module the transcript mounts, not a still of it.
 */
export const ComposerSurface = () => (
  <Mount>
    <Frame>
      <PaneProvider
        scope={{
          paneId: 'design' as never,
          view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never,
          sessionKey: PREVIEW_SESSION_KEY,
        }}
      >
        <div className={styles.work} />
        <Composer onChooseProject={() => {}} />
      </PaneProvider>
    </Frame>
  </Mount>
)

/**
 * The sidebar at a window's width, with the work beside it standing in.
 *
 * A rail alone on a white page always looks fine; the only real question about
 * one is how much attention it takes from what it sits next to.
 */
export const RailSurface = () => (
  <Mount>
    <Frame height="page">
      <div className={`${styles.beside} h-full`}>
        <Sidebar
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenUsage={() => {}}
          onBrowseFolders={() => {}}
          onSignIn={() => {}}
          onSearch={() => {}}
        />
        <div className={styles.work} />
      </div>
    </Frame>
  </Mount>
)

/**
 * The repository pane: the graph, and the detail the graph opens.
 *
 * The pane reads its repository from where it is mounted — the root is the
 * view's, not the pane's — so without a `MountProvider` it has no repository
 * and draws an empty frame. That is what this surface showed for a while, and
 * nothing failed: a blank pane is a perfectly valid render.
 */
export const GitSurface = () => (
  <Mount>
    <Frame height="page">
      <MountProvider scope={{ area: 'main', id: 'design-git', view: { kind: 'git', root: PREVIEW_ROOT } }}>
        <GitPane />
      </MountProvider>
    </Frame>
  </Mount>
)

/**
 * A group project: the board and the room that belongs to it, together.
 *
 * Apart they are two panes; together they are the claim the layout exists to
 * make — that a task names the harness holding it, and that the harness is one
 * press from the conversation where the work is happening.
 */
export const GroupSurface = () => (
  <Mount>
    <div className={styles.pair}>
      <Frame>
        <TeamBoardPane room={PREVIEW_ROOM} />
      </Frame>
      <Frame>
        <TeamRoomPane room={PREVIEW_ROOM} />
      </Frame>
    </div>
  </Mount>
)

/**
 * Every tool in the frame they share — the shipped panes, not a picture.
 *
 * This board is the argument that a browser, a terminal and an editor differ
 * only in what they genuinely are: the header, the mark, the subject line, the
 * tab strip and whether the body pads or bleeds are one component across all
 * of them. A drawing cannot make that argument, because a drawing draws the
 * header once and the argument is about six files agreeing.
 *
 * `MountProvider` rather than `PaneProvider`: a tool pane asks *where it is
 * mounted*, not which conversation it is about, and everything its header
 * offers — close, move, zoom — is the mount's rather than the pane's. Given
 * none, the panes render the branch the app never shows.
 */
const TOOL_AREA = 'main' as const

export const ToolsSurface = () => (
  <Mount>
    <div className={styles.pair}>
      <Frame>
        <MountProvider
          scope={{
            area: TOOL_AREA,
            id: 'design-browser',
            view: {
              kind: 'browser',
              tabs: [
                { id: 't1', url: 'http://localhost:5273/design.html', title: 'Design system' },
                { id: 't2', url: 'https://example.com', title: 'Example' },
              ],
              active: 't1',
              driven: 't1',
            },
          }}
        >
          <BrowserPane />
        </MountProvider>
      </Frame>
      <Frame>
        <MountProvider
          scope={{
            area: TOOL_AREA,
            id: 'design-file',
            view: { kind: 'file', path: 'packages/ui/src/lib/brands.ts', runtime: 'codex' as never },
          }}
        >
          <FilePane />
        </MountProvider>
      </Frame>
      <Frame>
        <MountProvider
          scope={{
            area: TOOL_AREA,
            id: 'design-terminal',
            view: {
              kind: 'terminal',
              terminalId: 'design-terminal',
              runtime: 'codex' as never,
              cwd: '/work/storefront',
            },
          }}
        >
          <TerminalPane />
        </MountProvider>
      </Frame>
    </div>
  </Mount>
)

/**
 * The panel system, as the app assembles it.
 *
 * `panels/Workbench.tsx`, the component the window renders, with a store of
 * its own. The app opens with every dock empty, which is the right default
 * and a useless one to judge docking by, so this store starts with the
 * Changes and Trajectory views in the right dock and a terminal in the
 * bottom — put there by `dock`, the function the app calls when you open a
 * view, so the tree is the one the app would build rather than one written
 * out by hand.
 *
 * The verbs are real too. Collapse, expand, move, split and resize are the
 * store's, and the harness answers each with the same pure function the
 * app's store does (`preview/harness.tsx`). What happens when you press
 * something here is what the app would do.
 */
const panelsStore = previewStore({
  workbench: (
    [
      ['right', { kind: 'changes' }],
      ['right', { kind: 'trajectory' }],
      [
        'bottom',
        { kind: 'terminal', terminalId: 'design-terminal', runtime: 'codex' as never, cwd: PREVIEW_ROOT },
      ],
    ] as const
  ).reduce((workbench, [area, view]) => dock(workbench, area, view), emptyWorkbench()),
})

export const PanelsSurface = () => (
  <Mount with={panelsStore}>
    <Frame height="page">
      <Workbench
        sidebar={
          <Sidebar
            onOpenSettings={() => {}}
            onOpenPlugins={() => {}}
            onOpenUsage={() => {}}
            onBrowseFolders={() => {}}
            onSignIn={() => {}}
            onSearch={() => {}}
          />
        }
      />
    </Frame>
  </Mount>
)

/**
 * The Dashboard — plan usage, what it cost, where it went — as the app opens
 * it with ⌘U.
 *
 * There used to be a tab called Dashboard here that was not this: a page of
 * stat tiles and charts assembled for the catalogue, which described itself as
 * "a page that does not exist" while wearing the name of one that does. This
 * is the one that does — `components/Usage.tsx`, in a window-sized frame,
 * because it is a window.
 */
export const DashboardSurface = () => (
  <Mount>
    <Frame height="window">
      <Usage onClose={() => {}} onSignIn={() => {}} />
    </Frame>
  </Mount>
)
