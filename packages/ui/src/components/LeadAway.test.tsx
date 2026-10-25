import { describe, expect, it } from 'vitest'
import { leadSceneProjection } from '../preview/lead-fixture'
import type { LeadState } from '../state/lead'
import { LEAD_AWAY_MS, leadAwayDigest } from './LeadAway'

const stateOf = (scene: Parameters<typeof leadSceneProjection>[0]): LeadState => {
  const projection = leadSceneProjection(scene)
  return { personActions: projection.personActions ?? [], revision: projection.revision, thread: projection.thread, settings: projection.settings,
    requestInFlight: projection.requestInFlight, wayOut: projection.wayOut, waitReason: projection.waitReason, planConsentExpiresAt: projection.planConsentExpiresAt,
    progress: projection.progress ?? null, team: projection.team ?? null, presence: projection.presence ?? null, steers: projection.steers ?? null, error: null }
}

describe('the away digest', () => {
  it('sums up an absence as one finding, caveat and ask', () => {
    const state = { ...stateOf('running'), presence: null }, now = 10 * 60 * 60_000
    const digest = leadAwayDigest({ at: now - 2 * 60 * 60_000, revision: 0, spent: 0 }, state, 'Dex', now)!
    expect(digest.title).toMatch(/^While you were away · \d\d:\d\d–\d\d:\d\d/)
    expect(digest.report.finding).toContain('Dex wrote')
    expect(digest.report.caveat).toContain('could not verify')
    expect(digest.report.ask).toBeTruthy()
  })
  it('says nothing after a short glance away or when nothing changed', () => {
    const state = stateOf('running'), now = 10 * 60 * 60_000
    expect(leadAwayDigest({ at: now - LEAD_AWAY_MS + 1, revision: 0, spent: 0 }, state, 'Dex', now)).toBeNull()
    expect(leadAwayDigest({ at: 0, revision: state.revision, spent: 0 }, state, 'Dex', now)).toBeNull()
  })
})
