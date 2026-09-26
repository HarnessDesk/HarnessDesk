import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { knownAgent } from '../../src/installs/known-agents.js'
import { knowledgeOverlay } from '../../src/installs/overlay.js'
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

/*
 * Opus review of #1028: `known-agents.ts` had no `dsh` entry at all, so
 * `knowledgeFor` (the real lookup a spawned agent goes through) never
 * resolved one and `providerReaderFor` was never reached — a test that
 * builds `{ id: 'dsh' }` by hand cannot see that. These go through
 * `knownAgent`/`knowledgeOverlay`, the real path, instead.
 */
const readDsh = async (env: Readonly<Record<string, string | undefined>>): Promise<string | null | undefined> => {
  const overlay = knowledgeOverlay(
    { id: 'dsh', name: 'DeepSeek', command: 'dsh', args: ['--profile', 'acp'] },
    knownAgent('dsh'),
    { env },
  )
  return overlay.resolveProvider ? overlay.resolveProvider() : undefined
}

test('DeepSeek Harness’s reader is reached through the real knowledgeFor/knowledgeOverlay path', async (t) => {
  const known = knownAgent('dsh')
  assert.ok(known, 'known-agents.ts now carries a dsh entry')
  const home = tree(t, {})
  const overlay = knowledgeOverlay({ id: 'dsh', name: 'DeepSeek', command: 'dsh', args: ['--profile', 'acp'] }, known, { env: { DSH_HOME: home } })
  assert.ok(overlay.resolveProvider, 'the real lookup wires a reader for dsh, not the undefined a missing entry produced')
  assert.equal(await overlay.resolveProvider!(), 'deepseek')
})

test('DeepSeek Harness serves its own models unless a base URL points elsewhere', async (t) => {
  const clean = tree(t, {})
  assert.equal(await readDsh({ DSH_HOME: clean }), 'deepseek')
  assert.equal(await readDsh({ DSH_HOME: clean, DEEPSEEK_BASE_URL: 'https://proxy.example.com' }), null, 'the environment it starts with')

  const onHost = tree(t, { 'cordis.patch.yml': '- id: llm-deepseek-account\n  config:\n    reasoningEffort: high\n' })
  assert.equal(await readDsh({ DSH_HOME: onHost }), 'deepseek', 'an override with no baseURL at all changes nothing')

  const same = tree(t, { 'cordis.patch.yml': '- id: llm-deepseek\n  config:\n    baseURL: https://api.deepseek.com/anthropic\n' })
  assert.equal(await readDsh({ DSH_HOME: same }), 'deepseek', 'pointed back at DeepSeek’s own host is no override')

  const homeLevel = tree(t, { 'cordis.patch.yml': "- id: llm-deepseek\n  config:\n    baseURL: 'https://proxy.example.com/v1'\n" })
  assert.equal(await readDsh({ DSH_HOME: homeLevel }), null, 'the home-level patch, which outranks every profile')

  const profileLevel = tree(t, { 'profiles/acp/cordis.patch.yml': '- id: llm-deepseek-api-key\n  config:\n    baseURL: https://proxy.example.com/v1\n' })
  assert.equal(await readDsh({ DSH_HOME: profileLevel }), null, 'the acp profile’s own patch')

  const unrelated = tree(t, { 'cordis.patch.yml': '- id: web-search\n  config:\n    baseURL: https://proxy.example.com/v1\n' })
  assert.equal(await readDsh({ DSH_HOME: unrelated }), 'deepseek', 'a baseURL on an entry that is not one of DeepSeek’s own is not this decision’s business')

  // DSH always starts on the `acp` profile; a patch aimed at another
  // shipped profile is defined but never in force, like an inactive Codex
  // profile — see #1019.
  const otherProfile = tree(t, { 'profiles/web/cordis.patch.yml': '- id: llm-deepseek\n  config:\n    baseURL: https://proxy.example.com/v1\n' })
  assert.equal(await readDsh({ DSH_HOME: otherProfile }), 'deepseek', 'a patch aimed at a profile DSH did not start on is inert')

  const broken = tree(t, {})
  mkdirSync(join(broken, 'cordis.patch.yml'), { recursive: true })
  assert.equal(await readDsh({ DSH_HOME: broken }), null, 'a patch file that cannot be read rules nothing out')
})

