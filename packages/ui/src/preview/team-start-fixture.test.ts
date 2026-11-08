import { expect, it } from 'vitest'
import writeAndReviewSource from '../../../server/flows/fix-and-review.yml?raw'
import { EDIT_TEAM_START_POLICY } from './front-door-edit-fixture'
import { SEAT_ATTACHMENTS } from './frames-team-start'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'

/**
 * The Start frame's seats carry the host's dry-run of what an Agent declares
 * (#1582), so the frames show every line under a seat: a seed seat whose
 * declarations all load, one whose skill would not, and a seat that shows its
 * runtime's defaults — the one side that draws a defaults line.
 */
it('the Start frame’s seats cover every line under a seat', () => {
  expect(SEAT_ATTACHMENTS.all.declarations.every(one => one.problem === null)).toBe(true)
  expect(SEAT_ATTACHMENTS.wont.declarations.some(one => one.problem !== null)).toBe(true)
  expect(SEAT_ATTACHMENTS.defaults).toEqual({ skillsMode: 'runtime-defaults', mcpMode: 'runtime-defaults', declarations: [], refusal: null })
})

it('shows the shipped Write and review policy in every current New Team specimen', () => {
  // The host's team-start-fixture test holds this data to its shipped parser.
  // This suite only needs the preview data, even before the host is built.
  expect(TEAM_START_SOURCES['fix-and-review']).toBe(writeAndReviewSource)
  expect(EDIT_TEAM_START_POLICY).toBe(TEAM_START_POLICIES['fix-and-review'])
})
