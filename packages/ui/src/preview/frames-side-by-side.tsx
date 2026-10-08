import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { TeamRoomPane } from '../components/TeamRoomPane'
import { shortcutFor } from '../lib/shortcuts'
import { MountProvider } from '../panels/mount'
import { KeyboardHereContext, StoreProvider } from '../state/context'
import { Frame } from './main'
import { useTheme } from '../state/theme'
import { PREVIEW_ROOM } from './harness'
import { SIDE_BY_SIDE_KEYS, sideBySideStore } from './side-by-side-fixture'

/** The browser preview has no app shell, so it supplies the shell's shortcut dispatch here. */
const PreviewShortcutBridge = () => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = shortcutFor(event)
      if (!shortcut || !shortcut.action.startsWith('tile-')) return
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('hd-side-by-side', { detail: shortcut.action }))
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

/**
 * The app has one focused pane; this page mounts three rooms, all of which
 * would answer a window chord at once. Each frame says it has the keyboard
 * only while the focus is inside it, the way the app's focused pane does.
 */
const FocusedWhileInside = ({ children }: { readonly children: ReactNode }) => {
  const box = useRef<HTMLDivElement>(null)
  const [inside, setInside] = useState(false)
  useEffect(() => {
    const update = () => setInside(Boolean(box.current?.contains(document.activeElement)))
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
    }
  }, [])
  return (
    <div ref={box} className="contents">
      <KeyboardHereContext.Provider value={inside}>{children}</KeyboardHereContext.Provider>
    </div>
  )
}

const SideBySideRoomFrame = ({
  id,
  title,
  count,
  expanded,
  browsers = false,
}: {
  readonly id: string
  readonly title: string
  readonly count: 2 | 4
  readonly expanded?: boolean
  readonly browsers?: boolean
}) => {
  const store = useMemo(() => sideBySideStore({ browsers }), [browsers])
  const tiles = SIDE_BY_SIDE_KEYS.slice(0, count)
  const view = {
    kind: 'room' as const,
    room: PREVIEW_ROOM,
    sideBySide: {
      tiles,
      ...(browsers ? { modes: Object.fromEntries(tiles.map(key => [key, 'browser' as const])) } : {}),
      focused: expanded ? tiles[1] : tiles[0],
      ...(expanded ? { expanded: tiles[1] } : {}),
    },
  }
  return (
    <Frame id={id} title={title}>
      <div data-side-by-side-container style={{ width: '100%', height: browsers ? 700 : 520 }}>
        <StoreProvider store={store}>
          <MountProvider scope={{ area: 'main', id, view }}>
            <FocusedWhileInside>
              <TeamRoomPane room={PREVIEW_ROOM} />
            </FocusedWhileInside>
          </MountProvider>
        </StoreProvider>
      </div>
    </Frame>
  )
}

export const SideBySideFrames = () => (
  <>
    <PreviewShortcutBridge />
    <div className="mt-4 grid grid-cols-1 gap-4">
      <SideBySideRoomFrame id="side-by-side-browsers" title="Room — Side by side · two live pages" count={2} browsers />
      <SideBySideRoomFrame id="side-by-side-two" title="Room — Side by side · two members" count={2} />
      <SideBySideRoomFrame id="side-by-side-four" title="Room — Side by side · four members" count={4} />
      <SideBySideRoomFrame id="side-by-side-expanded" title="Room — Side by side · expanded tile" count={4} expanded />
    </div>
  </>
)

/** Synthetic live and empty Seat browser scenes for coverage and public frames. */
export const TileBrowserFrames = () => {
  useTheme()
  return <main className="grid gap-4 bg-background p-4 text-foreground">
    <SideBySideRoomFrame id="side-by-side-browsers" title="Side by side — each Seat’s browser" count={2} browsers />
    <SideBySideRoomFrame id="side-by-side-browsers-empty" title="Side by side — live pages and Seats with nothing open" count={4} browsers />
  </main>
}
