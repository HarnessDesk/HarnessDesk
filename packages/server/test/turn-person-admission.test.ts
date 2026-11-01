import assert from 'node:assert/strict'
import { test } from 'node:test'
import { queueTurn, sendTurn } from '../src/methods/turns.js'
import type { HostContext } from '../src/methods/context.js'

for (const kind of ['send', 'queue'] as const) test(`an earlier ${kind} request cannot acquire a later retired Seat while dispatch waits`, async () => {
  const record = { live: {}, queue: { messages: [] } }
  let seat: string | null = null
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let captured: unknown
  const ctx = {
    registry: { get: () => record },
    sessions: { record: () => record, assertDispatchable: () => {}, dispatch: async (_params: unknown, run: (live: object) => Promise<unknown>) => { entered(); await held; return run({}) } },
    queue: { busy: () => false, retiredPersonSeat: () => seat, sendNow: async (...args: unknown[]) => { if (kind === 'queue') { entered(); await held } captured = args[5]; return 'turn-1' } },
  } as unknown as HostContext
  const params = { runtime: 'fixture', sessionId: 'session', input: [{ type: 'text', text: 'Earlier request' }] } as never
  const result = kind === 'send' ? sendTurn(ctx, params, undefined, true) : queueTurn(ctx, params, undefined, undefined, true)
  await waiting
  seat = 'closed-seat'
  release()
  await result
  assert.equal(captured, null, 'the request did not begin after the Seat closed')
})


for (const state of ['unopened', 'unheld'] as const) test(`a previously ${state} conversation is resolved by dispatch without gaining a person Seat`, async () => {
  const record = { queue: { messages: [] } }
  let opened = false, captured: unknown
  const ctx = {
    registry: { get: () => state === 'unheld' ? { live: null } : undefined },
    sessions: {
      record: () => { assert.ok(opened, 'dispatch must reopen before reading the record'); return record },
      dispatch: async (_params: unknown, run: (live: object) => Promise<unknown>) => { opened = true; return run({}) },
    },
    queue: { retiredPersonSeat: () => { throw new Error('an unopened owner cannot confer authority') }, sendNow: async (...args: unknown[]) => { captured = args[5]; return 'turn-1' } },
  } as unknown as HostContext
  const params = { runtime: 'fixture', sessionId: 'session', input: [{ type: 'text', text: 'Message' }] } as never
  assert.deepEqual(await sendTurn(ctx, params, undefined, true), { turnId: 'turn-1' })
  assert.equal(captured, null)
})
