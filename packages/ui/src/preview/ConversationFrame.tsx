import type { ReactNode } from 'react'
import { usePane } from '../state/context'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'

// Standalone preview surfaces use the real registry and bar, just as main does.
const FrameBar = () => {
  const pane = usePane()
  return pane ? <TopBarOutlet owner={pane.paneId} fallback={{ place: 'New session', more: () => null }} /> : null
}
export const ConversationFrame = ({ children }: { children: ReactNode }) => <TopBarProvider><FrameBar />{children}</TopBarProvider>
