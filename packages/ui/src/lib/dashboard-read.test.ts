import { expect, test } from 'vitest'
import { dashboardReadLabel } from './dashboard-read'

test('a reading kept from before this window says when it was read, as the phone does', () => {
  const opened = new Date(2026, 10, 11, 4, 0).getTime()
  expect(dashboardReadLabel(new Date(2026, 10, 3, 9, 30).getTime(), opened + 60_000, opened)).toBe('From a cached read · Nov 3')
  expect(dashboardReadLabel(new Date(2026, 10, 11, 1, 5).getTime(), opened + 60_000, opened)).toMatch(/^From a cached read · 1:05\sAM$/)
  expect(dashboardReadLabel(opened + 1000, opened + 121_000, opened)).toBe('Read 2m ago')
})