/*
 * Opus review of #1028, P0: none of these were checked at all, so each made
 * DSH's default session redirectable without ever touching an
 * `llm-deepseek*` baseURL, and the old reader still answered "deepseek".
 */
test('a live llm-pi-ai route makes the provider unknown, even with no llm-deepseek baseURL at all', async (t) => {
  const home = tree(t, { 'cordis.patch.yml': '- id: llm-pi-ai\n  config:\n    profiles:\n      - provider: anthropic\n' })
  assert.equal(await readDsh({ DSH_HOME: home }), null, 'llm-pi-ai ships dormant; any config on it means some other route could be live')
})

test('an agent-default-model provider other than the vendor default makes the provider unknown', async (t) => {
  const redirected = tree(t, { 'cordis.patch.yml': '- id: agent-default-model\n  config:\n    provider: pi-ai\n    model: some-model\n' })
  assert.equal(await readDsh({ DSH_HOME: redirected }), null)
  const official = tree(t, { 'cordis.patch.yml': '- id: agent-default-model\n  config:\n    provider: deepseek-official\n' })
  assert.equal(await readDsh({ DSH_HOME: official }), 'deepseek', 'naming the vendor default itself is no override')
})

/*
 * Opus review of #1028, round 4, P1: only the first item with an id was read,
 * but DSH applies every patch in order and the later one wins.
 */
test('a later patch item with the same id is read too, since the later one is the one DSH applies', async (t) => {
  const model = tree(t, { 'cordis.patch.yml': '- id: agent-default-model\n  config:\n    provider: deepseek-official\n- id: agent-default-model\n  config:\n    provider: other\n' })
  assert.equal(await readDsh({ DSH_HOME: model }), null)
  const route = tree(t, { 'cordis.patch.yml': '- id: llm-deepseek\n  config:\n    baseURL: https://api.deepseek.com\n- id: llm-deepseek\n  config:\n    baseURL: https://elsewhere.example.com/v1\n' })
  assert.equal(await readDsh({ DSH_HOME: route }), null)
})

/*
 * Found re-walking UC2 after #1028 (#1030): DSH scaffolds each profile's patch
 * as comments over a bare `[]`, which the flow-file parser refuses, so a
 * fresh install always read as unknown.
 */
test('DSH’s own scaffolded patch, comments over an empty list, reads as deepseek', async (t) => {
  const home = tree(t, { 'cordis.patch.yml': '# Patches for this profile.\n# Add entries below.\n[]\n' })
  assert.equal(await readDsh({ DSH_HOME: home }), 'deepseek')
  const other = tree(t, { 'cordis.patch.yml': '# comment\n[{ id: llm-pi-ai }]\n' })
  assert.equal(await readDsh({ DSH_HOME: other }), null, 'any other flow-style content still goes to the parser and is refused')
})

test('an insert anywhere in a patch layer makes the provider unknown', async (t) => {
  const home = tree(t, { 'cordis.patch.yml': '- id: llm-deepseek\n  insert:\n    - id: some-new-plugin\n      name: "@x/plugin"\n' })
  assert.equal(await readDsh({ DSH_HOME: home }), null, 'an inserted plugin can add any capability, including a different default provider')
})

/*
 * Opus review of #1028, round 3, P1: the old reader split a patch file's
 * top-level list by scanning for lines starting with "-" at column zero,
 * cruder than any real YAML parser — so a shape written any other way, even
 * a perfectly valid one, sailed past every check above and answered
 * "deepseek". The fix parses each layer with the server's own strict
 * `parseYaml`; any `YamlError` and any shape it does not recognise (not a
 * list, not a list of maps) now answers unknown outright, same as a real
 * structural override the parser lets it see clearly.
 */
