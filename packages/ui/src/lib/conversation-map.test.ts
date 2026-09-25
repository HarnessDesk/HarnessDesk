import { describe, expect, it } from 'vitest'

import type { Turn } from '@harnessdesk/protocol'

import { buildMarks, PREVIEW_MAX, RAIL_HYSTERESIS, railFit, shouldRenderMap } from './conversation-map'

const turn = (id: string, items: Turn['items']): Turn =>
  ({ id, items, startedAt: 0 }) as unknown as Turn

const asked = (text: string) => ({ id: `${text}-u`, type: 'userMessage', content: [{ type: 'text', text }] }) as never
const said = (text: string) => ({ id: `${text}-a`, type: 'assistantMessage', text }) as never
const aside = (text: string) => ({ id: `${text}-c`, type: 'assistantMessage', text, phase: 'commentary' }) as never
const ran = () => ({ id: 'cmd', type: 'command', command: 'ls' }) as never

describe('the conversation map', () => {
  it('marks what was asked and what came back, not every item in between', () => {
    const marks = buildMarks([turn('t1', [asked('why does checkout retry'), ran(), ran(), said('because 502 is not listed')])])
    expect(marks).toEqual([
      { turn: 't1', kind: 'prompt', preview: 'why does checkout retry' },
      { turn: 't1', kind: 'answer', preview: 'because 502 is not listed' },
    ])
  })

  it('leaves no mark for a side that said nothing', () => {
    // A turn that only ran a command would otherwise contribute a mark whose
    // preview is empty — a place on the rail that previews nothing.
    expect(buildMarks([turn('t1', [asked('run the tests'), ran()])])).toEqual([
      { turn: 't1', kind: 'prompt', preview: 'run the tests' },
    ])
    expect(buildMarks([turn('t1', [ran()])])).toEqual([])
  })

  it('reads the answer and not the narration beside it', () => {
    const marks = buildMarks([turn('t1', [asked('go'), aside('thinking about it'), said('done')])])
    expect(marks.map((m) => m.preview)).toEqual(['go', 'done'])
  })

  it('carries a mention by its name, since that is what the reader saw', () => {
    const marks = buildMarks([
      turn('t1', [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'look at' }, { type: 'mention', name: 'retry.ts', path: '/a/retry.ts' }] } as never]),
    ])
    expect(marks[0]?.preview).toBe('look at retry.ts')
  })

  it('collapses the whitespace a transcript is full of', () => {
    const marks = buildMarks([turn('t1', [asked('  two\n\n  lines  ')])])
    expect(marks[0]?.preview).toBe('two lines')
  })

  it('cuts a long message to the length a card can hold', () => {
    const long = 'x'.repeat(PREVIEW_MAX * 2)
    const marks = buildMarks([turn('t1', [asked(long), said(long)])])
    for (const mark of marks) expect(mark.preview).toHaveLength(PREVIEW_MAX)
  })

  it('stops joining answer parts once it has enough to preview', () => {
    const part = 'y'.repeat(PREVIEW_MAX)
    const marks = buildMarks([turn('t1', [said(part), said('never read')])])
    expect(marks[0]?.preview).toBe(part)
  })

  it('draws the rail only for a transcript that is both long and overflowing', () => {
    expect(shouldRenderMap({ marks: 4, overflows: true })).toBe(true)
    // One exchange has nowhere to go but where the reader already is.
    expect(shouldRenderMap({ marks: 1, overflows: true })).toBe(false)
    // A transcript on one screen has nothing to navigate.
    expect(shouldRenderMap({ marks: 9, overflows: false })).toBe(false)
  })
})

describe('railFit', () => {
  const tokens = { gap: 4, step: 8, stroke: 12 }

  it('keeps the full push where the gutter is wide', () => {
    expect(railFit({ gutter: 335, ...tokens })).toEqual({ fit: 'roomy', reach: 12, cap: null })
    // Exactly enough: three insets, a 24px peak and the gap.
    expect(railFit({ gutter: 24 + 24 + 4, ...tokens })).toEqual({ fit: 'roomy', reach: 12, cap: null })
  })

  it('moves to the edge and cuts the push to what fits before the text', () => {
    // A 640 pane: the column starts 32px in.
    expect(railFit({ gutter: 32, ...tokens })).toEqual({ fit: 'tight', reach: 8, cap: 20 })
    // One pixel short of roomy.
    expect(railFit({ gutter: 51, ...tokens })).toEqual({ fit: 'tight', reach: 12, cap: 39 })
  })

  it('measures from where the dash is drawn, the hairline of a mark included', () => {
    // A 1px border inside the mark moves every dash a pixel right.
    expect(railFit({ gutter: 32, ...tokens, inset: 9 })).toEqual({ fit: 'tight', reach: 7, cap: 19 })
    expect(railFit({ gutter: 52, ...tokens, inset: 9 })).toEqual({ fit: 'tight', reach: 12, cap: 39 })
    expect(railFit({ gutter: 53, ...tokens, inset: 9 })).toEqual({ fit: 'roomy', reach: 12, cap: null })
  })

  it('holds even a resting prompt short of the text, and draws nothing when an answer cannot fit', () => {
    expect(railFit({ gutter: 22, ...tokens })).toEqual({ fit: 'tight', reach: 0, cap: 10 })
    expect(railFit({ gutter: 19, ...tokens })).toBeNull()
  })

  it('guesses the drawn inset, a step and a hairline, before there is a mark to read it from', () => {
    const drawn = railFit({ gutter: 32, ...tokens, inset: 9, shown: true })
    expect(railFit({ gutter: 32, ...tokens, hairline: 1 })).toEqual(drawn)
  })

  it('does not flip on and off around the threshold: it needs a band either side', () => {
    // Hidden: exactly enough for an answer is not enough to appear.
    const edge = 8 + 9 + 4 // a resting answer, the inset, the gap
    expect(railFit({ gutter: edge, ...tokens, hairline: 1 })).toBeNull()
    expect(railFit({ gutter: edge + RAIL_HYSTERESIS, ...tokens, hairline: 1 })).not.toBeNull()
    // Shown: it stays through the same pixel, and a band below it.
    expect(railFit({ gutter: edge, ...tokens, hairline: 1, shown: true })).not.toBeNull()
    expect(railFit({ gutter: edge - RAIL_HYSTERESIS, ...tokens, hairline: 1, shown: true })).not.toBeNull()
    expect(railFit({ gutter: edge - RAIL_HYSTERESIS - 1, ...tokens, hairline: 1, shown: true })).toBeNull()
    // A measure that disagrees with the guess by a pixel settles, whichever it starts from.
    let fit = railFit({ gutter: edge, ...tokens, hairline: 1 })
    for (let round = 0; round < 4; round += 1) {
      fit = railFit({ gutter: edge, ...tokens, ...(fit ? { inset: 10, shown: true } : { hairline: 1 }) })
    }
    expect(fit).toBeNull()
  })
})
