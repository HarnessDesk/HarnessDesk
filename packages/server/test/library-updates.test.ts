import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyLibrary, currentSkillBundleDigest, planLibrary } from '@harnessdesk/agent-inventory'
import { runtimeId } from '@harnessdesk/protocol'
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
    assert.equal((await updates.read(agents, {})).entries.find(one => one.name === 'demo')?.update, undefined)
    assert.equal(calls, 0)
    assert.deepEqual(await updates.check(agents, ['local', 'missing']), [])
    assert.equal(calls, 0)
    const result = await updates.check(agents, ['demo'])
    assert.deepEqual(result, [{ name: 'demo', runtime: agents[0]!.id, origin, latest: 'b'.repeat(40), status: 'behind', reason: null }])
    assert.equal(calls, 1)
    const read = await updates.read(agents, {})
    assert.deepEqual(read.entries.find(one => one.name === 'demo')?.update, result)
    assert.equal(read.entries.find(one => one.name === 'local')?.update, undefined)
    assert.equal(calls, 1)
    assert.equal((await new LibraryUpdates(libraryDir, source, home).read(agents, {})).entries.find(one => one.name === 'demo')?.update, undefined)
    assert.equal(calls, 1)
    await rm(join(home, '.codex/skills/demo'), { recursive: true })
    assert.deepEqual(await updates.check(agents), [])
    assert.equal(calls, 1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('host wire checks the source only on request, then library/read carries the result', async (t) => {
  const { LibraryManifest, digestOf } = await import('@harnessdesk/agent-inventory')
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
  assert.equal(before.entries.find(one => one.name === 'demo')?.update, undefined)
  assert.equal(calls, 0)
  const checked = await client.call('library/sources/check', { names: ['demo'] }) as import('@harnessdesk/protocol').LibrarySkillUpdate[]
  assert.equal(checked[0]?.status, 'unreachable')
  assert.equal(calls, 1)
  const after = await client.call('library/read', {}) as import('@harnessdesk/protocol').Library
  assert.deepEqual(after.entries.find(one => one.name === 'demo')?.update, checked)
  assert.equal(calls, 1)
})
