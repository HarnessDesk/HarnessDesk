import { useEffect, useMemo } from 'react'

import { TeamRoomPane } from '../components/TeamRoomPane'
import { shortcutFor } from '../lib/shortcuts'
import { MountProvider } from '../panels/mount'
import { StoreProvider } from '../state/context'
import { Frame } from './main'
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

const SideBySideRoomFrame = ({
  id,
  title,
  count,
  expanded,
}: {
  readonly id: string
  readonly title: string
  readonly count: 2 | 4
  readonly expanded?: boolean
}) => {
  const store = useMemo(sideBySideStore, [])
  const tiles = SIDE_BY_SIDE_KEYS.slice(0, count)
  const view = {
    kind: 'room' as const,
    room: PREVIEW_ROOM,
    sideBySide: {
      tiles,
      focused: expanded ? tiles[1] : tiles[0],
      ...(expanded ? { expanded: tiles[1] } : {}),
    },
  }
  return (
    <Frame id={id} title={title}>
      <div data-side-by-side-container style={{ width: '100%', height: 520 }}>
        <StoreProvider store={store}>
          <MountProvider scope={{ area: 'main', id, view }}>
            <TeamRoomPane room={PREVIEW_ROOM} />
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
      <SideBySideRoomFrame id="side-by-side-two" title="Room — Side by side · two members" count={2} />
      <SideBySideRoomFrame id="side-by-side-four" title="Room — Side by side · four members" count={4} />
      <SideBySideRoomFrame id="side-by-side-expanded" title="Room — Side by side · expanded tile" count={4} expanded />
    </div>
  </>
)
