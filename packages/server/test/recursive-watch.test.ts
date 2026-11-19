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

for (const parentFilename of ['native', 'named', 'null'] as const) test(`the Linux roster walker stays async and avoids nested links (parent filename: ${parentFilename})`, async t => {
  const root = tempDir('hd-recursive-async-'), outside = tempDir('hd-recursive-outside-')
  await mkdir(join(root, 'agent'))
  await symlink(outside, join(root, 'linked'))
  const fs = createRequire(import.meta.url)('node:fs')
  const originals = { lstatSync: fs.lstatSync, readdirSync: fs.readdirSync, watch: fs.watch }
  let watcher: ReturnType<typeof watchRoster> | undefined
  t.after(() => {
    try { watcher?.close() } finally { Object.assign(fs, originals); syncBuiltinESMExports() }
  })
  let rootCallback: ((event: string, file: string | Buffer | null) => void) | undefined
  let creatingAgent = false
  const attached = new Set<string>()
  fs.watch = (dir: string, options: unknown, listener: (event: string, file: string | Buffer | null) => void) => {
    const watcher = originals.watch(dir, options, (event: string, file: string | Buffer | null) => {
      if (creatingAgent && parentFilename !== 'native' && dir === root && String(file) === 'new-agent') listener(event, parentFilename === 'named' ? 'new-agent' : null)
      else listener(event, file)
    })
    if (dir === root) rootCallback = listener
    attached.add(dir)
    return watcher
  }
  const sync: string[] = []
  for (const [name, original] of Object.entries({ lstatSync: originals.lstatSync, readdirSync: originals.readdirSync })) fs[name] = (...args: unknown[]) => {
    if (String(args[0]).startsWith(root)) sync.push(name)
    return original(...args)
  }
  syncBuiltinESMExports()
  const changes: string[] = []
  const renames: (string | null)[] = []
  watcher = watchRoster(root, { recursive: true, persistent: false, platform: 'linux' }, (event, file) => {
    changes.push(String(file))
    if (event === 'rename') renames.push(file === null ? null : String(file))
  })
  assert.deepEqual(sync, [], 'starting a recursive watcher must not block file requests')
  const until = async (check: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 5000
    while (!await check()) { assert.ok(Date.now() < end, 'folder watch did not settle'); await new Promise(done => setTimeout(done, 10)) }
  }
  // Wait for the actual watcher before writing once; the same deadline still
  // covers attachment and the real child-file notification.
  const writeUntilWatched = (file: string) => {
    let written = false
    return until(async () => {
      if (changes.includes(file)) return true
      if (!written && attached.has(join(root, file.split('/')[0]!))) {
        written = true
        await writeFile(join(root, file), 'Synthetic agent')
      }
      return false
    })
  }
  await writeUntilWatched('agent/AGENT.md')
  const beforeMkdir = renames.length
  creatingAgent = true
  await mkdir(join(root, 'new-agent'))
  assert.ok(rootCallback, 'the real root watcher supplied its callback')
  if (parentFilename === 'native') {
    await until(() => renames.slice(beforeMkdir).some(file => file === 'new-agent' || file === null))
  } else {
    // Deliver an API-legal parent event through the real watcher's callback.
    const filename = parentFilename === 'named' ? 'new-agent' : null
    rootCallback('rename', filename)
    assert.ok(renames.slice(beforeMkdir).includes(filename), 'the parent rename was forwarded')
  }
  // Only a real child notification proves the new folder was watched; a
  // platform need not report a named event for the parent directory itself.
  await writeUntilWatched('new-agent/AGENT.md')
  const seen = changes.length
  await writeFile(join(outside, 'never-follow.md'), 'Outside the roster')
  await new Promise(done => setTimeout(done, 50))
  assert.equal(changes.slice(seen).some(file => file.includes('never-follow')), false)
  assert.deepEqual(sync, [], 'native rename reconciliation must be asynchronous too')
})
