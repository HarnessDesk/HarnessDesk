import { describe, expect, it, vi } from 'vitest'

import type { SessionKey } from '@harnessdesk/protocol'

import { Drafts, draftsOf } from './drafts'

const a = 'codex\u0000a' as SessionKey
const b = 'claude\u0000b' as SessionKey

describe('the live draft a conversation keeps', () => {
  it('holds each conversation’s words apart, and forgets an emptied one', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'half a sentence', attachments: [] })
    drafts.setLive(b, { text: 'another', attachments: [] })
    expect(drafts.live(a)?.text).toBe('half a sentence')
    expect(drafts.live(b)?.text).toBe('another')
    drafts.setLive(a, { text: '   ', attachments: [] })
    expect(drafts.live(a)).toBeNull()
  })

  it('keeps a draft that is only chips', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: '', attachments: [{ id: '1', name: 'a.ts', path: '/repo/a.ts', kind: 'file' }] })
    expect(drafts.live(a)?.attachments).toHaveLength(1)
  })

  it('forgets a conversation outright', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'gone soon', attachments: [] })
    drafts.forget(a)
    expect(drafts.live(a)).toBeNull()
  })

  it('gives a store without its own drafts one of its own, never shared with another store', () => {
    const one = {}
    const two = {}
    draftsOf(one).setLive(a, { text: 'only here', attachments: [] })
    expect(draftsOf(one).live(a)?.text).toBe('only here')
    expect(draftsOf(two).live(a)).toBeNull()
    const own = new Drafts()
    expect(draftsOf({ drafts: own })).toBe(own)
  })
})

describe('a message put back into its conversation', () => {
  it('keeps what was typed there since, field by field, and tells whoever is drawing it', () => {
    const drafts = new Drafts()
    const heard = vi.fn()
    const stop = drafts.onPutBack(a, heard)
    drafts.setLive(a, { text: 'typed since', attachments: [] })
    drafts.putBack(a, { text: 'the failed one', attachments: [{ id: '1', name: 'a.ts', path: '/a.ts', kind: 'file' }] })
    expect(drafts.live(a)?.text).toBe('typed since')
    expect(drafts.live(a)?.attachments).toHaveLength(1)
    expect(heard).toHaveBeenCalledWith(drafts.live(a))
    stop()
    drafts.putBack(a, { text: 'again', attachments: [] })
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
