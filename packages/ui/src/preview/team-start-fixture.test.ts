import { expect, it } from 'vitest'
import { parseFlowPolicy } from '../../../server/dist/src/flow-policy.js'
import { EDIT_TEAM_START_POLICY } from './front-door-edit-fixture'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'

it('shows the shipped Write and review policy in every current New Team specimen', () => {
  const parsed = parseFlowPolicy(TEAM_START_SOURCES['fix-and-review']!)
  expect(parsed.problems).toEqual([])
  expect(parsed.document?.format).toBe('agents')
  if (parsed.document?.format !== 'agents') throw new Error('Expected a current policy')
  expect(TEAM_START_POLICIES['fix-and-review']).toEqual(parsed.document.flow)
  expect(EDIT_TEAM_START_POLICY).toEqual(parsed.document.flow)
})
