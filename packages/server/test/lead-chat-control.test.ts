import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile, symlink, rename } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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

test('a chat the Lead never wrote to can be held before its first Lead record', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  assert.equal(await store.holder(project, 'codex:s1'), null)
  assert.equal(await store.setHolder(project, 'fixture:s1', 'person', true), true)
  await store.noteSent(project, 'fixture:s1', 'a'.repeat(64))
  assert.equal(await new LeadChatControlStore(file).holder(project, 'fixture:s1'), 'person')
  assert.throws(() => store.assertDispatch(project, 'fixture:s1'), /taken this chat over/)
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


test('project switches preserve independent person holds', async t => {
  const { root, project, file } = await fixture(t)
  const other = join(root, 'other'); await mkdir(other)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'fixture:a', 'a'.repeat(64))
  await store.setHolder(project, 'fixture:a', 'person')
  await store.noteSent(other, 'fixture:b', 'b'.repeat(64))
  assert.equal(await store.holder(project, 'fixture:a'), 'person')
  assert.equal(await new LeadChatControlStore(file).holder(project, 'fixture:a'), 'person')
  assert.equal(await store.holder(other, 'fixture:b'), 'lead')
})

test('eviction drops Lead entries first and never removes a person hold', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'fixture:held', 'a'.repeat(64))
  await store.setHolder(project, 'fixture:held', 'person')
  for (let i = 0; i < 70; i++) await store.noteSent(project, `fixture:s${i}`, 'b'.repeat(64))
  assert.equal(await store.holder(project, 'fixture:held'), 'person')
  assert.equal((await store.list(project)).chats.length, 64)
})

test('64 person holds refuse another Lead chat without losing any hold', async t => {
  const { project, file } = await fixture(t)
  const chats = Array.from({ length: 64 }, (_, i) => ({ id: `fixture:s${i}`, holder: 'person', sent: ['a'.repeat(64)] }))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, project, chats }))
  const store = new LeadChatControlStore(file)
  const before = await readFile(file, 'utf8')
  await assert.rejects(store.noteSent(project, 'fixture:new', 'b'.repeat(64)), /64|full|hand back/i)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal((await store.list(project)).chats.filter(c => c.holder === 'person').length, 64)
})

for (const shape of ['truncated', 'oversize', 'symlink', 'bad key', 'duplicate ids', 'too many chats', 'project mismatch', 'extra field', 'duplicate keys', 'bad holder', 'bad projects', 'noncanonical project'] as const) {
  test(`an existing ${shape} control record refuses reads and writes without replacing it`, async t => {
    const { root, project, file } = await fixture(t)
    await mkdir(join(file, '..'), { recursive: true })
    const chat = { id: 'fixture:s1', holder: 'person', sent: ['a'.repeat(64)] }
    let value: unknown = { version: 1, project, chats: [chat] }
    if (shape === 'bad key') value = { version: 1, project, chats: [{ ...chat, sent: ['nothex'] }] }
    if (shape === 'duplicate ids') value = { version: 1, project, chats: [chat, chat] }
    if (shape === 'too many chats') value = { version: 1, project, chats: Array.from({ length: 65 }, (_, i) => ({ ...chat, id: `fixture:s${i}` })) }
    if (shape === 'project mismatch') value = { version: 1, project: root, chats: [chat] }
    if (shape === 'extra field') value = { version: 1, project, chats: [chat], repaired: true }
    if (shape === 'duplicate keys') value = { version: 1, project, chats: [{ ...chat, sent: ['a'.repeat(64), 'a'.repeat(64)] }] }
    if (shape === 'bad holder') value = { version: 1, project, chats: [{ ...chat, holder: 'unknown' }] }
    if (shape === 'bad projects') value = { version: 2, projects: [] }
    if (shape === 'noncanonical project') value = { version: 2, projects: { [join(project, '..') + '/w/../w']: [chat] } }
    const bytes = shape === 'truncated' ? '{' : shape === 'oversize' ? ' '.repeat(256 * 1024 + 1) : JSON.stringify(value)
    if (shape === 'symlink') { const target = join(root, 'target.json'); await writeFile(target, bytes); await symlink(target, file) }
    else await writeFile(file, bytes)
    const store = new LeadChatControlStore(file)
    await assert.rejects(store.holder(project, 'fixture:s1'), /control record.*reset|reset.*control record/i)
    await assert.rejects(store.noteSent(project, 'fixture:new', 'b'.repeat(64)), /control record.*reset|reset.*control record/i)
    assert.equal(await readFile(file, 'utf8'), bytes)
  })
}

