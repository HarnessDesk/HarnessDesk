import { expect, it } from 'vitest'
import { doingLine, teamOverview } from './team-overview'
import { doingLine as sharedDoingLine, teamOverview as sharedOverview } from '@harnessdesk/client/views'

it('keeps the window on the shared overview functions', () => {
  expect(teamOverview).toBe(sharedOverview)
  expect(doingLine).toBe(sharedDoingLine)
})
