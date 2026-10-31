import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { GitRecord } from '../src/git-gateway/record.js'
const repository = 'acme/widgets', sha = 'a'.repeat(40), requester = { kind: 'session' as const, id: 'session-1' }
const entry = (id: string, outcome: 'ok' | 'failed' | 'intent' = 'ok') => ({ id, repository, branch: 'worker', sha, requester, op: 'push' as const, approval: null, at: 1, outcome })
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hd-git-record-')), record = new GitRecord(directory)
  return { directory, record, path: join(directory, 'git-record', 'acme__widgets.ndjson') }
}

type PrEvidence = { readonly number: number; readonly branch: string }
const conversation = { runtime: 'fake', sessionId: 'conversation-1' }
const created = (id: string) => ({ ...entry(id), op: 'pr.create' as const, number: 17,
  requester: { ...requester, conversation } })
const creations = (record: GitRecord, repo = repository, caller = conversation) =>
  (record as GitRecord & { successfulPullRequests(repository: string, caller: typeof conversation): Promise<readonly PrEvidence[]> })
    .successfulPullRequests(repo, caller)

test('conversation PR evidence survives reopening and excludes unrelated or incomplete outcomes', async t => {
  const f = await fixture()
  t.after(() => rm(f.directory, { recursive: true, force: true }))
  await f.record.append(created('own'))
  await f.record.append(created('duplicate'))
  await f.record.append({ ...created('other-session'), requester: { ...requester, conversation: { ...conversation, sessionId: 'other' } } })
  await f.record.append({ ...created('other-runtime'), requester: { ...requester, conversation: { ...conversation, runtime: 'other' } } })
  await f.record.append({ ...created('other-repo'), repository: 'acme/other' })
  await f.record.append({ ...created('person'), requester: { ...requester, kind: 'person', conversation } })
  await f.record.append({ ...created('missing-conversation'), requester })
  await f.record.append({ ...created('push'), op: 'push' })
  for (const outcome of ['intent', 'failed', 'refused', 'rejected'] as const)
    await f.record.append({ ...created(`outcome-${outcome}`), outcome })
  for (const [index, number] of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries())
    await f.record.append({ ...created(`number-${index}`), number })
  for (const [index, branch] of [undefined, '', '   '].entries())
    await f.record.append({ ...created(`branch-${index}`), branch })
  const reopened = new GitRecord(f.directory)
  assert.deepEqual(await creations(reopened), [{ number: 17, branch: 'worker' }])
  assert.deepEqual(await creations(reopened, repository, { ...conversation, runtime: 'absent' }), [])
  assert.deepEqual(await creations(reopened, 'acme/absent'), [])
})

test('conversation PR evidence reads past the inspection window and keeps distinct recorded heads', { timeout: 30_000 }, async t => {
  const f = await fixture()
  t.after(() => rm(f.directory, { recursive: true, force: true }))
  await f.record.append(created('own-first'))
  await f.record.append({ ...created('same-number-different-head'), branch: 'other-worker' })
  const lines = (await readFile(f.path, 'utf8')).trimEnd().split('\n')
  const hash = (line: string) => createHash('sha256').update(line).digest('hex')
  let previous = hash(`${lines.at(-1)!}\n`)
  for (let n = 0; n < 1005; n++) {
    const line = JSON.stringify({ ...entry(`later-${n}`), prev: previous })
    lines.push(line)
    previous = hash(`${line}\n`)
  }
  const anchor = JSON.parse(await readFile(`${f.path}.anchor`, 'utf8'))
  await writeFile(f.path, `${lines.join('\n')}\n`)
  await writeFile(`${f.path}.anchor`, JSON.stringify({ ...anchor, last: previous, lines: lines.length }))
  assert.deepEqual(await new GitRecord(f.directory).verify(repository), { ok: true, damaged: 0 }, 'synthetic unrelated history retains a valid journal chain')
  assert.deepEqual(await creations(new GitRecord(f.directory)), [
    { number: 17, branch: 'worker' }, { number: 17, branch: 'other-worker' },
  ])
})

