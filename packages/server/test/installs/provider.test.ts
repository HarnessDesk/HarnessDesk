import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { providerReaderFor, type ProviderContext } from '../../src/installs/provider.js'

/*
 * Which vendor an agent's models come from, read from the agent's own
 * configuration: the vendor when nothing the person set could point it
 * elsewhere, unknown the moment anything could — an environment variable,
 * a settings file's `env` block, a project's own settings or `.env` — and
 * unknown for an agent this desk has no reader for.
 */

const tree = (t: TestContext, files: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-provider-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return dir
}

const read = async (id: string, context: ProviderContext, cwd?: string) => (await providerReaderFor({ id }, context)?.(cwd)) ?? null

test('Claude Code with nothing overridden serves Anthropic’s models', async (t) => {
  const home = tree(t, { '.claude/settings.json': { model: 'opus', env: { DISABLE_TELEMETRY: '1' } } })
  const project = tree(t, {})
  assert.equal(await read('claude-code', { home, env: {}, managed: null }), 'anthropic')
  assert.equal(await read('claude-code', { home, env: {}, managed: null }, project), 'anthropic')
})

test('Claude Code pointed anywhere else, by any of its own settings, is unknown', async (t) => {
  const clean = tree(t, {})
  assert.equal(await read('claude-code', { home: clean, env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, managed: null }), null, 'the environment')
  assert.equal(await read('claude-code', { home: clean, env: { CLAUDE_CODE_USE_BEDROCK: '1' }, managed: null }), null, 'another host')
  const user = tree(t, { '.claude/settings.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(await read('claude-code', { home: user, env: {}, managed: null }), null, 'the user settings’ env block')
  const moved = tree(t, { 'elsewhere/settings.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(await read('claude-code', { home: clean, env: { CLAUDE_CONFIG_DIR: join(moved, 'elsewhere') }, managed: null }), null, 'CLAUDE_CONFIG_DIR')
  const managed = tree(t, { 'managed-settings.json': { env: { ANTHROPIC_BEDROCK_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(await read('claude-code', { home: clean, env: {}, managed: join(managed, 'managed-settings.json') }), null, 'managed settings')
  const project = tree(t, { '.claude/settings.local.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(await read('claude-code', { home: clean, env: {}, managed: null }, project), null, 'the project’s own settings')
  const broken = tree(t, { '.claude/settings.json': '{ not json' })
  assert.equal(await read('claude-code', { home: broken, env: {}, managed: null }), null, 'a settings file that cannot be read rules nothing out')
})

test('Gemini CLI serves Google’s models unless a base URL is set anywhere it reads one', async (t) => {
  const clean = tree(t, {})
  assert.equal(await read('gemini', { home: clean, env: {} }), 'google')
  assert.equal(await read('gemini', { home: clean, env: { GOOGLE_GEMINI_BASE_URL: 'https://proxy.example.com' } }), null)
  const dotenv = tree(t, { '.gemini/.env': 'GOOGLE_GEMINI_BASE_URL=https://proxy.example.com\n' })
  assert.equal(await read('gemini', { home: dotenv, env: {} }), null, 'its own .env')
  const project = tree(t, { 'repo/.git/HEAD': 'ref: refs/heads/main\n', 'repo/.env': 'GOOGLE_GEMINI_BASE_URL=https://proxy.example.com\n', 'repo/src/.keep': '' })
  assert.equal(await read('gemini', { home: clean, env: {} }, join(project, 'repo', 'src')), null, 'a .env above the folder it works in')
  const gateway = tree(t, { '.gemini/settings.json': { security: { auth: { selectedType: 'gateway' } } } })
  assert.equal(await read('gemini', { home: gateway, env: {} }), null, 'a gateway sign-in')
})

test('an agent with no reader is unknown, whatever it is called', () => {
  assert.equal(providerReaderFor({ id: 'codex' }, {}), undefined)
  assert.equal(providerReaderFor({ id: 'cursor' }, {}), undefined)
  assert.equal(providerReaderFor(undefined, {}), undefined)
})

/*
 * What a clone can plant in a project — a link to a device or elsewhere, a
 * FIFO, a file far too large, a linked folder on the way down — is unknown,
 * promptly, and never holds the desk's thread: the timer below must keep
 * ticking while the read runs.
 */
const promptly = async <T>(work: () => Promise<T>): Promise<T> => {
  let last = performance.now()
  let longest = 0
  const held = (): number => process.memoryUsage().arrayBuffers
  const before = held()
  let peak = before
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    peak = Math.max(peak, held())
  }, 5)
  const started = performance.now()
  try {
    const value = await work()
    longest = Math.max(longest, performance.now() - last)
    const took = performance.now() - started
    assert.ok(took < 1_000, `answered in ${Math.round(took)} ms`)
    assert.ok(longest < 250, `the event loop was held for ${Math.round(longest)} ms`)
    peak = Math.max(peak, held())
    assert.ok(peak - before < 64 * 1024 * 1024, `the read held ${Math.round((peak - before) / 1024 / 1024)} MiB`)
    return value
  } finally {
    clearInterval(timer)
  }
}

const HOSTILE: readonly [string, (file: string) => void][] = [
  ['linked to /dev/stdin', (file) => symlinkSync('/dev/stdin', file)],
  ['linked to /dev/zero', (file) => symlinkSync('/dev/zero', file)],
  ['a FIFO', (file) => execFileSync('mkfifo', [file])],
  ['oversized', (file) => { writeFileSync(file, '{}'); truncateSync(file, 1536 * 1024 * 1024) }],
]

for (const [what, plant] of HOSTILE) {
  test(`a project’s Claude Code settings ${what} are unknown, promptly`, async (t) => {
    const home = tree(t, {})
    const project = tree(t, { '.claude/.keep': '' })
    plant(join(project, '.claude', 'settings.local.json'))
    assert.equal(await promptly(() => read('claude-code', { home, env: {}, managed: null }, project)), null)
  })
  test(`a project’s Gemini .env ${what} is unknown, promptly`, async (t) => {
    const home = tree(t, {})
    const project = tree(t, { '.git/HEAD': 'ref: refs/heads/main\n', 'src/.keep': '' })
    plant(join(project, '.env'))
    assert.equal(await promptly(() => read('gemini', { home, env: {} }, join(project, 'src'))), null)
  })
}

test('a project file reached through a linked folder is unknown, even a harmless one', async (t) => {
  const home = tree(t, {})
  const elsewhere = tree(t, { 'settings.json': { model: 'opus' }, '.env': 'HARMLESS=1\n' })
  const claude = tree(t, {})
  symlinkSync(elsewhere, join(claude, '.claude'))
  assert.equal(await promptly(() => read('claude-code', { home, env: {}, managed: null }, claude)), null)
  const gemini = tree(t, { '.git/HEAD': 'ref: refs/heads/main\n' })
  symlinkSync(elsewhere, join(gemini, 'linked'))
  assert.equal(await promptly(() => read('gemini', { home, env: {} }, join(gemini, 'linked'))), null, 'an ancestor inside the checkout')
  const dotenv = tree(t, { '.git/HEAD': 'ref: refs/heads/main\n' })
  symlinkSync(join(elsewhere, '.env'), join(dotenv, '.env'))
  assert.equal(await promptly(() => read('gemini', { home, env: {} }, dotenv)), null, 'a harmless .env the checkout only links to')
})

test('the person’s own settings, linked to a device, are unknown and not read', async (t) => {
  for (const device of ['/dev/zero', '/dev/null']) {
    const home = tree(t, { '.claude/.keep': '' })
    symlinkSync(device, join(home, '.claude', 'settings.json'))
    assert.equal(await promptly(() => read('claude-code', { home, env: {}, managed: null })), null, `${device} is not a settings file`)
  }
  const gemini = tree(t, { '.gemini/.keep': '' })
  symlinkSync('/dev/null', join(gemini, '.gemini', 'settings.json'))
  assert.equal(await promptly(() => read('gemini', { home: gemini, env: {} })), null, '/dev/null is not Gemini’s settings file')
  const big = tree(t, { '.gemini/.env': 'HARMLESS=1\n' })
  truncateSync(join(big, '.gemini', '.env'), 1536 * 1024 * 1024)
  assert.equal(await promptly(() => read('gemini', { home: big, env: {} })), null, 'an oversized .env of the person’s own, never read whole')
  const linked = tree(t, { 'dotfiles/settings.json': { model: 'opus' }, '.claude/.keep': '' })
  symlinkSync(join(linked, 'dotfiles', 'settings.json'), join(linked, '.claude', 'settings.json'))
  assert.equal(await read('claude-code', { home: linked, env: {}, managed: null }), 'anthropic', 'a dotfiles link of the person’s own is still read')
})
