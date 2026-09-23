import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatAttachmentsRecord } from '@harnessdesk/protocol'

import { AttachmentReceipts } from '../src/attachments/receipts.js'
import { McpToolGateway, type McpGatewayPort } from '../src/attachments/gate.js'
import { tempDir } from './scratch.js'

/**
 * Append-only per-Seat attachment history: a resume is a new epoch, never a
 * rewrite of an old one, and a Seat with no sidecar at all — or one that
 * only ever arrived as history — reads back honestly as such.
 */

const identity = (name: string, digest: string) => ({
  kind: 'skill' as const,
  name,
  digest,
  source: 'agent' as const,
  pathLabel: `~/${name}`,
})

const epoch = (overrides: Partial<SeatAttachmentsRecord> = {}): SeatAttachmentsRecord => ({
  version: 1,
  seat: 'seat-1',
  agentDigest: 'agent-digest',
  runtime: 'claude',
  build: '1.0.0',
  epoch: 0,
  observedAt: Date.now(),
  skillsMode: 'allowlist',
  mcpMode: 'runtime-defaults',
  declarations: [{ kind: 'skill', name: 'demo', identity: identity('demo', 'digest-a'), problem: null }],
  results: [{ identity: identity('demo', 'digest-a'), status: 'loaded', reason: null }],
  restored: false,
  ...overrides,
})

test('resume is a new observation', async () => {
  const receipts = new AttachmentReceipts(tempDir('hd-attach-receipts-resume-'))
  await receipts.append(epoch({ epoch: 0 }))
  const firstRead = await receipts.read('seat-1' as never)
  assert.equal(firstRead?.epoch, 0)
  assert.equal(firstRead?.results[0]?.status, 'loaded')

  // A resume observes different (or unavailable) bytes this time — appended
  // as epoch 1, never rewriting epoch 0's own "loaded" result.
  await receipts.append(
    epoch({
      epoch: 1,
      declarations: [{ kind: 'skill', name: 'demo', identity: identity('demo', 'digest-b'), problem: null }],
      results: [{ identity: identity('demo', 'digest-b'), status: 'not-loaded', reason: 'The runtime loaded different content; start a new Seat.' }],
    }),
  )
  const history = await receipts.history('seat-1' as never)
  assert.equal(history.length, 2)
  assert.equal(history[0]!.epoch, 0)
  assert.equal(history[0]!.results[0]!.status, 'loaded', 'the historical epoch is never rewritten by a later observation')
  assert.equal(history[0]!.results[0]!.identity.digest, 'digest-a')
  assert.equal(history[1]!.epoch, 1)
  assert.equal(history[1]!.results[0]!.status, 'not-loaded')

  const latest = await receipts.read('seat-1' as never)
  assert.equal(latest?.epoch, 1)

  // An epoch that does not increase by exactly one is refused outright.
  await assert.rejects(receipts.append(epoch({ epoch: 1 })), /epoch must increase/)
  await assert.rejects(receipts.append(epoch({ epoch: 5 })), /epoch must increase/)
  assert.equal((await receipts.history('seat-1' as never)).length, 2, 'a refused append changes nothing on disk')
})

test('legacy and restored are not live', async () => {
  const receipts = new AttachmentReceipts(tempDir('hd-attach-receipts-legacy-'))
  // Never recorded at all — every Seat opened before this phase shipped.
  assert.equal(await receipts.read('never-seen' as never), null)
  assert.deepEqual(await receipts.history('never-seen' as never), [])

  // A restored sidecar (imported alongside a restored Seat) still reads back
  // as history — but nothing here ever turns that history into a live
  // caller mapping or a runnable server: the gateway's own map is a
  // separate, in-memory structure this file's records can never populate.
  await receipts.append(epoch({ seat: 'restored-seat' as never, epoch: 0, restored: true }))
  const restored = await receipts.read('restored-seat' as never)
  assert.equal(restored?.restored, true)
  assert.equal(restored?.results[0]?.status, 'loaded', 'the history itself is shown honestly, restored or not')

  const port: McpGatewayPort = {
    // A restored record names a Seat; the live gateway map is built only by
    // an actual, in-process `record()` call during a real Seat opening, so a
    // restored-only Seat has nothing here at all.
    serversFor: () => null,
    callerOf: () => ({ seat: 'restored-seat' as never, runtime: 'claude', sessionId: 'one' }),
    admit: async () => ({ admitted: true }),
  }
  const gateway = new McpToolGateway(port)
  assert.deepEqual(
    await gateway.list('token-for-restored-seat', async () => {
      throw new Error('a Seat with no live server list must never be queried for one')
    }),
    [],
  )
  const called = await gateway.call('token-for-restored-seat', 'anything', 'anything', async () => 'should not run')
  assert.equal(called.ok, false, 'a restored sidecar can mint no live token and reach no server')
})
