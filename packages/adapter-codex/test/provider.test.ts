import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { codexProvider, launchOverridesProvider } from '../src/provider.js'

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

test('any provider or base URL actually in force makes the provider unknown', async (t) => {
  const cases: readonly [string, string][] = [
    ['config.toml', 'model_provider = "ollama"\n'],
    ['config.toml', 'openai_base_url = "http://localhost:4000/v1"\n'],
    // The active `model_provider` names this table, so its `base_url` is in force even though the id is "openai".
    ['config.toml', 'model_provider = "openai"\n[model_providers.openai]\nname = "OpenAI"\nbase_url = "https://proxy.example.com/v1"\n'],
    // A profile a person actually selected can point the active provider elsewhere.
    ['config.toml', 'profile = "prod"\n[profiles.prod]\nmodel_provider = "azure"\n'],
    ['config.toml', 'profile = "prod"\n[profiles.prod]\nopenai_base_url = "http://localhost:4000/v1"\n'],
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

test('a profile or provider table nothing selects is defined but never in force, and stays OpenAI’s', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  // Exactly #1019: a config.toml kept around for occasional use, with an
  // inactive local/ollama-style profile and a matching provider table, while
  // the session that actually runs stays on the plain, unselected root config.
  writeFileSync(join(home, 'config.toml'), [
    'model = "gpt-5.5"',
    '[profiles.ollama-launch]',
    'model_provider = "ollama-launch"',
    'openai_base_url = "http://localhost:11434/v1"',
    '',
    '[model_providers.ollama-launch]',
    'name = "Ollama"',
    'base_url = "http://localhost:11434/v1"',
  ].join('\n'))
  assert.equal(await codexProvider(home, {}), 'openai', 'an unselected profile and provider table are read but never counted')

  // A provider table with no active reference at all, root or profile.
  const other = folder(t, 'codex-provider-home-')
  writeFileSync(join(other, 'config.toml'), '[model_providers.local]\nname = "Local"\nenv_key = "LOCAL_KEY"\n')
  assert.equal(await codexProvider(other, {}), 'openai')
})

/*
 * Opus review of #1028: three shapes this scanner used to skip past rather
 * than refuse — a header with a trailing comment, whitespace around a
 * header's dot, and a multi-line string that merely *contains* something
 * that looks like a header — each made a real, selected override invisible.
 * Three more were already open on main: a dotted root key, `[profiles]`
 * followed by a dotted assignment, and an inline table. Every one of these
 * must answer unknown, never openai.
 */
test('a header or assignment this scanner cannot fully parse answers unknown, never openai', async (t) => {
  const cases: readonly [string, string][] = [
    // A trailing comment on a header, after an unrelated table.
    ['config.toml', 'profile = "x"\n[features]\nenabled = true\n[profiles.x] # local\nmodel_provider = "ollama"\n'],
    // Whitespace around a header's dot.
    ['config.toml', 'profile = "x"\n[ profiles . x ]\nmodel_provider = "ollama"\n'],
    // A multi-line string whose body merely looks like it contains a header.
    ['config.toml', 'instructions = """\nSome notes\n[notes]\nmore text\n"""\nmodel_provider = "ollama"\n'],
    // Already open on main: a dotted root key is TOML shorthand for a table this scanner cannot see into.
    ['config.toml', 'profiles.x.model_provider = "ollama"\n'],
    // Already open on main: `[profiles]` is a real, but unrelated, header; the dotted key under it is not read.
    ['config.toml', '[profiles]\nx.model_provider = "ollama"\n'],
    // Already open on main: an inline table can define anything this scanner never looks inside.
    ['config.toml', 'profiles = { x = { model_provider = "ollama" } }\n'],
  ]
  for (const [file, text] of cases) {
    const home = folder(t, 'codex-provider-home-')
    writeFileSync(join(home, file), text)
    assert.equal(await codexProvider(home, {}), null, `${file}: ${text.trim()}`)
  }
})

/*
 * Opus review of #1028, round 3, P3: normalising a header's dots by blindly
 * collapsing "\s*\.\s*" everywhere also ate the spaces sitting inside a
 * quoted segment's own text, so `[profiles."a . b"]` normalized to
 * `profiles."a.b"` while `profile = "a . b"` (only ever dequoted, never
 * touched by header normalisation) stayed "a . b" — the two names no
 * longer matched, the table's own override went unlooked-at, and the
 * answer was "openai". Separately, a key captured from quotes that carries
 * a backslash escape this scanner does not decode is a second way the same
 * kind of override hides: the raw text never equals "model_provider" even
 * where a real TOML reader would decode it to exactly that.
 */
test('a quoted header’s own spacing, and an escaped quoted key, no longer hide a selected override', async (t) => {
  const dottedName = folder(t, 'codex-provider-home-')
  writeFileSync(join(dottedName, 'config.toml'), 'profile = "a . b"\n[profiles."a . b"]\nmodel_provider = "ollama"\n')
  assert.equal(await codexProvider(dottedName, {}), null, 'the selected profile name and the table it names must still match after normalising')

  const escapedKey = folder(t, 'codex-provider-home-')
  writeFileSync(join(escapedKey, 'config.toml'), 'profile = "x"\n[profiles.x]\n"model\\u005fprovider" = "ollama"\n')
  assert.equal(await codexProvider(escapedKey, {}), null, 'a backslash in a quoted key is not decoded, so it is not read as a plain match either')
})

/*
 * Opus review of #1028, round 3, P2: any line that was not a clean
 * `key = value` on its own answered unknown outright, so a multi-line array
 * — common as an `[mcp_servers.*]` table's own `args` — made the whole
 * file unknown even with an otherwise plain OpenAI configuration, bringing
 * back #1019's dead end on a real machine. The fix follows a bracketed
 * value to its own closing bracket across as many lines as it takes,
 * counting nesting and ignoring brackets inside quotes, and only refuses
 * when a key this scanner tracks (`profile`, `model_provider`, a
 * `*base_url` key) is the one holding an array — a shape none of them is
 * ever written in.
 */
test('a multi-line array next to a plain OpenAI profile is read past, not refused', async (t) => {
  const home = folder(t, 'codex-provider-home-')
  writeFileSync(join(home, 'config.toml'), [
    'model = "gpt-5.5"',
    '[mcp_servers.docs]',
    'command = "docs"',
    'args = [',
    '  "--foo",',
    '  "--bar",',
    ']',
  ].join('\n'))
  assert.equal(await codexProvider(home, {}), 'openai', 'a multi-line args array in an unrelated table is not a reason to refuse')

  const nested = folder(t, 'codex-provider-home-')
  writeFileSync(join(nested, 'config.toml'), [
    '[mcp_servers.docs]',
    'env = [',
    '  { NAME = "docs" },',
    ']',
  ].join('\n'))
  assert.equal(await codexProvider(nested, {}), 'openai', 'an inline table nested inside the array is still just skipped over')
})

test('an array on a tracked key, or one that never closes, stays unknown', async (t) => {
  const trackedKey = folder(t, 'codex-provider-home-')
  writeFileSync(join(trackedKey, 'config.toml'), 'profile = [\n  "x",\n]\n')
  assert.equal(await codexProvider(trackedKey, {}), null, 'profile is never an array; a shape none of these keys is written in is not trusted')

  const unbalanced = folder(t, 'codex-provider-home-')
  writeFileSync(join(unbalanced, 'config.toml'), '[mcp_servers.docs]\nargs = [\n  "--foo",\n')
  assert.equal(await codexProvider(unbalanced, {}), null, 'an array that never closes is unknown, not skipped past')
})

/*
 * Opus review of #1028: each config layer used to be judged on its own, so a
 * `profile` selected in one file and the table it selects defined in another
 * never met — both files, read alone, said "openai".
 */
test('the active profile is chosen across every layer together, and layers that disagree are unknown', async (t) => {
  // The project selects a profile the home config never mentions selecting; the home config defines its table.
  const home = folder(t, 'codex-provider-home-')
  const project = folder(t, 'codex-provider-project-')
  writeFileSync(join(home, 'config.toml'), '[profiles.local]\nmodel_provider = "ollama"\n')
  mkdirSync(join(project, '.codex'))
  writeFileSync(join(project, '.codex', 'config.toml'), 'profile = "local"\n')
  assert.equal(await codexProvider(home, {}, project), null, 'the home table the project selects still counts')

  // Layers naming different profiles cannot be merged into one decision.
  const disagreeing = folder(t, 'codex-provider-home-')
  const disagreeingProject = folder(t, 'codex-provider-project-')
  writeFileSync(join(disagreeing, 'config.toml'), 'profile = "a"\n')
  mkdirSync(join(disagreeingProject, '.codex'))
  writeFileSync(join(disagreeingProject, '.codex', 'config.toml'), 'profile = "b"\n')
  assert.equal(await codexProvider(disagreeing, {}, disagreeingProject), null, 'layers that disagree on the active profile are unknown')
})

/*
 * Opus review of #1028: a `-c profile=…` launch override was not counted,
 * even though it can select a different profile as surely as `config.toml`'s
 * own `profile` key.
 */
test('launchOverridesProvider counts a -c profile override, not only model_provider and base_url', () => {
  assert.equal(launchOverridesProvider(['profile=ollama-launch']), true)
  assert.equal(launchOverridesProvider(['model_provider=azure']), true)
  assert.equal(launchOverridesProvider(['openai_base_url=http://localhost:4000/v1']), true)
  assert.equal(launchOverridesProvider(['approval_policy=never']), false)
  assert.equal(launchOverridesProvider([]), false)
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

/*
 * Found re-walking UC2 after #1028: an MCP server's env commonly holds a JSON
 * blob as one quoted string, and a `{` anywhere in a value used to make the
 * whole configuration unknown, which left the judge unseatable on a real desk.
 */
test('a `{` inside one whole quoted string is text, not an inline table', async (t) => {
  const plain = 'model = "gpt-5.5"\n[mcp_servers.repl.env]\n'
  const kept: readonly string[] = [
    `SERVICES = '{"docs":{"url":"https://docs.example.com"}}'`,
    'SERVICES = "{\\"docs\\": 1}"',
    'SERVICES = "ends in a backslash \\\\"',
  ]
  for (const line of kept) {
    const home = folder(t, 'codex-provider-string-')
    writeFileSync(join(home, 'config.toml'), plain + line + '\n')
    assert.equal(await codexProvider(home, {}), 'openai', line)
  }
  const refused: readonly string[] = [
    'SERVICES = { docs = 1 }',
    `SERVICES = '{"a":1}' x`,
    'SERVICES = "{ unclosed',
    'SERVICES = "an escaped last quote \\"',
    `SERVICES = 'it's'`,
    'SERVICES = bare{',
  ]
  for (const line of refused) {
    const home = folder(t, 'codex-provider-string-')
    writeFileSync(join(home, 'config.toml'), plain + line + '\n')
    assert.equal(await codexProvider(home, {}), null, line)
  }
})
