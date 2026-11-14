import assert from 'node:assert/strict'
import test from 'node:test'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { parseLeadAsk } from '@harnessdesk/protocol'
import { serve } from '../src/index.js'
import { startPhoneLink } from '../src/phone-link.js'
import { Client, silent } from './fixtures/harness.js'
import { rig } from './fixtures/lead-attempts-rig.js'

/** The prior protocol's LeadAsk projection was closed to unknown keys. */
const oldAskShape = (ask: Record<string, unknown>) => {
  for (const key of Object.keys(ask)) assert.ok(['question', 'options', 'recommended', 'expiresInMinutes', 'startsMarked'].includes(key), `older ask parser rejects ${key}`)
  assert.deepEqual(parseLeadAsk(ask), ask, 'the remaining fields still satisfy the original ask validators')
}

for (const surface of ['desktop', 'phone'] as const) test(`#2145: ${surface} answers the bound retry over its wire`, async t => {
  const r = await rig(t)
  await r.personWrites('Fix the stalled build a game task')
  const first = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task' } })
  const { id, handle, ledgerItem } = first.value as { id: string; handle: string; ledgerItem: string }
  const question = `Start another chat for "Fix the stalled build a game task" instead of continuing ${handle}?`
  const publishAsk = async () => {
    await r.journal.appendReply(question, undefined, { question, retryOf: { item: ledgerItem, attempt: id }, startsMarked: true,
      options: [{ id: 'start', label: 'Start another chat', starts: true }, { id: 'later', label: 'Not now' }], recommended: 'later' })
    const message = r.journal.state.messages.at(-1)!
    assert.deepEqual(message.ask?.retryOf, { item: ledgerItem, attempt: id }, 'the durable journal retains the binding')
    return message.id
  }
  let ask = ''
  t.mock.method(r.host.credentials, 'leadStatus', async () => ({ configured: true, protection: 'synthetic cipher' }))
  t.mock.method(r.host.credentials, 'resolveLead', async () => 'fixture-key')
  if (surface === 'desktop') {
    const server = await serve({ host: r.host, logger: silent, port: 0 })
    const client = await Client.connect(server)
    try {
      await client.call('lead/thread/read', {})
      ask = await publishAsk()
      await client.until(() => client.notifications.some(n => 'method' in n && n.method === 'lead/changed' && 'thread' in n.params && n.params.thread.messages.some(m => m.id === ask)), 5_000, 'the question delta')
      const delta = client.notifications.findLast(n => 'method' in n && n.method === 'lead/changed' && 'thread' in n.params && n.params.thread.messages.some(m => m.id === ask))!
      if (!('method' in delta) || delta.method !== 'lead/changed' || !('thread' in delta.params)) throw new Error('missing Lead delta')
      oldAskShape(delta.params.thread.messages.find(m => m.id === ask)!.ask as unknown as Record<string, unknown>)
      const read = await client.call('lead/thread/read', {}) as { thread: { messages: { id: string; ask?: { question: string } }[] } }
      assert.equal(read.thread.messages.find(message => message.id === ask)?.ask?.question, question)
      oldAskShape(read.thread.messages.find(message => message.id === ask)!.ask as unknown as Record<string, unknown>)
      await client.call('lead/thread/send', { idempotencyKey: 'desktop-retry-answer', text: 'Start another chat', ask, device: { id: 'window:main', label: 'Desktop' } })
    } finally { await client.close(); await server.close() }
  } else {
    const { tempDir } = await import('./scratch.js')
    const running = await startPhoneLink(r.host, silent, { home: tempDir('hd-retry-phone-'), host: '127.0.0.1', includeLoopback: true, name: 'Test desk' })
    let phone: PhoneSim | undefined
    try {
      const code = await running.control.pairing()
      phone = await PhoneSim.fromCode(code.url)
      await phone.open(running.service.port, phone.offer!.deskPub)
      await phone.enroll(phone.offer!.enroll, 'Jane phone')
      for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.ok(running.control.state().pending.length, 'the phone enrollment reached the desk')
      running.control.allow(running.control.state().pending[0]!.id)
      await phone.next(message => message.t === 'enroll.ok')
      assert.equal((await phone.request('lead/thread/read', {})).ok, true)
      ask = await publishAsk()
      const delta = await phone.next(message => message.t === 'evt' && message.topic === 'lead' && message.data?.thread?.messages?.some((one: { id: string }) => one.id === ask))
      oldAskShape(delta.data.thread.messages.find((message: { id: string }) => message.id === ask).ask)
      const read = await phone.request('lead/thread/read', {})
      assert.equal(read.ok, true, JSON.stringify(read))
      assert.equal(read.result.thread.messages.find((message: { id: string }) => message.id === ask)?.ask?.question, question)
      oldAskShape(read.result.thread.messages.find((message: { id: string }) => message.id === ask).ask)
      const sent = await phone.request('lead/thread/send', { idempotencyKey: 'phone-retry-answer', text: 'Start another chat', ask })
      assert.equal(sent.ok, true, JSON.stringify(sent))
    } finally { phone?.close(); await running.close() }
  }
  const receipt = await r.host.call('lead/presence/read', { device: { id: 'window:main', label: 'Desktop' } })
  assert.equal(receipt.asks.find(one => one.id === ask)?.answer?.by, surface === 'desktop' ? 'Desktop' : 'Jane phone')
  const retried = await r.execute({ method: 'lead/chat/start', params: { text: 'Fix the stalled build a game task (second attempt)', ledgerItem } })
  assert.ok((retried.value as { id?: string } | undefined)?.id, JSON.stringify(retried))
  assert.equal(r.runtime.sessions.size, 2)
})

// Both surfaces use the same bound question receipt.
