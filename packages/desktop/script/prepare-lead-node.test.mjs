import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { prepareLeadNode } from './prepare-lead-node.mjs'

test('development startup reuses the pinned fetcher and a fetch failure leaves startup available', async () => {
  const calls = [], warnings = []
  await prepareLeadNode({ platform: 'darwin', arch: 'arm64', fetchNode: async value => { calls.push(value) } })
  assert.deepEqual(calls, [{ arch: 'arm64' }])
  await assert.doesNotReject(prepareLeadNode({ platform: 'darwin', arch: 'x64', fetchNode: async () => { throw new Error('fixture network unavailable') }, warn: text => warnings.push(text) }))
  assert.match(warnings[0], /fixture network unavailable/)
  await prepareLeadNode({ platform: 'linux', fetchNode: async () => assert.fail('macOS fetch only') })
})

test('both source launch scripts prepare the fetched runtime before Electron', async () => {
  const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const name of ['start', 'dev']) assert.match(scripts[name], /^node script\/prepare-lead-node\.mjs && .*electron \.$/)
})
