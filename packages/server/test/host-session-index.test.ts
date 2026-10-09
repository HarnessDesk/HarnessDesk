import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { Host } from '../src/host.js'
import { StateStore } from '../src/state.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

test('the first sidebar page asks no runtime, even without a selected agent', async (t) => {
  const root = tempDir('hd-index-host-')
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  let asked = 0
  runtime.listSessions = async () => { asked++; throw new Error('the sidebar must not ask the agent') }
  runtime.start = async () => { asked++; throw new Error('the sidebar must not start an agent') }
  host.register(runtime)
  assert.deepEqual((await host.call('session/index', {})).data, [])
  assert.equal(asked, 0)
})

test('a 5,000-row host first page spawns neither an agent nor Git', () => {
  const root = tempDir('hd-index-first-frame-')
  // Patch the process boundary before the isolated child imports the host.
  // This counts the actual path used by both repository readers and adapters.
  const driver = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    let git = 0, measuring = false;
    const original = cp.execFile;
    cp.execFile = (...args) => { if (measuring && args[0] === 'git') git++; return original(...args); };
    syncBuiltinESMExports();
    const { SessionIndex } = await import(${JSON.stringify(new URL('../src/session-index.js', import.meta.url).href)});
    const index = new SessionIndex(${JSON.stringify(join(root, 'sessions.sqlite'))});
    for (let i = 0; i < 5000; i++) index.upsert({ runtime:'fake',id:'row-'+i,cwd:'/synthetic/project-'+(i%450),
      title:'Synthetic task '+i,createdAt:1,updatedAt:5000-i,status:{type:'notLoaded'} });
    index.close();
    const { Host } = await import(${JSON.stringify(new URL('../src/host.js', import.meta.url).href)});
    const { StateStore } = await import(${JSON.stringify(new URL('../src/state.js', import.meta.url).href)});
    const { FakeRuntime } = await import(${JSON.stringify(new URL('./fixtures/fake-runtime.js', import.meta.url).href)});
    const { Logger } = await import(${JSON.stringify(new URL('../src/log.js', import.meta.url).href)});
    const host = new Host({ state:new StateStore(${JSON.stringify(join(root, 'state.json'))}),
      logger:new Logger('test',{level:'error',console:false}),builtinAgents:${JSON.stringify(join(root, 'agents'))},libraryHome:${JSON.stringify(join(root, 'library'))} });
    const runtime = new FakeRuntime(); let agent = 0;
    runtime.listSessions = async () => { agent++; throw new Error('agent history was asked'); };
    runtime.start = async () => { agent++; throw new Error('agent was started'); };
    host.register(runtime);
    measuring = true;
    const start = performance.now(); const page = await host.call('session/index',{}); const elapsed = performance.now()-start;
    measuring = false;
    console.log(JSON.stringify({ rows:page.data.length,git,agent,elapsed }));
    await host.dispose();
  `
  const output = execFileSync(process.execPath, [...process.execArgv.filter(arg => arg !== '--test'), '--input-type=module', '-e', driver], { encoding: 'utf8' })
  const measured = JSON.parse(output.trim()) as { rows: number; git: number; agent: number; elapsed: number }
  assert.equal(measured.rows, 50)
  assert.equal(measured.git, 0)
  assert.equal(measured.agent, 0)
  assert.ok(measured.elapsed < 50, `first host page took ${measured.elapsed.toFixed(2)} ms`)
  console.log(`Indexed host first page: ${measured.elapsed.toFixed(2)} ms; 0 agent/Git processes`)
})

test('desk lifecycle and title/archive changes update the index across a restart', async (t) => {
  const root = tempDir('hd-index-writes-')
  execFileSync('git', ['init', '-q', root])
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') }
  const host = new Host(options)
  let disposed = false
  t.after(() => disposed ? undefined : host.dispose())
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } })
  assert.equal((await host.call('session/index', {})).data[0]?.id, session.id)
  await host.call('session/setTitle', { runtime: runtime.info.id, sessionId: session.id, title: 'Review the cache' })
  assert.equal((await host.call('session/index', {})).data[0]?.title, 'Review the cache')
  const live = runtime.sessions.get(String(session.id))!
  await live.send([{ type: 'text', text: 'Check the synthetic cache' }])
  live.finish('Checked')
  const completed = (await host.call('session/index', {})).data[0]!
  assert.deepEqual(completed.status, { type: 'idle' })
  assert.ok(completed.updatedAt >= session.updatedAt)
  await host.call('session/close', { runtime: runtime.info.id, sessionId: session.id })
  await host.call('session/resume', { runtime: runtime.info.id, sessionId: session.id })
  assert.equal((await host.call('session/index', {})).data[0]?.id, session.id)
  await host.call('session/archive', { runtime: runtime.info.id, sessionId: session.id, archived: true })
  assert.equal((await host.call('session/index', {})).data.length, 0)
  assert.equal((await host.call('session/index', { archived: 'only' })).data[0]?.id, session.id)
  await host.call('session/archive', { runtime: runtime.info.id, sessionId: session.id, archived: false })
  assert.equal((await host.call('session/index', {})).data[0]?.id, session.id)
  const forked = await host.call('session/fork', { runtime: runtime.info.id, sessionId: session.id })
  assert.ok((await host.call('session/index', {})).data.some(row => row.id === forked.id))
  const team = await host.teamPlane.createRoom(root, 'Review the cache')
  await host.teamPlane.joinRoom(team.id, runtime.info.id, String(forked.id))
  assert.ok(!(await host.call('session/index', {})).data.some(row => row.id === forked.id))
  assert.ok(host.teamPlane.stateFor(team.id).members.includes(`${runtime.info.id}\u0000${forked.id}` as import('@harnessdesk/protocol').SessionKey))
  await host.call('session/delete', { runtime: runtime.info.id, sessionId: forked.id })
  assert.ok(!(await host.call('session/index', {})).data.some(row => row.id === forked.id))
  await host.dispose()
  disposed = true
  const reopened = new Host({ ...options, state: new StateStore(join(root, 'state.json')) })
  reopened.register(new FakeRuntime())
  t.after(() => reopened.dispose())
  assert.equal((await reopened.call('session/index', {})).data[0]?.title, 'Review the cache')
})

test('removed runtimes stay absent from later pages and a fresh host', async (t) => {
  const root = tempDir('hd-index-removed-')
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') }
  const host = new Host(options)
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } })
  assert.equal((await host.call('session/index', {})).data[0]?.id, session.id)
  await host.unregister(runtime.info.id)
  assert.deepEqual((await host.call('session/index', {})).data, [])
  await host.dispose()
  const reopened = new Host({ ...options, state: new StateStore(join(root, 'state.json')) })
  t.after(() => reopened.dispose())
  assert.deepEqual((await reopened.call('session/index', {})).data, [])
})

test('index status follows the live handle, not a persisted active state', async (t) => {
  const root = tempDir('hd-index-status-')
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') }
  const host = new Host(options)
  const runtime = new FakeRuntime()
  host.register(runtime)
  await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: root } })
  const live = runtime.sessions.get(String(session.id))!
  await live.send([{ type: 'text', text: 'Synthetic active turn' }])
  assert.deepEqual((await host.call('session/index', {})).data[0]?.status, { type: 'active' })
  live.finish('Finished')
  assert.deepEqual((await host.call('session/index', {})).data[0]?.status, { type: 'idle' })
  await host.call('session/close', { runtime: runtime.info.id, sessionId: session.id })
  assert.deepEqual((await host.call('session/index', {})).data[0]?.status, { type: 'notLoaded' })
  await host.dispose()
  const reopened = new Host({ ...options, state: new StateStore(join(root, 'state.json')) })
  reopened.register(new FakeRuntime())
  t.after(() => reopened.dispose())
  assert.deepEqual((await reopened.call('session/index', {})).data[0]?.status, { type: 'notLoaded' })
})

test('verified backup restores update a seeded index immediately and on restart', async (t) => {
  const root = tempDir('hd-index-backup-')
  const options = { logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') }
  const host = new Host(options)
  const runtime = new FakeRuntime({ capabilities: { archiveHistory: false } })
  host.register(runtime)
  await host.start()
  const backup = await host.call('backup/export', {})
  const payload = { ...backup, transcripts: [{ runtime: runtime.info.id, id: 'restored', data: {
    version: 1, runtime: runtime.info.id, id: 'restored', savedAt: 10, updatedAt: 9,
    createdAt: 2, title: 'Restored synthetic task', cwd: root, turns: [],
  } }] }
  const report = await host.call('backup/import', { backup: payload })
  assert.equal(report.transcripts.restored, 1)
  assert.equal((await host.call('session/index', {})).data[0]?.title, 'Restored synthetic task')
  const newer = { ...payload, transcripts: payload.transcripts.map(entry => ({ ...entry,
    data: { ...entry.data, savedAt: 20, updatedAt: 19, title: 'Newer restored task' } })) }
  await host.call('backup/import', { backup: newer })
  assert.equal((await host.call('session/index', {})).data[0]?.title, 'Newer restored task')
  await host.call('backup/import', { backup: payload })
  assert.equal((await host.call('session/index', {})).data[0]?.title, 'Newer restored task')
  await host.dispose()
  const reopened = new Host({ ...options, state: new StateStore(join(root, 'state.json')) })
  reopened.register(runtime)
  t.after(() => reopened.dispose())
  assert.equal((await reopened.call('session/index', {})).data[0]?.title, 'Newer restored task')
})

test('native archive seed waits for authority, retries a failure and never adopts unindexed history', async (t) => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { sessionId } = await import('@harnessdesk/protocol')
  const root = tempDir('hd-index-native-')
  const folder = join(root, 'transcripts', 'fake')
  await mkdir(folder, { recursive: true })
  for (const id of ['archived', 'unarchived', 'absent']) await writeFile(join(folder, `${id}.json`), JSON.stringify({
    version: 1, runtime: 'fake', id, savedAt: 10, title: `Synthetic ${id}`, cwd: root, turns: [],
  }))
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  t.after(() => host.dispose())
  const runtime = new FakeRuntime()
  runtime.history.push(...['archived', 'unarchived', 'not-a-desk-row'].map(id => ({ runtime: runtime.info.id, id: sessionId(id),
    title: id, cwd: root, createdAt: 1, updatedAt: 10, status: { type: 'notLoaded' as const } })))
  runtime.archived.add('archived')
  const original = runtime.listSessions.bind(runtime)
  let release!: () => void
  const delay = new Promise<void>(resolve => { release = resolve })
  runtime.listSessions = async () => { await delay; throw new Error('Synthetic listing failed') }
  host.register(runtime)
  await host.start()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual((await host.call('session/index', {})).data, [])
  assert.deepEqual((await host.call('session/index', { archived: 'only' })).data, [])
  release()
  await new Promise(resolve => setImmediate(resolve))
  runtime.listSessions = original
  await host.call('session/list', { runtime: runtime.info.id, archived: 'only' })
  // The archive-view refresh retries both authoritative listings to completion.
  for (let i = 0; i < 30 && !(await host.call('session/index', {})).data.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual((await host.call('session/index', {})).data.map(row => row.id), ['unarchived'])
  assert.deepEqual((await host.call('session/index', { archived: 'only' })).data.map(row => row.id), ['archived'])
  assert.equal(runtime.history.length, 3)
})

test('a persisted active row without a live handle is not loaded after restart', async (t) => {
  const { SessionIndex } = await import('../src/session-index.js')
  const { runtimeId, sessionId } = await import('@harnessdesk/protocol')
  const root = tempDir('hd-index-stale-active-')
  const index = new SessionIndex(join(root, 'sessions.sqlite'))
  index.upsert({ runtime: runtimeId('fake'), id: sessionId('stale'), title: 'Synthetic old turn', cwd: root,
    createdAt: 1, updatedAt: 2, status: { type: 'active' } })
  index.close()
  const host = new Host({ logger: silent, state: new StateStore(join(root, 'state.json')),
    builtinAgents: join(root, 'agents'), libraryHome: join(root, 'library') })
  host.register(new FakeRuntime())
  t.after(() => host.dispose())
  assert.deepEqual((await host.call('session/index', {})).data[0]?.status, { type: 'notLoaded' })
})
