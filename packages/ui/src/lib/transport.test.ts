import { describe, expect, it } from 'vitest'

import { sentenceOf } from './transport'

describe('sentenceOf', () => {
  it('adds the reason the agent gave, because the message alone says nothing', () => {
    expect(
      sentenceOf({
        code: 'methodFailed',
        message: 'Internal error',
        details: 'the query closed before it answered',
      }),
    ).toBe('Internal error — the query closed before it answered')
  })

  it('leaves a message that already explains itself alone', () => {
    const message = 'Fake ACP Agent cannot open this conversation: its folder no longer exists (/gone).'
    expect(sentenceOf({ code: 'methodFailed', message, details: null })).toBe(message)
    expect(sentenceOf({ code: 'methodFailed', message })).toBe(message)
  })

  it('does not say the same thing twice', () => {
    expect(sentenceOf({ code: 'methodFailed', message: 'Nope', details: 'Nope' })).toBe('Nope')
    expect(sentenceOf({ code: 'methodFailed', message: 'Nope', details: '   ' })).toBe('Nope')
  })
})
