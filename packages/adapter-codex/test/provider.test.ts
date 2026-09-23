import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
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

test('Codex with its own configuration untouched serves OpenAI’s models', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  assert.equal(await codexProvider(home, {}), 'openai')
  writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.5"\nmodel_provider = "openai"\n[mcp_servers.docs]\ncommand = "docs"\n')
  assert.equal(await codexProvider(home, {}), 'openai', 'naming OpenAI itself is no override')
})

test('any provider or base URL the person set makes the provider unknown', async (t) => {
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
    assert.equal(await codexProvider(home, {}), null, `${file}: ${text.trim()}`)
  }
  const home = folder(t, 'codex-provider-home-')
  assert.equal(await codexProvider(home, { OPENAI_BASE_URL: 'https://proxy.example.com/v1' }), null, 'the environment it is started with')
})

test('a project’s own Codex configuration can override it for sessions there', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  const project = folder(t, 'codex-provider-project-')
  assert.equal(await codexProvider(home, {}, project), 'openai')
  mkdirSync(join(project, '.codex'))
  writeFileSync(join(project, '.codex', 'config.toml'), 'model_provider = "openrouter"\n')
  assert.equal(await codexProvider(home, {}, project), null)
})

test('a configuration that cannot be read cannot rule an override out', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  mkdirSync(join(home, 'config.toml'))
  assert.equal(await codexProvider(home, {}), null)
})

/*
 * A project's `.codex` arrives with a clone. What it can plant there — a
 * link to a device or to somewhere else, a FIFO, a file far too large —
 * reads as unknown, promptly, and never holds the desk's own thread: the
 * probe below is a timer that must keep ticking while the read runs.
 */
const promptly = async <T>(work: () => Promise<T> | T): Promise<T> => {
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

const planted = (t: TestContext, plant: (codex: string) => void): string => {
  const project = folder(t, 'codex-provider-hostile-')
  mkdirSync(join(project, '.codex'))
  plant(join(project, '.codex'))
  return project
}

test('a project config linked to /dev/stdin is unknown, promptly', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  const project = planted(t, (codex) => symlinkSync('/dev/stdin', join(codex, 'config.toml')))
  assert.equal(await promptly(() => codexProvider(home, {}, project)), null)
})

test('a project config linked to /dev/zero is unknown, promptly', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  const project = planted(t, (codex) => symlinkSync('/dev/zero', join(codex, 'config.toml')))
  assert.equal(await promptly(() => codexProvider(home, {}, project)), null)
})

test('a project config that is a FIFO is unknown, promptly', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  const project = planted(t, (codex) => execFileSync('mkfifo', [join(codex, 'config.toml')]))
  assert.equal(await promptly(() => codexProvider(home, {}, project)), null)
})

test('an oversized project config is unknown, and never read whole', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  // Sparse: one and a half gigabytes on paper, nothing on disk. Only a read that checks the size first stays prompt.
  const project = planted(t, (codex) => {
    writeFileSync(join(codex, 'config.toml'), 'model = "x"\n')
    truncateSync(join(codex, 'config.toml'), 1536 * 1024 * 1024)
  })
  assert.equal(await promptly(() => codexProvider(home, {}, project)), null)
})

test('a project config reached through a linked folder is unknown, even a harmless one', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  const elsewhere = folder(t, 'codex-provider-elsewhere-')
  writeFileSync(join(elsewhere, 'config.toml'), 'model = "gpt-5.5"\n')
  const project = folder(t, 'codex-provider-hostile-')
  symlinkSync(elsewhere, join(project, '.codex'))
  assert.equal(await promptly(() => codexProvider(home, {}, project)), null)
})

test('Codex’s own home config linked to a device is unknown, and not read', async (t) => {
  for (const device of ['/dev/zero', '/dev/null']) {
    const home = folder(t, 'codex-provider-home-')
    symlinkSync(device, join(home, 'config.toml'))
    assert.equal(await promptly(() => codexProvider(home, {})), null, `${device} is not a configuration file`)
  }
})
