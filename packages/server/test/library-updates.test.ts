import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyLibrary, currentSkillBundleDigest, digestOf, LibraryManifest, planLibrary, readLibrary } from '@harnessdesk/agent-inventory'
import { runtimeId, type LibraryCopy } from '@harnessdesk/protocol'
import { LibraryUpdates } from '../src/library-updates.js'

const agents = [{ id: runtimeId('codex'), brand: 'codex' }]
const origin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: 'a'.repeat(40), path: 'demo' }

test('library/read exposes only this host lifetime checks for installed origins and never checks the source', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-library-updates-'))
  const libraryDir = join(home, 'library')
  let calls = 0
  const source = { check: async () => { calls++; return { latest: 'b'.repeat(40), status: 'behind' as const, reason: null } } }
  try {
    const dir = join(libraryDir, 'sources/acme-dev__skills', origin.commit, 'demo')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nRead this.\n')
    const plan = await planLibrary(agents, [{ kind: 'installSkill', name: 'demo', targetRuntime: agents[0]!.id, sourcePath: dir, origin: { ...origin, bundle: currentSkillBundleDigest(dir)! } }], { home, libraryDir })
    assert.equal((await applyLibrary(plan.ops, { home, libraryDir }))[0]?.outcome, 'done')
    await mkdir(join(home, '.codex/skills/local'), { recursive: true })
    await writeFile(join(home, '.codex/skills/local/SKILL.md'), 'Local instructions')
    const updates = new LibraryUpdates(libraryDir, source, home)
    const before = (await updates.read(agents, {})).entries.find(one => one.name === 'demo')
    assert.deepEqual(before?.copies[0], { ...before?.copies[0], origin })
    assert.equal(before?.update, undefined)
    assert.equal(calls, 0)
    assert.deepEqual(await updates.check(agents, ['local', 'missing']), [])
    assert.equal(calls, 0)
    const result = await updates.check(agents, ['demo'])
    assert.deepEqual(result, [{ name: 'demo', runtime: agents[0]!.id, origin, latest: 'b'.repeat(40), status: 'behind', reason: null }])
    assert.equal(calls, 1)
    const read = await updates.read(agents, {})
    const installed = read.entries.find(one => one.name === 'demo')
    assert.deepEqual(installed?.update, result)
    assert.deepEqual(installed?.copies[0], before?.copies[0])
    assert.equal(read.entries.find(one => one.name === 'local')?.update, undefined)
    assert.equal(calls, 1)
    const restarted = (await new LibraryUpdates(libraryDir, source, home).read(agents, {})).entries.find(one => one.name === 'demo')
    assert.deepEqual(restarted?.copies[0], before?.copies[0])
    assert.equal(restarted?.update, undefined)
    assert.equal(calls, 1)
    const manifest = await LibraryManifest.load(libraryDir)
    const target = join(home, '.codex/skills/demo')
    const recorded = manifest.find('skill', target, 'demo')!
    const nextOrigin = { ...origin, commit: 'b'.repeat(40) }
    manifest.record({ ...recorded, origin: nextOrigin })
    await manifest.save()
    const updated = (await updates.read(agents, {})).entries.find(one => one.name === 'demo')
    assert.deepEqual(updated?.copies[0], { ...before?.copies[0], origin: nextOrigin })
    assert.equal(updated?.update, undefined)
    assert.equal(calls, 1)
    await rm(target, { recursive: true })
    assert.deepEqual(await updates.check(agents), [])
    assert.equal(calls, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('host wire checks the source only on request, then library/read carries the result', async (t) => {
  const { Client, start, stop } = await import('./fixtures/harness.js')
  const { FakeRuntime } = await import('./fixtures/fake-runtime.js')
  const home = await mkdtemp(join(tmpdir(), 'hd-library-update-wire-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let calls = 0
  const rig = await start({ libraryHome: home, librarySources: { transport: () => { calls++; throw new Error('offline') } } }, undefined, new FakeRuntime({ brand: 'codex' }))
  t.after(() => stop(rig))
  const target = join(home, '.codex/skills/demo')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), 'Demo instructions')
  const manifest = await LibraryManifest.load(join(rig.stateDir, 'library'))
  manifest.record({ kind: 'skill', name: 'demo', path: target, digest: digestOf('Demo instructions'), bundle: currentSkillBundleDigest(target)!, at: Date.now(), origin })
  await manifest.save()
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const before = await client.call('library/read', {}) as import('@harnessdesk/protocol').Library
  const installed = before.entries.find(one => one.name === 'demo')
  assert.deepEqual(installed?.copies[0], { ...installed?.copies[0], origin })
  assert.equal(installed?.update, undefined)
  assert.equal(calls, 0)
  const checked = await client.call('library/sources/check', { names: ['demo'] }) as import('@harnessdesk/protocol').LibrarySkillUpdate[]
  assert.equal(checked[0]?.status, 'unreachable')
  assert.equal(calls, 1)
  const after = await client.call('library/read', {}) as import('@harnessdesk/protocol').Library
  assert.deepEqual(after.entries.find(one => one.name === 'demo')?.update, checked)
  assert.deepEqual(after.entries.find(one => one.name === 'demo')?.copies, installed?.copies)
  assert.equal(calls, 1)
})

test("library/read carries each copy's recorded origin without calling a throwing source", async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-library-copy-origins-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const libraryDir = join(home, 'library')
  const manifest = await LibraryManifest.load(libraryDir)
  const bothAgents = [...agents, { id: runtimeId('claudecode'), brand: 'claudecode' }]
  const copies = [
    { path: join(home, '.codex/skills/demo'), origin },
    { path: join(home, '.claude/skills/demo'), origin: { ...origin, commit: 'c'.repeat(40) } },
  ]
  for (const copy of copies) {
    await mkdir(copy.path, { recursive: true })
    await writeFile(join(copy.path, 'SKILL.md'), 'Demo instructions')
    manifest.record({ kind: 'skill', name: 'demo', ...copy, digest: digestOf('Demo instructions'), at: Date.now() })
  }
  await manifest.save()
  let calls = 0
  const updates = new LibraryUpdates(libraryDir, { check: async () => { calls++; throw new Error('read must never check a source') } }, home)
  const entry = (await updates.read(bothAgents, {})).entries.find(one => one.name === 'demo')
  assert.equal(entry?.copies.length, 2)
  for (const expected of copies) {
    const copy: LibraryCopy | undefined = entry?.copies.find(one => one.path === expected.path)
    assert.deepEqual(copy, { ...copy, origin: expected.origin })
  }
  assert.equal(entry?.update, undefined)
  assert.equal(calls, 0)
})

test('library/read leaves local, unknown, malformed, hollow and MCP copies without origins', async (t) => {
  t.mock.method(Date, 'now', () => 1_800_000_000_000)
  const home = await mkdtemp(join(tmpdir(), 'hd-library-no-origins-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const libraryDir = join(home, 'library')
  const manifest = await LibraryManifest.load(libraryDir)
  for (const name of ['local', 'unknown', 'malformed', 'hollow']) {
    const target = join(home, '.codex/skills', name)
    await mkdir(target, { recursive: true })
    if (name !== 'hollow') await writeFile(join(target, 'SKILL.md'), 'Local instructions')
    if (name !== 'unknown') manifest.record({
      kind: 'skill', name, path: target, digest: digestOf('Local instructions'), at: Date.now(),
      ...(name === 'hollow' ? { origin } : name === 'malformed' ? { origin: { ...origin, commit: 'invalid' } } : {}),
    })
  }
  const config = join(home, '.codex/config.toml')
  await writeFile(config, '[mcp_servers.demo]\ncommand = "demo"\n')
  manifest.record({ kind: 'mcp', name: 'demo', path: config, digest: 'unused', at: Date.now(), origin })
  await manifest.save()
  const updates = new LibraryUpdates(libraryDir, { check: async () => { throw new Error('read must never check a source') } }, home)
  const library = await updates.read(agents, {})
  assert.equal(library.entries.length, 5)
  assert.deepEqual(library, await readLibrary(agents, { home }))
  for (const entry of library.entries) {
    assert.equal(entry.update, undefined)
    for (const copy of entry.copies) assert.equal('origin' in copy, false, entry.name)
  }
})
