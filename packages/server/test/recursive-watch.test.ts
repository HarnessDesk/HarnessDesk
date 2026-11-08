import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'

import { watchRoster } from '../src/recursive-watch.js'
import { tempDir } from './scratch.js'

test('a missing recursive watch root refuses instead of returning an inert watcher', () => {
  const root = join(tempDir('hd-recursive-watch-'), 'missing')
  let watcher = null as ReturnType<typeof watchRoster> | null
  try {
    assert.throws(() => {
      watcher = watchRoster(root, { recursive: true, persistent: false }, () => {})
    }, { code: 'ENOENT' })
  } finally {
    watcher?.close()
  }
})

test('the Linux roster walker never reads synchronously and never follows a nested link', async t => {
  const root = tempDir('hd-recursive-async-'), outside = tempDir('hd-recursive-outside-')
  await mkdir(join(root, 'agent'))
  await symlink(outside, join(root, 'linked'))
  const fs = createRequire(import.meta.url)('node:fs')
  const originals = { lstatSync: fs.lstatSync, readdirSync: fs.readdirSync }
  const sync: string[] = []
  for (const [name, original] of Object.entries(originals)) fs[name] = (...args: unknown[]) => {
    if (String(args[0]).startsWith(root)) sync.push(name)
    return original(...args)
  }
  syncBuiltinESMExports()
  const changes: string[] = []
  const watcher = watchRoster(root, { recursive: true, persistent: false, platform: 'linux' }, (_event, file) => changes.push(String(file)))
  t.after(() => { watcher.close(); Object.assign(fs, originals); syncBuiltinESMExports() })
  assert.deepEqual(sync, [], 'starting a recursive watcher must not block file requests')
  const until = async (check: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 5000
    while (!await check()) { assert.ok(Date.now() < end, 'folder watch did not settle'); await new Promise(done => setTimeout(done, 10)) }
  }
  // Repeated writes also wait for the initial asynchronous walk to attach.
  const writeUntilWatched = (file: string) => until(async () => {
    if (changes.includes(file)) return true
    await writeFile(join(root, file), 'Synthetic agent')
    return false
  })
  await writeUntilWatched('agent/AGENT.md')
  await mkdir(join(root, 'new-agent'))
  await until(() => changes.includes('new-agent'))
  await writeUntilWatched('new-agent/AGENT.md')
  const seen = changes.length
  await writeFile(join(outside, 'never-follow.md'), 'Outside the roster')
  await new Promise(done => setTimeout(done, 50))
  assert.equal(changes.slice(seen).some(file => file.includes('never-follow')), false)
  assert.deepEqual(sync, [], 'native rename reconciliation must be asynchronous too')
})
