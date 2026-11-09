import type { SessionKey } from '@harnessdesk/protocol'
import { panes, sessionOf } from './layout'
import type { AppSnapshot } from './snapshot'
import { visibleViews } from './workbench'

/** Every conversation actually on screen, regardless of which pane has focus. */
export const sessionVisible = (snapshot: Pick<AppSnapshot, 'layout' | 'workbench' | 'adjacentSession'>, key: SessionKey): boolean => {
  if (snapshot.workbench.navigation.current.kind !== 'work') return false
  const { zoom } = snapshot.workbench
  const areaVisible = (area: 'main' | 'sidebar' | 'right' | 'bottom') => !zoom || zoom.area === area || (zoom.scope === 'content' && area === 'sidebar')
  return (areaVisible('right') && snapshot.adjacentSession?.key === key) ||
    (areaVisible('main') && panes(snapshot.layout.root).some(pane => (snapshot.layout.expanded === null || snapshot.layout.expanded === pane.id) && sessionOf(pane) === key)) ||
    (['sidebar', 'right', 'bottom'] as const).some(area => areaVisible(area) && !snapshot.workbench[area].collapsed &&
      visibleViews(snapshot.workbench[area]).some(({ view }) => view.kind === 'conversation' && view.session === key))
}
