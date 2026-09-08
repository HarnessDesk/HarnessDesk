import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { AcpRegistry, parseRegistryDocument, registryPlatform } from '../src/acp-registry.js'

/**
 * The public ACP registry, read and acted on. What these tests hold to: the
 * document is judged against *this* machine (a runner missing from PATH or a
 * platform with no build blocks an entry with the reason, never silently),
 * the cache means the list outlives the network, and a binary entry becomes
 * a real command on disk — verified against the registry's digest before a
 * single byte of it is trusted.
 */

const run = promisify(execFile)

const tempDir = () => mkdtemp(join(tmpdir(), 'hd-acp-registry-'))

/** A registry document with one entry per distribution channel. */
const DOCUMENT = {
  version: '1.0.0',
  agents: [
    {
      id: 'npx-agent',
      name: 'Npx Agent',
      version: '2.0.0',
      description: 'Ships through npm.',
      website: 'https://npx-agent.dev',
      license: 'MIT',
      distribution: { npx: { package: 'npx-agent@2.0.0', args: ['--acp'] } },
    },
    {
      id: 'uvx-agent',
      name: 'Uvx Agent',
      version: '3.0.0',
      distribution: { uvx: { package: 'uvx-agent==3.0.0', env: { MODE: 'acp' } } },
    },
    {
      id: 'binary-agent',
      name: 'Binary Agent',
      version: '1.2.3',
      distribution: {
        binary: {
          'darwin-aarch64': { archive: 'https://example.test/agent.tar.gz', cmd: './bin/agent' },
          'linux-x86_64': { archive: 'https://example.test/agent-linux.tar.gz', cmd: './bin/agent' },
        },
      },
    },
    { id: 'broken-entry', name: 'No Version' },
  ],
}

test('the document is read forgivingly and judged against this machine', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => DOCUMENT,
    which: async (command) => (command === 'npx' ? '/usr/bin/npx' : null),
    platform: 'darwin-aarch64',
  })

  const catalog = await registry.catalog((id) => id === 'binary-agent')
  // The malformed entry cost itself, not the list.
  assert.deepEqual(
    catalog.agents.map((agent) => agent.id),
    ['npx-agent', 'uvx-agent', 'binary-agent'],
  )
  const [npx, uvx, binary] = catalog.agents
  assert.equal(npx?.available, true)
  assert.equal(npx?.run, 'npx')
  assert.equal(npx?.website, 'https://npx-agent.dev')
  // uvx is not on this fake machine, and the row says so.
  assert.equal(uvx?.available, false)
  assert.match(uvx?.reason ?? '', /uvx/)
  // A binary with a build for this platform is addable with no runner at all.
  assert.equal(binary?.available, true)
  assert.equal(binary?.run, 'binary')
  assert.equal(binary?.registered, true)
})

test('a platform with no build blocks a binary entry with the reason', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => DOCUMENT,
    which: async () => null,
    platform: 'windows-aarch64',
  })
  const catalog = await registry.catalog(() => false)
  const binary = catalog.agents.find((agent) => agent.id === 'binary-agent')
  assert.equal(binary?.available, false)
  assert.match(binary?.reason ?? '', /windows-aarch64/)
})

test('the cache serves while fresh, and again when the network says no', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  let fetches = 0
  let fail = false
  const make = () =>
    new AcpRegistry({
      stateDir: dir,
      fetchJson: async () => {
        fetches += 1
        if (fail) throw new Error('offline')
        return DOCUMENT
      },
      which: async () => '/usr/bin/found',
      platform: 'darwin-aarch64',
    })

  await make().catalog(() => false)
  assert.equal(fetches, 1)
  // A second client over the same state directory reads the cache, not the net.
  const again = await make().catalog(() => false)
  assert.equal(fetches, 1)
  assert.equal(again.agents.length, 3)

  // Stale cache, dead network: the list from last time, not an empty screen.
  fail = true
  const stale = new AcpRegistry({
    stateDir: dir,
    freshMs: 0,
    fetchJson: async () => {
      fetches += 1
      throw new Error('offline')
    },
    which: async () => '/usr/bin/found',
    platform: 'darwin-aarch64',
  })
  const offline = await stale.catalog(() => false)
  assert.equal(offline.agents.length, 3)
  assert.equal(offline.unavailable, undefined)
})