test('conversation PR evidence rejects damaged and unreadable journals', async t => {
  const damaged = await fixture(), unreadable = await fixture()
  t.after(async () => { await rm(damaged.directory, { recursive: true, force: true }); await rm(unreadable.directory, { recursive: true, force: true }) })
  await damaged.record.append(created('damaged'))
  await writeFile(damaged.path, (await readFile(damaged.path, 'utf8')).replace('"number":17', '"number":18'))
  await assert.rejects(creations(damaged.record), /git-record-broken:/)
  await unreadable.record.append(created('unreadable'))
  await rm(unreadable.path)
  await mkdir(unreadable.path)
  await assert.rejects(creations(unreadable.record))
})

test('the anchor detects an edited last outcome and attributes no damaged history', async () => {
  const f = await fixture()
  await f.record.append(entry('one', 'failed'))
  await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('"failed"', '"ok"'))
  assert.deepEqual(await f.record.verify(repository), { ok: false, line: 1, damaged: 1 })
  assert.equal(await f.record.attribute(repository, 'worker', sha), 'outside')
})

test('malformed lines are counted and skipped without throwing from attribution or startup reads', async () => {
  const f = await fixture()
  for (const id of ['one', 'two', 'three']) await f.record.append(entry(id))
  const lines = (await readFile(f.path, 'utf8')).trimEnd().split('\n'); lines[1] = '{damaged'
  await writeFile(f.path, `${lines.join('\n')}\n`)
  const verification = await f.record.verify(repository)
  assert.equal(verification.ok, false); assert.equal(verification.damaged, 1)
  assert.equal(await f.record.attribute(repository, 'worker', sha), 'outside')
  assert.equal((await f.record.list({ repository, limit: 10 })).some(row => row.id === 'two'), false)
  assert.equal((await f.record.stats(repository)).damaged, 1)
  assert.deepEqual(await f.record.pending(), [])
})

test('record rotates with a continuous chain and indexes exact successful requester identities', async () => {
  const f = await fixture(), record = new GitRecord(f.directory, { segmentBytes: 700 })
  await record.append(entry('one', 'failed')); await record.append(entry('two', 'intent'))
  assert.equal(await record.hasSucceededPush({ repository, branch: 'worker', sha, requester }), false)
  await record.append(entry('three'))
  assert.equal(typeof record.hasSucceededPush({ repository, branch: 'worker', sha, requester }), 'boolean')
  assert.equal(await record.hasSucceededPush({ repository: 'Acme/Widgets', branch: 'worker', sha, requester }), true)
  assert.equal(await record.hasSucceededPush({ repository, branch: 'worker', sha, requester: { ...requester, id: 'other' } }), false)
  assert.equal(await record.hasSucceededPush({ repository, branch: 'worker', sha, requester: { ...requester, kind: 'person' } }), false)
  assert.equal(record.hasSucceededPush({ repository, branch: 'worker', sha: 'b'.repeat(40), requester }), false)
  assert.equal(await record.hasSucceededPush({ repository, branch: 'other', sha, requester }), false)
  const files = (await readdir(join(f.directory, 'git-record'), { recursive: true })).filter(name => name.endsWith('.ndjson'))
  assert.ok(files.length > 1)
  assert.deepEqual(await record.verify(repository), { ok: true, damaged: 0 })
  const reopened = new GitRecord(f.directory)
  assert.deepEqual(await reopened.attribute(repository, 'worker', sha), requester)
  assert.equal((await reopened.list({ repository, limit: 10 })).length, 3)
  assert.equal((await reopened.stats(repository)).segments, files.length)
})

