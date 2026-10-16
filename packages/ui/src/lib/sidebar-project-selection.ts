import { sessionKey, type SessionSummary, type TeamState } from '@harnessdesk/protocol'
import { panes, type LayoutNode } from '../state/layout'

type ProjectRow =
  | { readonly kind: 'room'; readonly room: Pick<TeamState, 'id'> }
  | { readonly kind: 'session'; readonly summary: Pick<SessionSummary, 'runtime' | 'id'> }

/** The focused conversation (or its Team) wins over another visible Team pane. */
export const selectedProjectRowIndex = (
  rows: readonly ProjectRow[],
  activeKey: string | null,
  activeTeamId: string | null,
  root: LayoutNode,
): number => {
  const active = rows.findIndex(row => row.kind === 'room' ? row.room.id === activeTeamId
    : String(sessionKey(row.summary.runtime, row.summary.id)) === activeKey)
  if (active >= 0) return active
  const visible = panes(root)
  return rows.findIndex(row => row.kind === 'room'
    && visible.some(pane => pane.view.kind === 'room' && pane.view.room === row.room.id))
}
