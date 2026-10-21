import { expect, it } from 'vitest'
import { parseFlowPolicy } from '../../../server/dist/src/flow-policy.js'
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
  const parsed = parseFlowPolicy(TEAM_START_SOURCES['fix-and-review']!)
  expect(parsed.problems).toEqual([])
  expect(parsed.document?.format).toBe('agents')
  if (parsed.document?.format !== 'agents') throw new Error('Expected a current policy')
  expect(TEAM_START_POLICIES['fix-and-review']).toEqual(parsed.document.flow)
  expect(EDIT_TEAM_START_POLICY).toEqual(parsed.document.flow)
})
