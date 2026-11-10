import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { MessagesHttpRequest, MessagesHttpResponse, MessagesTransport } from '@harnessdesk/lead'

import { observerAssessor, type AssessAccount, type AssessUsage } from '../src/intake/assess.js'
import type { MentionAssessInput } from '../src/intake/mentions.js'

/*
 * The observer model's request is the Lead's spend: it is held against the
 * Lead's limit before it is sent, settled at what the provider reports, and
 * counted whole when what it cost cannot be known. Refused, it is not sent.
 */

const INPUT: MentionAssessInput = {
  trigger: { id: 'ask', handle: 'dex', opens: 'the flow review-pr' },
  repository: 'acme/widgets',
  thread: { kind: 'issue', number: 1, title: 'Flaky test' },
  comment: { author: 'jane-doe', body: '@dex please fix the flaky test' },
}

const ANSWER = JSON.stringify({
  type: 'message', role: 'assistant', stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"decision": "accept", "reason": "It asks for a fix."}' }],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
})

/** A scripted provider and a scripted spend limit, each writing what happened into one shared log. */
const rig = (reply: MessagesHttpResponse | Error, allow = true) => {
  const log: string[] = []
  const sent: MessagesHttpRequest[] = []
  const settled: (AssessUsage | 'unknown')[] = []
  const reserved: { requestId: string; inputTokens: number; maxOutputTokens: number }[] = []
  const transport: MessagesTransport = {
    send: async (request) => {
      log.push('send')
      sent.push(request)
      if (reply instanceof Error) throw reply
      return reply
    },
  }
  const account: AssessAccount = {
    reserve: async (requestId, inputTokens, maxOutputTokens) => {
      log.push('reserve')
      reserved.push({ requestId, inputTokens, maxOutputTokens })
      if (!allow) return null
      return {
        settle: async (usage) => { log.push('settle'); settled.push(usage) },
        unknown: async () => { log.push('unknown'); settled.push('unknown') },
      }
    },
  }
  const assess = observerAssessor({ transport, key: async () => 'test-key-not-real', model: 'test-model', account })
  return { assess, log, sent, settled, reserved }
}

test('the observer request is held against the Lead’s limit before it is sent, and settled at what it used', async () => {
  const r = rig({ status: 200, body: ANSWER })
  const answer = await r.assess(INPUT, new AbortController().signal)
  assert.deepEqual(answer, { decision: 'accept', reason: 'It asks for a fix.' })
  assert.deepEqual(r.log, ['reserve', 'send', 'settle'])
  const [hold] = r.reserved
  assert.match(hold!.requestId, /^mention-assess:[0-9a-f-]{36}$/)
  assert.equal(r.sent[0]!.requestId, hold!.requestId, 'one id names the request and its charge')
  assert.ok(hold!.inputTokens >= Buffer.byteLength(r.sent[0]!.body), 'the hold covers every byte sent, an upper bound on its tokens')
  assert.equal(hold!.maxOutputTokens, 200)
  assert.deepEqual(r.settled, [{ inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 }])
})

test('a refused hold sends nothing: the request waits for the person', async () => {
  const r = rig({ status: 200, body: ANSWER }, false)
  assert.equal(await r.assess(INPUT, new AbortController().signal), null)
  assert.deepEqual(r.log, ['reserve'])
})

test('a refusal before any processing settles at zero; anything else unknown counts the whole hold', async () => {
  const early = rig({ status: 400, body: '{}', processing: 'not-started' })
  assert.equal(await early.assess(INPUT, new AbortController().signal), null)
  assert.deepEqual(early.settled, [{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }])

  for (const reply of [{ status: 500, body: '{}' }, new Error('socket closed'), { status: 200, body: '{"content": []}' }] as const) {
    const r = rig(reply)
    assert.equal(await r.assess(INPUT, new AbortController().signal), null)
    assert.deepEqual(r.settled, ['unknown'], `${reply instanceof Error ? reply.message : reply.status}: what it cost cannot be known`)
  }
})
