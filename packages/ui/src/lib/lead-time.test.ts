import { describe, expect, it } from 'vitest'

import { leadOriginText } from './lead-time'

describe('leadOriginText', () => {
  it('names a @harnessdesk request as a request, never by its wire word', () => {
    expect(leadOriginText({ source: 'pull-request', event: 'mentioned', subject: 'acme/widgets#12', url: 'https://github.com/acme/widgets/pull/12#issuecomment-1' }))
      .toBe('From: a request on acme/widgets#12')
    expect(leadOriginText({ source: 'issue', event: 'mentioned', subject: 'acme/widgets#7', url: null })).toBe('From: a request on acme/widgets#7')
  })
  it('reads any other event in words', () => {
    expect(leadOriginText({ source: 'pull-request', event: 'checks-failed', subject: 'acme/widgets#12', url: null })).toBe('From: checks failed on acme/widgets#12')
  })
})
