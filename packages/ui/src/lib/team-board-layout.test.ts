import { expect, it } from 'vitest'
import { teamBoardLayout } from './team-board-layout'

it('keeps the board at readable pane widths and switches to the compact list below 600px', () => {
  expect(teamBoardLayout(1280)).toEqual({ compact: false })
  expect(teamBoardLayout(720)).toEqual({ compact: false })
  expect(teamBoardLayout(599)).toEqual({ compact: true })
  expect(teamBoardLayout(560)).toEqual({ compact: true })
})
