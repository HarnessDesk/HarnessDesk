import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { runtimeId, sessionId, type Page, type SessionSummary } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { SessionIndex } from '../src/session-index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const row = (id: string, time = 10): SessionSummary => ({ runtime: runtimeId('fake'), id: sessionId(id),
  title: `Synthetic ${id}`, cwd: '/synthetic/project', createdAt: 1, updatedAt: time, status: { type: 'notLoaded' } })
const fixture = (t: TestContext, native = false) => {
  const root = tempDir('hd-import-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: native } })
  return { host, root, runtime }
}
const finished = async (host: Host) => {
  for (let i = 0; i < 100; i++) {
    const status = await host.call('history/status', { runtime: runtimeId('fake') })
    assert.ok(status)
    if (status.state !== 'running') return status
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('import did not settle')
}

test('import starts an idle runtime and writes all 2,000 metadata rows, preserving desk bodies and tombstones', async t => {
  const { host, root, runtime } = fixture(t)
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert(row('desk'))
  index.upsert(row('hidden'), { origin: 'imported' })
  index.remove(runtime.info.id, sessionId('hidden'))
  index.close()
  let starts = 0, pages = 0
  runtime.start = async () => { starts++ }
  runtime.listSessions = async query => {
    assert.ok(starts > 0, 'startup precedes listing')
    assert.equal(query?.pageSize, 500)
    const offset = Number(query?.cursor ?? 0)
    pages++
    const rows = Array.from({ length: 500 }, (_, i) => row(`row-${offset + i}`, offset + i))
    if (offset === 0) rows.push(row('desk', 99), row('hidden', 99))
    return { data: rows, nextCursor: offset < 1500 ? String(offset + 500) : null }
  }
  host.register(runtime)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  db.exec("UPDATE sessions SET body='full',usage='{}' WHERE id='desk'")
  await host.call('history/import', { runtime: runtime.info.id })
  assert.equal((await finished(host)).state, 'done')
  assert.equal(pages, 4)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions WHERE origin='imported' AND removed_at IS NULL").get()?.n, 2000)
  assert.equal(db.prepare("SELECT body FROM sessions WHERE id='desk'").get()?.body, 'full')
  assert.equal(db.prepare("SELECT updated_at FROM sessions WHERE id='desk'").get()?.updated_at, 10)
  assert.ok(db.prepare("SELECT removed_at FROM sessions WHERE id='hidden'").get()?.removed_at)
  assert.equal((await host.call('history/status', { runtime: runtime.info.id }))?.count, 2000)
  await host.call('history/import', { runtime: runtime.info.id })
  assert.equal(pages, 4, 'rescan inside 60 seconds is dropped')
  const removed = await host.call('history/removeImported', { runtime: runtime.info.id })
  assert.equal(removed.removed, 2000)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 2)
  assert.equal(await host.call('history/status', { runtime: runtime.info.id }), null)
})

test('native archive state comes from both authoritative listings; local archive marks apply otherwise', async t => {
  for (const native of [true, false]) {
    const { host, runtime, root } = fixture(t, native)
    const archive = new (await import('../src/archive.js')).SessionArchive(join(root, 'archive.json'))
    await archive.set(runtime.info.id, sessionId('local'), true)
    runtime.listSessions = async query => ({ data: native
      ? [row(query?.archived === 'only' ? 'native-archived' : 'native-open')]
      : [row('local'), row('open')], nextCursor: null })
    host.register(runtime)
    await host.call('history/import', { runtime: runtime.info.id })
    await finished(host)
    const list = await host.call('history/list', {})
    assert.deepEqual(list.data.filter((one: SessionSummary) => one.archived).map((one: SessionSummary) => one.id), [native ? 'native-archived' : 'local'])
  }
})

test('native import pages cannot overwrite newer archive or unarchive actions', async t => {
  for (const archived of [true, false]) await t.test(archived ? 'archive' : 'unarchive', async t => {
    const { host, runtime, root } = fixture(t, true)
    const index = new SessionIndex(join(root, 'sessions.sqlite'))
    index.upsert(row('desk'), { archived: !archived })
    index.upsert(row('imported'), { origin: 'imported', archived: !archived })
    index.close()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let requested!: () => void
    const waiting = new Promise<void>(resolve => { requested = resolve })
    runtime.listSessions = async query => {
      if (query?.archived !== (archived ? 'exclude' : 'only')) return { data: [], nextCursor: null }
      requested()
      await held
      return { data: ['desk', 'imported', 'unseen', 'unchanged'].map(id => row(id, 99)), nextCursor: null }
    }
    host.register(runtime)
    await host.call('history/import', { runtime: runtime.info.id })
    await waiting
    for (const id of ['desk', 'imported', 'unseen']) {
      await host.call('session/archive', { runtime: runtime.info.id, sessionId: sessionId(id), archived })
    }
    release()
    assert.equal((await finished(host)).state, 'done')
    const db = new DatabaseSync(join(root, 'sessions.sqlite'))
    t.after(() => db.close())
    for (const id of ['desk', 'imported', 'unseen']) assert.equal(db.prepare('SELECT archived FROM sessions WHERE id=?').get(id)?.archived, Number(archived), id)
    assert.equal(db.prepare("SELECT archived FROM sessions WHERE id='unchanged'").get()?.archived, Number(!archived))
    assert.equal(db.prepare("SELECT updated_at FROM sessions WHERE id='imported'").get()?.updated_at, 99, 'metadata still refreshes')
  })
})

test('a host-only rename survives import and later transcript reads, including before metadata exists', async t => {
  for (const indexed of [false, true]) await t.test(indexed ? 'indexed preview' : 'unseen history', async t => {
    const { host, runtime, root } = fixture(t)
    const target = sessionId('renamed')
    Object.assign(runtime.info, { capabilities: { ...runtime.info.capabilities, nameHistory: false } })
    const title = 'Review the startup policy'
    const listed = row(target)
    runtime.history.push(listed)
    if (indexed) {
      const index = new SessionIndex(join(root, 'sessions.sqlite'))
      index.upsert(listed, { origin: 'imported' })
      index.close()
    }
    host.register(runtime)
    await host.call('session/setTitle', { runtime: runtime.info.id, sessionId: target, title })
    await host.call('history/import', { runtime: runtime.info.id })
    assert.equal((await finished(host)).state, 'done')
    const history = () => host.call('history/list', { runtimes: [runtime.info.id], query: title })
    assert.equal((await history()).data[0]?.title, title, 'import cannot replace the chosen name')
    await host.call('session/read', { runtime: runtime.info.id, sessionId: target })
    assert.equal((await history()).data[0]?.title, title, 'a later transcript refresh keeps the name')
    assert.equal((await host.call('session/index', { runtimes: [runtime.info.id] })).data.length, 0, 'rename and read do not adopt a preview')
  })
})

test('the first project-filtered History page resolves cold folders beyond the unfiltered first page', async t => {
  const { host, runtime, root } = fixture(t)
  const canonicalRoot = await realpath(root)
  const repo = join(canonicalRoot, 'repo'), nested = join(repo, 'nested'), other = join(canonicalRoot, 'other')
  await mkdir(nested, { recursive: true })
  await mkdir(other)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['init', '-q', other])
  runtime.listSessions = async () => ({ data: [
    ...Array.from({ length: 60 }, (_, i) => ({ ...row(`other-${i}`, 100 + i), cwd: other })),
    ...['target-a', 'target-b'].map(id => ({ ...row(id), cwd: nested })),
  ], nextCursor: null })
  host.register(runtime)
  await host.call('history/import', { runtime: runtime.info.id })
  await finished(host)
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  assert.equal(db.prepare('SELECT count(*) AS n FROM repos').get()?.n, 0, 'import leaves repository resolution cold')
  const first = await host.call('history/list', { repoRoot: repo, query: 'target', runtimes: [runtime.info.id], pageSize: 1 })
  assert.deepEqual(first.data.map(row => row.id), ['target-a'])
  assert.equal(first.data[0]?.repo?.root, repo)
  assert.ok(first.nextCursor)
  const second = await host.call('history/list', { repoRoot: repo, query: 'target', runtimes: [runtime.info.id], pageSize: 1, cursor: first.nextCursor })
  assert.deepEqual(second.data.map(row => row.id), ['target-b'])
  assert.equal(second.nextCursor, null)
  assert.equal(db.prepare('SELECT count(*) AS n FROM repos WHERE cwd=?').get(other)?.n, 0, 'title-filtered folders alone are resolved')
})

