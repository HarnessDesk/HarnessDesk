import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIosControl } from './build-ios-control.mjs'
test('non-macOS skips without running compiler', async () => {
  assert.equal(await buildIosControl({ platform: 'linux', run: () => { throw Error('must not run') } }), undefined)
})
test('required build refuses missing or stale architecture output', async () => {
  for (const exists of [false, true]) {
    await assert.rejects(buildIosControl({ platform: 'darwin', arch: 'arm64', required: true, remove: () => {}, exists: () => exists, run: async (bin) => ({ stdout: bin === 'lipo' ? 'x86_64' : '' }) }), /architecture|output/)
  }
})
