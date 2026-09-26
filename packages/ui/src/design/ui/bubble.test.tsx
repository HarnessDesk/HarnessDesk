import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { Bubble, BubbleContent, bubbleVariants } from './bubble'

/**
 * The surface a message's words stand on: a filled plate sized to its own
 * content, or no frame at all across the full row.
 */

describe('Bubble', () => {
  it('caps the current person’s own words at two thirds of the column', () => {
    const secondary = bubbleVariants({ variant: 'secondary' })
    expect(secondary).toContain('max-w-[66.6667%]')
    expect(secondary).toContain('items-start')
    expect(secondary).toContain('bg-(--hd-muted)')
    expect(secondary).toContain('rounded-(--hd-radius-xl)')
  })

  it('drops the cap and stretches its content for an unframed answer', () => {
    const ghost = bubbleVariants({ variant: 'ghost' })
    expect(ghost).toContain('w-full')
    expect(ghost).toContain('items-stretch')
    expect(ghost).not.toContain('max-w-')
    expect(ghost).not.toContain('bg-(--hd-muted)')
  })

  it('names its own variant as data', () => {
    const markup = renderToStaticMarkup(<Bubble variant="ghost">hi</Bubble>)
    expect(markup).toContain('data-slot="bubble"')
    expect(markup).toContain('data-variant="ghost"')
  })
})

describe('BubbleContent', () => {
  it('keeps a sent message’s own line breaks, unlike a rendered answer', () => {
    const markup = renderToStaticMarkup(<BubbleContent variant="secondary">a\nb</BubbleContent>)
    expect(markup).toContain('whitespace-pre-wrap')
    const ghostMarkup = renderToStaticMarkup(<BubbleContent variant="ghost">a</BubbleContent>)
    expect(ghostMarkup).not.toContain('whitespace-pre-wrap')
  })

  it('clamps to a line count until told it is expanded', () => {
    const clamped = renderToStaticMarkup(<BubbleContent clampLines={12}>long</BubbleContent>)
    expect(clamped).toContain('overflow-hidden')
    expect(clamped).toContain('calc(var(--hd-line) * 12)')

    const open = renderToStaticMarkup(<BubbleContent clampLines={12} expanded>long</BubbleContent>)
    expect(open).not.toContain('overflow-hidden')
    expect(open).not.toContain('max-height')
  })

  it('clamps to a fixed pixel height for the room’s own measure', () => {
    const clamped = renderToStaticMarkup(<BubbleContent clampHeight={192}>long</BubbleContent>)
    expect(clamped).toContain('max-height:192px')
  })
})
