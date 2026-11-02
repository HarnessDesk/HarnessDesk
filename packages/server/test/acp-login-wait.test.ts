import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { LoginStart } from '@harnessdesk/protocol'
import { knownAgent } from '../src/installs/known-agents.js'
import { knowledgeOverlay } from '../src/installs/overlay.js'
import { Client, start, stop } from './fixtures/harness.js'
import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { tempDir } from './scratch.js'

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const id = 'antigravity-acp'
const methods = JSON.stringify([{ id: 'oauth-personal', name: 'Personal' }, { id: 'oauth-business', name: 'Organization' }, { id: 'agent-platform', name: 'Platform' }])

test('business warning and expiring an unanswered ACP login travel through the Host without losing late success', async t => {
  const dir = tempDir('hd-acp-login-wait-'), gate = join(dir, 'release'), log = join(dir, 'auth.log')
  const row = { id, name: 'Antigravity', command: process.execPath, args: [PEER] }
  const env = { HOME: dir, GEMINI_HOME: join(dir, 'gemini'), FAKE_ACP_AUTH_GATE: gate, FAKE_ACP_AUTH_LOG: log, FAKE_ACP_AUTH_METHODS: methods, FAKE_ACP_AUTH_REQUIRED: '1' }
  const runtime = new AcpRuntime({ ...row, ...knowledgeOverlay(row, knownAgent(id), { env }), env })
  await runtime.start()
  const observed: string[] = []
  runtime.subscribe(event => { if (event.type === 'account/loginCompleted') observed.push(event.loginId ?? '') })
  const harness = await start({ builtinAgents: join(dir, 'agents'), libraryHome: join(dir, 'library'), catalogRefreshMs: 0 }, undefined, runtime as unknown as FakeRuntime)
  const one = await Client.connect(harness.server), two = await Client.connect(harness.server)
  t.after(async () => { one.close(); two.close(); await stop(harness) })
  const account = await one.call('runtime/account', { runtime: id }) as Awaited<ReturnType<typeof runtime.getAccount>>
  const personal = account.signInMethods.find(m => m.id === 'acp:oauth-personal')!
  const business = account.signInMethods.find(m => m.id === 'acp:oauth-business')!
  assert.ok(account.signInMethods.indexOf(personal) < account.signInMethods.indexOf(business))
  assert.equal(business.flow, 'browser')
  assert.match(business.description ?? '', /Google Cloud project.*Gemini Enterprise/i)
  assert.equal(account.signInMethods.find(m => m.id === 'acp:agent-platform')?.flow, 'external')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = await one.call('runtime/login', { runtime: id, method: business.id }) as LoginStart
  const deadline = Date.now() + 5_000
  while (!(await readFile(log, 'utf8').catch(() => '')).includes('oauth-business')) {
    if (Date.now() > deadline) throw new Error('peer did not receive authenticate')
    await new Promise(resolve => setImmediate(resolve))
  }
  t.mock.timers.tick(5 * 60_000 - 1)
  assert.equal(observed.includes(started.loginId), false, 'wait stays live before the bound')
  t.mock.timers.tick(1)
  t.mock.timers.reset()
  await Promise.all([one.until(() => one.events.some(e => e.type === 'account/loginCompleted' && e.loginId === started.loginId)), two.until(() => two.events.some(e => e.type === 'account/loginCompleted' && e.loginId === started.loginId))])
  const ended = one.events.find(e => e.type === 'account/loginCompleted' && e.loginId === started.loginId)!
  assert.equal(Reflect.get(ended, 'reason'), 'wait-expired')
  const retry = await one.call('runtime/login', { runtime: id, method: personal.id }) as LoginStart
  const changes = one.events.filter(e => e.type === 'account/changed').length
  await writeFile(gate, '')
  await one.until(() => one.events.filter(e => e.type === 'account/changed').length > changes)
  await one.until(() => one.events.some(e => e.type === 'account/loginCompleted' && e.loginId === retry.loginId))
  assert.equal(one.events.filter(e => e.type === 'account/loginCompleted' && e.loginId === started.loginId).length, 1)
  assert.equal(one.events.find(e => e.type === 'account/loginCompleted' && e.loginId === retry.loginId && e.success)?.type, 'account/loginCompleted')
})