test('no cache and no network is an honest empty list', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => {
      throw new Error('offline')
    },
    which: async () => null,
  })
  const catalog = await registry.catalog(() => false)
  assert.equal(catalog.agents.length, 0)
  assert.equal(catalog.fetchedAt, null)
  assert.match(catalog.unavailable ?? '', /could not be reached/)
})

test('a package-runner entry resolves to its runner, provenance and all', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => DOCUMENT,
    which: async () => '/usr/bin/found',
    platform: 'darwin-aarch64',
  })
  const { entry, config } = await registry.resolve('npx-agent')
  assert.equal(config.command, 'npx')
  // `-y`, because there is no terminal here to answer npx's first-run prompt.
  assert.deepEqual(config.args, ['-y', 'npx-agent@2.0.0', '--acp'])
  assert.equal(config.tagline, 'Ships through npm.')
  assert.deepEqual(entry['registry'], { id: 'npx-agent', version: '2.0.0' })

  const uvx = await registry.resolve('uvx-agent')
  assert.equal(uvx.config.command, 'uvx')
  assert.deepEqual(uvx.config.args, ['uvx-agent==3.0.0'])
  assert.deepEqual(uvx.config.env, { MODE: 'acp' })

  await assert.rejects(registry.resolve('no-such-agent'), /no agent with the id/)
})

/** A real tar.gz holding `bin/agent`, plus its digest — what a binary entry names. */
const makeArchive = async (dir: string): Promise<{ archive: string; sha256: string }> => {
  const stage = join(dir, 'stage')
  await mkdir(join(stage, 'bin'), { recursive: true })
  await writeFile(join(stage, 'bin', 'agent'), '#!/bin/sh\necho agent\n')
  const archive = join(dir, 'agent.tar.gz')
  await run('tar', ['-czf', archive, '-C', stage, 'bin'])
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  return { archive, sha256 }
}

test('a binary entry is downloaded, verified, unpacked and made runnable', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { archive, sha256 } = await makeArchive(dir)
  let downloads = 0
  const document = {
    agents: [
      {
        id: 'bin',
        name: 'Bin',
        version: '9.9.9',
        distribution: {
          binary: {
            'darwin-aarch64': {
              archive: 'https://example.test/agent.tar.gz',
              cmd: './bin/agent',
              args: ['acp'],
              sha256,
            },
          },
        },
      },
    ],
  }
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => document,
    download: async (_url, to) => {
      downloads += 1
      await copyFile(archive, to)
    },
    which: async () => null,
    platform: 'darwin-aarch64',
  })

  const { entry, config } = await registry.resolve('bin')
  assert.equal(config.command, join(dir, 'acp-agents', 'bin', '9.9.9', 'bin', 'agent'))
  assert.deepEqual(config.args, ['acp'])
  assert.equal(config.cwd, join(dir, 'acp-agents', 'bin', '9.9.9', 'bin'))
  assert.doesNotThrow(() => accessSync(config.command, constants.X_OK))
  assert.deepEqual(entry['registry'], { id: 'bin', version: '9.9.9' })
  // The archive is spent once unpacked — some are hundreds of megabytes.
  const leftovers = await readdir(join(dir, 'acp-agents', 'bin', '9.9.9'))
  assert.ok(!leftovers.some((name) => name.startsWith('archive-')), 'the archive was cleaned up')
  // Adding the same version again reuses the unpacked copy.
  await registry.resolve('bin')
  assert.equal(downloads, 1)
})

test('a download that does not match its digest is refused whole', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { archive } = await makeArchive(dir)
  const document = {
    agents: [
      {
        id: 'bin',
        name: 'Bin',
        version: '1.0.0',
        distribution: {
          binary: {
            'darwin-aarch64': {
              archive: 'https://example.test/agent.tar.gz',
              cmd: './bin/agent',
              sha256: 'deadbeef'.repeat(8),
            },
          },
        },
      },
    ],
  }
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => document,
    download: async (_url, to) => copyFile(archive, to),
    which: async () => null,
    platform: 'darwin-aarch64',
  })
  await assert.rejects(registry.resolve('bin'), /does not match the registry's digest/)
})

