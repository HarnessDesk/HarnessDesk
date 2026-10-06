import { expect, it } from 'vitest'
import { teamBoardLayout } from './team-board-layout'

it('folds Ready before To do while every open column keeps its 220px floor', () => {
  expect(teamBoardLayout(1440, 1416).folded).toEqual([])
  expect(teamBoardLayout(1000, 976).folded).toEqual(['ready'])
  expect(teamBoardLayout(900, 876).folded).toEqual(['ready', 'todo'])
  expect(teamBoardLayout(800, 776).lanes).toBe(true)
  expect(teamBoardLayout(760, 736).lanes).toBe(true)
  expect(teamBoardLayout(640, 616).folded).toEqual(['ready'])
  expect(teamBoardLayout(560, 536).compact).toBe(true)
})
it('opening a folded lane reallocates space, then uses rows if its floor will not fit', () => {
  expect(teamBoardLayout(1000, 976, new Set(['ready'])).folded).toEqual(['todo'])
  expect(teamBoardLayout(900, 876, new Set(['ready'])).lanes).toBe(true)
  expect(teamBoardLayout(640, 616, new Set(['ready'])).folded).toEqual([])
})
