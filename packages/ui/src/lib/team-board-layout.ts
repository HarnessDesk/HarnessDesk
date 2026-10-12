/** The Team board changes to its compact list only when the pane is too narrow to read columns. */
export const teamBoardLayout = (paneWidth: number) => ({ compact: paneWidth > 0 && paneWidth < 600 })
