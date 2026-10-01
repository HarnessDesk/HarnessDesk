import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { geminiTrustsFolder } from '../src/gemini-trust.js'

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'hd-gemini-trust-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const gemini = join(home, '.gemini')
  const project = join(root, 'project')
  mkdirSync(gemini, { recursive: true })
  mkdirSync(project, { recursive: true })
  const settings = (value: unknown) => writeFileSync(join(gemini, 'settings.json'), JSON.stringify(value))
  const folders = (value: unknown, path = join(gemini, 'trustedFolders.json')) => writeFileSync(path, JSON.stringify(value))
  const trust = (env: Record<string, string> = {}) => geminiTrustsFolder(project, { env: { HOME: home, ...env } })
  return { root, home, gemini, project, settings, folders, trust }
}

test('Gemini trust prediction follows trust environment overrides', (t) => {
  const f = fixture(t)
  f.folders({})
  assert.equal(f.trust({ GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_RESTRICTED_MODE: 'true' }), false)
  assert.equal(f.trust({ GEMINI_CLI_TRUST_WORKSPACE: 'true' }), true)
  assert.equal(f.trust({ GEMINI_CLI_TRUST_WORKSPACE: 'false' }), false)
  assert.equal(f.trust({ GEMINI_RESTRICTED_MODE: 'true' }), false)
})

test('disabling folder trust in Gemini settings trusts folders without a trust-file rule', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: false } } })
  assert.equal(f.trust(), true)
})

test('Gemini defaults folder trust to enabled when its setting is absent', (t) => {
  const f = fixture(t)
  assert.equal(f.trust(), false)
})

test('Gemini trust-file folder rules apply to descendants, with the longest matching rule winning', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: true } } })
  const nested = join(f.project, 'nested')
  mkdirSync(nested)
  f.folders({ [f.project]: 'TRUST_FOLDER', [nested]: 'DO_NOT_TRUST' })
  assert.equal(f.trust(), true)
  assert.equal(geminiTrustsFolder(nested, { env: { HOME: f.home } }), false)
})

test('Gemini TRUST_PARENT rules trust descendants of the rule path parent', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: true } } })
  f.folders({ [join(f.root, 'sibling')]: 'TRUST_PARENT' })
  assert.equal(f.trust(), true)
})

test('Gemini leaves an unlisted folder untrusted when no trust file exists', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: true } } })
  assert.equal(f.trust(), false)
})

test('Gemini uses its configured trusted-folders path', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: true } } })
  const override = join(f.root, 'trusted.json')
  f.folders({ [f.project]: 'TRUST_FOLDER' }, override)
  assert.equal(f.trust({ GEMINI_CLI_TRUSTED_FOLDERS_PATH: override }), true)
})
