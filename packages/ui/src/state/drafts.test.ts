import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionKey } from '@harnessdesk/protocol'

import { Drafts, draftsOf, UNSCOPED_RECOVERY_KEY } from './drafts'

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

  it('does not let a late refusal recreate drafts for a deleted conversation', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'being sent', attachments: [] })
    drafts.forget(a)

    const late = drafts.addRecoverable(a, {
      text: 'being sent',
      attachments: [],
      detail: 'Restore it.',
    })

    expect(late).toBeNull()
    expect(drafts.live(a)).toBeNull()
    expect(drafts.recoverable(a)).toEqual([])
    expect(new Drafts().recoverable(a)).toEqual([])
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

describe('draft reload storage', () => {
  const storageKey = 'harnessdesk:drafts:v1'

  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes the newest live and recoverable drafts on pagehide', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'newest', attachments: [] })
    drafts.addRecoverable(a, { text: 'refused', attachments: [], detail: 'Restore it.' })
    window.dispatchEvent(new Event('pagehide'))

    const restored = new Drafts()
    expect(restored.live(a)?.text).toBe('newest')
    expect(restored.recoverable(a)[0]?.text).toBe('refused')
  })

  it('removes restored and emptied drafts synchronously before a fresh store reads', () => {
    const drafts = new Drafts()
    const entry = drafts.addRecoverable(a, { text: 'refused', attachments: [], detail: 'Restore it.' })
    drafts.restore(a, entry!.id)
    const afterRestore = new Drafts()
    expect(afterRestore.recoverable(a)).toEqual([])

    drafts.setLive(a, { text: '', attachments: [] })
    const afterSend = new Drafts()
    expect(afterSend.live(a)).toBeNull()
  })

  it('swaps the restored entry with the current live draft', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'typed meanwhile', attachments: [] })
    const entry = drafts.addRecoverable(a, { text: 'failed send', attachments: [], detail: 'Restore it.' })
    const restored = drafts.restore(a, entry!.id)
    expect(restored?.text).toBe('failed send')
    expect(drafts.live(a)?.text).toBe('failed send')
    expect(drafts.recoverable(a).map((item) => item.text)).toEqual(['typed meanwhile'])
  })

  it('restores an unscoped recovery into another conversation and persists its displaced draft', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'newer', attachments: [{ id: 'file', kind: 'file', name: 'new.md', path: '/repo/new.md' }] })
    const entry = drafts.addRecoverable(UNSCOPED_RECOVERY_KEY, { text: 'old', attachments: [], detail: 'Restore it.' })!
    drafts.restore(UNSCOPED_RECOVERY_KEY, entry.id, { key: a, draft: drafts.live(a) })
    const reloaded = new Drafts()
    expect(reloaded.live(a)?.text).toBe('old')
    expect(reloaded.live(UNSCOPED_RECOVERY_KEY)).toBeNull()
    const displaced = reloaded.recoverable(a)[0]!
    expect(displaced.text).toBe('newer')
    expect(displaced.attachments[0]?.name).toBe('new.md')
    expect(reloaded.restore(a, displaced.id)?.text).toBe('newer')
    expect(reloaded.recoverable(a).map((draft) => draft.text)).toEqual(['old'])
  })

  it('saves a fresh composer draft on Restore without creating a phantom live owner', () => {
    const drafts = new Drafts()
    const entry = drafts.addRecoverable(UNSCOPED_RECOVERY_KEY, { text: 'old', attachments: [], detail: 'Restore it.' })!
    drafts.restore(UNSCOPED_RECOVERY_KEY, entry.id, { key: null, draft: {
      text: 'newer', attachments: [{ id: 'file', kind: 'file', name: 'new.md', path: '/repo/new.md' }],
    } })
    const reloaded = new Drafts()
    expect(reloaded.live(UNSCOPED_RECOVERY_KEY)).toBeNull()
    expect(reloaded.recoverable(UNSCOPED_RECOVERY_KEY)[0]?.text).toBe('newer')
    expect(reloaded.recoverable(UNSCOPED_RECOVERY_KEY)[0]?.attachments[0]?.name).toBe('new.md')
  })

  it('mirrors text and path chips but never image data URLs', () => {
    const drafts = new Drafts()
    const imagePath = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`
    drafts.setLive(a, {
      text: 'keep this text',
      attachments: [
        { id: 'file', name: 'a.ts', path: '/repo/a.ts', kind: 'file' },
        { id: 'image', name: 'paste.png', path: imagePath, kind: 'image' },
      ],
    })
    drafts.addRecoverable(a, {
      text: 'refused text',
      attachments: [{ id: 'image', name: 'paste.png', path: imagePath, kind: 'image' }],
      detail: 'Restore the refused message.',
    })
    vi.advanceTimersByTime(300)
    const raw = sessionStorage.getItem(storageKey) ?? ''
    expect(raw).toContain('keep this text')
    expect(raw).toContain('/repo/a.ts')
    expect(raw).not.toContain('data:image')
    const restored = new Drafts()
    expect(restored.live(a)?.attachments.map((item) => item.kind)).toEqual(['file'])
    expect(restored.recoverable(a)[0]?.detail).toContain('Images are not kept across a reload.')
    expect(restored.recoverable(a)[0]?.attachments).toEqual([])
  })

  it('keeps a visible warning when a restored image is omitted from the reload mirror', () => {
    const drafts = new Drafts()
    const imagePath = 'data:image/png;base64,abc123'
    const entry = drafts.addRecoverable(a, {
      text: 'send this with the image',
      attachments: [{ name: 'paste.png', path: imagePath, kind: 'image' }],
      detail: 'Restore the refused message.',
    })

    const restored = drafts.restore(a, entry!.id)
    const afterReload = new Drafts()

    expect(restored?.imagesWillBeLostOnReload).toBe(true)
    expect(afterReload.live(a)?.attachments).toEqual([])
    expect(afterReload.live(a)?.imagesWillBeLostOnReload).toBe(true)
  })

  it('removes stale stored data and reports memory-only when storage still throws', () => {
    const memory = new Map<string, string>([[storageKey, '{"stale":true}']])
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 40) throw new Error('quota')
        memory.set(key, value)
      },
      removeItem: (key: string) => { memory.delete(key) },
    }
    const drafts = new Drafts(storage)
    drafts.addRecoverable(a, { text: 'a sufficiently large draft that cannot fit', attachments: [], detail: 'Restore it.' })
    window.dispatchEvent(new Event('pagehide'))
    expect(memory.has(storageKey)).toBe(false)
    expect(drafts.recoverable(a)[0]?.detail).toContain('Not saved for a reload — it stays only while this window is open.')
  })

  it('flushes on visibilitychange when the document becomes hidden', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'hidden latest', attachments: [] })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(new Drafts().live(a)?.text).toBe('hidden latest')
  })
})

describe('a refused message in its conversation', () => {
  it('keeps the refusal beside the live draft so Restore can swap them', () => {
    const drafts = new Drafts()
    drafts.setLive(a, { text: 'typed since', attachments: [] })
    drafts.putBack(a, { text: 'the failed one', attachments: [{ id: '1', name: 'a.ts', path: '/a.ts', kind: 'file' }] })
    expect(drafts.live(a)?.text).toBe('typed since')
    expect(drafts.recoverable(a)).toHaveLength(1)
    const restored = drafts.restore(a, drafts.recoverable(a)[0]!.id)
    expect(restored?.text).toBe('the failed one')
    expect(drafts.recoverable(a).map((item) => item.text)).toEqual(['typed since'])
  })
})
