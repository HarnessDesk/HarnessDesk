import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage } from '../src/wire-validators.js'
import { ValidationError } from '../src/validate.js'

const request = (method: string, input: unknown) => ({
  id: 1,
  method,
  params: method === 'turn/queue'
    ? { runtime: 'codex', sessionId: 's1', input }
    : { runtime: 'codex', sessionId: 's1', id: 'q1', input },
})

test('queue and update reject empty text but still accept a message made of an attachment', () => {
  for (const method of ['turn/queue', 'turn/queue/update']) {
    for (const text of ['', '   ', '\n\t']) {
      assert.throws(() => parseClientMessage(request(method, [{ type: 'text', text }])), ValidationError)
    }
  }

  const attachmentOnly = parseClientMessage(request('turn/queue', [
    { type: 'mention', name: 'plan.md', path: '/work/plan.md' },
  ]))
  assert.equal(attachmentOnly.method, 'turn/queue')
})


test('queue records accept safe lengths and reject negative, fractional and string lengths', () => {
  for (const method of ['turn/queue', 'turn/queue/update']) {
    for (const prefixLength of [0, 3, 100]) {
      const parsed = parseClientMessage(request(method, [{ type: 'text', text: 'say', deskContext: { prefixLength } }]))
      assert.ok(parsed.method === 'turn/queue' || parsed.method === 'turn/queue/update')
      assert.deepEqual(JSON.parse(JSON.stringify(parsed.params)), request(method, [{ type: 'text', text: 'say', deskContext: { prefixLength } }]).params)
    }
    for (const prefixLength of [-1, 1.5, '3']) {
      assert.throws(() => parseClientMessage(request(method, [{ type: 'text', text: 'say', deskContext: { prefixLength } }])), ValidationError)
    }
  }
})
