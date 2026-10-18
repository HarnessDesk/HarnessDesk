import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as nodeClient from '../src/node.js'
import { WireCallError } from '../src/index.js'

test('a host-verified private descriptor connects without filesystem discovery or metadata reads', async () => {
  const connect = (nodeClient as unknown as Record<string, typeof nodeClient.localTransport>).hostVerifiedLocalTransport
  assert.equal(typeof connect, 'function')
  // No such directory exists. Ordinary localTransport refuses its metadata
  // before connecting; a private stdin descriptor needs only the socket itself.
  await assert.rejects(connect!({ home: '/synthetic-home', pid: 123, startedAt: 1, hostVersion: 'test', protocolVersion: 1,
    socketPath: '/nonexistent-lead-fixture/socket.sock' }), error => error instanceof WireCallError && error.code === 'noDesk' && /socket could not be opened/.test(error.message))
})
