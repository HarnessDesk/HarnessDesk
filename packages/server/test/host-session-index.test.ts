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
  t.after(() => reopened.dispose())
  assert.equal((await reopened.call('session/index', {})).data[0]?.title, 'Review the cache')
})
