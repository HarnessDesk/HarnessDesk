import { describe, expect, it } from 'vitest'

import {
  MUTE_AFTER,
  NOTICE_KINDS,
  afterDismiss,
  emptyNoticePolicy,
  isSilenced,
  noticeKind,
  offersMute,
  readNoticePolicy,
  withMuted,
  type NoticeIdentity,
} from './notice-policy'

/**
 * Four lifetimes, and the promise each one makes to whoever clicked the ×.
 *
 * The bug these replace was not that a dismissal was forgotten — it was that
 * every banner made a different promise and none of them said which. One came
 * back every five hours because its window had honestly turned over; another
 * had to be refused once per agent on the roster. So what is tested here is
 * mostly the *difference* between the lifetimes.
 */

const NOW = Date.UTC(2026, 7, 26, 12)

const pace = (window: string): NoticeIdentity => ({
  key: `usage:pace:codex:5h:${window}`,
  kind: 'usage:pace',
  lifetime: 'occurrence',
})

const offer: NoticeIdentity = { key: 'import:offer', kind: 'import:offer', lifetime: 'once' }
const link: NoticeIdentity = { key: 'link:reconnecting', kind: 'link', lifetime: 'session' }

describe('a condition', () => {
  it('stays away for the window it was dismissed in, and comes back for the next', () => {
    const policy = afterDismiss(emptyNoticePolicy(), pace('488000'), NOW)
    expect(isSilenced(policy, pace('488000'))).toBe(true)
    expect(isSilenced(policy, pace('488005'))).toBe(false)
  })

  it('offers to be silenced only once it has been put away twice', () => {
    let policy = emptyNoticePolicy()
    expect(offersMute(policy, pace('1'))).toBe(false)
    policy = afterDismiss(policy, pace('1'), NOW)
    expect(offersMute(policy, pace('2'))).toBe(false)
    policy = afterDismiss(policy, pace('2'), NOW)
    expect(policy.records['usage:pace']?.count).toBe(MUTE_AFTER)
    expect(offersMute(policy, pace('3'))).toBe(true)
  })

  it('stops offering once it has actually been silenced', () => {
    const policy = withMuted(
      { records: { 'usage:pace': { count: 5, at: NOW } }, muted: [], seen: [] },
      'usage:pace',
      true,
    )
    expect(offersMute(policy, pace('9'))).toBe(false)
    // And a window it was never dismissed in is quiet too — that is the whole
    // point of muting the kind rather than another instance.
    expect(isSilenced(policy, pace('9'))).toBe(true)
  })

  it('speaks again when the switch is turned back on', () => {
    const muted = withMuted(emptyNoticePolicy(), 'usage:pace', true)
    expect(isSilenced(withMuted(muted, 'usage:pace', false), pace('9'))).toBe(false)
  })
})

describe('an offer', () => {
  it('is answered for good by one dismissal, whatever agent asked it', () => {
    const policy = afterDismiss(emptyNoticePolicy(), offer, NOW)
    expect(policy.muted).toContain('import:offer')
    expect(isSilenced(policy, offer)).toBe(true)
    // The old flag was per runtime, so the same question came back for every
    // agent on the roster and every one registered afterwards.
    expect(isSilenced(policy, { ...offer, key: 'import:offer:cursor' })).toBe(true)
  })

  it('is never given a second door on the banner itself', () => {
    // It has already been answered for good; asking again in a menu would be
    // asking the same question twice in one click.
    const policy = { records: { 'import:offer': { count: 3, at: NOW } }, muted: [], seen: [] }
    expect(offersMute(policy, offer)).toBe(false)
  })
})

describe('something happening right now', () => {
  it('is never written down and never silenceable', () => {
    const policy = afterDismiss(emptyNoticePolicy(), link, NOW)
    expect(policy).toEqual(emptyNoticePolicy())
    expect(isSilenced(policy, link)).toBe(false)
    expect(offersMute({ records: { link: { count: 9, at: NOW } }, muted: [], seen: [] }, link)).toBe(false)
  })

  it('has no row to turn off, because a dropped link must always be able to speak', () => {
    expect(noticeKind('link')).toBeNull()
  })
})

describe('what is written down', () => {
  it('bounds the instances it remembers', () => {
    let policy = emptyNoticePolicy()
    for (let n = 0; n < 60; n += 1) policy = afterDismiss(policy, pace(String(n)), NOW)
    expect(policy.seen.length).toBe(40)
    // The newest survive: the oldest windows stopped being true long ago.
    expect(isSilenced(policy, pace('59'))).toBe(true)
    expect(isSilenced(policy, pace('0'))).toBe(false)
  })

  it('does not grow an entry for putting the same instance away twice', () => {
    const once = afterDismiss(emptyNoticePolicy(), pace('1'), NOW)
    expect(afterDismiss(once, pace('1'), NOW).seen).toEqual(once.seen)
  })

  it('reads back a file someone has edited by hand', () => {
    expect(readNoticePolicy(undefined)).toEqual(emptyNoticePolicy())
    expect(readNoticePolicy('muted')).toEqual(emptyNoticePolicy())
    expect(
      readNoticePolicy({
        muted: ['usage:pace', 7],
        seen: ['a', null],
        records: { 'usage:pace': { count: 2, at: NOW }, bad: { count: 'x' }, worse: null },
      }),
    ).toEqual({
      muted: ['usage:pace'],
      seen: ['a'],
      records: { 'usage:pace': { count: 2, at: NOW } },
    })
  })
})

describe('the settings page', () => {
  it('can name every kind a banner claims, so nothing is silenced anonymously', () => {
    // A kind with no entry here can still be dismissed but never muted, and
    // the escalation checks the same list — so a typo in a banner's kind
    // would quietly cost it its "stop showing this" rather than crash.
    for (const entry of NOTICE_KINDS) {
      expect(noticeKind(entry.kind)).toEqual(entry)
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.detail.length).toBeGreaterThan(0)
    }
    expect(new Set(NOTICE_KINDS.map((entry) => entry.kind)).size).toBe(NOTICE_KINDS.length)
  })
})
