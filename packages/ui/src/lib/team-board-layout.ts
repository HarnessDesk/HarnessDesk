import type { FactColumn } from './board-facts'
import { BOARD_COLUMN_MIN_WIDTH, BOARD_RAIL_WIDTH } from '../design'

/** Column geometry, measured inside the pane rather than from the window. */
export const teamBoardLayout = (
  paneWidth: number,
  contentWidth: number,
  opened: ReadonlySet<string> = new Set(),
  gap = 12,
) => {
  const folded: FactColumn[] = []
  const fits = () => (5 - folded.length) * BOARD_COLUMN_MIN_WIDTH + folded.length * BOARD_RAIL_WIDTH + 4 * gap <= contentWidth
  for (const column of ['ready', 'todo'] as const) {
    if (fits()) break
    if (!opened.has(column)) folded.push(column)
  }
  const lanes = paneWidth < 760 || !fits()
  return {
    compact: paneWidth > 0 && paneWidth < 600,
    lanes,
    folded: lanes ? (opened.has('ready') ? [] : ['ready'] as FactColumn[]) : folded,
  }
}
