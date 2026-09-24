import assert from 'node:assert/strict'
import { runtimeId, sessionId, type SeatCeiling } from '@harnessdesk/protocol'
import { test } from 'node:test'

import { CeilingGate, type CeilingGatePort, type Conversation, type HeldQuestion } from '../src/ceilings/gate.js'
import { EXPIRED_CALLER_REFUSAL, HIDDEN_TOOL_REFUSAL, McpToolGateway, type GatewayCaller, type GatewayServer } from '../src/attachments/gate.js'

/**
 * The gate an external MCP call answers to once a server is loaded: a
 * hidden name is refused before the network, an expired caller is refused
 * outright rather than falling through as unidentified, and a delegated
 * child still answers to its root's ceiling — phase 3's own gate, reused
 * rather than re-implemented, with one new rule on top: an unidentified
 * caller here is never plain authority.
 */

const server = (overrides: Partial<GatewayServer> = {}): GatewayServer => ({
  seat: 'seat-1',
  identity: { kind: 'mcp', name: 'reviewer-tools', digest: 'digest-a', source: 'library', pathLabel: '~/reviewer-tools' },
  endpoint: 'gateway://seat-1/reviewer-tools',
  ceiling: 'merge',
  ...overrides,
})

/** A minimal, real `CeilingGatePort` — root resolution and holding, no fakes standing in for phase 3's own gate. */
class FakePort implements CeilingGatePort {
  readonly ceilings = new Map<string, SeatCeiling>()
  readonly roots = new Map<string, Conversation>()
  readonly said: string[] = []
  answer: 'allowed' | 'refused' | 'unanswered' = 'allowed'
  asked: { readonly summary: string; readonly reason: string } | null = null

  rootOf(runtime: string, session: string): Conversation | null {
    return this.roots.get(`${runtime}:${session}`) ?? { runtime, sessionId: session }
  }
  ceilingOf(runtime: string, session: string): SeatCeiling | null {
    return this.ceilings.get(`${runtime}:${session}`) ?? null
  }
  cause: ReturnType<CeilingGatePort['causeOf']> = { kind: 'person' }
  causeOf(): ReturnType<CeilingGatePort['causeOf']> {
    return this.cause
  }
  nameOf(): string {
    return 'Receiver'
  }
  say(_runtime: string, _session: string, text: string): void {
    this.said.push(text)
  }
  async askPerson(_r: string, _s: string, question: HeldQuestion): Promise<'allowed' | 'refused' | 'unanswered'> {
    this.asked = question
    return this.answer
  }
}

test('server cannot raise a read Seat', async () => {
  for (const level of ['read', 'edit', 'publish'] as const) {
    const port = new FakePort()
    port.ceilings.set('claude:one', { level, hold: 'held' })
    const gate = new CeilingGate(port)
    let connected = false
    let invoked = false
    const gateway = new McpToolGateway({
      serversFor: () => [server({ ceiling: 'merge' })],
      callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }),
      admit: (call) => {
        connected = true // stands in for "reached the point of dialing out" — never true for a Seat below merge
        return gate.admit(call)
      },
    })
    const result = await gateway.call('token', 'reviewer-tools', 'flag_issue', async () => {
      invoked = true
      return 'ok'
    })
    assert.equal(result.ok, false, level)
    assert.equal(invoked, false, level)
    assert.equal(connected, true, 'admit is still consulted — refusal comes from the gate, not from skipping it')
  }

  // On a merge Seat, phase 3's own checks still run normally and admit it.
  const port = new FakePort()
  port.ceilings.set('claude:one', { level: 'merge', hold: 'held' })
  const gate = new CeilingGate(port)
  let invoked = false
  const gateway = new McpToolGateway({
    serversFor: () => [server({ ceiling: 'merge' })],
    callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }),
    admit: (call) => gate.admit(call),
  })
  const result = await gateway.call('token', 'reviewer-tools', 'flag_issue', async () => {
    invoked = true
    return 'ok'
  })
  assert.equal(result.ok, true)
  assert.equal(invoked, true)
})

test('hidden tool cannot be called by name', async () => {
  const approved = server({ identity: { kind: 'mcp', name: 'approved-server', digest: 'd', source: 'library', pathLabel: 'x' } })
  let admitCalls = 0
  const gateway = new McpToolGateway({
    serversFor: () => [approved],
    callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }),
    admit: async () => { admitCalls += 1; return { admitted: true } },
  })
  const listed = await gateway.list('token', async (queried) => {
    assert.equal(queried.identity.name, 'approved-server', 'only the caller’s own approved server is ever queried')
    return [{ name: 'do_the_real_thing', description: 'A real tool this server actually offers.', inputSchema: { type: 'object' } }]
  })
  assert.deepEqual(listed, [
    { name: 'do_the_real_thing', server: 'approved-server', description: 'A real tool this server actually offers.', inputSchema: { type: 'object' } },
  ])

  let invoked = false
  const result = await gateway.call('token', 'hidden-server', 'do_something', async () => {
    invoked = true
    return 'ok'
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, HIDDEN_TOOL_REFUSAL)
  assert.equal(invoked, false, 'a name outside the approved set is never invoked')
  assert.equal(admitCalls, 0, 'refused before the ceiling gate is even asked — discovery is not authorization, and neither is a bare name')
})

