import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import type { RuntimeInfo } from '@harnessdesk/protocol'

import { UpdateChecker, isNewer, upgradeCommand } from '../src/updates.js'

/**
 * The update advisory: a registry dist-tag read, cached for a day, compared
 * against the running version, and never in the way.
 */

const info = (overrides: Partial<RuntimeInfo> & { version: string | null; pkg?: string }): RuntimeInfo =>
  ({
    id: 'codex',
    name: 'Codex',
    version: overrides.version,
    capabilities: {} as RuntimeInfo['capabilities'],
    presentation: {
      name: 'Codex',
      install: {
        command: 'brew install codex',
        ...(overrides.pkg ? { package: overrides.pkg } : {}),
      },
    },
  }) as RuntimeInfo

const registry = (latest: string) => {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return { ok: true, json: async () => ({ latest }) }
  }
  return { fetch, calls }
}

test('isNewer compares release triples and never trusts what it cannot parse', () => {
  assert.equal(isNewer('0.149.0', '0.135.0'), true)
  assert.equal(isNewer('0.149.0', 'codex-cli 0.135.0'), true)
  assert.equal(isNewer('0.135.0', '0.135.0'), false)
  assert.equal(isNewer('0.135.0', '0.149.0'), false)
  assert.equal(isNewer('latest', '0.1.0'), false)
  assert.equal(isNewer('1.0.0', null), false)
})

test('upgradeCommand rephrases an install as an upgrade where the tool distinguishes them', () => {
  assert.equal(upgradeCommand('brew install codex'), 'brew upgrade codex')
  assert.equal(upgradeCommand('npm i -g @openai/codex'), 'npm i -g @openai/codex@latest')
  assert.equal(upgradeCommand('npm install -g @zed-industries/claude-code-acp'), 'npm install -g @zed-industries/claude-code-acp@latest')
  assert.equal(upgradeCommand('npm i -g thing@2'), 'npm i -g thing@2')
  assert.equal(upgradeCommand('curl -fsSL https://x | sh'), 'curl -fsSL https://x | sh')
})

test('a runtime behind its package gets an advisory; one without a package gets nothing', async () => {
  const dir = tempDir('hd-updates-')
  const npm = registry('0.149.0')
  const checker = new UpdateChecker({ cachePath: join(dir, 'cache.json'), fetch: npm.fetch })

  assert.equal(await checker.updateFor(info({ version: '0.135.0' })), null)
  assert.equal(npm.calls.length, 0)

  const update = await checker.updateFor(info({ version: 'codex-cli 0.135.0', pkg: '@openai/codex' }))
  assert.equal(update?.version, '0.149.0')
  assert.equal(update?.command, 'brew upgrade codex')
  assert.equal(update?.url, undefined)
  assert.equal(npm.calls[0], 'https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags')

  // Up to date: no advisory, and the answer came from the cache.
  assert.equal(await checker.updateFor(info({ version: '0.149.0', pkg: '@openai/codex' })), null)
  assert.equal(npm.calls.length, 1)
  const cached = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8')) as Record<string, { latest: string }>
  assert.equal(cached['@openai/codex']?.latest, '0.149.0')
})

test('the cache is honoured within its ttl and refreshed after it', async () => {
  const dir = tempDir('hd-updates-')
  let clock = 1_000
  const npm = registry('0.150.0')
  const make = () =>
    new UpdateChecker({ cachePath: join(dir, 'cache.json'), fetch: npm.fetch, now: () => clock, ttlMs: 100 })
  assert.equal((await make().updateFor(info({ version: '0.1.0', pkg: 'x' })))?.version, '0.150.0')
  clock += 50
  await make().updateFor(info({ version: '0.1.0', pkg: 'x' })) // a fresh checker reads the file
  assert.equal(npm.calls.length, 1)
  clock += 100
  await make().updateFor(info({ version: '0.1.0', pkg: 'x' }))
  assert.equal(npm.calls.length, 2)
})

test('an unreachable registry is a null, not an error, and keeps the last answer', async () => {
  const dir = tempDir('hd-updates-')
  let clock = 0
  let online = true
  const fetch = async (url: string) => {
    if (!online) throw new Error(`offline: ${url}`)
    return { ok: true, json: async () => ({ latest: '2.0.0' }) }
  }
  const checker = new UpdateChecker({ cachePath: join(dir, 'cache.json'), fetch, now: () => clock, ttlMs: 10 })
  assert.equal((await checker.updateFor(info({ version: '1.0.0', pkg: 'x' })))?.version, '2.0.0')
  online = false
  clock = 100
  assert.equal((await checker.updateFor(info({ version: '1.0.0', pkg: 'x' })))?.version, '2.0.0')
  const fresh = new UpdateChecker({ cachePath: join(dir, 'nothing.json'), fetch })
  assert.equal(await fresh.updateFor(info({ version: '1.0.0', pkg: 'x' })), null)
})
