import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { geminiTrustsFolder, geminiTrustsFolderStatus } from '../src/gemini-trust.js'

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'hd-gemini-trust-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const gemini = join(home, '.gemini')
  const project = join(root, 'project')
  const system = join(root, 'system')
  const defaultsPath = join(system, 'system-defaults.json')
  const systemPath = join(system, 'settings.json')
  mkdirSync(gemini, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(system, { recursive: true })
  const settings = (value: unknown) => writeFileSync(join(gemini, 'settings.json'), JSON.stringify(value))
  const defaults = (value: unknown) => writeFileSync(defaultsPath, JSON.stringify(value))
  const systemSettings = (value: unknown) => writeFileSync(systemPath, JSON.stringify(value))
  const folders = (value: unknown, path = join(gemini, 'trustedFolders.json')) => writeFileSync(path, JSON.stringify(value))
  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemPath,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: defaultsPath,
    ...extra,
  })
  const trust = (extra: Record<string, string> = {}) => geminiTrustsFolder(project, { env: env(extra) })
  return { root, home, gemini, project, systemPath, defaultsPath, settings, defaults, systemSettings, folders, env, trust }
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

test('Gemini folds trust settings from system defaults, then user, then system', (t) => {
  const f = fixture(t)
  f.folders({})
  f.defaults({ security: { folderTrust: { enabled: false } } })
  assert.equal(f.trust(), true, 'system defaults disable trust unless a later layer enables it')

  f.settings({ security: { folderTrust: { enabled: true } } })
  assert.equal(f.trust(), false, 'user settings override system defaults')

  f.systemSettings({ security: { folderTrust: { enabled: false } } })
  assert.equal(f.trust(), true, 'system settings override user settings')
})

test('Gemini uses GEMINI_CLI_HOME before HOME for its user settings and trusted folders', (t) => {
  const f = fixture(t)
  const alternateHome = join(f.root, 'alternate-home')
  const alternateGemini = join(alternateHome, '.gemini')
  mkdirSync(alternateGemini, { recursive: true })
  writeFileSync(join(alternateGemini, 'settings.json'), JSON.stringify({ security: { folderTrust: { enabled: true } } }))
  writeFileSync(join(alternateGemini, 'trustedFolders.json'), JSON.stringify({ [f.project]: 'TRUST_FOLDER' }))
  assert.equal(f.trust({ GEMINI_CLI_HOME: alternateHome }), true)
})

test('an unreadable trusted-folders file is distinguished from an untrusted folder', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: true } } })
  f.folders({ [f.project]: 'TRUST_FOLDER' })
  writeFileSync(join(f.gemini, 'trustedFolders.json'), '{ broken')
  assert.deepEqual(geminiTrustsFolderStatus(f.project, { env: f.env() }), {
    trusted: false,
    unavailable: true,
  })
})

test('a directory where the trusted-folders file belongs is unreadable, not absent', (t) => {
  const f = fixture(t)
  f.settings({ security: { folderTrust: { enabled: true } } })
  mkdirSync(join(f.gemini, 'trustedFolders.json'))
  assert.deepEqual(geminiTrustsFolderStatus(f.project, { env: f.env() }), {
    trusted: false,
    unavailable: true,
  })
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


test('Gemini folder trust refuses a POSIX slash/backslash collision', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t)
  const admitted = join(f.root, 'a', 'b')
  const foreign = join(f.root, 'a\\b')
  mkdirSync(admitted, { recursive: true })
  mkdirSync(foreign)
  f.folders({ [admitted]: 'TRUST_FOLDER' })
  assert.equal(geminiTrustsFolder(admitted, { env: f.env() }), true)
  assert.equal(geminiTrustsFolder(foreign, { env: f.env() }), false)
  f.folders({ [foreign]: 'TRUST_FOLDER' })
  assert.equal(geminiTrustsFolder(admitted, { env: f.env() }), false)
  assert.equal(geminiTrustsFolder(foreign, { env: f.env() }), true)
})
