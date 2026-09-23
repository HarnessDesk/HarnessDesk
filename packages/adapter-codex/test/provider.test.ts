import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { codexProvider } from '../src/provider.js'

/*
 * Which vendor a Codex session's models come from, read from Codex's own
 * configuration: OpenAI's, unless anything the person set could point it at
 * another provider or base URL — then unknown, never a guess from the name.
 */

const folder = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('Codex with its own configuration untouched serves OpenAI’s models', (t) => {
  const home = folder(t, 'codex-provider-home-')
  assert.equal(codexProvider(home, {}), 'openai')
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.5"\nmodel_provider = "openai"\n[mcp_servers.docs]\ncommand = "docs"\n')
  assert.equal(codexProvider(home, {}), 'openai', 'naming OpenAI itself is no override')
})

test('any provider or base URL the person set makes the provider unknown', (t) => {
  const cases: readonly [string, string][] = [
    ['config.toml', 'model_provider = "ollama"\n'],
    ['config.toml', 'openai_base_url = "http://localhost:4000/v1"\n'],
    ['config.toml', '[model_providers.proxy]\nname = "Proxy"\nbase_url = "https://proxy.example.com/v1"\n'],
    ['config.toml', '[model_providers.local]\nname = "Local"\nenv_key = "LOCAL_KEY"\n'],
    ['sol.config.toml', 'model_provider = "azure"\n'],
  ]
  for (const [file, text] of cases) {
    const home = folder(t, 'codex-provider-home-')
    writeFileSync(join(home, file), text)
    assert.equal(codexProvider(home, {}), null, `${file}: ${text.trim()}`)
  }
  const home = folder(t, 'codex-provider-home-')
  assert.equal(codexProvider(home, { OPENAI_BASE_URL: 'https://proxy.example.com/v1' }), null, 'the environment it is started with')
})

test('a project’s own Codex configuration can override it for sessions there', (t) => {
  const home = folder(t, 'codex-provider-home-')
  const project = folder(t, 'codex-provider-project-')
  assert.equal(codexProvider(home, {}, project), 'openai')
  mkdirSync(join(project, '.codex'))
  writeFileSync(join(project, '.codex', 'config.toml'), 'model_provider = "openrouter"\n')
  assert.equal(codexProvider(home, {}, project), null)
})

test('a configuration that cannot be read cannot rule an override out', (t) => {
  const home = folder(t, 'codex-provider-home-')
  mkdirSync(join(home, 'config.toml'))
  assert.equal(codexProvider(home, {}), null)
})
