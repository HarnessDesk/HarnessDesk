import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  CODEX_PROFILE_OPTION_ID,
  listCodexProfiles,
  profileOption,
  readCodexProfile,
} from '../src/profiles.js'

const home = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-profiles-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a profile parses only the bounded root settings a thread may inherit', async (t) => {
  const dir = home(t)
  writeFileSync(
    join(dir, 'sol.config.toml'),
    [
      'model = "gpt-profile"',
      'model_context_window = 872_000',
      'model_auto_compact_token_limit = 550_000',
      'instructions = "not forwarded"',
      '',
      '[mcp_servers.untrusted]',
      'command = "never executed"',
    ].join('\n'),
  )

  const profile = await readCodexProfile(dir, 'sol')
  assert.deepEqual(profile, {
    id: 'sol',
    model: 'gpt-profile',
    config: {
      model_context_window: 872_000,
      model_auto_compact_token_limit: 550_000,
    },
  })
})

test('multiline strings cannot masquerade as root settings or table headers', async (t) => {
  const dir = home(t)
  writeFileSync(
    join(dir, 'sol.config.toml'),
    [
      'instructions = """',
      'model = "gpt-instructions"',
      '[mcp_servers.not_a_real_table]',
      'model_context_window = 1',
      '"""',
      "notes = '''model_auto_compact_token_limit = 2'''",
      '"model" = "gpt-profile"',
      "'model_context_window' = 872_000",
      'model_auto_compact_token_limit = 550_000',
    ].join('\n'),
  )

  assert.deepEqual(await readCodexProfile(dir, 'sol'), {
    id: 'sol',
    model: 'gpt-profile',
    config: {
      model_context_window: 872_000,
      model_auto_compact_token_limit: 550_000,
    },
  })
})

test('malformed and non-file profiles are refused while a slot’s regular-file link is accepted', async (t) => {
  const dir = home(t)
  writeFileSync(join(dir, 'broken.config.toml'), 'model_context_window = 100\nmodel_context_window = 200\n')
  writeFileSync(join(dir, 'huge.config.toml'), 'model_context_window = 10_000_001\n')
  writeFileSync(join(dir, 'unterminated.config.toml'), 'model = "gpt-profile"\ninstructions = """\nnever ends\n')
  writeFileSync(join(dir, 'outside.toml'), 'model = "outside"\n')
  symlinkSync(join(dir, 'outside.toml'), join(dir, 'linked.config.toml'))
  mkdirSync(join(dir, 'folder.config.toml'))

  const entries = await listCodexProfiles(dir)
  const option = profileOption(entries, 'broken')
  assert.equal(option.id, CODEX_PROFILE_OPTION_ID)
  assert.equal(option.currentValue, 'broken')
  for (const id of ['broken', 'huge', 'unterminated', 'folder']) {
    const choice = option.choices.find((entry) => entry.value === id)
    assert.ok(choice?.disabled, `${id} is listed with its refusal`)
  }
  assert.equal(option.choices.find((entry) => entry.value === 'linked')?.disabled, undefined)
  assert.equal((await readCodexProfile(dir, 'linked')).model, 'outside')
})

test('profile discovery is capped before the directory can become an unbounded option list', async (t) => {
  const dir = home(t)
  for (let index = 69; index >= 0; index -= 1) {
    writeFileSync(join(dir, `p${String(index).padStart(2, '0')}.config.toml`), 'model = "gpt-profile"\n')
  }
  assert.deepEqual(
    (await listCodexProfiles(dir)).map((entry) => entry.id),
    Array.from({ length: 64 }, (_, index) => `p${String(index).padStart(2, '0')}`),
  )
})

test('profile bytes, encoding, names and related context settings are bounded', async (t) => {
  const dir = home(t)
  writeFileSync(join(dir, 'large.config.toml'), Buffer.alloc(64 * 1024 + 1, 97))
  writeFileSync(join(dir, 'binary.config.toml'), Buffer.from([0xff, 0xfe]))
  writeFileSync(
    join(dir, 'late.config.toml'),
    'model_context_window = 100\nmodel_auto_compact_token_limit = 101\n',
  )

  await assert.rejects(() => readCodexProfile(dir, 'large'), /larger than 64 KiB/)
  await assert.rejects(() => readCodexProfile(dir, 'binary'), /valid UTF-8/)
  await assert.rejects(() => readCodexProfile(dir, 'late'), /context window ends/)
  await assert.rejects(() => readCodexProfile(dir, '../outside'), /profile name/i)
})

test('a selected profile that is unavailable is retained as a disabled current value', () => {
  const option = profileOption([], 'gone')
  assert.equal(option.currentValue, 'gone')
  assert.match(option.choices.find((entry) => entry.value === 'gone')?.disabled ?? '', /not available/)
})
