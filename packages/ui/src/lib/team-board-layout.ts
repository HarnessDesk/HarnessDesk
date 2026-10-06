import type { FactColumn } from './board-facts'

/** Column geometry, measured inside the pane rather than from the window. */
export const teamBoardLayout = (
  paneWidth: number,
  contentWidth: number,
  opened: ReadonlySet<string> = new Set(),
  gap = 12,
) => {
  const folded: FactColumn[] = []
  const fits = () => (5 - folded.length) * 220 + folded.length * 44 + 4 * gap <= contentWidth
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
