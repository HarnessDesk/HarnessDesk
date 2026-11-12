import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MCP_DAILY_STARTS_MAX, parseClientMessage, ValidationError } from '../src/index.js'

/**
 * Starting work from an MCP client is the person's to allow, from the window.
 * The wire is where a stated surface is held to the one value it may take,
 * where the daily number is held to its bounds, and where a window preference
 * that could be mistaken for this host-owned state is refused.
 */
const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
const hello = { client: { name: 'example-client', version: '1.0.0' }, protocol: 1 }

test('a hello may state the MCP surface, and nothing else', () => {
  assert.doesNotThrow(() => request('client/hello', hello), 'no surface is the command line')
  assert.doesNotThrow(() => request('client/hello', { ...hello, surface: 'mcp' }))
  for (const surface of ['cli', 'MCP', 'window', '', 1, true]) {
    assert.throws(() => request('client/hello', { ...hello, surface }), ValidationError, `surface ${JSON.stringify(surface)} is refused`)
  }
})

test('the MCP start settings take a revision and bounded values, and nothing the host measures', () => {
  assert.doesNotThrow(() => request('app/mcpStarts/get', {}))
  assert.doesNotThrow(() => request('app/mcpStarts/set', { revision: 0 }))
  assert.doesNotThrow(() => request('app/mcpStarts/set', { revision: 3, mayStart: true }))
  assert.doesNotThrow(() => request('app/mcpStarts/set', { revision: 3, dailyStarts: 1 }))
  assert.doesNotThrow(() => request('app/mcpStarts/set', { revision: 3, dailyStarts: MCP_DAILY_STARTS_MAX }))
  for (const dailyStarts of [0, MCP_DAILY_STARTS_MAX + 1, 2.5, -1, '5']) {
    assert.throws(() => request('app/mcpStarts/set', { revision: 3, dailyStarts }), ValidationError, `dailyStarts ${JSON.stringify(dailyStarts)} is refused`)
  }
  assert.throws(() => request('app/mcpStarts/set', {}), ValidationError, 'a change names the revision it read')
  assert.throws(() => request('app/mcpStarts/set', { revision: -1 }), ValidationError)
  assert.throws(() => request('app/mcpStarts/set', { revision: 0, mayStart: 'yes' }), ValidationError)
  for (const forged of ['started', 'day', 'remaining', 'source']) {
    assert.throws(() => request('app/mcpStarts/set', { revision: 0, [forged]: 0 }), ValidationError, `${forged} is the host's, not a setting`)
  }
})

test('a window preference can never pass for the MCP start settings', () => {
  for (const key of ['mcpStarts', 'mcpMayStart', 'MCPDailyStarts', 'mcp']) {
    assert.throws(() => request('app/state/set', { patch: { [key]: true } }), ValidationError, `${key} is not a window preference`)
  }
  assert.doesNotThrow(() => request('app/state/set', { patch: { clientsMayAnswer: true } }), 'the answer switch is still a preference')
})
