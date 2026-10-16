import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runtimeId, type LibraryIntent } from '@harnessdesk/protocol'
import { applyLibrary, currentSkillBundleDigest, LibraryManifest, planLibrary } from '../src/index.js'

const BODY = '---\nname: demo\ndescription: Demo skill\n---\nRead this.\n'
const agents = [{ id: runtimeId('codex'), brand: 'codex' }]
const baseOrigin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: 'a'.repeat(40), path: 'demo' }

async function fixture(fn: (home: string, libraryDir: string, target: string, source: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'hd-skill-updates-'))
  const libraryDir = join(home, 'library')
  const source = join(libraryDir, 'sources/acme-dev__skills', baseOrigin.commit, 'demo')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), BODY)
    await writeFile(join(source, 'old.md'), 'Old note')
    await writeFile(join(source, 'same.md'), 'Same note')
    const plan = await planLibrary(agents, [{ kind: 'installSkill', name: 'demo', targetRuntime: agents[0]!.id, sourcePath: source, origin: { ...baseOrigin, bundle: currentSkillBundleDigest(source)! } }], { home, libraryDir })
    assert.equal((await applyLibrary(plan.ops, { home, libraryDir }))[0]?.outcome, 'done')
    const next = join(libraryDir, 'sources/acme-dev__skills', 'b'.repeat(40), 'demo')
    await mkdir(next, { recursive: true })
    await writeFile(join(next, 'SKILL.md'), BODY + 'New instructions.\n')
    await writeFile(join(next, 'same.md'), 'Same note')
    await writeFile(join(next, 'run.sh'), 'echo demo\n')
    await fn(home, libraryDir, join(home, '.codex/skills/demo'), next)
  } finally { await rm(home, { recursive: true, force: true }) }
}

const intent = (source: string): Extract<LibraryIntent, { kind: 'updateSkill' }> => ({ kind: 'updateSkill', name: 'demo', targetRuntime: agents[0]!.id, origin: { ...baseOrigin, commit: 'b'.repeat(40), bundle: currentSkillBundleDigest(source)! } })

test('update plans added, changed and removed files; apply rechecks acknowledgement and removes listed files', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    const plan = await planLibrary(agents, [intent(source)], { home, libraryDir })
    const op = plan.ops[0]!
    assert.equal(op.action, 'update')
    assert.deepEqual(op.files?.map(({ path, change, runnable, binary }) => ({ path, change, runnable, binary })), [
      { path: 'SKILL.md', change: 'changed', runnable: false, binary: false },
      { path: 'old.md', change: 'removed', runnable: false, binary: false },
      { path: 'run.sh', change: 'added', runnable: true, binary: false },
    ])
    const refused = await applyLibrary([{ ...op, files: [] }], { home, libraryDir })
    assert.equal(refused[0]?.outcome, 'failed')
    assert.match(refused[0]?.detail ?? '', /acknowledge/)
    assert.equal(await readFile(join(target, 'old.md'), 'utf8'), 'Old note')
    assert.equal((await applyLibrary([{ ...op, acknowledged: true }], { home, libraryDir }))[0]?.outcome, 'done')
    await assert.rejects(readFile(join(target, 'old.md')), { code: 'ENOENT' })
    assert.equal(await readFile(join(target, 'same.md'), 'utf8'), 'Same note')
    assert.equal((await LibraryManifest.load(libraryDir)).find('skill', target, 'demo')?.origin?.commit, 'b'.repeat(40))
  })
})

test('an edited installed copy plans a replacement with a backup', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    await writeFile(join(target, 'same.md'), 'My own note')
    const op = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    assert.equal(op.action, 'replace')
    assert.equal(op.backup, true)
    const result = (await applyLibrary([{ ...op, acknowledged: true }], { home, libraryDir }))[0]!
    assert.equal(result.outcome, 'done')
    assert.equal(await readFile(join(result.backupPath!, 'same.md'), 'utf8'), 'My own note')
  })
})

test('an update refuses a fetched source changed after planning', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    const op = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    await writeFile(join(source, 'run.sh'), 'echo changed\n')
    const result = (await applyLibrary([{ ...op, acknowledged: true }], { home, libraryDir }))[0]!
    assert.equal(result.outcome, 'failed')
    assert.match(result.detail ?? '', /changed/)
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), BODY)
  })
})

test('update refuses a local install and an unrelated repository origin', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    const update = intent(source)
    await cp(source, join(libraryDir, 'sources/acme-dev__other', update.origin.commit, 'demo'), { recursive: true })
    assert.equal((await planLibrary(agents, [{ ...update, origin: { ...update.origin, url: 'https://github.com/acme-dev/other' } } as LibraryIntent], { home, libraryDir })).ops[0]?.action, 'refuse')
    const manifest = await LibraryManifest.load(libraryDir)
    const { origin: _origin, ...local } = manifest.find('skill', target, 'demo')!
    manifest.record(local)
    await manifest.save()
    assert.equal((await planLibrary(agents, [update], { home, libraryDir })).ops[0]?.action, 'refuse')
  })
})

test('an unchanged revision still records the new origin, with no file changes', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    await rm(join(source, 'run.sh'))
    await writeFile(join(source, 'SKILL.md'), BODY)
    await writeFile(join(source, 'old.md'), 'Old note')
    const op = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    assert.equal(op.action, 'update')
    assert.deepEqual(op.files, [])
    assert.equal((await applyLibrary([op], { home, libraryDir }))[0]?.outcome, 'done')
    assert.equal((await LibraryManifest.load(libraryDir)).find('skill', target, 'demo')?.origin?.commit, 'b'.repeat(40))
  })
})

test('an edit after the update preview refuses before replacing or removing any file', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    const op = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    await writeFile(join(target, 'same.md'), 'Edited after the preview')
    const result = (await applyLibrary([{ ...op, acknowledged: true }], { home, libraryDir }))[0]!
    assert.equal(result.outcome, 'failed')
    assert.match(result.detail ?? '', /target changed/i)
    assert.equal(await readFile(join(target, 'old.md'), 'utf8'), 'Old note')
    assert.equal(await readFile(join(target, 'same.md'), 'utf8'), 'Edited after the preview')
  })
})

test('apply refuses an update whose submitted file list hides a removal', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    const op = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    const result = (await applyLibrary([{ ...op, acknowledged: true, files: op.files!.filter(file => file.change !== 'removed') }], { home, libraryDir }))[0]!
    assert.equal(result.outcome, 'failed')
    assert.match(result.detail ?? '', /file list/)
    assert.equal(await readFile(join(target, 'old.md'), 'utf8'), 'Old note')
  })
})


test('an update never drops a linked target file that the bundle reader omits', async () => {
  await fixture(async (home, libraryDir, target, source) => {
    const op = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    await symlink('same.md', join(target, 'my-link'))
    const planned = (await planLibrary(agents, [intent(source)], { home, libraryDir })).ops[0]!
    assert.equal(planned.action, 'refuse')
    assert.match(planned.reason ?? '', /link/)
    const result = (await applyLibrary([{ ...op, acknowledged: true }], { home, libraryDir }))[0]!
    assert.equal(result.outcome, 'failed')
    assert.match(result.detail ?? '', /link/)
    assert.equal(await readFile(join(target, 'my-link'), 'utf8'), 'Same note')
  })
})
