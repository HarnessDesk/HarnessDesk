import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { identityReaderFor, type IdentityContext } from '../../src/installs/identity.js'

/**
 * Who an agent is signed in as, read from files laid out the way each agent
 * writes them — the shapes measured on 2026-09-09 against Gemini CLI 0.59.0,
 * Cline 3.0.61 and the Antigravity ACP server 1.1.1.
 */

const home = (t: TestContext, files: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return dir
}

const read = (id: string, context: IdentityContext) => identityReaderFor({ id }, context)?.() ?? null

test('Gemini CLI signed in with Google is named by the account it cached', (t) => {
  const dir = home(t, {
    '.gemini/settings.json': { security: { auth: { selectedType: 'oauth-personal' } } },
    '.gemini/google_accounts.json': { active: 'dev@example.com', old: [] },
  })
  assert.deepEqual(read('gemini', { home: dir, env: {} }), {
    kind: 'agent',
    label: 'dev@example.com',
    email: 'dev@example.com',
  })
})

test('Gemini CLI on a key says so, and names nobody — a cached Google account is not who a key runs as', (t) => {
  const dir = home(t, {
    '.gemini/settings.json': { security: { auth: { selectedType: 'gemini-api-key' } } },
    '.gemini/google_accounts.json': { active: 'dev@example.com', old: [] },
  })
  assert.deepEqual(read('gemini', { home: dir, env: {} }), { kind: 'agent', label: 'Gemini API key', anonymous: true })
})

test('a Google sign-in with no cached account says how, not who', (t) => {
  const dir = home(t, { '.gemini/settings.json': { security: { auth: { selectedType: 'oauth-personal' } } } })
  assert.deepEqual(read('gemini', { home: dir, env: {} }), { kind: 'agent', label: 'Google account', anonymous: true })
})

test('Gemini CLI: the pre-0.3 key, GEMINI_CLI_HOME, and its own fallback to the environment', (t) => {
  const legacy = home(t, { '.gemini/settings.json': { selectedAuthType: 'vertex-ai' } })
  assert.equal(read('gemini', { home: legacy, env: {} })?.label, 'Vertex AI')

  const moved = home(t, {
    '.gemini/settings.json': { security: { auth: { selectedType: 'oauth-personal' } } },
    '.gemini/google_accounts.json': { active: 'dev@example.com' },
  })
  const empty = home(t, {})
  assert.equal(read('gemini', { home: empty, env: { GEMINI_CLI_HOME: moved } })?.email, 'dev@example.com')
  assert.equal(read('gemini', { home: empty, env: { GEMINI_API_KEY: 'k' } })?.label, 'Gemini API key')
  assert.equal(read('gemini', { home: empty, env: { GOOGLE_GENAI_USE_GCA: 'true' } })?.label, 'Google account')
  assert.equal(read('gemini', { home: empty, env: {} }), null, 'no method chosen and none implied: nobody')
})

test('a settings file that is not JSON names nobody', (t) => {
  const dir = home(t, { '.gemini/settings.json': '{ not json' })
  assert.equal(read('gemini', { home: dir, env: {} }), null)
})

test('Antigravity says how it signed in and never who — its address is in the keychain', (t) => {
  const dir = home(t, {
    '.gemini/antigravity-acp/settings.json': { auth: { type: 'oauth-personal' } },
    // Gemini CLI's cache sits one folder up. It is not Antigravity's.
    '.gemini/google_accounts.json': { active: 'dev@example.com' },
  })
  assert.deepEqual(read('antigravity-acp', { home: dir, env: {} }), {
    kind: 'agent',
    label: 'Google account',
    anonymous: true,
  })

  // GEMINI_HOME is the `.gemini` folder itself; `vertex-ai` is the old spelling.
  const moved = home(t, { 'antigravity-acp/settings.json': { auth: { type: 'vertex-ai' } } })
  assert.equal(read('antigravity-acp', { home: dir, env: { GEMINI_HOME: moved } })?.label, 'Agent Platform')

  assert.equal(read('antigravity-acp', { home: home(t, {}), env: {} }), null, 'never signed in: nobody')
  const unknown = home(t, { '.gemini/antigravity-acp/settings.json': { auth: { type: 'something-new' } } })
  assert.equal(read('antigravity-acp', { home: unknown, env: {} }), null, 'a method the reader does not know names nobody')
})

test('Cline is named by the account its provider in use signed in to', (t) => {
  const providers = (lastUsedProvider: string) => ({
    version: 1,
    lastUsedProvider,
    modes: {},
    providers: {
      cline: {
        settings: {
          provider: 'cline',
          auth: {
            accessToken: 'token',
            metadata: { provider: 'cline', userInfo: { email: 'dev@example.com', name: 'Dev' } },
          },
        },
        updatedAt: '2026-09-09T00:00:00.000Z',
        tokenSource: 'oauth',
      },
      anthropic: {
        settings: { provider: 'anthropic', apiKey: 'key' },
        updatedAt: '2026-09-09T00:00:00.000Z',
        tokenSource: 'manual',
      },
    },
  })
  const signedIn = home(t, { '.cline/data/settings/providers.json': providers('cline') })
  assert.deepEqual(read('cline', { home: signedIn, args: ['-y', 'cline@3.0.61', '--acp'] }), {
    kind: 'agent',
    label: 'dev@example.com',
    email: 'dev@example.com',
  })

  const onAKey = home(t, { '.cline/data/settings/providers.json': providers('anthropic') })
  assert.equal(read('cline', { home: onAKey }), null, 'a provider on a bare key names nobody')

  const moved = home(t, { 'state/settings/providers.json': providers('cline') })
  const elsewhere = home(t, {})
  assert.equal(read('cline', { home: elsewhere, args: ['--acp', '--data-dir', join(moved, 'state')] })?.email, 'dev@example.com')
  assert.equal(read('cline', { home: elsewhere, args: ['--acp', `--data-dir=${join(moved, 'state')}`] })?.email, 'dev@example.com')
  assert.equal(read('cline', { home: signedIn, args: ['--acp', '--config', '/elsewhere'] }), null, '--config alone is not guessed at')
})

test("Gemini CLI's environment fallback is its own, branch for branch — and GOOGLE_API_KEY alone chooses nothing", (t) => {
  const empty = home(t, {})
  assert.equal(read('gemini', { home: empty, env: { CLOUD_SHELL: 'true' } })?.label, 'Google Cloud credentials')
  assert.equal(read('gemini', { home: empty, env: { GEMINI_CLI_USE_COMPUTE_ADC: 'true' } })?.label, 'Google Cloud credentials')
  // Gemini reads GOOGLE_API_KEY only inside a method already chosen; on its
  // own it chooses none, and no session opens (getAuthTypeFromEnv, 0.59.0).
  assert.equal(read('gemini', { home: empty, env: { GOOGLE_API_KEY: 'k' } }), null)
})

test('a relative --data-dir is relative to where Cline runs, not to the desk', (t) => {
  const moved = home(t, {
    'state/settings/providers.json': {
      version: 1,
      lastUsedProvider: 'cline',
      modes: {},
      providers: { cline: { settings: { auth: { metadata: { userInfo: { email: 'dev@example.com' } } } } } },
    },
  })
  assert.equal(read('cline', { home: home(t, {}), cwd: moved, args: ['--acp', '--data-dir', 'state'] })?.email, 'dev@example.com')
})

test('an agent the desk keeps no reader for gets none, and the observation stands', () => {
  assert.equal(identityReaderFor({ id: 'claude-code' }), undefined)
  assert.equal(identityReaderFor(undefined), undefined)
})
