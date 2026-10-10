import { TopBarOutlet, useRegisteredOwner } from './top-bar'
import { findPane } from '../state/layout'
import { tileBrowserWorkbench } from '../lib/browser-tiles'
import { rightPanelDrawn, rightPanelOverlays } from '../state/workbench'
import { PaneProvider, useSnapshot } from '../state/context'
export const WorkTopBar = () => {
  const snapshot = useSnapshot()
  const pane = findPane(snapshot.layout, snapshot.layout.focused)
  const registered = useRegisteredOwner(pane?.id ?? '')
  if (!pane || !registered) return null
  const scope = { paneId: pane.id, view: pane.view, sessionKey: pane.view.kind === 'conversation' ? pane.view.session : null }
  const drawn = tileBrowserWorkbench(snapshot)
  const rightColumnWidth = rightPanelDrawn(drawn) && !rightPanelOverlays(drawn, snapshot.windowWidth) ? 'var(--frame-right)' : undefined
  return <PaneProvider scope={scope}><TopBarOutlet owner={pane.id}
    rightColumnWidth={rightColumnWidth} fallback={{ place: 'New session', more: () => null }} /></PaneProvider>
}
