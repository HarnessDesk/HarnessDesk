import { describe, expect, it } from 'vitest'

import {
  ANNOTATE_ALIVE,
  ANNOTATE_SOURCE,
  annotateCall,
  annotationContext,
  annotationSummary,
  readAnnotations,
  type PageAnnotation,
} from './annotate'

const page = { title: 'Example Domain', url: 'https://example.com/' }

const comment = (over: Partial<PageAnnotation> = {}): PageAnnotation => ({
  n: 1,
  kind: 'element',
  comment: 'make this heading larger',
  target: 'Example Domain',
  selector: 'body > div > h1',
  rect: { x: 560, y: 114, width: 200, height: 32 },
  viewport: { width: 720, height: 800 },
  ...over,
})

describe('the block that travels with the picture', () => {
  it('says what was pointed at, where it is, and what was said about it', () => {
    const text = annotationContext(page, [comment()])
    expect(text).toContain('# Page annotations:')
    expect(text).toContain('Page URL: https://example.com/')
    expect(text).toContain('## Comment 1')
    expect(text).toContain('Target: "Example Domain"')
    expect(text).toContain('Target selector: body > div > h1')
    expect(text).toContain('Node position: (560, 114) in 720x800 viewport')
    expect(text).toContain('make this heading larger')
  })

  it('numbers a region and a drawing as themselves', () => {
    const text = annotationContext(page, [
      comment({ n: 1 }),
      comment({ n: 2, kind: 'region', target: undefined, selector: undefined, comment: 'too tight' }),
      comment({ n: 3, kind: 'drawing', target: undefined, selector: undefined, comment: '', strokes: 4 }),
    ])
    expect(text).toContain('## Comment 2')
    expect(text).toContain('Region: 200 × 32 at (560, 114)')
    expect(text).toContain('## Drawing 3')
    expect(text).toContain('Freehand marks: 4 strokes')
    // A mark can speak for itself; an empty "Comment:" heading would only
    // promise a sentence that is not there.
    expect(text).not.toContain('Comment:\n\n')
  })

  it('says the picture is missing rather than pretending it is attached', () => {
    const text = annotationContext(page, [comment()], { withImage: false })
    expect(text).toContain('this agent takes no images')
    expect(text).not.toContain('The attached image')
  })

  it('counts the marks the way the notice reads them', () => {
    expect(annotationSummary([comment()])).toBe('1 comment')
    expect(annotationSummary([comment(), comment({ n: 2 })])).toBe('2 comments')
    expect(annotationSummary([comment(), comment({ n: 2, kind: 'drawing' })])).toBe('1 comment and 1 drawing')
  })
})

describe('the overlay, as source', () => {
  it('installs itself in a document, and answers before anything is marked', () => {
    // The real risk in shipping a function as its own text is that it stops
    // being one: this evaluates the actual string the pane injects.
    const value = window.eval(ANNOTATE_SOURCE) as unknown
    expect(value).toBe(true)
    expect(window.eval(ANNOTATE_ALIVE)).toBe(true)
    expect(window.eval(annotateCall('list'))).toEqual([])
    // A second injection is a restart, not a second overlay: the three
    // layers it puts on the body stay three.
    window.eval(ANNOTATE_SOURCE)
    const layers = [...document.body.children].filter((node) => node.hasAttribute('data-hd-annotate'))
    expect(layers.length).toBe(3)
  })

  it('switches tool, clears, and comes down again', () => {
    window.eval(ANNOTATE_SOURCE)
    expect(() => window.eval(annotateCall('setMode', 'draw'))).not.toThrow()
    expect(() => window.eval(annotateCall('clear'))).not.toThrow()
    window.eval(annotateCall('stop'))
    expect(window.eval(ANNOTATE_ALIVE)).toBe(false)
  })

  it('reaches for nothing this module holds', () => {
    // It is stringified, so anything it did not bring with it is a reference
    // to nothing once it lands in the guest.
    for (const name of ['ANNOTATION_LABEL', 'annotationContext', 'annotationSummary', 'place', 'lines']) {
      expect(ANNOTATE_SOURCE).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  })
})

describe('what came back from the page', () => {
  it('keeps a well-formed list exactly, order and all', () => {
    const list = [comment({ n: 1 }), comment({ n: 2, kind: 'drawing', comment: '', strokes: 3 })]
    expect(readAnnotations(list)).toEqual(list)
  })

  it('is not a list, is not annotations', () => {
    expect(readAnnotations(null)).toEqual([])
    expect(readAnnotations('The page says hi')).toEqual([])
    expect(readAnnotations({ length: 2 })).toEqual([])
  })

  it('drops what is malformed and keeps what is not', () => {
    const kept = comment()
    const out = readAnnotations([
      kept,
      { ...comment({ n: 2 }), kind: 'script' },
      { ...comment({ n: 3 }), rect: { x: Number.NaN, y: 0, width: 1, height: 1 } },
      { ...comment({ n: 0 }) },
      'not an object',
    ])
    expect(out).toEqual([kept])
  })

  it('caps what a guest can say, in count and in length', () => {
    const flood = Array.from({ length: 500 }, (_, index) =>
      comment({ n: index + 1, comment: 'x'.repeat(100_000), selector: 'y'.repeat(10_000) }),
    )
    const out = readAnnotations(flood)
    expect(out.length).toBe(100)
    expect(out[0]!.comment.length).toBe(4000)
    expect(out[0]!.selector!.length).toBe(500)
  })

  it('rounds coordinates to integers on the way in', () => {
    const out = readAnnotations([comment({ rect: { x: 1.4, y: 2.6, width: 3.5, height: 4.4 } })])
    expect(out[0]!.rect).toEqual({ x: 1, y: 3, width: 4, height: 4 })
  })
})
