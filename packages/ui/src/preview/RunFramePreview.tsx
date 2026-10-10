import { useState, type ComponentProps } from 'react'
import { RunWorkspace } from '../components/RunWorkspace'
import { RunInspector } from '../components/RunInspector'
import { TeamRunFacts } from '../components/TeamRunFacts'
import { DockPanelBody, FRAME, ToolBody, ToolSection } from '../design'
import { useNarrowLayout } from '../lib/use-narrow-layout'
import { PaneProvider, useSnapshot, useStore } from '../state/context'
import { fixedSubject } from '../state/workbench'
import { MountProvider } from '../panels/mount'
import { WorkTools } from '../panels/WorkTools'
import { RunDockProvider } from '../panels/run-dock'
import { TopBarProvider, TopBarOutlet, useWorkDetails, WorkDetailsOutlet } from '../panels/top-bar'

type Props = ComponentProps<typeof RunWorkspace> & { facts?: boolean }
/** A catalogue Run uses the same owned bar, Details body and measured placement as a Team. */
export const RunFramePreview = (props: Props) => {
  const store = useStore()
  const owner = 'preview-run-main'
  const view = { kind: 'room' as const, room: props.inspector.input.execution.goal }
  useState(() => {
    const snapshot = store.getSnapshot()
    const main = { root: { kind: 'pane' as const, id: owner, view }, focused: owner, expanded: null }
    Object.assign(snapshot, { layout: main, workbench: { ...snapshot.workbench, main }, activeSessionKey: null })
    if (props.facts || props.selectedRow) store.chooseWorkTool('details', 'run-details')
    return true
  })
  return <TopBarProvider><RunDockProvider><PaneProvider scope={{ paneId: owner, view, sessionKey: null }}>
    <MountProvider scope={{ area: 'main', id: owner, view }}><RunFrameBody {...props} /></MountProvider>
  </PaneProvider></RunDockProvider></TopBarProvider>
}
const RunFrameBody = ({ facts, ...props }: Props) => {
  const snapshot = useSnapshot(), owner = 'preview-run-main'
  const subject = fixedSubject(snapshot.workbench.main), intent = subject ? snapshot.workbench.frameTools[subject] : undefined
  const measured = useNarrowLayout<HTMLDivElement>(FRAME.fold.panelFloats), standing = measured.narrow === false
  const details = intent?.open && intent.tool === 'details'
  useWorkDetails(owner, <ToolBody>
    {facts && <ToolSection label="Run"><TeamRunFacts input={props.inspector.input} number={props.number} at={null} /></ToolSection>}
    <RunInspector {...props.inspector} selectedRow={props.selectedRow} inspectionOnly={Boolean(facts)} />
  </ToolBody>)
  return <div ref={measured.ref} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <TopBarOutlet owner={owner} rightColumnWidth={details && standing ? FRAME.rightPanel.width : undefined} fallback={{ place: 'Recorded Run', tools: <WorkTools />, more: () => null }} />
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div data-slot="workbench-main" className="flex min-h-0 min-w-0 flex-1"><RunWorkspace {...props} /></div>
      {details && <div data-preview-tool-placement={standing ? 'column' : 'floating'} className={standing ? 'flex min-h-0 shrink-0 flex-col overflow-hidden' : 'absolute inset-y-0 right-0 z-(--hd-z-drawer) flex min-h-0 flex-col overflow-hidden bg-background shadow-(--hd-shadow-lg)'} style={{ width: FRAME.rightPanel.width, maxWidth: '100%' }}>
        <DockPanelBody><WorkDetailsOutlet owner={owner} /></DockPanelBody>
      </div>}
    </div>
  </div>
}