test('cancel and failed pages preserve completed pages, and can restart immediately', async t => {
  const { host, runtime, root } = fixture(t)
  let release!: (page: Page<SessionSummary>) => void
  let waiting!: () => void
  const second = new Promise<void>(resolve => { waiting = resolve })
  runtime.listSessions = async query => {
    if (!query?.cursor) return { data: [row('first')], nextCursor: 'next' }
    waiting()
    return new Promise(resolve => { release = resolve })
  }
  host.register(runtime)
  await host.call('history/import', { runtime: runtime.info.id })
  await second
  await host.call('history/cancel', { runtime: runtime.info.id })
  release({ data: [row('cancelled-page')], nextCursor: null })
  assert.equal((await finished(host)).state, 'cancelled')
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1)
  runtime.listSessions = async query => {
    if (!query?.cursor) return { data: [row('first')], nextCursor: 'next' }
    throw new Error('Synthetic page failure')
  }
  await host.call('history/import', { runtime: runtime.info.id })
  assert.match((await finished(host)).error ?? '', /Synthetic page failure/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n, 1)
  runtime.listSessions = async () => ({ data: [row('retry')], nextCursor: null })
  await host.call('history/import', { runtime: runtime.info.id })
  assert.equal((await finished(host)).state, 'done')
})

