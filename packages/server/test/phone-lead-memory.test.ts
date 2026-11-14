import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import type { WireNotification } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { startPhoneLink, type PhoneLinkControl } from '../src/phone-link.js'

/** The real link, asked the way a phone asks; the host behind it records what reaches it. */
const door = async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-memory-'))
  const reached: { method: string; params: unknown }[] = []
  let attached: PhoneLinkControl | null = null
  const host = {
    call: async (method: string, params: unknown) => { reached.push({ method, params }); return null },
    addBroadcaster: (_listener: (notification: WireNotification) => void) => () => {},
    attachPhoneLink: (control: PhoneLinkControl) => { attached = control },
  }
  const running = await startPhoneLink(host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk', workspaceDelayMs: 25 })
  const code = await running.control.pairing()
  const phone = await PhoneSim.fromCode(code.url)
  await phone.open(running.service.port, phone.offer!.deskPub)
  await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
  for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  running.control.allow(running.control.state().pending[0]!.id, ['read', 'run', 'answer'])
  await phone.next(message => message.t === 'enroll.ok')
  void attached
  return { phone, reached, done: async () => { phone.close(); await running.close(); await rm(home, { recursive: true, force: true }) } }
}

test('the phone may Keep or say No to a proposal and Forget one entry, and nothing else in memory', async () => {
  const d = await door()
  try {
    for (const params of [{ action: 'keep', id: 'c1' }, { action: 'keep', id: 'c2', text: 'Small pull requests.' }, { action: 'dismiss', id: 'c3' }, { action: 'forget', id: 'm1' }]) {
      const answer = await d.phone.request('lead/memory/change', params)
      assert.equal(answer.ok, true, JSON.stringify(params))
    }
    assert.deepEqual(d.reached.map(call => (call.params as { action: string }).action), ['keep', 'keep', 'dismiss', 'forget'])
  } finally { await d.done() }
})

for (const [what, params] of [
  ['Forget all', { action: 'forget-all' }],
  ['Undo', { action: 'undo', version: 3 }],
  ['Add', { action: 'add', text: 'A note from the phone.', kind: 'fact' }],
  ['the auto-keep switch', { action: 'auto', on: true }],
  ['Edit', { action: 'edit', id: 'm1', text: 'Changed on the phone.' }],
  ['Move', { action: 'move', id: 'm1', tier: 'archive' }],
] as const) {
  test(`the phone is refused ${what}, in plain words, and the desk never sees the request`, async () => {
    const d = await door()
    try {
      const answer = await d.phone.request('lead/memory/change', params)
      assert.equal(answer.ok, false)
      assert.equal(answer.error.code, 'notOnPhoneSurface')
      assert.match(answer.error.message, /^[A-Z][^{}<>]+\.$/, 'one plain sentence')
      assert.match(answer.error.message, /desk/)
      assert.deepEqual(d.reached, [])
    } finally { await d.done() }
  })
}
