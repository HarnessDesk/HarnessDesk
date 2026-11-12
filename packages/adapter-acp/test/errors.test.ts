import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentError } from '@harnessdesk/protocol'
import { AcpError } from '@harnessdesk/transport-acp'

import { classifyAcpError, isAuthRefusal } from '../src/errors.js'

const cases: readonly (readonly [string, unknown, AgentError['code']])[] = [
  // Structured signals first.
  ['a process exit', new AcpError('The agent exited (code 1) while requests were waiting.', undefined, undefined, 1), 'runtimeUnavailable'],
  ['an exit with no code, said by the transport', new AcpError('The agent is not running.'), 'runtimeUnavailable'],
  ['a spawn failure', new AcpError('agent failed to start: spawn ENOENT'), 'runtimeUnavailable'],
  ['ACP request cancelled', new AcpError('Request cancelled', -32800), 'interrupted'],
  ['ACP auth_required with its words', new AcpError('Authentication required', -32000), 'auth'],
  ['auth words only in the details', new AcpError('Internal error', -32603, 'Not logged in · Please run /login'), 'auth'],
  ['a bridge that sends the words alone', new Error('Please log in to use the agent.'), 'auth'],
  ['method not found', new AcpError('Method not found', -32601), 'protocol'],
  ['invalid params', new AcpError('Invalid params', -32602), 'protocol'],
  ['parse error', new AcpError('Parse error', -32700), 'protocol'],
  // Words after, conservatively.
  ['an upstream 401', new AcpError('Internal error', -32603, 'API Error: 401 {"type":"error"}'), 'auth'],
  ['an invalid key', new Error('Invalid API key · Fix external API key'), 'auth'],
  ['an upstream 429', new AcpError('Internal error', -32603, 'API Error: 429 Too Many Requests'), 'rateLimit'],
  ['a rate limit in words', new Error('Rate limit reached, try again shortly'), 'rateLimit'],
  ['a quota', new Error('Quota exceeded for quota metric generate_content_requests'), 'credits'],
  ['a usage limit', new Error('Usage limit reached. Your limit resets at 5pm.'), 'credits'],
  ['a credit balance', new Error('Your credit balance is too low to access the API.'), 'credits'],
  ['a billing problem', new Error('Billing details required'), 'credits'],
  ['connection refused', new Error('connect ECONNREFUSED 127.0.0.1:443'), 'network'],
  ['a DNS failure', new AcpError('Internal error', -32603, 'getaddrinfo ENOTFOUND api.example.com'), 'network'],
  ['a fetch failure', new Error('fetch failed'), 'network'],
  ['a version gate', new Error('This model requires a newer version of the agent.'), 'versionGate'],
  // Nothing certain is unknown.
  ['a bare -32000', new AcpError('Internal server error', -32000), 'unknown'],
  ['a bare internal error', new AcpError('Internal error', -32603), 'unknown'],
  ['a backend timeout', new AcpError('Internal server error: model backend timed out', -32603), 'unknown'],
  ['a thrown string', 'something went wrong', 'unknown'],
  ['a refusal stop reason in words', new Error('The agent stopped: refusal.'), 'unknown'],
]

for (const [name, error, code] of cases) {
  test(`classifyAcpError: ${name} → ${code}`, () => {
    assert.equal(classifyAcpError(error), code)
  })
}

test('a process exit outranks the words it carries', () => {
  const error = new AcpError('The agent exited (code 1) while requests were waiting.', undefined, 'Not logged in', 1)
  assert.equal(classifyAcpError(error), 'runtimeUnavailable')
})

test('isAuthRefusal reads the details as well as the message, and nothing else', () => {
  assert.equal(isAuthRefusal(new AcpError('Internal error', -32603, 'authRequired')), true)
  assert.equal(isAuthRefusal(new AcpError('Internal server error', -32000)), false)
  assert.equal(isAuthRefusal('Authentication required'), false, 'a thrown string is not an agent refusal')
})