test('an account without listHistory is refused before starting or listing', async t => {
  const { host } = fixture(t)
  const runtime = new FakeRuntime({ capabilities: { listHistory: false } })
  runtime.start = async () => { assert.fail('refused account started') }
  runtime.listSessions = async () => { assert.fail('refused account listed') }
  host.register(runtime)
  await assert.rejects(host.call('history/import', { runtime: runtime.info.id }), /history/i)
})

test('History queries escape wildcards, filter runtime/project/hidden and page tied timestamps stably', async t => {
  const { host, runtime, root } = fixture(t)
  const project = await realpath(root)
  execFileSync('git', ['init', '-q', project])
  runtime.listSessions = async () => ({ data: [row('a'), row('b'), { ...row('c'), title: '100%_done' }].map(row => ({ ...row, cwd: project })), nextCursor: null })
  host.register(runtime)
  await host.call('history/import', { runtime: runtime.info.id })
  await finished(host)
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.remove(runtime.info.id, sessionId('b'))
  index.upsert({ ...row('other'), runtime: runtimeId('other') }, { origin: 'imported' })
  index.close()
  const listed = await host.call('history/list', { query: '%_', repoRoot: project, runtimes: [runtime.info.id] })
  assert.deepEqual(listed.data.map((one: SessionSummary) => one.id), ['c'])
  assert.equal((await host.call('history/list', { query: 'DONE' })).data.length, 1)
  assert.equal((await host.call('history/list', { runtimes: [] })).data.length, 0)
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = await host.call('history/list', { pageSize: 1, includeHidden: true, cursor })
    ids.push(...page.data.map((one: SessionSummary) => `${one.runtime}:${one.id}`))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.deepEqual(ids, ['fake:a', 'fake:b', 'fake:c', 'other:other'])
  assert.equal((await host.call('history/list', {})).data.length, 3)
  assert.equal((await host.call('history/list', { includeHidden: true })).data.find((one: { hidden: boolean }) => one.hidden)?.id, 'b')
  await assert.rejects(host.call('history/list', { cursor: 'invalid' }), /cursor/i)
})

test('import spawns no Git, including reconciliation of an existing desk archive row', () => {
  const root = tempDir('hd-import-no-git-')
  const driver = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    let git=0, measuring=false;
    for (const method of ['spawn','spawnSync','execFile','execFileSync']) {
      const original=cp[method]; cp[method]=(...args)=>{if(measuring && args[0]==='git') git++; return original(...args)};
    }
    syncBuiltinESMExports();
    const {SessionIndex}=await import(${JSON.stringify(new URL('../src/session-index.js', import.meta.url).href)});
    const index=new SessionIndex(${JSON.stringify(join(root, 'sessions.sqlite'))});
    index.upsert({runtime:'fake',id:'desk',cwd:${JSON.stringify(root)},title:'Synthetic desk',createdAt:1,updatedAt:2,status:{type:'notLoaded'}});index.close();
    const {Host}=await import(${JSON.stringify(new URL('../src/host.js', import.meta.url).href)});
    const {StateStore}=await import(${JSON.stringify(new URL('../src/state.js', import.meta.url).href)});
    const {FakeRuntime}=await import(${JSON.stringify(new URL('./fixtures/fake-runtime.js', import.meta.url).href)});
    const {Logger}=await import(${JSON.stringify(new URL('../src/log.js', import.meta.url).href)});
    const host=new Host({state:new StateStore(${JSON.stringify(join(root, 'state.json'))}),logger:new Logger('test',{level:'error',console:false}),
      builtinAgents:${JSON.stringify(join(root, 'agents'))},libraryHome:${JSON.stringify(join(root, 'library'))}});
    const runtime=new FakeRuntime();
    runtime.listSessions=async query=>({data:query.archived==='only'?[{runtime:'fake',id:'desk',cwd:${JSON.stringify(root)},title:'Synthetic native',createdAt:1,updatedAt:3,status:{type:'notLoaded'}}]:[],nextCursor:null});
    host.register(runtime); measuring=true;
    await host.call('history/import',{runtime:'fake'});
    for(let i=0;i<100;i++){const state=await host.call('history/status',{runtime:'fake'});if(state.state!=='running'){if(state.state!=='done')throw new Error(JSON.stringify(state));break} await new Promise(r=>setImmediate(r));}
    await new Promise(r=>setTimeout(r,30));
    measuring=false;console.log(JSON.stringify({git}));await host.dispose();
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' })
  assert.equal(JSON.parse(output.trim()).git, 0)
})

