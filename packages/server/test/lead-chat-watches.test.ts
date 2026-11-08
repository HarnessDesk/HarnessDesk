import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const load = async () => {
  const module = '../src/lead/chat-watches.js'
  return import(module) as Promise<{ LeadChatWatches: new (file: string) => { read(project: string): Promise<readonly string[]>; watch(project: string, id: string): Promise<void> } }>
}

test('tracked chats survive recreation, stay project-pinned and retain the newest 64 unique ids', async t => {
  const directory = await mkdtemp('/tmp/hd-chat-watch-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = await realpath(directory), other = join(project, 'other')
  await mkdir(other)
  const file = join(directory, 'lead', 'chats.json')
  const { LeadChatWatches } = await load()
  const watches = new LeadChatWatches(file)
  assert.deepEqual(await watches.read(project), [])
  await Promise.all(Array.from({ length: 70 }, (_, n) => watches.watch(project, `demo:session-${n}`)))
  assert.deepEqual(await new LeadChatWatches(file).read(project), Array.from({ length: 64 }, (_, n) => `demo:session-${n + 6}`))
  await watches.watch(project, 'demo:session-6')
  assert.equal((await watches.read(project)).length, 64)
  assert.equal((await watches.read(project)).at(-1), 'demo:session-6')
  assert.deepEqual(await watches.read(other), [])
  assert.ok((await readFile(file, 'utf8')).length < 64 * 1024)
  await watches.watch(other, 'demo:other')
  assert.deepEqual(await watches.read(project), [])
  assert.deepEqual(await watches.read(other), ['demo:other'])
})

test('watch records fail closed on malformed, oversized, missing-project and noncanonical input', async t => {
  const directory = await mkdtemp('/tmp/hd-chat-watch-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = await realpath(directory), file = join(directory, 'chats.json')
  const { LeadChatWatches } = await load()
  const watches = new LeadChatWatches(file)
  for (const contents of ['broken', 'x'.repeat(64 * 1024 + 1), JSON.stringify({ version: 1, project, ids: [''] }), JSON.stringify({ version: 1, project, ids: Array(65).fill('demo:s') })]) {
    await writeFile(file, contents)
    assert.deepEqual(await watches.read(project), [])
  }
  await assert.rejects(watches.watch(project, ''))
  await assert.rejects(watches.watch(project, 'x'.repeat(301)))
  await assert.rejects(watches.watch(join(project, 'missing'), 'demo:s'))
  await assert.rejects(watches.watch(`${project}/.`, 'demo:s'))
})
