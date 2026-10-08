import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { SessionKey } from '@harnessdesk/protocol'
import { ToolPaneEmptyState } from '../design'
import { browserMount, browserProfileKey, seatBrowserProfile } from '../lib/browser-tiles'
import { MountProvider } from '../panels/mount'
import { useSnapshot, useStore } from '../state/context'
import { BrowserPane } from './BrowserPane'

/** A tile borrows the existing browser mount, including every tab verb and guest. */
export const SeatBrowser = ({ paneId, session, onFocus }: { paneId: string; session: SessionKey; onFocus: (key: SessionKey) => void }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [problem, setProblem] = useState<string | null>(null)
  const profile = seatBrowserProfile(snapshot, session)
  const focus = useCallback(() => onFocus(session), [onFocus, session])
  const cwd = snapshot.sessions.get(session)?.cwd
  useEffect(() => {
    let here = true
    void store.loadLanePreferences().catch(() => {
      if (here) setProblem('The browser profile could not be read. Switch to Conversation and try Browser again.')
    })
    return () => { here = false }
  }, [store, session, cwd])
  useLayoutEffect(() => {
    if (profile === undefined) return
    return store.mountBrowserTile(profile, { paneId, key: session, focus })
  }, [store, paneId, session, profile, focus])
  const owner = profile === undefined ? null : snapshot.browserTiles.get(browserProfileKey(profile))
  const browser = profile === undefined ? null : browserMount(snapshot, profile)
  if (owner && (owner.paneId !== paneId || owner.key !== session)) {
    return <ToolPaneEmptyState title="Shared browser" description="This browser is shown in another tile." />
  }
  if (!browser || !owner) {
    return <ToolPaneEmptyState title="Nothing open yet" description={problem ?? 'Pages the agent opens appear here.'} />
  }
  return <MountProvider scope={{ ...browser, embedded: true }}><BrowserPane /></MountProvider>
}