test('one server’s failed listing does not hide another’s real tools', async () => {
  const down = server({ identity: { kind: 'mcp', name: 'down-server', digest: 'd1', source: 'library', pathLabel: 'x' } })
  const up = server({ identity: { kind: 'mcp', name: 'up-server', digest: 'd2', source: 'library', pathLabel: 'y' } })
  const gateway = new McpToolGateway({
    serversFor: () => [down, up],
    callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }),
    admit: async () => ({ admitted: true }),
  })
  const listed = await gateway.list('token', async (queried) => {
    if (queried.identity.name === 'down-server') throw new Error('connection refused')
    return [{ name: 'real_tool', description: '', inputSchema: {} }]
  })
  assert.deepEqual(listed, [{ name: 'real_tool', server: 'up-server', description: '', inputSchema: {} }])
})

test("child and message retain root limits", async () => {
  const port = new FakePort()
  // The receiver holds merge itself and is the *root* of the child it
  // delegated to — but the receiver's own current turn was itself caused by
  // a message from a sender who may only read. A message cannot carry a
  // ceiling across: the receiver may not lend the sender its own higher
  // ceiling merely by acting on what the message asked, so admitting this
  // call still depends on the person, not on the root's own held ceiling alone.
  port.ceilings.set('claude:receiver', { level: 'merge', hold: 'held' })
  port.roots.set('claude:child', { runtime: 'claude', sessionId: 'receiver' })
  port.cause = {
    kind: 'message',
    from: { runtime: runtimeId('claude'), sessionId: 'sender', name: 'Sender' },
    ceiling: { level: 'read', hold: 'held' },
  }
  const gate = new CeilingGate(port)

  const gateway = new McpToolGateway({
    serversFor: () => [server({ ceiling: 'merge' })],
    // The call arrives from the *child* conversation the receiver delegated
    // to — never inferred from any name the call's own arguments might claim.
    callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'child' }),
    admit: (call) => gate.admit(call),
  })
  let invoked = false
  port.answer = 'refused'
  const result = await gateway.call('token', 'reviewer-tools', 'flag_issue', async () => {
    invoked = true
    return 'ok'
  })
  assert.equal(result.ok, false, "a message cannot hand the receiver's own higher ceiling to what the sender may do")
  assert.equal(invoked, false)
  assert.ok(port.asked, 'the person was actually asked, rather than the call silently passing or failing')

  // Refused was the person's call; allowed is too, and both are real answers — a hidden "reason: text says so" is not one.
  port.answer = 'allowed'
  const allowed = await gateway.call('token', 'reviewer-tools', 'flag_issue', async () => {
    invoked = true
    return 'ok'
  })
  assert.equal(allowed.ok, true)
  assert.equal(invoked, true)
})

test('expired token is not plain authority', async () => {
  const calls: string[] = []
  const gateway = new McpToolGateway({
    serversFor: () => [server()],
    callerOf: () => null, // the bridge mapping for this token was removed
    admit: async () => {
      calls.push('admit')
      return { admitted: true }
    },
  })
  const listed = await gateway.list('gone', async () => {
    calls.push('list')
    return [{ name: 'flag_issue', description: '', inputSchema: {} }]
  })
  assert.deepEqual(listed, [])
  const result = await gateway.call('gone', 'reviewer-tools', 'flag_issue', async () => {
    calls.push('invoke')
    return 'ok'
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, EXPIRED_CALLER_REFUSAL)
  assert.deepEqual(calls, [], 'an unidentified caller must never fall through to phase 3’s own permissive default for this path')
})

test('a blind round embargoes an external server that may publish, but not one held to read', async () => {
  const embargo = 'Your review round is blind until every reviewer has finished.'
  const port = new FakePort() as FakePort & { embargoOf(runtime: string, session: string): string | null }
  port.embargoOf = () => embargo
  port.ceilings.set('claude:one', { level: 'merge', hold: 'held' })
  const gate = new CeilingGate(port)
  for (const [ceiling, admitted] of [['merge', false], ['publish', false], ['edit', true], ['read', true]] as const) {
    let invoked = false
    const gateway = new McpToolGateway({
      serversFor: () => [server({ ceiling })],
      callerOf: () => ({ seat: 'seat-1', runtime: 'claude', sessionId: 'one' }),
      admit: (call) => gate.admit(call),
    })
    const result = await gateway.call('token', 'reviewer-tools', 'post_comment', async () => {
      invoked = true
      return 'ok'
    })
    assert.equal(result.ok, admitted, ceiling)
    assert.equal(invoked, admitted, ceiling)
    if (!result.ok) assert.equal(result.reason, embargo, ceiling)
  }
})
