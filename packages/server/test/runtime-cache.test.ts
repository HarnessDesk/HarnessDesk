import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AccountStatus } from '@harnessdesk/protocol'
import { RuntimeCache } from '../src/runtime-cache.js'

test('atomic queued observations survive reload and exclude extra account fields and sign-in payloads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-display-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'runtime-cache.json')
  const failures: unknown[] = []
  const cache = new RuntimeCache(path, error => failures.push(error))
  await cache.load()
  const secret = 'synthetic-token'
  cache.update('one', { account: { accounts: [{ kind: 'subscription', label: 'Jane Doe', planType: 'Demo', email: 'dev@example.com', token: secret }], signInMethods: [{ id: secret, label: 'Sign in', flow: 'external', key: secret }] } as unknown as AccountStatus })
  cache.update('two', { models: [], commands: [], start: { readyMs: 200, modelsMs: 350 } })
  await cache.flush()
  const text = await readFile(path, 'utf8')
  assert.ok(!text.includes(secret))
  assert.ok(!text.includes('dev@example.com'))
  const again = new RuntimeCache(path, error => failures.push(error))
  await again.load()
  assert.deepEqual(again.get('one').account, { accounts: [{ kind: 'subscription', label: 'Jane Doe', planType: 'Demo' }], signInMethods: [] })
  assert.deepEqual(again.get('two').start, { readyMs: 200, modelsMs: 350 })
  assert.deepEqual(again.get('two').models, [])
  assert.deepEqual(again.get('missing'), {})
  assert.deepEqual(failures, [])
})

test('invalid costs and unreadable cache do not prevent launch or become measured-fast', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-display-cache-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'runtime-cache.json')
  const failures: unknown[] = []
  await writeFile(path, JSON.stringify({ version: 1, runtimes: { bad: { start: { readyMs: -1, modelsMs: 0 } }, good: { start: { readyMs: 500, modelsMs: null } } } }))
  const cache = new RuntimeCache(path, error => failures.push(error))
  await cache.load()
  assert.deepEqual(cache.get('bad'), {})
  assert.deepEqual(cache.get('good').start, { readyMs: 500, modelsMs: null })
  await writeFile(path, 'partial bytes')
  await new RuntimeCache(path, error => failures.push(error)).load()
  assert.equal(failures.length, 2)
})