test('separate processes serialize appends and recover a dead stale lock', async () => {
  const f = await fixture()
  await f.record.append(entry('initial'))
  const script = `import {GitRecord} from ${JSON.stringify(new URL('../src/git-gateway/record.js', import.meta.url).href)};
const record = new GitRecord(process.argv[1]);
for(let i=0;i<15;i++) await record.append({...${JSON.stringify(entry('child'))},id:process.argv[2]+'-'+i});`
  const run = promisify(execFile)
  await Promise.all(['a', 'b', 'c'].map(id => run(process.execPath, ['--input-type=module', '-e', script, f.directory, id])))
  assert.deepEqual(await f.record.verify(repository), { ok: true, damaged: 0 })
  assert.equal((await f.record.list({ repository, limit: 100 })).length, 46)
  await writeFile(`${f.path}.lock`, JSON.stringify({ pid: 2147483647, at: Date.now() - 120_000 }))
  await writeFile(`${f.path}.lock.reap`, JSON.stringify({ pid: 2147483647, at: Date.now() - 120_000 }))
  await f.record.append(entry('recovered'))
  assert.equal((await f.record.list({ repository, limit: 100 })).length, 47)
  await assert.rejects(stat(`${f.path}.lock`), { code: 'ENOENT' })
})

test('rotated segment names cannot collide with another repository name', async () => {
  const f = await fixture(), record = new GitRecord(f.directory, { segmentBytes: 1 })
  await record.append(entry('one')); await record.append(entry('two'))
  await record.append({ ...entry('other'), repository: 'acme/widgets.000001' })
  assert.deepEqual(await record.verify(repository), { ok: true, damaged: 0 })
  assert.deepEqual(await record.verify('acme/widgets.000001'), { ok: true, damaged: 0 })
  assert.equal((await record.list({ repository, limit: 10 })).length, 2)
  assert.equal((await record.list({ repository: 'acme/widgets.000001', limit: 10 })).length, 1)
})

test('edits across segment boundaries fail closed at the edited line', async () => {
  const f = await fixture(), record = new GitRecord(f.directory, { segmentBytes: 1 })
  for (const id of ['one', 'two', 'three']) await record.append(entry(id))
  await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('"session"', '"person"'))
  assert.deepEqual(await record.verify(repository), { ok: false, line: 1, damaged: 1 })
  assert.equal(record.hasSucceededPush({ repository, branch: 'worker', sha, requester }), false)
  await assert.rejects(record.append(entry('four')), /git-record-broken:1/)
})

test('unchanged reads use the branch index and recheck only a changed segment', async () => {
  const f = await fixture(), record = new GitRecord(f.directory, { segmentBytes: 1 })
  for (const id of ['one', 'two', 'three']) await record.append(entry(id))
  assert.deepEqual(await record.verify(repository), { ok: true, damaged: 0 })
  const fs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module')
  const original = fs.default.readFileSync, reads: string[] = []
  fs.default.readFileSync = ((path: any, ...args: any[]) => {
    if (String(path).endsWith('.ndjson')) reads.push(String(path))
    return (original as any)(path, ...args)
  }) as typeof fs.readFileSync
  syncBuiltinESMExports()
  try {
    assert.equal(record.hasSucceededPush({ repository, branch: 'worker', sha, requester }), true)
    assert.deepEqual(await record.attribute(repository, 'worker', sha), requester)
    assert.deepEqual(reads, [])
    await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('"session"', '"person"'))
    assert.equal((await record.verify(repository)).ok, false)
    assert.deepEqual(reads, [f.path])
  } finally { fs.default.readFileSync = original; syncBuiltinESMExports() }
})

test('a live aged lock is not evicted and a deleted journal is detected by its anchor', async () => {
  const f = await fixture()
  await f.record.append(entry('one'))
  const { unlink } = await import('node:fs/promises')
  await writeFile(`${f.path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - 120_000 }))
  const pending = f.record.append(entry('two'))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(JSON.parse(await readFile(`${f.path}.lock`, 'utf8')).pid, process.pid)
  assert.equal((await readFile(f.path, 'utf8')).trimEnd().split('\n').length, 1)
  await unlink(`${f.path}.lock`); await pending
  await unlink(f.path)
  assert.equal((await f.record.verify()).ok, false)
  assert.equal(await f.record.attribute(repository, 'worker', sha), 'outside')
})
