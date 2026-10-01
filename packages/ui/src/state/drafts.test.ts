import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionKey } from '@harnessdesk/protocol'

import { DRAFT_STORAGE_PREFIX, Drafts, draftsOf } from './drafts'

const a = 'codex\u0000a' as SessionKey
const b = 'claude\u0000b' as SessionKey

const memoryStorage = (): Storage => {
  const held = new Map<string, string>()
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, String(value)),
    removeItem: (key) => void held.delete(key),
    clear: () => held.clear(),
    key: (index) => [...held.keys()][index] ?? null,
    get length() {
      return held.size
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('the live draft a conversation keeps', () => {
  it('holds each conversation’s words apart, and forgets an emptied one', () => {
    const drafts = new Drafts(null)
    drafts.setLive(a, { text: 'half a sentence', attachments: [] })
    drafts.setLive(b, { text: 'another', attachments: [] })
    expect(drafts.live(a)?.text).toBe('half a sentence')
    expect(drafts.live(b)?.text).toBe('another')
    drafts.setLive(a, { text: '   ', attachments: [] })
    expect(drafts.live(a)).toBeNull()
  })

  it('keeps a draft that is only chips', () => {
    const drafts = new Drafts(null)
    drafts.setLive(a, { text: '', attachments: [{ id: '1', name: 'a.ts', path: '/repo/a.ts', kind: 'file' }] })
    expect(drafts.live(a)?.attachments).toHaveLength(1)
  })

  it('mirrors to storage after a pause, so a reload reads it back', () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const drafts = new Drafts(storage)
    drafts.setLive(a, { text: 'mid-sente', attachments: [] })
    drafts.setLive(a, { text: 'mid-sentence', attachments: [] })
    expect(storage.getItem(DRAFT_STORAGE_PREFIX + a)).toBeNull()
    vi.advanceTimersByTime(300)
    expect(JSON.parse(storage.getItem(DRAFT_STORAGE_PREFIX + a)!).text).toBe('mid-sentence')
    // A new window's store reads it back.
    expect(new Drafts(storage).live(a)?.text).toBe('mid-sentence')
    // Sent: the mirror goes too.
    drafts.setLive(a, { text: '', attachments: [] })
    drafts.flush()
    expect(storage.getItem(DRAFT_STORAGE_PREFIX + a)).toBeNull()
  })

  it('ignores a mirrored record of the wrong shape, and survives storage that throws', () => {
    const storage = memoryStorage()
    storage.setItem(DRAFT_STORAGE_PREFIX + a, '{not json')
    storage.setItem(DRAFT_STORAGE_PREFIX + b, JSON.stringify({ text: 7 }))
    expect(new Drafts(storage).live(a)).toBeNull()
    expect(new Drafts(storage).live(b)).toBeNull()
    const broken = { ...memoryStorage(), getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') } } as Storage
    const drafts = new Drafts(broken)
    drafts.setLive(a, { text: 'still here', attachments: [] })
    drafts.flush()
    expect(drafts.live(a)?.text).toBe('still here')
  })

  it('forgets a conversation outright, mirror included', () => {
    const storage = memoryStorage()
    const drafts = new Drafts(storage)
    drafts.setLive(a, { text: 'gone soon', attachments: [] })
    drafts.flush()
    drafts.forget(a)
    expect(drafts.live(a)).toBeNull()
    expect(storage.getItem(DRAFT_STORAGE_PREFIX + a)).toBeNull()
  })

  it('gives a store without its own drafts one in memory, never shared with another store', () => {
    const one = {}
    const two = {}
    draftsOf(one).setLive(a, { text: 'only here', attachments: [] })
    expect(draftsOf(one).live(a)?.text).toBe('only here')
    expect(draftsOf(two).live(a)).toBeNull()
    const own = new Drafts(null)
    expect(draftsOf({ drafts: own })).toBe(own)
  })
})
