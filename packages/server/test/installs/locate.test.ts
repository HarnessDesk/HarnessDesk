import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  candidatePaths,
  compareVersionsDesc,
  expandHome,
  findInstalls,
  judgeInstalls,
  meetsFloor,
} from '../../src/installs/locate.js'

/**
 * Every copy of an agent on the machine, and which one answers. What these
 * hold to: PATH order breaks ties and nothing else; symlinked twins are one
 * copy; the newest readable copy that is new enough is chosen, a pin wins
 * over that, and a copy that does not answer for its version is never run.
 */

const HOME = '/Users/x'
const ENV = { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin' }

test('candidates come from PATH first, in its order, then the known places', () => {
  const paths = candidatePaths(
    { commands: ['codebuddy', 'cbc'], paths: ['~/.codebuddy/bin/codebuddy'] },
    { env: ENV, home: HOME, platform: 'darwin', also: ['/Users/x/.harnessdesk/acp-agents/cb/1.0.0/codebuddy', 'relative/no'] },
  )
  assert.deepEqual(paths.slice(0, 4), [
    '/opt/homebrew/bin/codebuddy',
    '/opt/homebrew/bin/cbc',
    '/Users/x/.local/bin/codebuddy',
    '/Users/x/.local/bin/cbc',
  ])
  assert.ok(paths.includes('/Users/x/.codebuddy/bin/codebuddy'))
  assert.ok(paths.includes('/Users/x/.harnessdesk/acp-agents/cb/1.0.0/codebuddy'))
  assert.ok(!paths.some((path) => path.startsWith('relative')))
  assert.equal(expandHome('~/.x/y', HOME), '/Users/x/.x/y')
})

test('on Windows the executable suffixes are tried too', () => {
  const paths = candidatePaths({ commands: ['gemini'] }, { env: { PATH: 'C:\\tools' }, home: 'C:\\Users\\x', platform: 'win32' })
  assert.ok(paths.some((path) => path.endsWith('gemini.cmd')))
  assert.ok(paths.some((path) => path.endsWith('gemini.exe')))
})

test('versions compare as triples and the floor is inclusive', () => {
  assert.ok(compareVersionsDesc('1.18.29', '1.18.27') < 0, 'newer sorts first')
  assert.ok(compareVersionsDesc(null, '1.0.0') > 0, 'unreadable sorts last')
  assert.equal(compareVersionsDesc('2026.8.2', '2026.8.2'), 0)
  assert.ok(compareVersionsDesc('2026.9.2', '2026.8.2') < 0)
  assert.equal(meetsFloor('0.58.0', '0.58.0'), true)
  assert.equal(meetsFloor('0.57.9', '0.58.0'), false)
  assert.equal(meetsFloor(null, '0.58.0'), false)
  assert.equal(meetsFloor('anything', undefined), true)
})

test('copies are probed, deduplicated through symlinks, and ordered newest first', async () => {
  const files = new Map<string, string>([
    ['/opt/homebrew/bin/opencode', '/opt/homebrew/Cellar/opencode/1.18.27/bin/opencode'],
    ['/Users/x/.local/bin/opencode', '/Users/x/.local/bin/opencode'],
    ['/Users/x/.opencode/bin/opencode', '/Users/x/.local/bin/opencode'], // the same file, linked twice
    ['/Users/x/.harnessdesk/acp-agents/opencode/1.18.20/opencode', '/Users/x/.harnessdesk/acp-agents/opencode/1.18.20/opencode'],
  ])
  const versions: Record<string, string | null> = {
    '/opt/homebrew/bin/opencode': 'opencode 1.18.27',
    '/Users/x/.local/bin/opencode': '1.18.29',
    '/Users/x/.harnessdesk/acp-agents/opencode/1.18.20/opencode': '1.18.20',
  }
  const probed: string[] = []
  const found = await findInstalls(
    { commands: ['opencode'], paths: ['~/.opencode/bin/opencode'], publish: { brewFormula: 'opencode', selfUpdate: 'opencode upgrade' } },
    {
      env: ENV,
      home: HOME,
      platform: 'darwin',
      managedDir: '/Users/x/.harnessdesk/acp-agents',
      also: ['/Users/x/.harnessdesk/acp-agents/opencode/1.18.20/opencode'],
      exists: (path) => files.has(path),
      realpath: (path) => files.get(path) ?? path,
      probe: async (path) => {
        probed.push(path)
        return versions[path] ?? null
      },
    },
  )
  assert.deepEqual(
    found.map((copy) => [copy.path, copy.version, copy.channel, copy.updateCommand, copy.managed, copy.onPath]),
    [
      ['/Users/x/.local/bin/opencode', '1.18.29', 'installer', 'opencode upgrade', false, true],
      ['/opt/homebrew/bin/opencode', '1.18.27', 'homebrew', 'brew upgrade opencode', false, true],
      ['/Users/x/.harnessdesk/acp-agents/opencode/1.18.20/opencode', '1.18.20', 'harnessdesk', null, true, false],
    ],
  )
  // The twin link was never probed as a second copy.
  assert.equal(probed.filter((path) => path.endsWith('.opencode/bin/opencode')).length, 0)
  assert.equal(probed.length, 3)
})

test('the newest copy that meets the floor is chosen; a pin wins; unreadable is never run', () => {
  const copy = (path: string, version: string | null) => ({
    path,
    realPath: path,
    version,
    channel: 'path' as const,
    packageName: null,
    managed: false,
    onPath: true,
    updateCommand: null,
  })
  const found = [copy('/a', '2.0.0'), copy('/b', '1.5.0'), copy('/c', '0.9.0'), copy('/d', null)]

  const auto = judgeInstalls(found, { minVersion: '1.0.0' })
  assert.equal(auto.chosen?.path, '/a')
  assert.deepEqual(
    auto.copies.map((one) => one.standing),
    ['chosen', 'older', 'too-old', 'unreadable'],
  )

  const pinned = judgeInstalls(found, { minVersion: '1.0.0', pinnedPath: '/b' })
  assert.equal(pinned.chosen?.path, '/b')
  assert.equal(pinned.copies.find((one) => one.path === '/b')?.standing, 'pinned')
  assert.equal(pinned.copies.find((one) => one.path === '/a')?.standing, 'older')
  /* Newest first under a pin too: the pinned copy isn't moved to the front.
     The settings page finds "the copy newest-wins would run" as the first
     usable one in this order (copyReason, #106), so the order is load-bearing (#219). */
  assert.deepEqual(pinned.copies.map((one) => one.path), ['/a', '/b', '/c', '/d'])

  // A pin on a copy that is too old, or gone, falls back to the rule.
  assert.equal(judgeInstalls(found, { minVersion: '1.0.0', pinnedPath: '/c' }).chosen?.path, '/a')
  assert.equal(judgeInstalls(found, { pinnedPath: '/gone' }).chosen?.path, '/a')

  // Nothing new enough: nothing chosen, and every copy says why.
  const none = judgeInstalls([copy('/old', '0.1.0')], { minVersion: '1.0.0' })
  assert.equal(none.chosen, null)
  assert.equal(none.copies[0]?.standing, 'too-old')
})

test("a managed download whose --version prints no number is versioned by its folder", async () => {
  const managed = '/Users/x/.harnessdesk/acp-agents'
  const path = `${managed}/antigravity-acp/1.1.1/agy_acp_server.par`
  const found = await findInstalls(
    { commands: ['agy_acp_server'] },
    {
      env: { PATH: '' },
      home: HOME,
      platform: 'darwin',
      managedDir: managed,
      also: [path],
      exists: (candidate) => candidate === path,
      realpath: (candidate) => candidate,
      probe: async () => 'Built from changelist 975248206 in a mint client based on //depot/branches/x',
    },
  )
  assert.equal(found[0]?.version, '1.1.1')
  assert.equal(found[0]?.channel, 'harnessdesk')
})

test('a PATH entry written with a trailing slash still counts as on PATH', async () => {
  const found = await findInstalls(
    { commands: ['thing'] },
    {
      env: { PATH: '/usr/local/bin/' },
      home: HOME,
      platform: 'darwin',
      exists: (path) => path === '/usr/local/bin/thing',
      realpath: (path) => path,
      probe: async () => 'thing 1.0.0',
    },
  )
  assert.equal(found[0]?.onPath, true)
})
