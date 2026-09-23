import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const read = (id: string, context: ProviderContext, cwd?: string) => providerReaderFor({ id }, context)?.(cwd) ?? null

test('Claude Code with nothing overridden serves Anthropic’s models', (t) => {
  const home = tree(t, { '.claude/settings.json': { model: 'opus', env: { DISABLE_TELEMETRY: '1' } } })
  const project = tree(t, {})
  assert.equal(read('claude-code', { home, env: {}, managed: null }), 'anthropic')
  assert.equal(read('claude-code', { home, env: {}, managed: null }, project), 'anthropic')
})

test('Claude Code pointed anywhere else, by any of its own settings, is unknown', (t) => {
  const clean = tree(t, {})
  assert.equal(read('claude-code', { home: clean, env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' }, managed: null }), null, 'the environment')
  assert.equal(read('claude-code', { home: clean, env: { CLAUDE_CODE_USE_BEDROCK: '1' }, managed: null }), null, 'another host')
  const user = tree(t, { '.claude/settings.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(read('claude-code', { home: user, env: {}, managed: null }), null, 'the user settings’ env block')
  const moved = tree(t, { 'elsewhere/settings.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(read('claude-code', { home: clean, env: { CLAUDE_CONFIG_DIR: join(moved, 'elsewhere') }, managed: null }), null, 'CLAUDE_CONFIG_DIR')
  const managed = tree(t, { 'managed-settings.json': { env: { ANTHROPIC_BEDROCK_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(read('claude-code', { home: clean, env: {}, managed: join(managed, 'managed-settings.json') }), null, 'managed settings')
  const project = tree(t, { '.claude/settings.local.json': { env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } } })
  assert.equal(read('claude-code', { home: clean, env: {}, managed: null }, project), null, 'the project’s own settings')
  const broken = tree(t, { '.claude/settings.json': '{ not json' })
  assert.equal(read('claude-code', { home: broken, env: {}, managed: null }), null, 'a settings file that cannot be read rules nothing out')
})

test('Gemini CLI serves Google’s models unless a base URL is set anywhere it reads one', (t) => {
  const clean = tree(t, {})
  assert.equal(read('gemini', { home: clean, env: {} }), 'google')
  assert.equal(read('gemini', { home: clean, env: { GOOGLE_GEMINI_BASE_URL: 'https://proxy.example.com' } }), null)
  const dotenv = tree(t, { '.gemini/.env': 'GOOGLE_GEMINI_BASE_URL=https://proxy.example.com\n' })
  assert.equal(read('gemini', { home: dotenv, env: {} }), null, 'its own .env')
  const project = tree(t, { 'repo/.env': 'GOOGLE_GEMINI_BASE_URL=https://proxy.example.com\n', 'repo/src/.keep': '' })
  assert.equal(read('gemini', { home: clean, env: {} }, join(project, 'repo', 'src')), null, 'a .env above the folder it works in')
  const gateway = tree(t, { '.gemini/settings.json': { security: { auth: { selectedType: 'gateway' } } } })
  assert.equal(read('gemini', { home: gateway, env: {} }), null, 'a gateway sign-in')
})

test('an agent with no reader is unknown, whatever it is called', () => {
  assert.equal(providerReaderFor({ id: 'codex' }, {}), undefined)
  assert.equal(providerReaderFor({ id: 'cursor' }, {}), undefined)
  assert.equal(providerReaderFor(undefined, {}), undefined)
})
