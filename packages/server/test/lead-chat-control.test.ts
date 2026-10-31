import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LeadChatControlStore } from '../src/lead/chat-control.js'

const fixture = async (t: test.TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hd-chat-control-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'w')
  await (await import('node:fs/promises')).mkdir(project)
  return { root, project, file: join(root, 'lead', 'chat-control.json') }
}

test('a chat the Lead never wrote to has no holder and cannot be taken over', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  assert.equal(await store.holder(project, 'codex:s1'), null)
  assert.equal(await store.setHolder(project, 'codex:s1', 'person'), false)
  assert.deepEqual(await store.list(project), { project, chats: [] })
})

test('the first send makes the Lead the holder; take over and hand back persist across instances', async t => {
  const { project, file } = await fixture(t)
  await new LeadChatControlStore(file).noteSent(project, 'codex:s1', 'a'.repeat(64))
  assert.equal(await new LeadChatControlStore(file).holder(project, 'codex:s1'), 'lead')
  assert.equal(await new LeadChatControlStore(file).setHolder(project, 'codex:s1', 'person'), true)
  assert.equal(await new LeadChatControlStore(file).holder(project, 'codex:s1'), 'person')
  await new LeadChatControlStore(file).noteSent(project, 'codex:s1', 'b'.repeat(64))
  assert.equal(await new LeadChatControlStore(file).holder(project, 'codex:s1'), 'person', 'a send never takes a chat back')
  assert.deepEqual((await new LeadChatControlStore(file).list(project)).chats[0]!.sent, ['a'.repeat(64), 'b'.repeat(64)])
})

test('bounded: 64 chats, 32 keys a chat, oldest out first', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  for (let i = 0; i < 70; i++) await store.noteSent(project, `codex:s${i}`, i.toString(16).padStart(64, '0'))
  const { chats } = await store.list(project)
  assert.equal(chats.length, 64)
  assert.equal(chats[0]!.id, 'codex:s6')
  for (let i = 0; i < 40; i++) await store.noteSent(project, 'codex:s69', i.toString(16).padStart(64, 'f'))
  assert.equal((await store.list(project)).chats.at(-1)!.sent.length, 32)
})

test('another project, a malformed file or a bad key reads as empty, never as a grant', async t => {
  const { root, project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'codex:s1', 'a'.repeat(64))
  assert.deepEqual(await store.list(root), { project: root, chats: [] })
  await writeFile(file, '{"version":1,"project":"' + project + '","chats":[{"id":"codex:s1","holder":"lead","sent":["nothex"]}]}')
  assert.deepEqual(await store.list(project), { project, chats: [] })
  await assert.rejects(store.noteSent(project, 'codex:s1', 'nothex'))
})
