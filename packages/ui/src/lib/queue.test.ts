import { describe, expect, it } from 'vitest'

import type { QueuedMessage } from '@harnessdesk/protocol'

import { describeQueued, queuedLabel } from './queue'

/**
 * Reading a queued message back into something a person recognises. The rule
 * is that nothing is invented and nothing is hidden: what the user typed is
 * what they see, and whatever else rides along is counted.
 */

const message = (input: QueuedMessage['input']): QueuedMessage => ({
  id: 'q0',
  input,
  queuedAt: 0,
  state: 'queued',
})

describe('describeQueued', () => {
  it('gives back the words that were typed', () => {
    expect(describeQueued([{ type: 'text', text: 'run the tests' }])).toEqual({
      text: 'run the tests',
      attachments: [],
      context: [],
    })
  })

  it('separates resolved context from the words, and keeps it whole', () => {
    const view = describeQueued([
      { type: 'text', text: '<context source="Issue 12">\nthe body\n</context>\nfix this' },
    ])
    expect(view.text).toBe('fix this')
    // Whole, because editing this message has to hand it back: a count could
    // only be reported, and the message would go out missing what it carried.
    expect(view.context).toEqual([{ label: 'Issue 12', text: 'the body' }])
  })

  it('names the files and images that ride along', () => {
    const view = describeQueued([
      { type: 'text', text: 'look' },
      { type: 'image', url: 'data:image/png;base64,AA', name: 'shot.png' },
      { type: 'localImage', path: '/w/pics/diagram.png' },
      { type: 'mention', name: 'a.ts', path: '/w/a.ts' },
      { type: 'skill', name: 'review', path: '/w/.skills/review' },
    ])
    expect(view.attachments).toEqual([
      { kind: 'image', name: 'shot.png', path: 'data:image/png;base64,AA' },
      { kind: 'image', name: 'diagram.png', path: '/w/pics/diagram.png' },
      { kind: 'mention', name: 'a.ts', path: '/w/a.ts' },
      { kind: 'skill', name: 'review', path: '/w/.skills/review' },
    ])
  })
})

describe('queuedLabel', () => {
  it('is the first line with anything in it', () => {
    expect(queuedLabel(message([{ type: 'text', text: '\n\n  the point  \nthe detail' }]))).toBe('the point')
  })

  it('falls back to what the message carries when it has no words', () => {
    expect(queuedLabel(message([{ type: 'mention', name: 'a.ts', path: '/w/a.ts' }]))).toBe('a.ts')
    expect(
      queuedLabel(message([{ type: 'text', text: '<context source="Issue 12">\nbody\n</context>' }])),
    ).toBe('Context only')
    expect(queuedLabel(message([]))).toBe('Empty message')
  })
})
