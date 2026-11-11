import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PhoneSim } from '@harnessdesk/phone-link/sim'
import { LEAD_AUTONOMY_DEFAULTS, parseLeadSettingsProposal, type LeadAutonomyView, type LeadSettingsChange, type PhoneLeadMemory, type WireNotification } from '@harnessdesk/protocol'
import { Logger } from '../src/log.js'
import { startPhoneLink } from '../src/phone-link.js'
import { phoneAutonomy, phoneMemory } from '../src/phone-work.js'

/** The real link, asked the way a phone asks; the host behind it records what reaches it. */
const door = async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-phone-settings-'))
  const reached: { method: string; params: unknown }[] = []
  const host = {
    call: async (method: string, params: unknown) => { reached.push({ method, params }); return null },
    addBroadcaster: (_listener: (notification: WireNotification) => void) => () => {},
    attachPhoneLink: () => {},
  }
  const running = await startPhoneLink(host as never, new Logger('test', { console: false }), { home, host: '127.0.0.1', includeLoopback: true, name: 'Test desk', workspaceDelayMs: 25 })
  const code = await running.control.pairing()
  const phone = await PhoneSim.fromCode(code.url)
  await phone.open(running.service.port, phone.offer!.deskPub)
  await phone.enroll(phone.offer!.enroll, 'Jane’s phone')
  for (let i = 0; i < 200 && running.control.state().pending.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  running.control.allow(running.control.state().pending[0]!.id, ['read', 'run', 'answer'])
  await phone.next(message => message.t === 'enroll.ok')
  return { phone, reached, done: async () => { phone.close(); await running.close(); await rm(home, { recursive: true, force: true }) } }
}

test('#2106 review: a phone\'s answer on a settings card reaches the desk under the phone\'s own name, whatever the request says', async () => {
  const d = await door()
  try {
    const forged = { id: 'window:forged', label: 'Forged desktop' }
    assert.equal((await d.phone.request('lead/settings/decide', { id: 's1', decision: 'apply', device: forged })).ok, true)
    assert.equal((await d.phone.request('lead/settings/decide', { id: 's2', decision: 'decline' })).ok, true)
    assert.equal(d.reached.length, 2)
    for (const call of d.reached) assert.match((call.params as { device: { id: string } }).device.id, /^phone:/, 'the desk can tell a phone\'s Apply from the window\'s')
  } finally { await d.done() }
})

test('#2106 review: the Lead\'s proposal words reach the phone through the same scrub as the work board', () => {
  const view: LeadAutonomyView = { version: 1, modes: LEAD_AUTONOMY_DEFAULTS, observed: [], rules: [], deadline: null, proposals: [
    { id: 's1', state: 'pending', proposedAt: 1, afterSeq: 1, history: [{ what: 'proposed', at: 1 }],
      change: { kind: 'rules', section: 'talk', fromVersion: 0, text: 'Keep it short.\nMail dev@example.com the notes in /srv/acme/private/notes.txt', add: 'Mail dev@example.com the notes in /srv/acme/private/notes.txt' } },
    { id: 's2', state: 'pending', proposedAt: 1, afterSeq: 1, history: [{ what: 'proposed', at: 1 }],
      change: { kind: 'rules', section: 'done', fromVersion: 0, text: 'Line one.\nToken pk_fixture_placeholder goes here.' } },
    { id: 's3', state: 'pending', proposedAt: 1, afterSeq: 1, history: [{ what: 'proposed', at: 1 }],
      change: { kind: 'autonomy', autonomy: 'stuck', from: 'act', to: 'off' } },
  ] }
  const out = phoneAutonomy(view).proposals!
  const [add, whole, mode] = out.map(one => one.change)
  assert.ok(add?.kind === 'rules' && whole?.kind === 'rules')
  for (const text of [add.add!, add.text, whole.text]) {
    assert.doesNotMatch(text, /dev@example\.com|\/srv\/acme|pk_fixture_placeholder/, text)
  }
  assert.match(add.text, /^Keep it short\.\n/, 'a section keeps its lines')
  assert.match(whole.text, /^Line one\.\n/)
  assert.deepEqual(mode, view.proposals![2]!.change, 'a mode card carries no words to scrub')
  const memory: PhoneLeadMemory = { revision: 1, core: 0, archive: 0, auto: false,
    inbox: [{ id: 'c1', text: 'Notes live in /srv/acme/private/notes.txt', kind: 'fact', afterSeq: 1, proposedAt: 1 } as never] }
  assert.doesNotMatch(phoneMemory(memory).inbox[0]!.text, /\/srv\/acme/)
})

test('#2117 review 2: the phone is told outright which cards it answers No only, never left to infer it from a missing line', () => {
  const card = (id: string, change: LeadSettingsChange) => ({ id, state: 'pending' as const, proposedAt: 1, afterSeq: 1, history: [{ what: 'proposed' as const, at: 1 }], change })
  const view: LeadAutonomyView = { version: 1, modes: LEAD_AUTONOMY_DEFAULTS, observed: [], rules: [], deadline: null, proposals: [
    card('s1', { kind: 'rules', section: 'talk', fromVersion: 0, text: 'Keep it short.\nSend review notes to ops@acme.dev', add: 'Send review notes to ops@acme.dev' }),
    card('s2', { kind: 'rules', section: 'talk', fromVersion: 0, text: 'Keep it short.\n \u3000 ', add: ' \u3000 ' }),
    card('s3', { kind: 'rules', section: 'done', fromVersion: 0, text: 'Whole new words.' }),
    card('s4', { kind: 'rules', section: 'delegate', fromVersion: 0, text: 'Keep it short.\nConclusion first.', add: 'Conclusion first.' }),
    card('s5', { kind: 'autonomy', autonomy: 'stuck', from: 'act', to: 'off' }),
  ] }
  const out = phoneAutonomy(view).proposals!
  assert.deepEqual(out.map(one => [one.id, one.deskOnly ?? false]), [['s1', true], ['s2', true], ['s3', true], ['s4', false], ['s5', false]])
  const [hidden, empty, , shown] = out.map(one => one.change)
  assert.ok(hidden?.kind === 'rules' && empty?.kind === 'rules' && shown?.kind === 'rules')
  assert.doesNotMatch(hidden.add!, /ops@acme\.dev/, 'the phone still never sees the address')
  assert.equal(empty.add, undefined, 'a line the scrub empties is not sent')
  assert.equal(shown.add, 'Conclusion first.', 'a line shown exactly applies from the phone')
  for (const one of out) assert.deepEqual(parseLeadSettingsProposal(one), one, 'the phone\'s copy is a valid proposal')
})