test('a patch layer’s shape, not just a line scanner’s idea of one, decides the answer — every one of these was “deepseek” before', async (t) => {
  const cases: readonly [string, string][] = [
    ['a flow-style list item', '- { id: agent-default-model, config: { provider: other } }\n'],
    ['a bare top-level flow map, not a list at all', 'config: { provider: other }\n'],
    ['a quoted "provider" key', '- id: agent-default-model\n  config:\n    "provider": other\n'],
    ['an indented top-level list', '  - id: agent-default-model\n    config:\n      provider: other\n'],
    ['a JSON-style patch', '[{"id": "agent-default-model", "config": {"provider": "other"}}]\n'],
    ['a bare top-level flow map naming baseURL', 'config: { baseURL: "https://proxy.example.com/v1" }\n'],
  ]
  for (const [what, text] of cases) {
    const home = tree(t, { 'cordis.patch.yml': text })
    assert.equal(await readDsh({ DSH_HOME: home }), null, what)
  }
})

/*
 * Opus review of #1028, P2: DSH itself expands a `~`-prefixed DSH_HOME and
 * resolves a relative one against its own working directory; the old reader
 * joined the raw string, found nothing, and answered "deepseek".
 */
test('DSH_HOME’s tilde form is expanded the way DSH expands it, and a still-relative one is unknown', async (t) => {
  const fakeOsHome = tree(t, {})
  mkdirSync(join(fakeOsHome, 'x'), { recursive: true })
  writeFileSync(join(fakeOsHome, 'x', 'cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    baseURL: https://proxy.example.com/v1\n')
  assert.equal(
    await providerReaderFor({ id: 'dsh' }, { home: fakeOsHome, env: { DSH_HOME: '~/x' } })?.(),
    null,
    '~/x resolves against the same OS home a real DSH_HOME=~/x would expand against',
  )

  const bareTilde = tree(t, {})
  writeFileSync(join(bareTilde, 'cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    baseURL: https://proxy.example.com/v1\n')
  assert.equal(await providerReaderFor({ id: 'dsh' }, { home: bareTilde, env: { DSH_HOME: '~' } })?.(), null, 'a bare ~ is the home itself')

  assert.equal(
    await providerReaderFor({ id: 'dsh' }, { home: tree(t, {}), env: { DSH_HOME: 'relative/dsh' } })?.(),
    null,
    'a still-relative DSH_HOME cannot be resolved here, so it is unknown, never the default',
  )
})

/*
 * Opus review of #1028, round 3, P2: the reader only ever looked at the
 * `acp` profile's own two files and never saw the row's own launch
 * arguments, so a row started with anything past `--profile acp` — another
 * overlay, a different profile — loaded configuration this reader never
 * checked, and still answered "deepseek".
 */
test('a row launched with anything but the acp profile’s own arguments is unknown, even with clean config files', async (t) => {
  const home = tree(t, {})
  const extra = knowledgeOverlay(
    { id: 'dsh', name: 'DeepSeek', command: 'dsh', args: ['--profile', 'acp', '--patch', 'x.yml'] },
    knownAgent('dsh'),
    { env: { DSH_HOME: home } },
  )
  assert.equal(await extra.resolveProvider?.(), null, 'an overlay this reader never checks might redirect the default session')

  const otherProfile = knowledgeOverlay(
    { id: 'dsh', name: 'DeepSeek', command: 'dsh', args: ['--profile', 'work'] },
    knownAgent('dsh'),
    { env: { DSH_HOME: home } },
  )
  assert.equal(await otherProfile.resolveProvider?.(), null, 'a profile these two files never speak for')

  const noArgs = knowledgeOverlay({ id: 'dsh', name: 'DeepSeek', command: 'dsh' }, knownAgent('dsh'), { env: { DSH_HOME: home } })
  assert.equal(await noArgs.resolveProvider?.(), null, 'no args at all means this reader cannot tell what actually launches')
})

test('an agent with no reader is unknown, whatever it is called', () => {
  assert.equal(providerReaderFor({ id: 'codex' }, {}), undefined)
  assert.equal(providerReaderFor({ id: 'cursor' }, {}), undefined, 'Cursor’s provider is a per-session model choice, not read here')
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
