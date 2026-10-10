import { useState } from 'react'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { ComposerMountsProvider } from '../components/Notices'
import { PaneProvider, useSnapshot, useStore } from '../state/context'
import { fixedSubject } from '../state/workbench'
import { findPane, type PaneView } from '../state/layout'
import { MountProvider } from '../panels/mount'
import { RunDockProvider } from '../panels/run-dock'
import { TopBarProvider, TopBarOutlet, WorkDetailsOutlet } from '../panels/top-bar'
import { useShell } from '../panels/views'
import { DockPanelBody, FRAME } from '../design'
import { useNarrowLayout } from '../lib/use-narrow-layout'

/** A standalone synthetic scene owns its real registries and selected reads.
 * Full-sidebar and wall fixtures use Workbench; these catalogue/content frames
 * compose the same providers directly so the rendered Team is a visible export. */
export const TeamFramePreview = ({ room, view }: { room: string; view?: Extract<PaneView, { kind: 'room' }> }) => {
  const store = useStore()
  useState(() => {
    const snapshot = store.getSnapshot()
    const main = { root: { kind: 'pane' as const, id: 'preview-team-main', view: view ?? { kind: 'room' as const, room } }, focused: 'preview-team-main', expanded: null }
    Object.assign(snapshot, { layout: main, workbench: { ...snapshot.workbench, main }, activeSessionKey: null, sidebarCollapsed: true, sidebarFloating: false })
    return true
  })
  const snapshot = useSnapshot(), shell = useShell()
  const pane = findPane(snapshot.workbench.main, snapshot.workbench.main.focused)!
  const subject = fixedSubject(snapshot.workbench.main)
  const intent = subject ? snapshot.workbench.frameTools[subject] : undefined
  const measured=useNarrowLayout<HTMLDivElement>(FRAME.fold.panelFloats)
  const standing=measured.narrow === false
  const details = intent?.open && intent.tool === 'details' && ['details','run-details'].includes(intent.mode)
  return <TopBarProvider><RunDockProvider><ComposerMountsProvider>
    <PaneProvider scope={{paneId:pane.id,view:pane.view,sessionKey:null}}><MountProvider scope={{area:'main',id:pane.id,view:pane.view}}>
      <div ref={measured.ref} className="h-full min-w-0 flex flex-col overflow-hidden">
        <TopBarOutlet owner={pane.id} rightColumnWidth={details && standing ? FRAME.rightPanel.width : undefined} fallback={{place:'Team',more:()=>null}} />
        <div className="relative min-h-0 flex-1 flex overflow-hidden">
          <div data-slot="workbench-main" className="min-w-0 min-h-0 flex-1">
            <TeamRoomPane room={room} onChooseProject={shell.chooseProject} onSignIn={shell.signIn} onOpenUsage={shell.openUsage} onOpenRuntimes={shell.openRuntimes} />
          </div>
          {details && <div data-preview-tool-placement={standing ? 'column' : 'floating'} className={standing ? "flex min-h-0 shrink-0 flex-col overflow-hidden" : "absolute inset-y-0 right-0 z-(--hd-z-drawer) flex min-h-0 flex-col overflow-hidden bg-background shadow-(--hd-shadow-lg)"} style={{width:FRAME.rightPanel.width,maxWidth:'100%'}}><DockPanelBody><WorkDetailsOutlet owner={pane.id} /></DockPanelBody></div>}
        </div>
      </div>
    </MountProvider></PaneProvider>
  </ComposerMountsProvider></RunDockProvider></TopBarProvider>
}
