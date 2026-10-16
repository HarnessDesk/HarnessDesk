import type { ReactNode } from 'react'
import { WorkViewControlsOutlet, TopBarOutlet, TopBarProvider } from '../panels/top-bar'
import { PaneProvider, useSnapshot } from '../state/context'

/** Standalone synthetic Team views keep their real controls in a scoped shell. */
export const TeamViewFrame = ({ room, page, children }: { room: string; page: 'board' | 'findings'; children: ReactNode }) => {
  const snapshot = useSnapshot()
  const title = snapshot.goals.get(room)?.goal.sentence ?? snapshot.teams.get(room)?.name ?? 'Team'
  const owner = `preview-team-${page}`
  return <TopBarProvider><PaneProvider scope={{ paneId: owner, view: { kind: 'room', room, framePage: page }, sessionKey: null }}>
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <TopBarOutlet owner={owner} fallback={{ place: title, more: () => null }} /><WorkViewControlsOutlet owner={owner} />
      {children}
    </div>
  </PaneProvider></TopBarProvider>
}