test('a failed person hold persistence keeps the synchronous hold until explicit recovery', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'fixture:s1', 'a'.repeat(64))
  const old = `${file}.old`; await rename(file, old); await mkdir(file)
  const pending = store.setHolder(project, 'fixture:s1', 'person')
  assert.throws(() => store.assertDispatch(project, 'fixture:s1'), /taken|control record/i)
  await assert.rejects(pending)
  assert.throws(() => store.assertDispatch(project, 'fixture:s1'), /taken|control record/i)
})

test('explicit reset is the only recovery from a damaged record', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'fixture:s1', 'a'.repeat(64))
  await writeFile(file, '{')
  await assert.rejects(store.holder(project, 'fixture:s1'))
  await store.reset()
  assert.deepEqual(await store.list(project), { project, chats: [] })
  await store.noteSent(project, 'fixture:s2', 'b'.repeat(64))
  assert.equal(await store.holder(project, 'fixture:s2'), 'lead')
})

test('a new take-over during explicit reset keeps its fence and is persisted afterwards', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'fixture:s1', 'a'.repeat(64))
  const resetting = store.reset()
  const taking = store.setHolder(project, 'fixture:s1', 'person')
  await resetting
  assert.equal(await taking, true)
  assert.throws(() => store.assertDispatch(project, 'fixture:s1'), /taken this chat over/)
  assert.equal(await new LeadChatControlStore(file).holder(project, 'fixture:s1'), 'person')
})

for (const code of ['EMFILE', 'EBUSY']) test(`a transient ${code} read refuses once without latching or losing a hold`, async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  await store.noteSent(project, 'fixture:held', 'a'.repeat(64))
  await store.setHolder(project, 'fixture:held', 'person')
  const open = fsPromises.open
  let fail = true
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (fail) { fail = false; throw Object.assign(new Error('Synthetic transient read failure'), { code }) }
    return open(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(store.list(project))
    assert.equal(store.problem, null, 'transient I/O does not require a destructive reset')
    assert.throws(() => store.assertDispatch(project, 'fixture:other'), /temporarily unavailable/, 'unknown state refuses synchronous dispatch too')
    assert.equal(await store.holder(project, 'fixture:held'), 'person')
    await store.noteSent(project, 'fixture:other', 'b'.repeat(64))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
})

test('a deleted project keeps its holds without blocking another project', async t => {
  const { root, project, file } = await fixture(t)
  const stale = join(root, 'stale'); await mkdir(stale)
  const store = new LeadChatControlStore(file)
  await store.noteSent(stale, 'fixture:old', 'b'.repeat(64))
  await store.setHolder(stale, 'fixture:old', 'person')
  await rm(stale, { recursive: true })
  await store.noteSent(project, 'fixture:current', 'a'.repeat(64))
  assert.equal(await store.holder(project, 'fixture:current'), 'lead')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.projects[stale][0].holder, 'person')
  await mkdir(stale)
  assert.equal(await new LeadChatControlStore(file).holder(stale, 'fixture:old'), 'person')
})

for (const staleKind of ['not-directory', 'symlink'] as const) test(`a stale ${staleKind} project keeps its record without blocking other projects`, async t => {
  const { root, project, file } = await fixture(t)
  const parent = join(root, 'old-parent'), stale = join(parent, 'stale')
  await mkdir(stale, { recursive: true })
  const store = new LeadChatControlStore(file)
  await store.noteSent(stale, 'fixture:old', 'b'.repeat(64))
  await store.setHolder(stale, 'fixture:old', 'person')
  await rm(parent, { recursive: true })
  if (staleKind === 'not-directory') await writeFile(parent, 'replaced')
  else { await mkdir(parent); await symlink(project, stale) }
  await store.noteSent(project, 'fixture:current', 'a'.repeat(64))
  assert.equal(await store.holder(project, 'fixture:current'), 'lead')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[stale][0].holder, 'person')
  await rm(parent, { recursive: true, force: true }); await mkdir(stale, { recursive: true })
  assert.equal(await new LeadChatControlStore(file).holder(stale, 'fixture:old'), 'person')
})

test('a valid-shaped unknown chat cannot reserve a person slot', async t => {
  const { project, file } = await fixture(t)
  const store = new LeadChatControlStore(file)
  assert.equal(await store.setHolder(project, 'fixture:invented', 'person'), false)
  assert.deepEqual((await store.list(project)).chats, [])
  assert.equal(await store.holder(project, 'fixture:invented'), null)
})
