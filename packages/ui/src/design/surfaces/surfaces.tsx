import type { ReactNode } from 'react'

import { Composer } from '../../components/Composer'
import { Conversation } from '../../components/Conversation'
import { GitPane } from '../../components/GitPane'
import { Sidebar } from '../../components/Sidebar'
import { TeamBoardPane } from '../../components/TeamBoardPane'
import { TeamRoomPane } from '../../components/TeamRoomPane'
import { PaneProvider } from '../../state/context'
import { Mount, PREVIEW_ROOM, PREVIEW_SESSION_KEY } from '../../preview/harness'
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
 * `script/check-ui-system.mjs` holds this: every surface in the catalogue
 * names a module under `components/`, and that module has to be one this file
 * actually imports.
 *
 * The frames are the only judgement this file makes, and they are about room
 * rather than looks — see `surfaces.module.css`.
 */

const Frame = ({
  height = 'pane',
  children,
}: {
  height?: 'pane' | 'page'
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

/** The repository pane: the graph, and the detail the graph opens. */
export const GitSurface = () => (
  <Mount>
    <Frame height="page">
      <GitPane />
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