test('removing imported rows drops cached bodies and search atomically, keeping tombstones and full desk bodies', async t => {
  const { host, runtime, root } = fixture(t)
  runtime.history.push(row('preview'), row('hidden'))
  runtime.stored.set(sessionId('preview'), [{ id: 'turn' as import('@harnessdesk/protocol').TurnId, status: 'completed',
    items: [{ type: 'assistantMessage', id: 'answer' as import('@harnessdesk/protocol').ItemId, text: 'Synthetic cached needle' }] }])
  host.register(runtime)
  await host.call('history/import', { runtime: runtime.info.id })
  await finished(host)
  await host.call('session/read', { runtime: runtime.info.id, sessionId: sessionId('preview') })
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.remove(runtime.info.id, sessionId('hidden'))
  index.upsert(row('desk'))
  index.close()
  const db = new DatabaseSync(join(root, 'sessions.sqlite'))
  t.after(() => db.close())
  assert.equal(db.prepare("SELECT body FROM sessions WHERE id='preview'").get()?.body, 'cached')
  assert.equal((await host.call('history/removeImported', { runtime: runtime.info.id })).removed, 1)
  for (const table of ['sessions', 'items', 'turns', 'bodies']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id='preview'`).get()?.n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items_fts WHERE items_fts MATCH 'needle'").get()?.n, 0)
  assert.ok(db.prepare("SELECT removed_at FROM sessions WHERE id='hidden'").get()?.removed_at)
  assert.equal(db.prepare("SELECT origin FROM sessions WHERE id='desk'").get()?.origin, 'desk')
  assert.equal(runtime.history.length, 2, 'the agent metadata is untouched')
  assert.equal(runtime.stored.get(sessionId('preview'))?.length, 1, 'the agent body is untouched')
})

test('import state survives restart and an interrupted running scan is cancelled', async t => {
  const { host, root, runtime } = fixture(t)
  runtime.history.push(row('persisted'))
  host.register(runtime)
  await host.call('history/import', { runtime: runtime.info.id })
  const done = await finished(host)
  await host.dispose()
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.saveImport(runtimeId('interrupted'), { state: 'running', count: 12, importedAt: null, lastScanAt: 1 })
  index.close()
  const fresh = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  t.after(() => fresh.dispose())
  assert.deepEqual(await fresh.call('history/status', { runtime: runtime.info.id }), done)
  assert.equal((await fresh.call('history/status', { runtime: runtimeId('interrupted') }))?.state, 'cancelled')
})

test('repeated cursors fail without looping and removing an account cancels its held page', async t => {
  const { host, runtime } = fixture(t)
  runtime.listSessions = async () => ({ data: [row('first')], nextCursor: 'same' })
  host.register(runtime)
  await host.call('history/import', { runtime: runtime.info.id })
  assert.match((await finished(host)).error ?? '', /cursor/)
  let release!: () => void
  runtime.listSessions = async () => { await new Promise<void>(resolve => { release = resolve }); return { data: [row('late')], nextCursor: null } }
  await host.call('history/import', { runtime: runtime.info.id })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  await host.unregister(runtime.info.id)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await host.call('history/status', { runtime: runtime.info.id }))?.state, 'cancelled')
  assert.equal((await host.call('history/list', {})).data.some(row => row.id === 'late'), false)
})
