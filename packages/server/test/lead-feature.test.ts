import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { Host, StateStore } from '../src/index.js'
import { LeadBudgets } from '../src/lead/budgets.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

const rig = (t: TestContext, leadEnabled?: boolean) => {
  const home = tempDir('hd-lead-feature-')
  const host = new Host({ logger: silent, state: new StateStore(join(home, 'state.json')), catalogRefreshMs: 0,
    ...(leadEnabled === undefined ? {} : { leadEnabled }) })
  t.after(() => host.dispose())
  return { host, home }
}
const unavailable = (error: any) => error.wireCode === 'lead-unavailable'

for (const enabled of [undefined, false]) test(`disabled host (${String(enabled)}) refuses a Lead owner before reading its ports`, async t => {
  const { host } = rig(t, enabled)
  let reads = 0
  const options = new Proxy({}, { get() { reads++; throw new Error('Lead service ports were read') } })
  assert.throws(() => host.createLeadService(options as any), unavailable)
  assert.throws(() => host.registerLead(options as any, options as any), unavailable)
  assert.equal(reads, 0)
  await host.start()
  assert.throws(() => host.createLeadService(options as any), unavailable)
  assert.throws(() => host.registerLead(options as any, options as any), unavailable)
  assert.equal(reads, 0)
})

for (const enabled of [undefined, false]) test(`disabled host (${String(enabled)}) leaves Lead listeners and recovery untouched`, async t => {
  const { host, home } = rig(t, enabled)
  const stale = join(home, 'lead-clients', 'hd-lead-ABC123')
  await mkdir(join(home, 'lead-clients'), { mode: 0o700 })
  await mkdir(stale, { mode: 0o700 })
  await writeFile(join(stale, 'old.sock'), '')
  let recoveries = 0
  t.mock.method(LeadBudgets.prototype, 'recover', async () => { recoveries++ })
  await host.start()
  assert.equal((await lstat(stale)).isDirectory(), true, 'disabled startup must not sweep a Lead listener')
  assert.equal(recoveries, 0)
  assert.equal((await host.call('host/hello', { clientVersion: 'test' }) as any).capabilities?.lead, undefined)
  let keyCalls = 0
  for (const name of ['leadStatus', 'resolveLead', 'storeLead', 'deleteLead'] as const) {
    t.mock.method(host.credentials, name, async () => { keyCalls++; throw new Error('credential port reached') })
  }
  const requests = [
    ['lead/thread/read', {}], ['lead/thread/send', { idempotencyKey: 'off', text: 'Inspect' }],
    ['lead/card/decide', { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' }],
    ['lead/settings/read', {}], ['lead/settings/update', { expectedRevision: 0, credential: { provider: 'anthropic', key: 'synthetic-value' } }],
    ['lead/resume', { expectedRevision: 0 }],
  ] as const
  for (const [method, params] of requests) await assert.rejects(host.call(method as never, params as never), unavailable, method)
  assert.equal(keyCalls, 0)
  assert.equal((await lstat(stale)).isDirectory(), true)
})

test('a default host creates no Lead directory or files', async t => {
  const { host, home } = rig(t)
  await host.start()
  assert.deepEqual((await readdir(home)).filter(name => /lead/i.test(name)), [])
  assert.equal(Object.hasOwn(await host.call('host/hello', { clientVersion: 'test' }), 'capabilities'), false)
})

test('only the explicitly enabled host advertises the Lead capability', async t => {
  const { host } = rig(t, true)
  const hello = await host.call('host/hello', { clientVersion: 'test' })
  assert.deepEqual((hello as any).capabilities, { lead: true })
})

test('the disabled host never lists the private Lead recipe in its Flow catalogue', async t => {
  const { host } = rig(t)
  const project = tempDir('hd-lead-feature-project-')
  await host.start()
  await host.call('workspace/open', { path: project })
  const catalogue = await host.call('flow/catalog', { root: project })
  assert.ok(catalogue.length > 0, 'ordinary built-in Flows remain available')
  assert.equal(catalogue.some(entry => entry.id === 'lead-reviewed-result'), false)
})
