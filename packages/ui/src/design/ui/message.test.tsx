import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { Message, MessageFooter, messageFooterVariants, messageVariants } from './message'

/**
 * The chat message row: which side it stands on, and the one meta line under
 * it that the transcript and the room's channel both read from.
 */

describe('Message', () => {
  it('defaults to the far side of the conversation', () => {
    expect(messageVariants({})).toContain('items-start')
    expect(messageVariants({ align: 'start' })).toContain('items-start')
    expect(messageVariants({ align: 'end' })).toContain('items-end')
  })

  it('stamps its own alignment as data, for a screen or a test to read', () => {
    const markup = renderToStaticMarkup(<Message align="end">hi</Message>)
    expect(markup).toContain('data-slot="message"')
    expect(markup).toContain('data-align="end"')
  })

  it('a caller’s className overrides the box without losing the slot', () => {
    const markup = renderToStaticMarkup(<Message align="start" className="block min-w-0" />)
    expect(markup).toContain('data-slot="message"')
    expect(markup).toMatch(/class="[^"]*\bblock\b/)
  })

  it('carries no rhythm of its own until asked, whichever side it aligns to', () => {
    expect(messageVariants({ align: 'end' })).not.toMatch(/py-/)
    expect(messageVariants({ align: 'start' })).not.toMatch(/py-/)
  })

  it('gives the transcript’s own rhythm — 12px above a sent message, 4px below; 6px each way for an answer', () => {
    const sent = messageVariants({ align: 'end', rhythm: 'transcript' })
    expect(sent).toContain('py-(--hd-space-3)')
    expect(sent).toContain('pb-(--hd-space-1)')
    const answer = messageVariants({ align: 'start', rhythm: 'transcript' })
    expect(answer).toContain('py-(--hd-space-1-5)')
    expect(answer).not.toContain('py-(--hd-space-3)')
  })

  it('stamps no data-rhythm without the option — align alone never implies it', () => {
    const markup = renderToStaticMarkup(<Message align="end">hi</Message>)
    expect(markup).not.toMatch(/py-\(--hd-space-3\)/)
  })
})

describe('MessageFooter', () => {
  it('spans the row on the far side, and sizes to its content on the near one', () => {
    expect(messageFooterVariants({ align: 'start' })).toContain('w-full')
    expect(messageFooterVariants({ align: 'end' })).not.toContain('w-full')
  })

  it('reads as the meta line every screen inherits from', () => {
    const base = messageFooterVariants({})
    expect(base).toContain('text-xs')
    expect(base).toContain('text-(--hd-muted-foreground)')
    expect(base).toContain('tabular-nums')
  })

  it('renders its own slot', () => {
    const markup = renderToStaticMarkup(<MessageFooter align="end">10:41 AM</MessageFooter>)
    expect(markup).toContain('data-slot="message-footer"')
    expect(markup).toContain('10:41 AM')
  })
})
