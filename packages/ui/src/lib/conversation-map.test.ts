import { describe, expect, it } from 'vitest'

import type { Turn } from '@harnessdesk/protocol'

import { buildMarks, PREVIEW_MAX, shouldRenderMap } from './conversation-map'

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
