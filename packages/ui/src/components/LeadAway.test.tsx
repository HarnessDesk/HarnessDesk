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
  it('sums up an absence in four lines', () => {
    const state = stateOf('running'), now = 10 * 60 * 60_000
    const digest = leadAwayDigest({ at: now - 2 * 60 * 60_000, revision: 0, spent: 0 }, state, 'Dex', now)!
    expect(digest.title).toMatch(/^While you were away · \d\d:\d\d–\d\d:\d\d/)
    expect(digest.lines).toHaveLength(4)
    expect(digest.lines[0]).toMatch(/^Dex wrote \d+ message/)
    expect(digest.lines[1]).toMatch(/^Step 1 of /)
    expect(digest.lines[3]).toMatch(/spent while away$/)
  })
  it('says nothing after a short glance away or when nothing changed', () => {
    const state = stateOf('running'), now = 10 * 60 * 60_000
    expect(leadAwayDigest({ at: now - LEAD_AWAY_MS + 1, revision: 0, spent: 0 }, state, 'Dex', now)).toBeNull()
    expect(leadAwayDigest({ at: 0, revision: state.revision, spent: 0 }, state, 'Dex', now)).toBeNull()
  })
})
