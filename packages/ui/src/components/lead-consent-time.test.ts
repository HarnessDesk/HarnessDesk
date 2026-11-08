import { describe, expect, it } from 'vitest'
import { formatLeadConsentTime } from './lead-consent-time'

const NOON = new Date('2026-08-22T12:00:00').getTime()
describe('Lead consent expiry', () => {
  it('prints minutes today and the calendar date otherwise', () => {
    expect(formatLeadConsentTime(NOON + 3_600_000, NOON)).toBe('1:00 PM')
    expect(formatLeadConsentTime(NOON + 2 * 86_400_000, NOON)).toBe('Aug 24 12:00 PM')
  })
  it('includes a different year and preserves absent expiry', () => {
    expect(formatLeadConsentTime(new Date('2025-08-22T13:00:00').getTime(), NOON)).toBe('Aug 22, 2025 1:00 PM')
    expect(formatLeadConsentTime(null, NOON)).toBeNull()
  })
})
