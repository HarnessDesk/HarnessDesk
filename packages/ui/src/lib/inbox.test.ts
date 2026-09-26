import { describe, expect, it } from 'vitest'

import { INBOX_LIMIT, kept, markedRead, readInbox, unreadCount } from './inbox'

const entry = (id: string, at = 1) => ({ id, tone: 'info' as const, title: `Message ${id}`, at })

describe('the inbox', () => {
  it('keeps newest first, and a message kept again replaces its copy unread', () => {
    const one = kept([], entry('a'))
    const two = kept(markedRead(one, 'a'), entry('b'))
    expect(two.map((message) => message.id)).toEqual(['b', 'a'])
    const again = kept(two, entry('a', 5))
    expect(again.map((message) => message.id)).toEqual(['a', 'b'])
    expect(again[0]?.read).toBe(false)
    expect(unreadCount(again)).toBe(2)
  })

  it('marks one read, or all of them', () => {
    const inbox = kept(kept([], entry('a')), entry('b'))
    expect(unreadCount(markedRead(inbox, 'a'))).toBe(1)
    expect(unreadCount(markedRead(inbox, null))).toBe(0)
  })

  it('holds at most its limit, dropping the oldest', () => {
    let inbox = readInbox([])
    for (let index = 0; index < INBOX_LIMIT + 5; index += 1) inbox = kept(inbox, entry(String(index)))
    expect(inbox).toHaveLength(INBOX_LIMIT)
    expect(inbox[0]?.id).toBe(String(INBOX_LIMIT + 4))
  })

  it('reads back only what has the shape of a kept message', () => {
    const read = readInbox([entry('ok'), { id: 'no-title', at: 1 }, null, { ...entry('toned'), tone: 'loud', read: true, open: 'settings:library' }])
    expect(read.map((message) => message.id)).toEqual(['ok', 'toned'])
    expect(read[1]).toMatchObject({ tone: 'neutral', read: true, open: 'settings:library' })
    expect(readInbox('nope')).toEqual([])
  })
})
