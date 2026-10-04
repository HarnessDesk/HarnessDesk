import assert from 'node:assert/strict'
import { appendFile, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { admitProject, gitReader } from '../src/provenance/git.js'
import { countingRunner, history, makeRepo } from './fixtures/provenance-repo.js'

const signal = () => new AbortController().signal

test('a reader never asks Git twice what an object id has already answered', async (t) => {
  const repo = await makeRepo()
  const { base, shas } = await history(repo, 2, 3)
  await repo.git('update-ref', 'refs/heads/main', shas.at(-1)!)
  const counted = countingRunner()
  const reader = gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]), { run: counted.run })
  t.after(() => reader.close())
  const read = async () => [
    await reader.commit(shas[0]!, signal()),
    await reader.patch(base, shas[0]!, signal()),
    await reader.files(base, shas[0]!, signal()),
    (await reader.snapshot(signal())).heads.get(repo.dir),
  ]
  const first = await read()
  const cost = counted.started
  assert.ok(cost > 0)
  assert.ok(cost <= 24, `a commit of three files should cost a few dozen processes at most, not ${cost}`)
  assert.deepEqual(await read(), first)
  assert.equal(counted.started, cost, 'asking again must not start a process')
  const patch = await reader.patch(base, shas[0]!, signal())
  ;(patch.files as string[]).push('scribbled')
  assert.ok(!(await reader.patch(base, shas[0]!, signal())).files.includes('scribbled'), 'a caller cannot change what is cached')
})

test('one process answers for many object ids, and only what exists is remembered', async (t) => {
  const repo = await makeRepo()
  const { shas } = await history(repo, 2)
  const tree = await repo.git('rev-parse', `${shas[0]}^{tree}`)
  const gone = 'f'.repeat(40)
  const counted = countingRunner()
  const reader = gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]), { run: counted.run })
  t.after(() => reader.close())
  const answer = await reader.kinds([shas[0]!, shas[1]!, tree, gone, shas[0]!], signal())
  assert.deepEqual([...answer].sort(), [[shas[0], 'commit'], [shas[1], 'commit'], [tree, 'tree'], [gone, null]].sort())
  assert.equal(counted.started, 1)
  await reader.kinds([shas[0]!, shas[1]!, tree], signal())
  assert.equal(counted.started, 1, 'an object that exists keeps its answer')
  await reader.kinds([gone], signal())
  assert.equal(counted.started, 2, 'an object that was missing is asked about again')
  await assert.rejects(reader.kinds(['HEAD'], signal()), /Expected a full object id/)
})

test('a cached answer is not served after a metadata check fails, even once the metadata is whole again', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const next = await repo.commitTree(base, { one: 'next\n' }, 'next')
  await repo.git('update-ref', 'refs/heads/main', next)
  const linked = join(dirname(repo.dir), 'linked')
  await repo.git('worktree', 'add', '-q', '--detach', linked, base)
  const handle = await admitProject(linked, repo.stateDir, [repo.dir, linked])
  const counted = countingRunner()
  const reader = gitReader(handle, { run: counted.run })
  t.after(() => reader.close())
  await reader.patch(base, next, signal())
  const pointer = join(handle.checkouts.get(linked)!, 'gitdir')
  const original = await readFile(pointer, 'utf8')
  await writeFile(pointer, join(repo.stateDir, 'not-a-checkout'))
  await assert.rejects(reader.patch(base, next, signal()), /metadata-changed/, 'the answer was cached; the check still comes first')
  await assert.rejects(reader.commit(next, signal()), /metadata-changed/)
  await assert.rejects(reader.batch(signal(), (inside) => inside.kinds([next], signal())), /metadata-changed/)
  await writeFile(pointer, original)
  const before = counted.started
  await reader.patch(base, next, signal())
  assert.ok(counted.started > before, 'what a failed check found suspect must be asked of Git again')
})

test('every admission check still runs when reads share a batch', async (t) => {
  const objects = await makeRepo()
  const base = await objects.commitTree(null, { one: 'base\n' }, 'base')
  const swapped = gitReader(await admitProject(objects.dir, objects.stateDir, [objects.dir]))
  t.after(() => swapped.close())
  await rename(join(objects.dir, '.git/objects'), join(objects.stateDir, 'moved-objects'))
  await symlink(join(objects.stateDir, 'moved-objects'), join(objects.dir, '.git/objects'))
  await assert.rejects(swapped.batch(signal(), (inside) => inside.commit(base, signal())), /Linked metadata/)
  const nested = await makeRepo()
  const tip = await nested.commitTree(null, { one: 'base\n' }, 'base')
  const walked = gitReader(await admitProject(nested.dir, nested.stateDir, [nested.dir]))
  t.after(() => walked.close())
  await symlink(nested.stateDir, join(nested.dir, '.git/objects/outside'))
  await assert.rejects(walked.batch(signal(), (inside) => inside.commit(tip, signal())), /Linked metadata/)
  const format = await makeRepo()
  const root = await format.commitTree(null, { one: 'base\n' }, 'base')
  const reader = gitReader(await admitProject(format.dir, format.stateDir, [format.dir]))
  t.after(() => reader.close())
  await appendFile(join(format.dir, '.git/config'), '\n[extensions]\nobjectFormat = sha256\n')
  await assert.rejects(reader.batch(signal(), (inside) => inside.commit(root, signal())), /metadata-changed/)
})

test('reads in one batch check the metadata once; a change is caught by the next batch', async (t) => {
  const repo = await makeRepo()
  const { base, shas } = await history(repo, 2, 2)
  await repo.git('update-ref', 'refs/heads/main', shas[1]!)
  let checks = 0
  const reader = gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]), { validated: () => { checks += 1 } })
  t.after(() => reader.close())
  await reader.batch(signal(), async (inside) => {
    await inside.commit(shas[0]!, signal())
    await inside.commit(shas[1]!, signal())
    await inside.patch(base, shas[0]!, signal())
    await inside.files(base, shas[1]!, signal())
    await inside.snapshot(signal())
  })
  assert.equal(checks, 1)
  await reader.batch(signal(), async () => 'nothing was read')
  assert.equal(checks, 1, 'a batch that reads nothing has nothing to check')
  await reader.commit(shas[0]!, signal())
  await reader.patch(base, shas[1]!, signal())
  assert.equal(checks, 3, 'a read outside a batch is a batch of one')
  await appendFile(join(repo.dir, '.git/config'), '\n[extensions]\nobjectFormat = sha256\n')
  await assert.rejects(reader.batch(signal(), (inside) => inside.commit(shas[0]!, signal())), /metadata-changed/)
})
