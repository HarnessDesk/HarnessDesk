import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { formatLeadDollars } from '@harnessdesk/protocol'

// The Lead's own turn runs through the real host, so this file is in the Lead group, which runs on the runtime the Lead's child needs.

test('the expiry note reaches the model request of the turn that answers the message, through the host', async t => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const requests: string[] = []
  const reply = (text: string) => ({ status: 200, body: JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) })
  const asked = JSON.stringify({ version: 1, type: 'lead-output', text: 'I can start it.', ask: { question: 'Start the fix?', options: [{ id: 'start', label: 'Start it' }, { id: 'later', label: 'Not now' }], recommended: 'start', expiresInMinutes: 5 } })
  const transport = { async send(request: { readonly body: unknown }) { requests.push(String(request.body)); return reply(requests.length === 1 ? asked : 'Understood.') } }
  const state = new StateStore(`${tempDir('hd-lead-note-state-')}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state, leadMessagesTransport: transport as never,
    credentialCipher: { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() } as never })
  const settings = await desk.host.call('lead/settings/read', {}) as { revision: number }
  const step = async <T,>(name: string, run: () => Promise<T>): Promise<T> => { try { return await run() } catch (error) { throw new Error(`${name}: ${(error as { wireCode?: string }).wireCode ?? error}`) } }
  await step('settings', () => desk.host.call('lead/settings/update', { expectedRevision: settings.revision, credential: { provider: 'anthropic', key: 'sk-test-not-real-0000' } } as never))
  const settled = async (count: number) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const read = await desk.host.call('lead/thread/read', {}) as unknown as { requestInFlight: boolean; thread: { messages: { role: string }[] } }
      if (!read.requestInFlight && read.thread.messages.filter(message => message.role === 'assistant').length >= count) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('the reply did not settle')
  }
  await step('send 1', () => desk.host.call('lead/thread/send', { idempotencyKey: 'note-1', text: 'Fix the status list' }))
  await settled(1)
  // Its five minutes pass, and then the person writes plain words to it.
  t.mock.timers.tick(10 * 60_000)
  await step('send 2', () => desk.host.call('lead/thread/send', { idempotencyKey: 'note-2', text: 'yes please' }))
  await settled(2)
  assert.equal(requests.length, 2)
  assert.match(requests[1]!, /<host-note>/, 'the turn that answers the message is told the question expired')
  assert.match(requests[1]!, /expired at/)
  assert.doesNotMatch(requests[0]!, /<host-note>/)
})

test('after half an hour with no window or phone looked at, the next person turn carries the real away window, through the host (#2147)', async t => {
  const { StateStore } = await import('../src/index.js')
  const { tempDir } = await import('./scratch.js')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const requests: string[] = []
  const transport = { async send(request: { readonly body: unknown }) { requests.push(String(request.body))
    return { status: 200, body: JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'Nothing moved.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) } } }
  const state = new StateStore(`${tempDir('hd-lead-away-state-')}/state.json`)
  const desk = await evidenceDesk(t, { leadEnabled: true, state, leadMessagesTransport: transport as never,
    credentialCipher: { protection: 'synthetic cipher', encrypt: (plain: string) => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: (blob: Buffer) => Buffer.from(blob.toString(), 'hex').toString() } as never })
  const settings = await desk.host.call('lead/settings/read', {}) as { revision: number }
  await desk.host.call('lead/settings/update', { expectedRevision: settings.revision, credential: { provider: 'anthropic', key: 'sk-test-not-real-0000' } } as never)
  const settled = async (count: number) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const read = await desk.host.call('lead/thread/read', {}) as unknown as { requestInFlight: boolean; thread: { messages: { role: string }[] } }
      if (!read.requestInFlight && read.thread.messages.filter(message => message.role === 'assistant').length >= count) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('the reply did not settle')
  }
  const device = { id: 'window:fixture-window', label: 'Desktop' }
  await desk.host.call('lead/presence/read', { device, active: true } as never)
  await desk.host.call('lead/thread/send', { idempotencyKey: 'away-1', text: 'Start on the status list' })
  await settled(1)
  t.mock.timers.tick(31 * 60_000)
  await desk.host.call('lead/presence/read', { device, active: true } as never)
  await desk.host.call('lead/thread/send', { idempotencyKey: 'away-2', text: 'What happened while I was away?' })
  await settled(2)
  assert.doesNotMatch(requests[0]!, /The person was away/)
  assert.match(requests.at(-1)!, /<host-note>[^<]*The person was away from/, 'the turn after the absence is told the window')
  // The first reply's spend is metered after the person's last look, so their away card shows it; the note gives the
  // window and the spend that card shows, by the card's rule, never a figure of its own (#2147).
  const presence = await desk.host.call('lead/presence/read', { device, active: true } as never) as unknown as { digest?: { kind: string; spentUsdMicros: number } }
  assert.equal(presence.digest?.kind, 'away', 'the card the person sees')
  assert.ok(requests.at(-1)!.includes(`${formatLeadDollars(presence.digest!.spentUsdMicros)} was spent in that span.`), 'the card\'s spend, by the card\'s rule')
  assert.doesNotMatch(requests.at(-1)!, /no away digest was shown/)
})