test('an archive without the promised command inside names what was missing', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { archive } = await makeArchive(dir)
  const document = {
    agents: [
      {
        id: 'bin',
        name: 'Bin',
        version: '1.0.0',
        distribution: {
          binary: {
            'darwin-aarch64': { archive: 'https://example.test/a.tar.gz', cmd: './bin/other' },
          },
        },
      },
    ],
  }
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => document,
    download: async (_url, to) => copyFile(archive, to),
    which: async () => null,
    platform: 'darwin-aarch64',
  })
  await assert.rejects(registry.resolve('bin'), /\.\/bin\/other was not inside it/)
})

test('platform names follow the registry, not Node', () => {
  assert.equal(registryPlatform('darwin', 'arm64'), 'darwin-aarch64')
  assert.equal(registryPlatform('linux', 'x64'), 'linux-x86_64')
  assert.equal(registryPlatform('win32', 'arm64'), 'windows-aarch64')
})

test('parsing tolerates a document that is not one', () => {
  assert.deepEqual(parseRegistryDocument(null), [])
  assert.deepEqual(parseRegistryDocument({ agents: 'nope' }), [])
  assert.deepEqual(parseRegistryDocument({ agents: [{ id: 'x' }] }), [])
})

test('registry-written paths are confined before any byte moves', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  let downloads = 0
  const entry = (over: Record<string, unknown>) => ({
    id: 'ok',
    name: 'Ok',
    version: '1.0.0',
    distribution: {
      binary: {
        'darwin-aarch64': { archive: 'https://example.test/a.tar.gz', cmd: './bin/agent' },
      },
    },
    ...over,
  })
  const make = (agent: Record<string, unknown>) =>
    new AcpRegistry({
      stateDir: dir,
      // Never fresh: three registries share this state directory, and each
      // case must read its own document rather than the previous one's cache.
      freshMs: 0,
      fetchJson: async () => ({ agents: [agent] }),
      download: async () => {
        downloads += 1
      },
      which: async () => null,
      platform: 'darwin-aarch64',
    })

  // A version that walks upward is refused as a name, never joined.
  await assert.rejects(
    make(entry({ version: '..' })).resolve('ok'),
    /not a plain directory name/,
  )
  // An id with a separator dies in the parser (ids are structural), and one
  // that is dot-led is refused here.
  await assert.rejects(make(entry({ id: '.hidden' })).resolve('.hidden'), /not a plain directory name/)
  // A command that resolves outside its own install folder is refused.
  await assert.rejects(
    make(
      entry({
        distribution: {
          binary: {
            'darwin-aarch64': { archive: 'https://example.test/a.tar.gz', cmd: '../../escape' },
          },
        },
      }),
    ).resolve('ok'),
    /points outside its own folder/,
  )
  assert.equal(downloads, 0, 'every refusal happened before a single download')
})

test('a refused install leaves no staging folder and no half-trusted tree', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { archive } = await makeArchive(dir)
  const document = {
    agents: [
      {
        id: 'bin',
        name: 'Bin',
        version: '1.0.0',
        distribution: {
          binary: {
            'darwin-aarch64': {
              archive: 'https://example.test/agent.tar.gz',
              cmd: './bin/agent',
              sha256: 'deadbeef'.repeat(8),
            },
          },
        },
      },
    ],
  }
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => document,
    download: async (_url, to) => copyFile(archive, to),
    which: async () => null,
    platform: 'darwin-aarch64',
  })
  await assert.rejects(registry.resolve('bin'), /digest/)
  const left = await readdir(join(dir, 'acp-agents', 'bin')).catch(() => [])
  assert.deepEqual(left, [], 'nothing under the id — no staging, no partial version dir')
})

test('uninstall deletes only the named agent’s downloads', async (t) => {
  const dir = await tempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'acp-agents', 'mine', '1.0.0'), { recursive: true })
  await writeFile(join(dir, 'acp-agents', 'mine', '1.0.0', 'agent'), 'x')
  await mkdir(join(dir, 'acp-agents', 'other'), { recursive: true })
  const registry = new AcpRegistry({
    stateDir: dir,
    fetchJson: async () => ({ agents: [] }),
    which: async () => null,
  })

  registry.uninstall('mine')
  const after = await readdir(join(dir, 'acp-agents'))
  assert.deepEqual(after, ['other'], 'every version of the named agent left; nothing else did')

  // A name that is not a plain directory name is a no-op, never a walk.
  registry.uninstall('..')
  registry.uninstall('.')
  assert.deepEqual(await readdir(join(dir, 'acp-agents')), ['other'])
  assert.ok((await readdir(dir)).includes('acp-agents'), 'the install root itself is untouched')
})
