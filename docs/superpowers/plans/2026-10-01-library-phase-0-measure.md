# Library Phase 0: The Measurements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure what installed agent builds load and report from isolated fixtures, then record versioned evidence in the measurement files, location table, runtime capabilities and resulting tier table.

**Architecture:** A manually run Node harness creates a disposable home and repository, probes each locally installed agent only through its own CLI or the desk’s ACP bridge, and persists one fixture-only normalized-and-parsed JSON result per agent build. Eight evidence tasks produce those results; follow-on test-first changes make the existing location inventory and runtime capability facts carry only supported, source-linked claims.

**Tech Stack:** Node.js 22 `.mjs`, `node:test`, JSON measurement records, TypeScript runtime protocol and adapters.

## Global Constraints

- The agent owns its own world. Auth, MCP servers, skills and history belong to Codex, Claude Code or Cursor and live in their directories; HarnessDesk reads through rather than shadowing.
- Parity is measured, not claimed. Run the task, on the real surface, and record what the sitting showed — a claim about what an agent can do here is worth exactly what the recording behind it is worth. Findings become plan items with that evidence attached, never an assertion in a document.
- Nothing that leaves the machine carries a real account. Identities are placeholders or the project's public demo persona — `Jane Doe`, addresses at `example.com` or `acme.dev`, or the persona at `harnessdesk.app` — in screenshots, tests, fixtures, docs and commit messages alike. Never a real account's address or handle, and no real person's name beyond that persona.
- Agent tests (Codex, ACP, Claude Code, Cursor) run against scripted fake services and peers, never real vendor endpoints: the suite must not need credentials, network, or credits.
- The measurement harness is run by hand and never added to CI. Every child agent, including a desk-hosted ACP session, runs inside macOS `sandbox-exec`; the profile denies reads and writes under the real user's agent/config/credential directories, denies `/Library/Keychains` and `/System/Library/Keychains`, and denies lookup of `securityd` and `SecurityServer`. It also sets `HOME`, `CODEX_HOME`, all vendor-home overrides, `HARNESSDESK_HOME`, `TMPDIR`, and cwd under a new temporary fixture root. A missing or untestable sandbox means `could-not-ask: cannot isolate` before launch. No real credentials are copied or symlinked.
- Antigravity and GitHub Copilot use machine credential services despite home overrides. Launch either only when the sandbox's keychain file and security-service denials are active; otherwise persist `could-not-ask: cannot isolate` before its first process start.
- Measurement requests use each agent's own interface: Codex `codex app-server` `skills/list`; other agents' documented non-interactive or print mode, or the existing ACP bridge. An absent, signed-out, interactive-only, or unsafe-to-isolate build produces an explicit `could-not-ask` result with reason, never a guessed fact.
- Harness output contains the agent, exact version, date, interface and question, a fixture-only normalized answer, and parsed facts. It never persists unrestricted stdout: retain only allowlisted fixture sentinels and parsed fields, and fail closed to `could-not-ask` when output is not safely reducible. Credentials are never copied into fixtures or result files.
- Each per-agent probe runs the eight questions in one temporary home, returns one composite `facts` object, and writes exactly one JSON for that agent/version after all questions finish. Tasks 2–9 define the fact parsers and the questions included in that composite; a refusal in one measurement records that fact as `unknown` without erasing other observations.
- Do not run `--all` until Task 9 has added all eight questions and parsers. Task 9 runs the complete probe once per installed build; Tasks 2–8 add their question and parser to that composite, avoiding partial files or overwrites.
- A location's `scanned` value moves from `build` to `asked` only when a matching result file reports that location. Capability facts are true or a non-`none` refresh value only when that agent/version's result file supports the fact.
- Every task ends with its package- or script-level tests and a commit. The Codex execution sandbox cannot commit or bind ports; the parent performs commit steps, and the harness uses subprocess stdio rather than a listening socket.

---

### Task 1: Isolated measurement harness and result contract

**Files:**
- Create: `script/measure/library.mjs`
- Create: `script/measure/library.test.mjs`
- Create: `script/measure/README.md`
- Create: `docs/verification/library-measurements/README.md`
- Test: `script/measure/library.test.mjs`

**Interfaces:**
- Consumes: `KNOWN_AGENTS` from `packages/server/src/installs/known-agents.ts`, `LOCATIONS` from `packages/agent-inventory/src/locations.ts`, and each adapter's existing runtime interface.
- Produces: `createFixture(root): Promise<Fixture>`, `assertIsolatedEnv(env, root): void`, `askAgent(agent, fixture): Promise<MeasurementResult>`, and `writeResult(result, directory?): Promise<string>`. `MeasurementResult` has `agent`, `agentId`, `version`, `measured`, `interface`, `question`, `rawAnswer`, `facts`, and `status: 'asked' | 'could-not-ask'` plus `reason` only for the latter.

- [ ] **Step 1: Write `script/measure/library.test.mjs` first.** This follows the imports, hooks and `node:test` pattern in `script/prune-dist.test.mjs` and covers fixture shape, guard rejection, result validation, redaction and failure serialization.

```js
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertIsolatedEnv,
  askAgent,
  createFixture,
  populateSkillRoots,
  redact,
  sandboxProfileText,
  makeSandboxProfile,
  verifySandbox,
  validateResult,
  writeResult,
  registerProbe,
  run,
  parseRules,
  parseCatalogue,
  parsePrecedence,
  parseRejections,
  parseSkillRoots,
  parseRefresh,
  parseMcp,
  parseSignedOut,
} from './library.mjs'

const under = (root, path) => path.startsWith(`${root}/`) || path === root

test('fixture contains user/project skills, invalid and oversized skills, rule sentinels, and MCP configs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-library-measure-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  assert.ok(under(root, fixture.home))
  assert.ok(under(root, fixture.repo))
  assert.ok(under(root, fixture.nested))
  assert.deepEqual(fixture.skills, {
    user: join(fixture.home, '.codex/skills/measure-user'),
    project: join(fixture.repo, '.codex/skills/measure-project'),
    duplicateUser: join(fixture.home, '.codex/skills/measure-duplicate'),
    duplicateProject: join(fixture.repo, '.codex/skills/measure-duplicate'),
    missingDescription: join(fixture.repo, '.codex/skills/measure-no-description'),
    oversized: join(fixture.repo, '.codex/skills/measure-oversized'),
    sentinel: join(fixture.repo, '.codex/skills/measure-sentinel'),
    auxiliary: join(fixture.repo, '.codex/skills/measure-with-auxiliary'),
  })
  for (const [path, phrase] of Object.entries(fixture.ruleSentinels)) {
    const body = await readFile(path, 'utf8')
    assert.match(body, new RegExp(phrase))
  }
  assert.ok(fixture.mcp.length >= 2)
  assert.ok(fixture.mcp.every((path) => under(root, path)))
  assert.match(await readFile(fixture.mcpPeer, 'utf8'), /tools\/list/)
  assert.match(await readFile(join(fixture.skills.auxiliary, 'references/measure-reference.md'), 'utf8'), /AUXILIARY_FILE_SENTINEL/)
  assert.match(await readFile(fixture.mcp[0], 'utf8'), /fixture-mcp\.mjs/)
  assert.match(await readFile(fixture.mcp[1], 'utf8'), /fixture-mcp\.mjs/)
  const claudeSkills = await populateSkillRoots(fixture, { user: ['~/.claude/skills'], project: ['.claude/skills'] })
  assert.ok(claudeSkills.some((one) => one.path === '~/.claude/skills' && one.scope === 'user'))
  assert.ok(claudeSkills.some((one) => one.path === '.claude/skills' && one.scope === 'project'))
  assert.ok((await readFile(join(fixture.skills.oversized, 'SKILL.md'), 'utf8')).length > 1_000_000)
  assert.doesNotMatch(await readFile(join(fixture.skills.missingDescription, 'SKILL.md'), 'utf8'), /^description:/m)
})

test('isolation guard rejects missing and out-of-root home, vendor home, and cwd values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-library-guard-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inside = join(root, 'home')
  const repo = join(root, 'repo')
  const vendorNames = [
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'CURSOR_CONFIG_DIR',
    'OPENCLAW_STATE_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HERMES_HOME',
    'CODEBUDDY_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'GROK_HOME', 'COPILOT_HOME',
    'GEMINI_HOME', 'DSH_HOME', 'OPENCLAW_CONFIG_PATH', 'OPENCODE_CONFIG_DIR',
  ]
  const good = { HOME: inside, HARNESSDESK_HOME: join(inside, 'harnessdesk'), TMPDIR: join(root, 'tmp'), cwd: repo, ...Object.fromEntries(vendorNames.map((name) => [name, join(root, name.toLowerCase())])) }
  await Promise.all(Object.values(good).map((path) => import('node:fs/promises').then(({ mkdir }) => mkdir(path, { recursive: true }))))
  assert.doesNotThrow(() => assertIsolatedEnv(good, root))
  for (const name of ['HOME', 'HARNESSDESK_HOME', 'TMPDIR', 'cwd', ...vendorNames]) {
    const missing = { ...good }
    delete missing[name]
    assert.throws(() => assertIsolatedEnv(missing, root), new RegExp(name))
    const escaped = { ...good, [name]: '/tmp/real-home' }
    assert.throws(() => assertIsolatedEnv(escaped, root), new RegExp(name))
  }
})

test('macOS sandbox profile blocks real agent homes, credentials, and the login keychain', () => {
  const profile = sandboxProfileText('/Users/Jane Doe')
  for (const path of ['.harnessdesk', '.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.agents', '.copilot', '.config', '.ssh', '.aws', '.netrc', '.npmrc', '.npm', '.docker', '.gnupg', '.pki', '.git-credentials', 'Library/Keychains', 'Library/Application Support']) {
    assert.ok(profile.includes(`(subpath "/Users/Jane Doe/${path}")`), `${path} is denied`)
  }
  assert.ok(profile.includes('(subpath "/Library/Keychains")'))
  assert.ok(profile.includes('(subpath "/System/Library/Keychains")'))
  assert.match(profile, /com\.apple\.securityd/)
  assert.match(profile, /com\.apple\.SecurityServer/)
})

test('sandbox preflight proves file denials and refuses unless keychain access fails', async (t) => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return t.skip('macOS sandbox-exec unavailable')
  const root = await mkdtemp(join(tmpdir(), 'hd-library-sandbox-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profilePath = join(root, 'real-home-profile.sb')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(profilePath, makeSandboxProfile(root)))
  assert.equal(verifySandbox(profilePath, root), true)
})

test('result validation requires an answer only for asked results', () => {
  const valid = {
    agent: 'Codex', agentId: 'codex', version: '0.149.0', measured: '2026-10-01', interface: 'codex app-server skills/list',
    question: 'Which skill sentinel is loaded?', rawAnswer: 'measure-sentinel', facts: { catalogue: ['measure-sentinel'] }, status: 'asked',
  }
  assert.deepEqual(validateResult(valid), valid)
  assert.throws(() => validateResult({ ...valid, rawAnswer: '' }), /rawAnswer/)
  assert.throws(() => validateResult({ ...valid, rawAnswer: '', status: 'could-not-ask' }), /reason/)
  assert.throws(() => validateResult({ ...valid, status: 'could-not-ask', reason: 'needs sign-in, not measured' }), /cannot persist an answer/)
  assert.equal(validateResult({ ...valid, rawAnswer: '', status: 'could-not-ask', reason: 'needs sign-in, not measured' }).status, 'could-not-ask')
  assert.throws(() => validateResult({ ...valid, rawAnswer: '', status: 'asked' }), /rawAnswer/)
})

test('raw-answer allowlist rejects account names, structured secrets, and outside paths', () => {
  const unsafe = 'Signed in as Jane Doe {"access_token":"eyJhbGciOiJIUzI1NiJ9","refresh_token":"r1"} /Users/private/.claude/config.json'
  assert.equal(redact(unsafe, ['HOME_AGENTS_SENTINEL', 'measure-sentinel'], '/tmp/fixture'), '')
  assert.equal(redact('HOME_AGENTS_SENTINEL and Jane Doe', ['HOME_AGENTS_SENTINEL'], '/tmp/fixture'), '')
  const valid = { agent: 'Codex', agentId: 'codex', version: '0.149.0', measured: '2026-10-01', interface: 'skills/list', question: 'Which skill?', facts: {}, status: 'asked' }
  assert.throws(() => validateResult({ ...valid, rawAnswer: 'Jane Doe' }), /normalized fixture tokens/)
  assert.throws(() => validateResult({ ...valid, rawAnswer: 'measure-sentinel', facts: { access_token: 'secret' } }), /sensitive facts/)
})

test('a missing probe persists a redacted could-not-ask result', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-library-result-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  fixture.isolation.available = true
  const result = await askAgent({ id: 'unregistered-test-agent', name: 'Test Agent' }, fixture)
  assert.equal(result.status, 'could-not-ask')
  assert.match(result.reason, /no safe probe registered/)
  const path = await writeResult(result, join(root, 'results'))
  const saved = await readFile(path, 'utf8')
  assert.match(saved, /could-not-ask/)
  assert.doesNotMatch(saved, /sk-live|@example\.com|\/Users\//)
})

test('subprocess environment contains only the allowlisted isolated values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-library-run-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const prior = process.env.MEASURE_SENTINEL_SECRET
  process.env.MEASURE_SENTINEL_SECRET = 'placeholder-secret'
  t.after(() => { if (prior === undefined) delete process.env.MEASURE_SENTINEL_SECRET; else process.env.MEASURE_SENTINEL_SECRET = prior })
  const fixture = await createFixture(root)
  if (!fixture.isolation.available) return t.skip('sandbox-exec is unavailable on this host')
  const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], fixture)
  assert.equal(result.code, 0)
  const env = JSON.parse(result.stdout)
  assert.equal(env.HOME, fixture.home)
  assert.equal(env.CODEX_HOME, join(fixture.home, '.codex'))
  assert.equal(env.MEASURE_SENTINEL_SECRET, undefined)
})

test('signed-out and cannot-isolate outcomes are recorded before a probe starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hd-library-refusal-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  let launches = 0
  registerProbe('unsafe-test-agent', async () => { launches += 1; throw new Error('must not launch') })
  fixture.isolation.available = false
  const unsafe = await askAgent({ id: 'unsafe-test-agent', name: 'Test Agent' }, fixture)
  assert.equal(unsafe.status, 'could-not-ask')
  assert.match(unsafe.reason, /cannot isolate/)
  assert.equal(launches, 0)
  fixture.isolation.available = true
  registerProbe('signed-out-test-agent', async () => ({ status: 'could-not-ask', reason: 'needs sign-in, not measured', rawAnswer: '' }))
  const signedOut = await askAgent({ id: 'signed-out-test-agent', name: 'Test Agent' }, fixture)
  assert.equal(signedOut.status, 'could-not-ask')
  assert.match(signedOut.reason, /needs sign-in/)
})
```
- [ ] **Step 2: Run the failing tests.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL because the harness exports do not exist.

- [ ] **Step 3: Implement `script/measure/library.mjs` with this complete fixture, isolation, subprocess, redaction, validation, dispatcher and writer contract.** The CLI-specific probe functions are registered by Tasks 2–9; an unregistered agent takes the complete `could-not-ask` path below.

```js
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESULT_DIR = new URL('../../docs/verification/library-measurements/', import.meta.url)
const RESULT_DIR_PATH = fileURLToPath(RESULT_DIR)
const VENDOR_HOMES = [
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'CURSOR_CONFIG_DIR',
  'OPENCLAW_STATE_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HERMES_HOME',
  'CODEBUDDY_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'GROK_HOME', 'COPILOT_HOME',
  'GEMINI_HOME', 'DSH_HOME', 'OPENCLAW_CONFIG_PATH', 'OPENCODE_CONFIG_DIR',
]
const PROBES = new Map()
const KNOWN_SKILL_ROOTS = {
  claudecode: { user: ['~/.claude/skills'], project: ['.claude/skills'] },
  cursor: { user: ['~/.cursor/skills', '~/.cursor/skills-cursor'], project: ['.cursor/skills'] },
  geminicli: { user: ['~/.gemini/skills'], project: ['.gemini/skills'] },
  deepseek: { user: ['~/.dsh/skills'], project: ['.dsh/skills'] },
}
const REAL_HOME_BLOCKS = [
  '.harnessdesk', '.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.agents', '.dsh',
  '.openclaw', '.hermes', '.codebuddy', '.kimi', '.pi', '.grok', '.copilot',
  '.antigravity', '.devin', '.cline', '.local/share', '.config', '.ssh', '.aws',
  '.azure', '.kube', '.netrc', '.npmrc', '.npm', '.docker', '.gnupg', '.pki',
  '.git-credentials', 'Library/Keychains', 'Library/Application Support',
]

const write = async (path, body) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

const skillBody = (name, description, extra = '') =>
  `---\nname: ${name}\n${description === null ? '' : `description: ${description}\n`}---\n\n${extra || `Fixture for ${name}.`}\n`

export async function createFixture(root) {
  root ??= await mkdtemp(join(tmpdir(), 'hd-library-measure-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const nested = join(repo, 'nested')
  const fixture = {
    root, home, repo, nested,
    harnessHome: join(home, 'harnessdesk'),
    isolation: { available: process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'), reason: '' },
    skills: {
      user: join(home, '.codex/skills/measure-user'),
      project: join(repo, '.codex/skills/measure-project'),
      duplicateUser: join(home, '.codex/skills/measure-duplicate'),
      duplicateProject: join(repo, '.codex/skills/measure-duplicate'),
      missingDescription: join(repo, '.codex/skills/measure-no-description'),
      oversized: join(repo, '.codex/skills/measure-oversized'),
      sentinel: join(repo, '.codex/skills/measure-sentinel'),
    },
    ruleSentinels: {},
    mcp: [join(home, '.codex/config.toml'), join(repo, '.cursor/mcp.json')],
    mcpPeer: join(root, 'fixture-mcp.mjs'),
  }
  await Promise.all([home, repo, nested].map((path) => mkdir(path, { recursive: true })))
  for (const [path, name, description] of [
    [fixture.skills.user, 'measure-user', 'user scope fixture'],
    [fixture.skills.project, 'measure-project', 'project scope fixture'],
    [fixture.skills.duplicateUser, 'measure-duplicate', 'USER_COPY_SENTINEL'],
    [fixture.skills.duplicateProject, 'measure-duplicate', 'PROJECT_COPY_SENTINEL'],
    [fixture.skills.missingDescription, 'measure-no-description', null],
    [fixture.skills.oversized, 'measure-oversized', 'oversized fixture'],
    [fixture.skills.sentinel, 'measure-sentinel', 'unique catalogue sentinel'],
    [fixture.skills.auxiliary, 'measure-with-auxiliary', 'auxiliary file fixture'],
  ]) {
    await write(join(path, 'SKILL.md'), skillBody(name, description,
      path === fixture.skills.oversized ? 'x'.repeat(1_100_000) : undefined))
  }
  await write(join(fixture.skills.auxiliary, 'references', 'measure-reference.md'), 'AUXILIARY_FILE_SENTINEL\n')
  const ruleFiles = [
    [join(home, 'AGENTS.md'), 'HOME_AGENTS_SENTINEL'],
    [join(home, 'CLAUDE.md'), 'HOME_CLAUDE_SENTINEL'],
    [join(home, 'GEMINI.md'), 'HOME_GEMINI_SENTINEL'],
    [join(home, '.cursor/rules/home.mdc'), 'HOME_CURSOR_RULE_SENTINEL'],
    [join(repo, 'AGENTS.md'), 'REPO_AGENTS_SENTINEL'],
    [join(repo, 'CLAUDE.md'), 'REPO_CLAUDE_SENTINEL'],
    [join(repo, 'GEMINI.md'), 'REPO_GEMINI_SENTINEL'],
    [join(repo, '.cursor/rules/repo.mdc'), 'REPO_CURSOR_RULE_SENTINEL'],
    [join(nested, 'AGENTS.md'), 'NESTED_AGENTS_SENTINEL'],
    [join(nested, 'CLAUDE.md'), 'NESTED_CLAUDE_SENTINEL'],
    [join(nested, 'GEMINI.md'), 'NESTED_GEMINI_SENTINEL'],
    [join(nested, '.cursor/rules/nested.mdc'), 'NESTED_CURSOR_RULE_SENTINEL'],
  ]
  for (const [path, phrase] of ruleFiles) {
    fixture.ruleSentinels[path] = phrase
    await write(path, `# Fixture rules\n\n${phrase}\n`)
  }
  await write(fixture.mcpPeer, `import { createInterface } from 'node:readline'\nconst io = createInterface({ input: process.stdin })\nio.on('line', line => {\n  const request = JSON.parse(line)\n  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'measure-fixture', version: '1' } } }) + '\\n')\n  else if (request.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\\n')\n})\n`)
  await write(fixture.mcp[0], `[mcp_servers.measure_fixture]\ncommand = "node"\nargs = [${JSON.stringify(fixture.mcpPeer)}]\n`)
  await write(fixture.mcp[1], JSON.stringify({ mcpServers: { measure_fixture: { command: 'node', args: [fixture.mcpPeer] } } }, null, 2))
  await write(join(root, 'tmp/.keep'), '')
  for (const roots of Object.values(KNOWN_SKILL_ROOTS)) await populateSkillRoots(fixture, roots)
  fixture.isolation.reason = fixture.isolation.available ? '' : 'cannot isolate: macOS sandbox-exec unavailable'
  return fixture
}

export async function populateSkillRoots(fixture, roots) {
  const names = ['measure-user', 'measure-project', 'measure-duplicate', 'measure-no-description', 'measure-oversized', 'measure-sentinel', 'measure-with-auxiliary']
  const written = []
  for (const [scope, candidates] of [['user', roots.user], ['project', roots.project]]) {
    for (const path of candidates) {
      const root = path.startsWith('~/') ? join(fixture.home, path.slice(2)) : join(fixture.repo, path)
      for (const name of names) {
        const destination = join(root, name)
        const description = name === 'measure-no-description' ? null : `${scope.toUpperCase()}_${name}_SENTINEL`
        const body = skillBody(name, description, name === 'measure-oversized' ? 'x'.repeat(1_100_000) : undefined)
        await write(join(destination, 'SKILL.md'), body)
        if (name === 'measure-with-auxiliary') await write(join(destination, 'references', 'measure-reference.md'), 'AUXILIARY_FILE_SENTINEL\n')
        written.push({ path, scope, name, sentinel: description })
      }
    }
  }
  return written
}

const isWithin = (root, path) => {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

export function assertIsolatedEnv(env, root) {
  for (const name of ['HOME', 'HARNESSDESK_HOME', 'TMPDIR', ...VENDOR_HOMES, 'cwd']) {
    if (!env[name]) throw new Error(`${name} must be set to a path under the temporary root`)
    if (!isWithin(root, env[name])) throw new Error(`${name} resolves outside the temporary root`)
  }
}

export const safeEnv = (fixture, cwd = fixture.repo) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: process.env.LANG ?? 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  HOME: fixture.home,
  CODEX_HOME: join(fixture.home, '.codex'),
  CLAUDE_CONFIG_DIR: join(fixture.home, '.claude'),
  GEMINI_CLI_HOME: join(fixture.home, '.gemini'),
  CURSOR_CONFIG_DIR: join(fixture.home, '.cursor'),
  OPENCLAW_STATE_DIR: join(fixture.home, '.openclaw'),
  XDG_CONFIG_HOME: join(fixture.home, '.config'),
  XDG_DATA_HOME: join(fixture.home, '.local/share'),
  HERMES_HOME: join(fixture.home, '.hermes'),
  CODEBUDDY_CONFIG_DIR: join(fixture.home, '.codebuddy'),
  PI_CODING_AGENT_DIR: join(fixture.home, '.pi'),
  GROK_HOME: join(fixture.home, '.grok'),
  COPILOT_HOME: join(fixture.home, '.copilot'),
  GEMINI_HOME: join(fixture.home, '.gemini-alt'),
  DSH_HOME: join(fixture.home, '.dsh'),
  OPENCLAW_CONFIG_PATH: join(fixture.home, '.openclaw/openclaw.json'),
  OPENCODE_CONFIG_DIR: join(fixture.home, '.config/opencode'),
  HARNESSDESK_HOME: fixture.harnessHome,
  TMPDIR: join(fixture.root, 'tmp'),
  cwd,
})

export function makeSandboxProfile(root, realHome = homedir()) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null
  return sandboxProfileText(realHome)
}

export function verifySandbox(profilePath, fixtureRoot) {
  const canaryHome = join(fixtureRoot, 'sandbox-canary-home')
  const canaryPaths = REAL_HOME_BLOCKS.map((part) => join(canaryHome, part, 'canary'))
  for (const path of canaryPaths) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'sandbox denial canary')
  }
  const canaryProfile = join(fixtureRoot, 'sandbox-canary.sb')
  writeFileSync(canaryProfile, sandboxProfileText(canaryHome))
  const checkScript = `
    const fs = require('node:fs');
    const paths = process.argv.slice(1);
    for (const path of paths) {
      let readDenied = false, writeDenied = false;
      try { fs.readFileSync(path); } catch (error) { readDenied = ['EPERM', 'EACCES'].includes(error.code); }
      try { fs.writeFileSync(path, 'must be denied'); } catch (error) { writeDenied = ['EPERM', 'EACCES'].includes(error.code); }
      if (!readDenied || !writeDenied) process.exit(31);
    }
  `
  const paths = spawnSync('/usr/bin/sandbox-exec', ['-f', canaryProfile, process.execPath, '-e', checkScript, ...canaryPaths], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  })
  if (paths.status !== 0) return false
  // A canary that does not exist fails with or without the sandbox, which
  // proves nothing. Plant a real item, prove it reads outside the sandbox,
  // prove it is refused inside, and always remove it.
  const service = `harnessdesk-measure-canary-${process.pid}`
  const security = (args, sandboxed) => spawnSync(
    sandboxed ? '/usr/bin/sandbox-exec' : '/usr/bin/security',
    sandboxed ? ['-f', profilePath, '/usr/bin/security', ...args] : args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
  )
  if (security(['add-generic-password', '-s', service, '-a', 'canary', '-w', 'canary'], false).status !== 0) return false
  try {
    if (security(['find-generic-password', '-s', service], false).status !== 0) return false
    return security(['find-generic-password', '-s', service], true).status !== 0
  } finally {
    security(['delete-generic-password', '-s', service], false)
  }
}

export function sandboxProfileText(realHome) {
  const blocked = [...REAL_HOME_BLOCKS.map((path) => join(realHome, path)), '/Library/Keychains', '/System/Library/Keychains']
  const denies = blocked.map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join('\n')
  return `(version 1)\n(allow default)\n${denies}\n(deny mach-lookup (global-name "com.apple.securityd"))\n(deny mach-lookup (global-name "com.apple.SecurityServer"))\n`
}

export function run(command, args, fixture, { cwd = fixture.repo, timeoutMs = 60_000, input = '', envOverrides = {}, allowedEnv = [] } = {}) {
  if (Object.keys(envOverrides).some((name) => !allowedEnv.includes(name))) throw new Error('subprocess environment override is not allowlisted')
  const env = { ...safeEnv(fixture), ...envOverrides, cwd }
  assertIsolatedEnv(env, fixture.root)
  const profile = makeSandboxProfile(fixture.root)
  if (!profile) throw new Error('cannot isolate')
  const profilePath = join(fixture.root, 'probe.sb')
  const sandboxEnv = { ...env, cwd: fixture.repo }
  return writeFile(profilePath, profile).then(() => new Promise((resolveRun, rejectRun) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, command, ...args], {
      cwd: fixture.repo, env: sandboxEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.stdin.end(input)
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr })
    })
  }))
}

export async function captureHelpVersion(agent, fixture) {
  const help = await run(agent.command, ['--help'], fixture)
  await write(join(fixture.root, 'captures', `${agent.id}.help.txt`), `${help.stdout}${help.stderr}`)
  const versionArgs = agent.cli?.versionArgs ?? ['--version']
  const version = await run(agent.command, versionArgs, fixture)
  await write(join(fixture.root, 'captures', `${agent.id}.version.txt`), `${version.stdout}${version.stderr}`)
  const text = `${version.stdout}\n${version.stderr}`
  const match = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/)
  return { help, version, value: version.code === 0 ? match?.[0] ?? null : null }
}

export function redact(value, allowed, fixtureRoot) {
  const answer = String(value)
  const sensitive = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|Jane Doe|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/|[A-Z]:\\Users\\)/i
  if (sensitive.test(answer)) return ''
  return normalizeFixtureTokens(answer, allowed)
}

export function normalizeFixtureTokens(value, allowed) {
  const answer = String(value)
  const hits = allowed.filter((token) => token).map((token) => ({ token, index: answer.indexOf(token) }))
    .filter((hit) => hit.index >= 0).sort((a, b) => a.index - b.index)
  return [...new Set(hits.map((hit) => hit.token))].join('\n')
}

export function validateResult(result) {
  for (const key of ['agent', 'agentId', 'version', 'measured', 'interface', 'question']) {
    if (typeof result?.[key] !== 'string' || !result[key].trim()) throw new Error(`${key} is required`)
  }
  if (!result.facts || typeof result.facts !== 'object' || Array.isArray(result.facts)) throw new Error('facts must be an object')
  if (result.status !== 'asked' && result.status !== 'could-not-ask') throw new Error('status must be asked or could-not-ask')
  if (typeof result.rawAnswer !== 'string' || (result.status === 'asked' && !result.rawAnswer.trim())) throw new Error('rawAnswer is required for asked results')
  if (result.rawAnswer && result.rawAnswer.split('\n').some((line) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(line))) throw new Error('rawAnswer must contain normalized fixture tokens')
  if (result.status === 'could-not-ask' && result.rawAnswer !== '') throw new Error('could-not-ask results cannot persist an answer')
  if (/(?:Jane Doe|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/)/i.test(JSON.stringify(result.facts))) throw new Error('sensitive facts are forbidden')
  if (result.status === 'could-not-ask' && (typeof result.reason !== 'string' || !result.reason.trim())) throw new Error('reason is required for could-not-ask')
  if (result.status === 'could-not-ask' && /(?:Jane Doe|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/)/i.test(result.reason)) throw new Error('sensitive reason is forbidden')
  if (result.status === 'asked' && result.reason !== undefined) throw new Error('reason is only valid for could-not-ask')
  return result
}

export function registerProbe(agentId, probe) {
  if (typeof probe !== 'function') throw new TypeError('probe must be a function')
  PROBES.set(agentId, probe)
}

export async function askAgent(agent, fixture) {
  const base = { agent: agent.name, agentId: agent.id, version: agent.version ?? 'unknown', measured: new Date().toISOString().slice(0, 10), interface: 'not selected', question: 'Probe the agent through its own interface', rawAnswer: '', facts: {}, fixtureRoot: fixture.root }
  if (!fixture.isolation.available) return validateResult({ ...base, status: 'could-not-ask', reason: 'cannot isolate' })
  const probe = PROBES.get(agent.id)
  if (!probe) return validateResult({ ...base, status: 'could-not-ask', reason: `no safe probe registered for ${agent.id}` })
  try {
    const answer = await probe(agent, fixture)
    if (answer.status === 'could-not-ask') {
      const reason = typeof answer.reason === 'string' && !/(?:Jane Doe|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|\/(?:Users|home|tmp|private|var)\/)/i.test(answer.reason)
        ? answer.reason : 'probe declined safely'
      return validateResult({ ...base, interface: answer.interface ?? base.interface, question: answer.question ?? base.question, status: 'could-not-ask', reason })
    }
    const normalizedRaw = redact(answer.rawAnswer ?? '', answer.allowedRawTokens ?? [], fixture.root)
    if (!normalizedRaw) return validateResult({ ...base, status: 'could-not-ask', reason: 'answer failed the fixture-only privacy allowlist' })
    const facts = answer.facts ?? {}
    if (/(?:Jane Doe|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|bearer\s|password|cookie|secret|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\/Users\/)/i.test(JSON.stringify(facts))) {
      return validateResult({ ...base, status: 'could-not-ask', reason: 'parsed facts failed the privacy allowlist' })
    }
    return validateResult({
      ...base,
      interface: answer.interface ?? base.interface,
      question: answer.question ?? base.question,
      rawAnswer: normalizedRaw,
      facts,
      status: answer.status ?? 'asked',
    })
  } catch (error) {
    return validateResult({ ...base, status: 'could-not-ask', reason: `probe failed safely (${error instanceof Error ? error.name : 'unknown error'})` })
  }
}

export async function writeResult(result, directory = RESULT_DIR_PATH) {
  const { fixtureRoot = '', ...publicResult } = result
  const safe = validateResult(publicResult)
  const agentSlug = String(safe.agentId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const versionSlug = String(safe.version).replace(/[^A-Za-z0-9.+_-]/g, '-')
  const path = join(directory, `${agentSlug}-${versionSlug}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(safe, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  return path
}

export async function findAgentInstall(agent, fixture) {
  const { candidatePaths, findInstalls, judgeInstalls } = await import('../../packages/server/dist/src/installs/locate.js')
  const spec = agent.id === 'codex'
    ? { commands: ['codex'], versionArgs: ['--version'] }
    : agent.cli
  const locateOptions = { home: homedir(), env: { PATH: process.env.PATH ?? '' } }
  const candidates = candidatePaths(spec, locateOptions).filter(existsSync)
  const protectedRoots = REAL_HOME_BLOCKS.map((path) => join(homedir(), path))
    .concat(['/Library/Keychains', '/System/Library/Keychains'])
  const candidateNeedsDeniedAccess = candidates.some((path) => {
    let real = path
    try { real = realpathSync(path) } catch {}
    return protectedRoots.some((root) => isWithin(root, path) || isWithin(root, real))
  })
  if (candidateNeedsDeniedAccess) return { chosen: null, cannotIsolate: true }
  const found = await findInstalls(spec, {
    ...locateOptions,
    probe: async (path, args) => {
      try {
        const result = await run(path, [...args], fixture, { timeoutMs: 10_000 })
        return result.code === 0 ? `${result.stdout}\n${result.stderr}` : null
      } catch {
        return null
      }
    },
  })
  return { chosen: judgeInstalls(found, { minVersion: spec.minVersion }).chosen, cannotIsolate: false }
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--all')) throw new Error('usage: node script/measure/library.mjs --all')
  await import('./probes/index.mjs')
  const { KNOWN_AGENTS } = await import('../../packages/server/dist/src/installs/known-agents.js')
  const agents = [{ id: 'codex', name: 'Codex' }, ...KNOWN_AGENTS]
  for (const agent of agents) {
    const root = await mkdtemp(join(tmpdir(), 'hd-library-measure-'))
    try {
      const fixture = await createFixture(root)
      if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
        fixture.isolation.available = false
        fixture.isolation.reason = 'cannot isolate: sandbox-exec unavailable'
      }
      const profilePath = join(root, 'probe.sb')
      if (fixture.isolation.available) {
        await writeFile(profilePath, makeSandboxProfile(root))
        fixture.isolation.available = verifySandbox(profilePath, root)
        if (!fixture.isolation.available) fixture.isolation.reason = 'cannot isolate: sandbox profile preflight failed'
      }
      const installResult = fixture.isolation.available ? await findAgentInstall(agent, fixture) : { chosen: null, cannotIsolate: true }
      const install = installResult.chosen
      const command = install?.path
      const discovered = command
        ? await captureHelpVersion({ ...agent, command }, fixture)
        : null
      const result = command && discovered?.value && discovered.value === install.version
        ? await askAgent({ ...agent, command, version: discovered.value }, fixture)
        : validateResult({
            agent: agent.name, agentId: agent.id, version: 'unknown', measured: new Date().toISOString().slice(0, 10),
            interface: 'not launched', question: 'Is an installed build available?', rawAnswer: '', facts: {},
            status: 'could-not-ask',
            reason: !fixture.isolation.available || installResult.cannotIsolate ? 'cannot isolate' : !install ? 'binary not installed' : !discovered?.value ? 'could not capture an exact version' : 'installed version changed during discovery',
          })
      await writeResult(result)
      process.stdout.write(`${result.status}: ${agent.id} ${result.version}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main()
```

- [ ] **Step 4: Run the focused tests.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS, including cleanup after successful and refused asks.

- [ ] **Step 5: Commit.**

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/README.md docs/verification/library-measurements/README.md
git commit -m "feat: add isolated library measurement harness"
```

Each `writeResult` call accepts an optional destination directory (the test above passes a temp directory); the default is the repository result directory. `rawAnswer` is only the newline-joined subset of allowlisted fixture sentinels, never process stdout. `validateResult` allows `rawAnswer: ''` only with `status: 'could-not-ask'` and a nonempty reason. The signed-out and cannot-isolate test above verifies both paths, including that unsafe isolation returns before the registered probe increments its launch counter.

### Task 2: Measurement 1 — rules-file discovery and precedence

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Create: `script/measure/probes/index.mjs`

**Interfaces:**
- Consumes: `createFixture`, `askAgent`, and `writeResult` from Task 1; ACP metadata from `KNOWN_AGENTS.find((agent) => agent.id === id)?.acp`.
- Produces: parsed `facts.rulesFiles`, an ordered list of visible sentinel paths with scope and relative order, or an empty list when the answer cannot establish visibility.

- [ ] **Step 1: Add the parser test and implementation.** Append this test and export this parser from `library.mjs`:

```js
test('rules parser keeps only reported sentinel paths in answer order', () => {
  const rows = [
    { path: 'AGENTS.md', scope: 'repo', sentinel: 'REPO_AGENTS_SENTINEL' },
    { path: 'nested/CLAUDE.md', scope: 'nested', sentinel: 'NESTED_CLAUDE_SENTINEL' },
  ]
  assert.deepEqual(parseRules('NESTED_CLAUDE_SENTINEL then REPO_AGENTS_SENTINEL', rows), [
    { path: 'nested/CLAUDE.md', scope: 'nested', order: 0 },
    { path: 'AGENTS.md', scope: 'repo', order: 1 },
  ])
})
export function parseRules(answer, rows) {
  const positions = rows.map((row) => ({ row, index: answer.indexOf(row.sentinel) }))
    .filter(({ index }) => index >= 0).sort((a, b) => a.index - b.index)
  return positions.map(({ row }, order) => ({ path: row.path, scope: row.scope, order }))
}
```

- [ ] **Step 2: Run the failing parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent rule parser.

- [ ] **Step 3: Register the rules question for Codex and every ACP build.** `codexSkillsList` performs app-server `initialize`, `skills/list`, then `thread/start`/`turn/start` with the question. The ACP path uses the implementation in Task 4. Repeat at user, repo-root and nested cwd; each question is a normal agent prompt and records only sentinels.

```js
const question = 'Repeat every rules-file sentinel you can see, in the order you read it. Do not summarize.'
registerCodexMeasurement('rulesFiles', async (agent, fixture) => {
  const rules = Object.entries(fixture.ruleSentinels).map(([absolute, sentinel]) => {
    const path = relative(fixture.home, absolute).startsWith('..') ? relative(fixture.repo, absolute) : `~/${relative(fixture.home, absolute)}`
    const scope = path.startsWith('~/') ? 'user' : path.startsWith('nested/') ? 'nested' : 'repo'
    return { path, scope, sentinel }
  })
  const answers = await Promise.all([fixture.home, fixture.repo, fixture.nested].map((cwd) => codexSkillsList(agent, fixture, question, cwd)))
  const answerText = answers.map((answer) => answer.rawText).join('\n')
  const rows = parseRules(answerText, rules)
  const allowedRawTokens = rules.map((row) => row.sentinel)
  return { question, facts: { rulesFiles: rows }, rawAnswer: normalizeFixtureTokens(answerText, allowedRawTokens), allowedRawTokens }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'rulesFiles', async (agent, fixture) => {
  const rules = Object.entries(fixture.ruleSentinels).map(([absolute, sentinel]) => {
    const path = relative(fixture.home, absolute).startsWith('..') ? relative(fixture.repo, absolute) : `~/${relative(fixture.home, absolute)}`
    const scope = path.startsWith('~/') ? 'user' : path.startsWith('nested/') ? 'nested' : 'repo'
    return { path, scope, sentinel }
  })
  const answers = await Promise.all([fixture.home, fixture.repo, fixture.nested].map((cwd) => acpAsk(agent, fixture, question, cwd)))
  const answerText = answers.map((answer) => answer.text).join('\n')
  const rows = parseRules(answerText, rules)
  const allowedRawTokens = rules.map((row) => row.sentinel)
  return { question, facts: { rulesFiles: rows }, rawAnswer: normalizeFixtureTokens(answerText, allowedRawTokens), allowedRawTokens }
})
```

`captureHelpVersion` calls `run(agent.command, ['--help'], fixture)` and `run(agent.command, agent.cli?.versionArgs ?? ['--version'], fixture)`, and writes both captures under `fixture.root/captures/`. Both invocations use the allowlisted child environment and the verified `sandbox-exec` profile.

Append the preceding registration code to `script/measure/probes/index.mjs`. Its module imports are relative to `probes/`; `--all` imports this index before iterating installs, so both protocol maps are populated before the first call to `askAgent`.

Create `script/measure/probes/index.mjs` as the deterministic registry entry point. It imports `registerProbe` and installs only drivers whose invocation has been established by the subsequent measurement tasks; missing entries remain explicit `could-not-ask` results. Every registered driver invokes subprocesses only through `run(command, args, fixture, { cwd })`. For ACP, the bridge process and agent binary both use `run`, with `HARNESSDESK_HOME=fixture.harnessHome`; if either cannot be placed inside this sandbox, do not start it.

```js
import { registerProbe, normalizeFixtureTokens, parseRules, parseCatalogue, parsePrecedence, parseRejections, parseSkillRoots, parseRefresh, parseMcp, parseSignedOut, populateSkillRoots } from '../library.mjs'
import { LOCATIONS, extraSkillRoots } from '../../../packages/agent-inventory/dist/src/locations.js'
import { relative, join } from 'node:path'
import { codexProbe } from './codex.mjs'
import { acpProbe } from './acp.mjs'
import { registerCodexMeasurement, codexSkillsList, startJsonRpc } from './codex.mjs'
import { ACP_AGENT_IDS, registerAcpMeasurement, acpAsk, acpAskSequence } from './acp.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
registerProbe('codex', codexProbe)
for (const id of ['claude-code', 'cursor', 'gemini', 'opencode', 'openclaw', 'hermes', 'cline', 'codebuddy-code', 'kimi', 'pi-acp', 'grok-build', 'github-copilot-cli', 'antigravity-acp', 'devin', 'dsh']) {
  registerProbe(id, acpProbe)
}
```

`codexProbe` and `acpProbe` each return one result containing all eight fact groups and an allowlisted normalized answer. The discovered CLI syntax is recorded in the versioned result's `interface` field; a build without a verified safe invocation is unregistered and therefore not launched.

- [ ] **Step 4: Run the focused parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS; the parser preserves the order of only the fixture rule sentinels present in its input. Task 9 produces the persisted composite result after all eight parsers are registered.
- [ ] **Step 5: Commit** the parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes/index.mjs
git commit -m "measure: parse agent rules files"
```

Task 10 adds evidence-linked location rows after Task 9's result exists.

### Task 3: Measurement 2 — skill bundle to catalogue mapping

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Create: `script/measure/probes/codex.mjs`

**Interfaces:**
- Consumes: `MeasurementResult` and the fixture bundle names/paths from Task 1.
- Produces: parsed `facts.catalogue`, with listed name, reported description, enabled state, and path/scope where reported; absent facts remain `null`, not inferred.

- [ ] **Step 1: Add the catalogue parser test and implementation.**

```js
test('catalogue parser accepts only exact fixture skill names and metadata', () => {
  const fixtures = [{ name: 'measure-sentinel', description: 'UNIQUE_SENTINEL', path: 'project/.claude/skills' }]
  assert.deepEqual(parseCatalogue({ skills: [{ name: 'measure-sentinel', description: 'UNIQUE_SENTINEL', enabled: true }, { name: 'other' }], commands: ['/measure-sentinel'] }, fixtures), [
    { name: 'measure-sentinel', description: 'UNIQUE_SENTINEL', enabled: true, path: 'project/.claude/skills', scope: 'project' },
  ])
})
export function parseCatalogue(response, fixtureSkills) {
  const rows = Array.isArray(response?.skills) ? response.skills : []
  return rows.flatMap((row) => {
    const fixture = fixtureSkills.find((item) => item.name === row.name && item.description === row.description)
      ?? fixtureSkills.find((item) => item.name === row.name)
    if (!fixture) return []
    return [{ name: fixture.name, description: row.description === fixture.description ? fixture.description : null, enabled: typeof row.enabled === 'boolean' ? row.enabled : null, path: fixture.path, scope: fixture.scope }]
  })
}
```
- [ ] **Step 2: Run the failing catalogue parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent catalogue parser.
- [ ] **Step 3: Add the catalogue questions to the composite probe.** It calls Codex app-server `skills/list`; other agents use their captured help's documented print mode or `KNOWN_AGENTS` ACP bridge args. Build skill fixtures from `LOCATIONS[agent.brand ?? agent.id].skills` plus `extraSkillRoots`, partitioned by scope; `KnownAgent.home` has no skill-root field. Ask for the sentinel-named skill. Task 9 runs the combined probe once. A response listing only commands is evidence for `reportsCatalogue: false`, not skill reach.

```js
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { populateSkillRoots, makeSandboxProfile, assertIsolatedEnv, safeEnv, parseCatalogue, normalizeFixtureTokens } from '../library.mjs'
import { LOCATIONS, extraSkillRoots } from '../../../packages/agent-inventory/dist/src/locations.js'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

const CODEX_MEASUREMENTS = new Map()
const MEASUREMENT_ORDER = ['rulesFiles', 'catalogue', 'precedence', 'rejections', 'skillRoots', 'refresh', 'mcp', 'signedOutCatalogue']

export function registerCodexMeasurement(name, probe) {
  if (!MEASUREMENT_ORDER.includes(name) || typeof probe !== 'function') throw new TypeError('invalid Codex measurement registration')
  CODEX_MEASUREMENTS.set(name, probe)
}

export async function codexProbe(agent, fixture) {
  const facts = {}
  const questions = []
  const tokens = []
  for (const name of MEASUREMENT_ORDER) {
    const probe = CODEX_MEASUREMENTS.get(name)
    if (!probe) { facts[name] = 'unknown'; continue }
    try {
      const result = await probe(agent, fixture)
      if (result.status === 'could-not-ask') { facts[name] = 'unknown'; continue }
      Object.assign(facts, result.facts)
      questions.push(result.question)
      tokens.push(...result.allowedRawTokens)
    } catch {
      facts[name] ??= 'unknown'
    }
  }
  if (!tokens.length) return { status: 'could-not-ask', reason: 'no registered safe Codex measurement', rawAnswer: '' }
  return { interface: 'codex app-server', question: questions.join('\n'), rawAnswer: [...new Set(tokens)].join('\n'), allowedRawTokens: [...new Set(tokens)], facts }
}

export async function startJsonRpc(command, args, fixture, cwd = fixture.repo, envOverrides = {}, allowedEnv = []) {
  if (Object.keys(envOverrides).some((name) => !allowedEnv.includes(name))) throw new Error('subprocess environment override is not allowlisted')
  const env = { ...safeEnv(fixture, cwd), ...envOverrides }
  assertIsolatedEnv(env, fixture.root)
  const profilePath = join(fixture.root, 'probe.sb')
  await writeFile(profilePath, makeSandboxProfile(fixture.root))
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, command, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  const notifications = []
  let nextId = 1
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { child.kill('SIGTERM'); return }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      message.error ? reject(new Error(message.error.message ?? 'JSON-RPC error')) : resolve(message.result)
    } else notifications.push(message)
  })
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const waitNotification = async (predicate, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = notifications.findIndex(predicate)
      if (index >= 0) return notifications.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('timed out waiting for JSON-RPC notification')
  }
  return { child, request, notify, waitNotification, takeNotifications: () => notifications.splice(0), close: () => { child.stdin.end(); child.kill('SIGTERM') } }
}

export async function codexSkillsList(agent, fixture, question = 'List the loaded fixture skills.', cwd = fixture.repo) {
  const rpc = await startJsonRpc(agent.command, ['app-server'], fixture, cwd)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'HarnessDeskMeasure', title: 'HarnessDesk measure', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] } })
    rpc.notify('initialized')
    const data = await rpc.request('skills/list', { cwds: [cwd], forceReload: true })
    const thread = await rpc.request('thread/start', { cwd, ephemeral: true })
    await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: question, text_elements: [] }] })
    const textParts = []
    for (;;) {
      const event = await rpc.waitNotification((message) => message.method === 'item/agentMessage/delta' || message.method === 'turn/completed')
      if (event.method === 'item/agentMessage/delta') textParts.push(event.params.delta)
      else break
    }
    return { data: data.data, rawText: textParts.join('') }
  } finally { rpc.close() }
}

export async function codexCatalogueProbe(agent, fixture) {
  const locations = LOCATIONS[agent.brand ?? agent.id] ?? { skills: [] }
  const candidates = [...locations.skills, ...extraSkillRoots]
  const written = await populateSkillRoots(fixture, {
    user: candidates.filter((row) => row.scope === 'user').map((row) => row.path),
    project: candidates.filter((row) => row.scope === 'project').map((row) => row.path),
  })
  fixture.skillFixtures = written.map(({ name, sentinel, path, scope }) => ({ name, description: sentinel, path, scope }))
  const listed = await codexSkillsList(agent, fixture, 'List fixture skills and their descriptions.', fixture.repo)
  const catalogue = parseCatalogue({ skills: listed.data.flatMap((entry) => entry.skills ?? []) }, fixture.skillFixtures)
  const names = catalogue.map((skill) => skill.name)
  return {
    interface: 'codex app-server skills/list',
    question: 'List fixture skills and their loaded state from the temporary home and repository.',
    rawAnswer: normalizeFixtureTokens(listed.rawText, [...names, 'catalogue-empty']),
    allowedRawTokens: [...names, 'catalogue-empty'],
    facts: { catalogue, reportsCatalogue: true },
  }
}

registerCodexMeasurement('catalogue', codexCatalogueProbe)
```

Append this ACP registration to `script/measure/probes/index.mjs`:

```js
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'catalogue', async (agent, fixture) => {
  const question = 'List the loaded fixture skills, exact names, descriptions, and whether you can invoke them.'
  const candidates = (LOCATIONS[agent.brand ?? agent.id] ?? { skills: [] }).skills.concat(extraSkillRoots)
  const written = await populateSkillRoots(fixture, { user: candidates.filter((row) => row.scope === 'user').map((row) => row.path), project: candidates.filter((row) => row.scope === 'project').map((row) => row.path) })
  fixture.skillFixtures = written.map(({ name, sentinel, path, scope }) => ({ name, description: sentinel, path, scope }))
  const observation = await acpAsk(agent, fixture, question)
  const fixtureSkills = fixture.skillFixtures
  const catalogue = parseCatalogue({ skills: observation.availableCommands.map((command) => ({ name: command.name, description: command.description, enabled: true })) }, fixtureSkills)
  const names = catalogue.map((row) => row.name)
  const allowedRawTokens = [...fixtureSkills.map((row) => row.name), ...fixtureSkills.map((row) => row.description).filter(Boolean)]
  return { question, facts: { catalogue, reportsCatalogue: observation.availableCommands.length > 0 }, rawAnswer: normalizeFixtureTokens(`${observation.text}\n${observation.availableCommands.map((row) => `${row.name} ${row.description ?? ''}`).join('\n')}`, allowedRawTokens), allowedRawTokens }
})
```
- [ ] **Step 4: Run the catalogue parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** the catalogue parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs
git add script/measure/probes/codex.mjs
git commit -m "measure: parse loaded skill catalogues"
```

### Task 4: Measurement 3 — same-name user/project precedence

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Modify: `script/measure/probes/codex.mjs`
- Create: `script/measure/probes/acp.mjs`

**Interfaces:**
- Consumes: Task 1 user/project fixtures and Task 3 catalogue query.
- Produces: parsed `facts.precedence` as `user`, `project`, `both`, `neither`, or `unknown`, backed by each copy's unique description and path sentinel.

- [ ] **Step 1: Add the precedence parser test and implementation.**

```js
test('precedence stays unknown unless a unique copy sentinel is observed', () => {
  assert.equal(parsePrecedence('no duplicate listed'), 'unknown')
  assert.equal(parsePrecedence('neither copy was loaded'), 'neither')
  assert.equal(parsePrecedence('USER_COPY_SENTINEL'), 'user')
  assert.equal(parsePrecedence('PROJECT_COPY_SENTINEL'), 'project')
  assert.equal(parsePrecedence('USER_COPY_SENTINEL PROJECT_COPY_SENTINEL'), 'both')
})
export function parsePrecedence(answer) {
  const user = answer.includes('USER_COPY_SENTINEL')
  const project = answer.includes('PROJECT_COPY_SENTINEL')
  if (user && project) return 'both'
  if (user) return 'user'
  if (project) return 'project'
  return /\b(neither|no (?:copy|skill) (?:was )?loaded|none loaded)\b/i.test(answer) ? 'neither' : 'unknown'
}
```

Create the ACP transport helper for every non-Codex registry entry. The task-specific question is built into the transcript by Tasks 2–9; this helper launches only the bridge or direct ACP CLI selected by current `KnownAgent` metadata.

```js
import { startJsonRpc } from './codex.mjs'
import { KNOWN_AGENTS } from '../../../packages/server/dist/src/installs/known-agents.js'

export const ACP_AGENT_IDS = ['claude-code', 'cursor', 'gemini', 'opencode', 'openclaw', 'hermes', 'cline', 'codebuddy-code', 'kimi', 'pi-acp', 'grok-build', 'github-copilot-cli', 'antigravity-acp', 'devin', 'dsh']
const ACP_MEASUREMENTS = new Map()
const MEASUREMENT_ORDER = ['rulesFiles', 'catalogue', 'precedence', 'rejections', 'skillRoots', 'refresh', 'mcp', 'signedOutCatalogue']

export function registerAcpMeasurement(agentId, name, probe) {
  if (!MEASUREMENT_ORDER.includes(name) || typeof probe !== 'function') throw new TypeError('invalid ACP measurement registration')
  const measurements = ACP_MEASUREMENTS.get(agentId) ?? new Map()
  measurements.set(name, probe)
  ACP_MEASUREMENTS.set(agentId, measurements)
}

export async function acpAskSequence(agent, fixture, questions, cwd = fixture.repo, afterFirst) {
  const known = KNOWN_AGENTS.find((candidate) => candidate.id === agent.id)
  if (!known?.acp) throw new Error('no ACP metadata')
  const bridge = known.acp.bridge
  const command = bridge?.command ?? agent.command
  const args = bridge?.args ?? known.acp.args
  const envOverrides = bridge ? { [bridge.executableEnv]: agent.command } : {}
  const allowedEnv = bridge ? [bridge.executableEnv] : []
  const rpc = await startJsonRpc(command, [...args], fixture, cwd, envOverrides, allowedEnv)
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false }, terminal: false, subagents: {},
        _meta: { 'subagent-transcript': true, jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
      },
    })
    const opened = await rpc.request('session/new', { cwd })
    const rounds = []
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]
      await rpc.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: question }] })
      const updates = rpc.takeNotifications().filter((message) => message.method === 'session/update').map((message) => message.params.update)
      const text = updates.filter((update) => update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text').map((update) => update.content.text).join('')
      const availableCommands = updates.filter((update) => update.sessionUpdate === 'available_commands_update').flatMap((update) => update.availableCommands ?? [])
      if (!text) throw new Error('ACP session returned no agent text')
      rounds.push({ question, text, availableCommands })
      if (index === 0 && afterFirst) await afterFirst()
    }
    return { rounds, sessionId: opened.sessionId, stopReason: 'session/prompt completed' }
  } finally { rpc.close() }
}

export async function acpAsk(agent, fixture, question, cwd = fixture.repo) {
  const result = await acpAskSequence(agent, fixture, [question], cwd)
  return { ...result.rounds[0], sessionId: result.sessionId, stopReason: result.stopReason }
}

export async function acpProbe(agent, fixture) {
  const measurements = ACP_MEASUREMENTS.get(agent.id)
  if (!measurements) return { status: 'could-not-ask', reason: `no safe ACP measurement registered for ${agent.id}`, rawAnswer: '' }
  const facts = {}
  const questions = []
  const tokens = []
  for (const name of MEASUREMENT_ORDER) {
    const probe = measurements.get(name)
    if (!probe) { facts[name] = 'unknown'; continue }
    try {
      const result = await probe(agent, fixture)
      if (result.status === 'could-not-ask') { facts[name] = 'unknown'; continue }
      Object.assign(facts, result.facts)
      questions.push(result.question)
      tokens.push(...result.allowedRawTokens)
    } catch {
      facts[name] ??= 'unknown'
    }
  }
  if (!tokens.length) return { status: 'could-not-ask', reason: 'no ACP question could be asked safely', rawAnswer: '' }
  return { interface: 'HarnessDesk ACP bridge', question: questions.join('\n'), rawAnswer: [...new Set(tokens)].join('\n'), allowedRawTokens: [...new Set(tokens)], facts }
}
```

Tasks 2–9 register a fact query only after captured help and ACP metadata establish a request transcript. Otherwise the dispatcher returns `could-not-ask` without launching; `run()` accepts only the one metadata-declared bridge executable variable through `allowedEnv`.
- [ ] **Step 2: Run the failing precedence parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent precedence parser.
- [ ] **Step 3: Register the duplicate-skill question in both protocols.** Write the user and project copies with their unique descriptions, issue the question through the Codex app-server or each ACP session, and preserve `unknown` when no unique sentinel is repeated.

Append this registration to `script/measure/probes/index.mjs`:

```js
const question = 'For measure-duplicate, repeat its exact description and say whether the user copy, project copy, both, or neither loaded.'
registerCodexMeasurement('precedence', async (agent, fixture) => {
  const answer = await codexSkillsList(agent, fixture, question)
  const precedence = parsePrecedence(answer.rawText)
  const allowedRawTokens = ['USER_COPY_SENTINEL', 'PROJECT_COPY_SENTINEL', 'neither']
  return { question, facts: { precedence }, rawAnswer: normalizeFixtureTokens(answer.rawText, allowedRawTokens), allowedRawTokens }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'precedence', async (agent, fixture) => {
  const answer = await acpAsk(agent, fixture, question)
  const precedence = parsePrecedence(answer.text)
  const allowedRawTokens = ['USER_COPY_SENTINEL', 'PROJECT_COPY_SENTINEL', 'neither']
  return { question, facts: { precedence }, rawAnswer: normalizeFixtureTokens(answer.text, allowedRawTokens), allowedRawTokens }
})
```

- [ ] **Step 4: Run the precedence parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** the precedence parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes/codex.mjs script/measure/probes/acp.mjs
git commit -m "measure: parse skill precedence"
```

### Task 5: Measurement 4 — SKILL.md validation limits and rejection reporting

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Modify: `script/measure/probes/codex.mjs`
- Modify: `script/measure/probes/acp.mjs`

**Interfaces:**
- Consumes: valid metadata, missing `description`, oversized `SKILL.md`, and `measure-with-auxiliary/references/measure-reference.md` from Task 1.
- Produces: parsed `facts.rejections`, one observation per fixture with accepted/rejected/unknown, agent-provided reason, auxiliary-file acceptance/rejection, and whether the agent surfaced a rejection catalogue.

- [ ] **Step 1: Add the rejection parser test and implementation.** Absence alone remains `unknown`.

```js
test('rejection parser needs explicit acceptance or path-plus-reason evidence', () => {
  assert.deepEqual(parseRejections({ skills: [{ name: 'measure-sentinel' }, { name: 'measure-with-auxiliary' }], errors: [{ path: '/tmp/fixture/measure-no-description/SKILL.md', message: 'description required' }] }, ['measure-sentinel', 'measure-no-description', 'measure-oversized', 'measure-with-auxiliary']), [
    { fixture: 'measure-sentinel', status: 'accepted', reason: null },
    { fixture: 'measure-no-description', status: 'rejected', reason: 'missing-description' },
    { fixture: 'measure-oversized', status: 'unknown', reason: null },
    { fixture: 'measure-with-auxiliary', status: 'accepted', reason: null },
  ])
})
export function parseRejections(response, fixtureNames) {
  const rejected = new Map((response?.errors ?? []).flatMap((error) => {
    const match = String(error.path ?? '').match(/(measure-[a-z-]+)\/SKILL\.md$/)
    const message = String(error.message ?? error.reason ?? '')
    const reason = /description|required field/i.test(message) ? 'missing-description' : /size|large|limit|bytes/i.test(message) ? 'size-limit' : message ? 'reported-rejection' : null
    return match && reason ? [[match[1], reason]] : []
  }))
  const accepted = new Set((response?.skills ?? []).map((skill) => skill.name))
  return fixtureNames.map((fixture) => rejected.has(fixture)
    ? { fixture, status: 'rejected', reason: rejected.get(fixture) }
    : accepted.has(fixture) ? { fixture, status: 'accepted', reason: null } : { fixture, status: 'unknown', reason: null })
}
export function reportsRejections(response) {
  return Array.isArray(response?.errors)
}
test('rejection reporting requires an explicit error catalogue field', () => {
  assert.equal(reportsRejections({ errors: [] }), true)
  assert.equal(reportsRejections({ skills: [] }), false)
})
```
- [ ] **Step 2: Run the failing rejection parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent rejection parser.
- [ ] **Step 3: Register the rejection/limits question in both protocols.** Query catalogue and explicit errors; correlate Codex `skills/list.errors` to fixture paths. Ask each ACP agent which fixtures were refused and why. Probe missing `description`, the 1.1 MB manifest, and the auxiliary-file bundle independently; report each as accepted/rejected/unknown and record the exact rejection reason token. Never infer a limit from silence. Task 9 runs this registered question once for each installed build.

Append the following to `script/measure/probes/index.mjs`:

```js
registerCodexMeasurement('rejections', async (agent, fixture) => {
  const observed = await codexSkillsList(agent, fixture, 'Report accepted and rejected fixture skills and any explicit errors.')
  const entries = observed.data ?? []
  const response = { skills: entries.flatMap((entry) => entry.skills ?? []), errors: entries.flatMap((entry) => entry.errors ?? []) }
  const fixtures = ['measure-sentinel', 'measure-no-description', 'measure-oversized', 'measure-with-auxiliary']
  const rejections = parseRejections(response, fixtures)
  const allowedRawTokens = [...fixtures, 'AUXILIARY_FILE_SENTINEL', 'missing-description', 'size-limit']
  return { question: 'Which fixture bundles were accepted or rejected, including the auxiliary file, and why?', facts: { rejections, reportsRejections: entries.some((entry) => Array.isArray(entry.errors)) }, rawAnswer: normalizeFixtureTokens(observed.rawText, allowedRawTokens), allowedRawTokens }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'rejections', async (agent, fixture) => {
  const observation = await acpAsk(agent, fixture, 'Which fixture bundles were accepted or rejected, including the auxiliary file, and why? Repeat exact fixture names and reason tokens.')
  const fixtures = ['measure-sentinel', 'measure-no-description', 'measure-oversized', 'measure-with-auxiliary']
  const errors = fixtures.flatMap((name) => /rejected|not loaded/i.test(observation.text) && observation.text.includes(name)
    ? [{ path: `/fixture/${name}/SKILL.md`, message: /description|required field/i.test(observation.text) ? 'description required' : /size|large|limit|bytes/i.test(observation.text) ? 'size limit' : '' }].filter((row) => row.message)
    : [])
  const skills = fixtures.filter((name) => observation.text.includes(name) && /accepted|loaded/i.test(observation.text)).map((name) => ({ name }))
  const rejections = parseRejections({ skills, errors }, fixtures)
  const allowedRawTokens = ['measure-sentinel', 'measure-no-description', 'measure-oversized', 'measure-with-auxiliary', 'AUXILIARY_FILE_SENTINEL', 'missing-description', 'size-limit']
  return { question: observation.question, facts: { rejections, reportsRejections: false }, rawAnswer: normalizeFixtureTokens(observation.text, allowedRawTokens), allowedRawTokens }
})
```
- [ ] **Step 4: Run the rejection parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** the rejection parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes/codex.mjs script/measure/probes/acp.mjs
git commit -m "measure: parse skill rejections"
```

### Task 6: Measurement 5 — tier C skill-folder locations

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Modify: `script/measure/probes/codex.mjs`
- Modify: `script/measure/probes/acp.mjs`

**Interfaces:**
- Consumes: tier C agent IDs from `KNOWN_AGENTS`, `LOCATIONS[brand].skills` and `extraSkillRoots`, and Task 3's catalogue parser.
- Produces: parsed `facts.skillRoots`, each observed relative fixture path plus scope; unobserved candidates remain unmeasured.

- [ ] **Step 1: Add the root parser test and implementation.** Call `populateSkillRoots` with every candidate in `(LOCATIONS[agent.brand ?? agent.id] ?? { skills: [] }).skills` plus `extraSkillRoots`, separately at each user's and project's isolated root. `KnownAgent.home` has no `skills` property; use help/version output to discover candidates absent from the location table. Do not reuse Codex-only `.codex/skills` fixture paths.

```js
test('root parser reports only explicit fixture root paths', () => {
  assert.deepEqual(parseSkillRoots('Loaded /tmp/fixture/home/.claude/skills/measure-sentinel/SKILL.md', [{ root: '/tmp/fixture/home/.claude/skills', path: '~/.claude/skills', scope: 'user' }]), [
    { path: '~/.claude/skills', scope: 'user' },
  ])
})
export function parseSkillRoots(answer, candidates) {
  return candidates.flatMap(({ root, path, scope }) => answer.includes(`${root}/measure-sentinel/SKILL.md`) || (answer.includes(path) && answer.includes('measure-sentinel')) ? [{ path, scope }] : [])
}
```
- [ ] **Step 2: Run the failing root parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent root parser.

- [ ] **Step 3: Register the tier C root question in both protocols** (OpenCode, OpenClaw, Hermes Agent, Cline, CodeBuddy Code, Kimi CLI, pi, Grok Build, GitHub Copilot, Antigravity and Devin). Place sentinel bundles at the table/help candidates, ask the agent to repeat paths and names, and record only explicitly named roots.

Append to `script/measure/probes/index.mjs`; main has already captured exact help/version before calling this composite probe:

```js
async function prepareRootMeasurement(agent, fixture) {
  const roots = (LOCATIONS[agent.brand ?? agent.id] ?? { skills: [] }).skills.concat(extraSkillRoots)
  const written = await populateSkillRoots(fixture, {
  user: roots.filter((row) => row.scope === 'user').map((row) => row.path),
  project: roots.filter((row) => row.scope === 'project').map((row) => row.path),
  })
  return written.filter(({ name }) => name === 'measure-sentinel').map(({ path, scope, name }) => ({ path, scope, name, root: path.startsWith('~/') ? join(fixture.home, path.slice(2)) : join(fixture.repo, path) }))
}
const question = 'Repeat the exact relative paths and names of measure-sentinel skill bundles you can see.'
registerCodexMeasurement('skillRoots', async (agent, fixture) => {
  fixture.skillFixtures = await prepareRootMeasurement(agent, fixture)
  const answer = await codexSkillsList(agent, fixture, question)
  const factRows = parseSkillRoots(answer.rawText, fixture.skillFixtures)
  const allowedRawTokens = fixture.skillFixtures.flatMap((row) => [row.name, row.path])
  return { question, facts: { skillRoots: factRows }, rawAnswer: normalizeFixtureTokens(answer.rawText, allowedRawTokens), allowedRawTokens }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'skillRoots', async (agent, fixture) => {
  fixture.skillFixtures = await prepareRootMeasurement(agent, fixture)
  const answer = await acpAsk(agent, fixture, question)
  const factRows = parseSkillRoots(answer.text, fixture.skillFixtures)
  const allowedRawTokens = fixture.skillFixtures.flatMap((row) => [row.name, row.path])
  return { question, facts: { skillRoots: factRows }, rawAnswer: normalizeFixtureTokens(answer.text, allowedRawTokens), allowedRawTokens }
})
```

Record `could-not-ask` when the binary is absent or no safe interface/home override exists.

- [ ] **Step 4: Run the root parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** the tier C parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes/codex.mjs script/measure/probes/acp.mjs
git commit -m "measure: parse agent skill roots"
```

### Task 7: Measurement 6 — catalogue refresh and open-session behavior

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Modify: `script/measure/probes/codex.mjs`
- Modify: `script/measure/probes/acp.mjs`

**Interfaces:**
- Consumes: Task 3's initial catalogue and each adapter's existing `refreshCatalog`, `listSkills`, and `setSkillEnabled` interfaces.
- Produces: `facts.refresh` with observed trigger (`live`, `restart`, or `none`) and whether an already-open session saw the added/removed sentinel.

- [ ] **Step 1: Add the refresh parser test and implementation.**

```js
test('refresh parser distinguishes a re-read from existing-session visibility', () => {
  assert.deepEqual(parseRefresh({ before: false, afterReload: true, existingSession: false, reload: 'restart', togglePersisted: true }), { catalogueRefresh: 'restart', openSessionSeesChange: false, skillToggle: true })
  assert.deepEqual(parseRefresh({ before: false, afterReload: true, existingSession: true, reload: 'live', togglePersisted: false }), { catalogueRefresh: 'live', openSessionSeesChange: true, skillToggle: false })
})
export function parseRefresh(observation) {
  const value = observation.before === observation.afterReload ? 'none' : observation.reload
  return { catalogueRefresh: ['live', 'restart'].includes(value) ? value : 'none', openSessionSeesChange: typeof observation.existingSession === 'boolean' ? observation.existingSession : null, skillToggle: observation.togglePersisted === true }
}
```
- [ ] **Step 2: Run the failing refresh parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent refresh parser.
- [ ] **Step 3: Register refresh and toggle probes in `probes/index.mjs`.** Create the new bundle after the first ask, then ask again on the same session. Re-read Codex `skills/list` on the same app-server and use only the fixture name with `skills/config/write`. ACP repeats `session/prompt` with its retained `sessionId`.

Append both callbacks to `script/measure/probes/index.mjs`.

```js
registerCodexMeasurement('refresh', async (agent, fixture) => {
  const rpc = await startJsonRpc(agent.command, ['app-server'], fixture)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'HarnessDeskMeasure', title: 'HarnessDesk measure', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] } })
    rpc.notify('initialized')
    await rpc.request('skills/list', { cwds: [fixture.repo], forceReload: true })
    const thread = await rpc.request('thread/start', { cwd: fixture.repo, ephemeral: true })
    const ask = async (text) => {
      await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text, text_elements: [] }] })
      const chunks = []
      for (;;) {
        const event = await rpc.waitNotification((message) => message.method === 'item/agentMessage/delta' || message.method === 'turn/completed')
        if (event.method === 'turn/completed') break
        chunks.push(event.params.delta)
      }
      return chunks.join('')
    }
    const before = await ask('Say whether measure-refresh is loaded; it has not been created yet.')
  const skillRoot = join(fixture.repo, '.codex/skills/measure-refresh')
    await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\\nname: measure-refresh\\ndescription: REFRESH_SKILL_SENTINEL\\n---\\n')
    const toggle = await rpc.request('skills/config/write', { name: 'measure-refresh', enabled: false })
    const after = await ask('A new measure-refresh bundle was added. Say whether this open session sees REFRESH_SKILL_SENTINEL.')
    const listed = await rpc.request('skills/list', { cwds: [fixture.repo], forceReload: true })
    const sessionVisible = after.includes('REFRESH_SKILL_SENTINEL')
    const listedVisible = JSON.stringify(listed).includes('measure-refresh')
    const value = sessionVisible ? 'live' : listedVisible ? 'restart' : 'none'
    const togglePersisted = toggle.effectiveEnabled === false && JSON.stringify(listed).includes('"enabled":false')
    const allowedRawTokens = ['measure-refresh', 'REFRESH_SKILL_SENTINEL']
    return { question: 'Does this open session see the added skill, and does the enable toggle persist?', facts: { refresh: { catalogueRefresh: value, openSessionSeesChange: sessionVisible, skillToggle: togglePersisted } }, rawAnswer: normalizeFixtureTokens(`${before}\\n${after}\\n${JSON.stringify(listed)}`, allowedRawTokens), allowedRawTokens }
  } finally { rpc.close() }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'refresh', async (agent, fixture) => {
  const questions = ['Say whether measure-refresh is loaded; it has not been created yet.', 'A new measure-refresh bundle was added. Say whether this same open session sees REFRESH_SKILL_SENTINEL.']
  const answer = await acpAskSequence(agent, fixture, questions, fixture.repo, async () => {
    const candidate = fixture.skillFixtures?.find((row) => row.scope === 'project')
    if (!candidate) throw new Error('no project skill root was populated')
    const base = candidate.path.startsWith('~/') ? join(fixture.home, candidate.path.slice(2)) : join(fixture.repo, candidate.path)
    const skillRoot = join(base, 'measure-refresh')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '---\\nname: measure-refresh\\ndescription: REFRESH_SKILL_SENTINEL\\n---\\n')
  })
  const before = answer.rounds[0].text
  const after = answer.rounds[1].text
  const seen = after.includes('REFRESH_SKILL_SENTINEL')
  const allowedRawTokens = ['measure-refresh', 'REFRESH_SKILL_SENTINEL']
  return { question: questions.join(' '), facts: { refresh: { catalogueRefresh: seen ? 'live' : 'none', openSessionSeesChange: seen, skillToggle: false } }, rawAnswer: normalizeFixtureTokens(`${before}\\n${after}`, allowedRawTokens), allowedRawTokens }
})
```
- [ ] **Step 4: Run the refresh parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** the refresh parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes/codex.mjs script/measure/probes/acp.mjs
git commit -m "measure: parse catalogue refresh behavior"
```

### Task 8: Measurement 7 — MCP configuration recognition and status

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Modify: `script/measure/probes/codex.mjs`
- Modify: `script/measure/probes/acp.mjs`

**Interfaces:**
- Consumes: Task 1 MCP config fixtures and each agent's isolated config paths from `KnownAgent.home.config`.
- Produces: parsed `facts.mcp` with recognized config path, configured server name, and observed status (`connected`, `configured`, `error`, or `unknown`).

- [ ] **Step 1: Add the MCP parser test and implementation.**

```js
test('MCP parser requires the fixture path, server name, and explicit status', () => {
  assert.deepEqual(parseMcp('~/.codex/config.toml measure_fixture configured connected', 'measure_fixture', '~/.codex/config.toml'), { path: '~/.codex/config.toml', server: 'measure_fixture', status: 'connected' })
  assert.equal(parseMcp('a server is configured', 'measure_fixture', '~/.codex/config.toml'), null)
})
export function parseMcp(answer, fixtureServer, configPath) {
  if (!answer.includes(fixtureServer)) return null
  const status = ['connected', 'configured', 'error'].find((value) => new RegExp(`\\b${value}\\b`, 'i').test(answer))
  return status ? { path: configPath, server: fixtureServer, status } : null
}
```
- [ ] **Step 2: Run the failing MCP parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent MCP parser.
- [ ] **Step 3: Add the MCP recognition/status question to the composite probe.** Write a dummy config only under the temporary home/repo using the discovered format and fixture-local peer path; call `parseMcp(answer, 'measure_fixture', canonicalConfigPath)` so `facts.mcp.path` records the canonical user/project config path alongside server and status. Then ask its own CLI/ACP bridge what is configured and whether it connected. Use the scripted stdio peer only; bind no ports or contact vendor endpoints. Task 9 runs all eight questions once.

Append to `script/measure/probes/index.mjs`:

```js
const question = 'Report whether MCP server measure_fixture from the temporary user or project config is recognized and its status. Repeat only the tokens measure_fixture, configured, connected, or error.'
registerCodexMeasurement('mcp', async (agent, fixture) => {
  const answer = await codexSkillsList(agent, fixture, question)
  const matched = parseMcp(answer.rawText, 'measure_fixture', '~/.codex/config.toml')
  const allowedRawTokens = ['measure_fixture', '~/.codex/config.toml', 'configured', 'connected', 'error']
  return { question, facts: { mcp: matched }, rawAnswer: normalizeFixtureTokens(answer.rawText, allowedRawTokens), allowedRawTokens }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'mcp', async (agent, fixture) => {
  const answer = await acpAsk(agent, fixture, question)
  const matched = parseMcp(answer.text, 'measure_fixture', '~/.codex/config.toml')
  const allowedRawTokens = ['measure_fixture', '~/.codex/config.toml', 'configured', 'connected', 'error']
  return { question, facts: { mcp: matched }, rawAnswer: normalizeFixtureTokens(answer.text, allowedRawTokens), allowedRawTokens }
})
```
- [ ] **Step 4: Run the MCP parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** the MCP parser and tests.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes/codex.mjs script/measure/probes/acp.mjs
git commit -m "measure: parse MCP recognition"
```

### Task 9: Measurement 8 — signed-out catalogue availability

**Files:**
- Modify: `script/measure/library.mjs`
- Modify: `script/measure/library.test.mjs`
- Modify: `script/measure/probes/codex.mjs`
- Modify: `script/measure/probes/acp.mjs`
- Create: `docs/verification/library-measurements/<agent>-<version>.json` for each asked build
- Modify: `docs/verification/library-measurements/README.md`

**Interfaces:**
- Consumes: Task 3's fixture skill and isolated empty-auth home.
- Produces: parsed `facts.signedOutCatalogue` with `available`, `empty`, or `unknown` and the answer/error establishing it.

- [ ] **Step 1: Add the signed-out parser test and implementation.**

```js
test('signed-out errors do not become empty catalogues', () => {
  assert.equal(parseSignedOut({ error: 'Sign in to continue', skills: [] }), 'unknown')
  assert.equal(parseSignedOut({ skills: [] }), 'empty')
  assert.equal(parseSignedOut({ skills: [{ name: 'measure-sentinel' }] }), 'available')
})
export function parseSignedOut(response) {
  if (response?.error || response?.signedOut === true) return 'unknown'
  if (!Array.isArray(response?.skills)) return 'unknown'
  return response.skills.length ? 'available' : 'empty'
}
```
- [ ] **Step 2: Run the failing signed-out parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: FAIL on the absent signed-out parser.
- [ ] **Step 3: Register the signed-out catalogue question for both protocols, then run the completed harness once.** Use the fixture home with no credential files or inherited secret variables. A sign-in requirement is `unknown`; never copy or symlink credentials.

Append to `script/measure/probes/index.mjs`:

```js
const signedOutQuestion = 'With this temporary account state, can you list measure-sentinel? If sign-in is required, say SIGN_IN_REQUIRED; if the catalogue is empty say CATALOGUE_EMPTY.'
const signedOutObservation = (answer) => ({
  error: /SIGN_IN_REQUIRED|sign in|authenticate|not signed in/i.test(answer) ? 'sign-in-required' : undefined,
  skills: answer.includes('measure-sentinel') ? [{ name: 'measure-sentinel' }] : /CATALOGUE_EMPTY|no skills/i.test(answer) ? [] : undefined,
})
registerCodexMeasurement('signedOutCatalogue', async (agent, fixture) => {
  const answer = await codexSkillsList(agent, fixture, signedOutQuestion)
  if (/SIGN_IN_REQUIRED|sign in|authenticate|not signed in/i.test(answer.rawText)) return { status: 'could-not-ask', reason: 'needs sign-in, not measured', interface: 'codex app-server', question: signedOutQuestion, rawAnswer: '' }
  const fact = parseSignedOut(signedOutObservation(answer.rawText))
  const allowedRawTokens = ['measure-sentinel', 'SIGN_IN_REQUIRED', 'CATALOGUE_EMPTY']
  return { question: signedOutQuestion, facts: { signedOutCatalogue: fact }, rawAnswer: normalizeFixtureTokens(answer.rawText, allowedRawTokens), allowedRawTokens }
})
for (const agentId of ACP_AGENT_IDS) registerAcpMeasurement(agentId, 'signedOutCatalogue', async (agent, fixture) => {
  const answer = await acpAsk(agent, fixture, signedOutQuestion)
  if (/SIGN_IN_REQUIRED|sign in|authenticate|not signed in/i.test(answer.text)) return { status: 'could-not-ask', reason: 'needs sign-in, not measured', interface: 'ACP session', question: signedOutQuestion, rawAnswer: '' }
  const fact = parseSignedOut(signedOutObservation(answer.text))
  const allowedRawTokens = ['measure-sentinel', 'SIGN_IN_REQUIRED', 'CATALOGUE_EMPTY']
  return { question: signedOutQuestion, facts: { signedOutCatalogue: fact }, rawAnswer: normalizeFixtureTokens(answer.text, allowedRawTokens), allowedRawTokens }
})
```

```sh
pnpm build:node
node script/measure/library.mjs --all
```

`--all` runs all eight questions per installed build and writes one combined JSON per agent/version; it writes explicit `could-not-ask` results for absent, refused, or unsafe builds. This is the only live measurement run; Task 10 then consumes these result files.
- [ ] **Step 4: Run the signed-out parser test.**

```sh
node --test script/measure/library.test.mjs
```

Expected: PASS.
- [ ] **Step 5: Commit** all generated result JSON and the completed harness.

```sh
git add script/measure/library.mjs script/measure/library.test.mjs script/measure/probes docs/verification/library-measurements/*.json
git commit -m "measure: record library phase 0 results"
```

### Task 10: Versioned evidence on location rows and four runtime capabilities

**Files:**
- Modify: `packages/agent-inventory/src/locations.ts`
- Modify: `packages/agent-inventory/test/inventory.test.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/protocol/test/validate.test.ts`
- Modify: `packages/adapter-codex/src/runtime.ts`
- Modify: `packages/adapter-codex/test/verbs.test.ts`
- Modify: `packages/adapter-acp/test/acp.test.ts`
- Modify: `packages/adapter-acp/src/runtime.ts`
- Modify: `packages/ui/src/state/context.tsx`
- Modify: `packages/server/test/fixtures/fake-runtime.ts`
- Modify: `packages/ui/src/preview/harness.tsx`

**Interfaces:**
- Consumes: result files under `docs/verification/library-measurements/` and Tasks 2–9's evidence.
- Produces: asked evidence links `{ basis: 'asked'; version: string; measured: string; resultFile: string; fact: string }`; build/table evidence retains optional version/date. `LocationSpec`, `McpFileSpec`, and `RuleFileSpec` require evidence. `BrandLocations.rules` records rule file candidates with path, scope, scanned, and evidence. `RuntimeCapabilities` gains `reportsCatalogue`, `reportsRejections`, `skillToggle`, and `catalogueRefresh`.

- [ ] **Step 1: Add the failing tests below.** Append the inventory assertion to the existing `packages/agent-inventory/test/inventory.test.ts`, which already uses `node:test` and imports location helpers. Append the default test to `packages/protocol/test/validate.test.ts`. Add the adapter assertions to the existing Codex `verbs.test.ts` and ACP `acp.test.ts` tests.

```ts
// packages/agent-inventory/test/inventory.test.ts: add this import and test.
import { extraSkillRoots, insideReadOnlyRoot, insideRoots, isInsideRoot, LOCATIONS } from '../src/locations.js'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('every skill, MCP, and rules location has source-linked evidence', async () => {
  for (const locations of Object.values(LOCATIONS)) {
    for (const row of [...locations.skills, ...locations.mcp, ...locations.rules]) {
      assert.ok(row.evidence, `${row.path} has no evidence`)
      assert.ok(['asked', 'build', 'table'].includes(row.evidence.basis))
      if (row.evidence.basis === 'asked') {
        assert.match(row.evidence.version ?? '', /\S/)
        assert.match(row.evidence.measured ?? '', /^\d{4}-\d{2}-\d{2}$/)
        assert.match(row.evidence.resultFile, /^docs\/verification\/library-measurements\/[a-z0-9-]+\.json$/)
        // Compiled tests live at packages/<pkg>/dist/test: four parents reach the repository root.
        const result = JSON.parse(await readFile(resolve(import.meta.dirname, '../../../../', row.evidence.resultFile), 'utf8'))
        assert.equal(result.agent, row.evidence.agent)
        assert.equal(result.status, 'asked')
        assert.equal(result.version, row.evidence.version)
        assert.equal(result.measured, row.evidence.measured)
        const value = row.evidence.fact.split('.').reduce((current, key) => current?.[key], result)
        assert.notEqual(value, undefined, `${row.path} fact exists in cited result`)
        const pathPattern = row.path.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^" ]+')
        assert.match(JSON.stringify(value), new RegExp(pathPattern), `${row.path} appears in cited fact`)
      }
    }
  }
  for (const row of extraSkillRoots) {
    assert.ok(row.evidence)
    assert.notEqual(row.scanned, true, `${row.path} cannot claim scanned without an agent result`)
  }
})

// packages/protocol/test/validate.test.ts: replace its current import block
// with this block, adding NO_CAPABILITIES to the existing names.
import {
  NO_CAPABILITIES,
  ValidationError,
  arrayOf,
  isKnownMethod,
  isString,
  knownMethods,
  literalUnion,
  optional,
  parseClientMessage,
  shape,
  tryParse,
} from '../src/index.js'
test('unmeasured library capabilities default to false and no refresh', () => {
  assert.deepEqual(
    {
      reportsCatalogue: NO_CAPABILITIES.reportsCatalogue,
      reportsRejections: NO_CAPABILITIES.reportsRejections,
      skillToggle: NO_CAPABILITIES.skillToggle,
      catalogueRefresh: NO_CAPABILITIES.catalogueRefresh,
    },
    { reportsCatalogue: false, reportsRejections: false, skillToggle: false, catalogueRefresh: 'none' },
  )
})

// packages/adapter-codex/test/verbs.test.ts: append after the started-runtime test.
// Add `CODEX_SKILL_MEASUREMENTS` to the existing `../src/runtime.js` import.
test('Codex library claims are backed by the checked-in versioned result', async (t) => {
  const { readFile } = await import('node:fs/promises')
  for (const [version, measurement] of CODEX_SKILL_MEASUREMENTS) {
    // Compiled tests live at packages/adapter-codex/dist/test: four parents reach the repository root.
    const evidence = JSON.parse(await readFile(new URL(`../../../../${measurement.result}`, import.meta.url), 'utf8'))
    assert.equal(evidence.agent, 'Codex')
    assert.equal(evidence.version, version)
    assert.equal(evidence.status, 'asked')
    assert.deepEqual(
      { reportsCatalogue: evidence.facts.reportsCatalogue, reportsRejections: evidence.facts.reportsRejections, skillToggle: evidence.facts.skillToggle, catalogueRefresh: evidence.facts.catalogueRefresh },
      { reportsCatalogue: measurement.reportsCatalogue, reportsRejections: measurement.reportsRejections, skillToggle: measurement.skillToggle, catalogueRefresh: measurement.catalogueRefresh },
    )
  }
  const { runtime } = await start(t)
  const measurement = runtime.info.version ? CODEX_SKILL_MEASUREMENTS.get(runtime.info.version) : undefined
  assert.deepEqual(
    (({ reportsCatalogue, reportsRejections, skillToggle, catalogueRefresh }) => ({ reportsCatalogue, reportsRejections, skillToggle, catalogueRefresh }))(runtime.info.capabilities),
    measurement
      ? { reportsCatalogue: measurement.reportsCatalogue, reportsRejections: measurement.reportsRejections, skillToggle: measurement.skillToggle, catalogueRefresh: measurement.catalogueRefresh }
      : { reportsCatalogue: false, reportsRejections: false, skillToggle: false, catalogueRefresh: 'none' },
  )
})

// packages/adapter-acp/test/acp.test.ts: make() is the existing fake ACP runtime factory.
// Add ACP_SKILL_MEASUREMENTS to the ../src/runtime.js import and verify each
// map entry against its own result file, like the Codex loop above.
test('an ACP runtime keeps unmeasured library facts at the no-capabilities defaults', async () => {
  const runtime = make()
  await runtime.start()
  try {
    assert.deepEqual(
      (({ reportsCatalogue, reportsRejections, skillToggle, catalogueRefresh }) => ({ reportsCatalogue, reportsRejections, skillToggle, catalogueRefresh }))(runtime.info.capabilities),
      { reportsCatalogue: false, reportsRejections: false, skillToggle: false, catalogueRefresh: 'none' },
    )
  } finally {
    await runtime.dispose()
  }
})

test('ACP positive library facts require the matching asked result', async () => {
  const { readFile } = await import('node:fs/promises')
  for (const [key, measurement] of ACP_SKILL_MEASUREMENTS) {
    // Compiled tests live at packages/adapter-acp/dist/test: four parents reach the repository root.
    const evidence = JSON.parse(await readFile(new URL(`../../../../${measurement.result}`, import.meta.url), 'utf8'))
    assert.equal(evidence.status, 'asked')
    assert.equal(`${evidence.agentId}@${evidence.version}`, key)
    assert.deepEqual(measurement.facts, {
      reportsCatalogue: evidence.facts.reportsCatalogue,
      reportsRejections: evidence.facts.reportsRejections,
      skillToggle: evidence.facts.skillToggle,
      catalogueRefresh: evidence.facts.catalogueRefresh,
    })
  }
})
```

- [ ] **Step 2: Run the focused suites before implementation.**

```sh
pnpm build:node
node --test packages/agent-inventory/dist/test/inventory.test.js packages/protocol/dist/test/validate.test.js packages/adapter-codex/dist/test/verbs.test.js packages/adapter-acp/dist/test/acp.test.js
```

Expected: FAIL because the evidence properties and the four capability facts do not exist yet. Use the exact existing ACP fake-runtime factory name in `acp.test.ts`; keep its setup and cleanup in that file's established pattern.

- [ ] **Step 3: Add the evidence type and attach a value to every row in `packages/agent-inventory/src/locations.ts`.** Change the `BRANDED` annotation from `Record<string, BrandLocations>` to `Record<string, LocationInput>`, preserve every current row, and add rule rows using the asked result's path/scope or an unscanned table-basis candidate. Keep `LocationSpec` and `McpFileSpec` members and add this shared shape; an asked row must cite the JSON's exact agent version and measurement date, binary-string rows retain `basis: 'build'`, and unmeasured candidates use `basis: 'table'`.

```ts
export type LocationEvidence =
  | { readonly basis: 'asked'; readonly agent: string; readonly version: string; readonly measured: string; readonly resultFile: string; readonly fact: string }
  | { readonly basis: 'build' | 'table'; readonly version?: string; readonly measured?: string }

const askedEvidence = (result: { agent: string; version: string; measured: string; status: string }, resultFile: string, fact: string): LocationEvidence => {
  if (result.status !== 'asked') throw new Error('only an asked result can support a location row')
  return { basis: 'asked', agent: result.agent, version: result.version, measured: result.measured, resultFile, fact }
}

export interface LocationSpec {
  readonly path: string
  readonly scope: 'user' | 'project'
  readonly scanned: boolean
  readonly readOnly?: boolean
  readonly evidence: LocationEvidence
}

export interface McpFileSpec {
  readonly path: string
  readonly scope: 'user' | 'project'
  readonly key: string
  readonly format: 'json' | 'toml'
  readonly scanned: boolean
  readonly evidence: LocationEvidence
}

export interface RuleFileSpec {
  readonly path: string
  readonly scope: 'user' | 'project'
  readonly scanned: boolean
  readonly evidence: LocationEvidence
}

export interface BrandLocations {
  readonly skills: readonly LocationSpec[]
  readonly mcp: readonly McpFileSpec[]
  readonly rules: readonly RuleFileSpec[]
}

type LocationInput = {
  skills: readonly (Omit<LocationSpec, 'evidence'> & { readonly evidence?: LocationEvidence })[]
  mcp: readonly (Omit<McpFileSpec, 'evidence'> & { readonly evidence?: LocationEvidence })[]
  rules?: readonly (Omit<RuleFileSpec, 'evidence'> & { readonly evidence?: LocationEvidence })[]
}

// Rule candidates are separate from skill and MCP rows. Begin each candidate
// as unscanned/table evidence; Task 10 replaces only paths reported by Task 9.
const RULE_CANDIDATES: readonly RuleFileSpec[] = [
  { path: '~/AGENTS.md', scope: 'user', scanned: false, evidence: { basis: 'table' } },
  { path: '~/CLAUDE.md', scope: 'user', scanned: false, evidence: { basis: 'table' } },
  { path: '~/GEMINI.md', scope: 'user', scanned: false, evidence: { basis: 'table' } },
  { path: '~/.cursor/rules/*.mdc', scope: 'user', scanned: false, evidence: { basis: 'table' } },
  { path: 'AGENTS.md', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: 'CLAUDE.md', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: 'GEMINI.md', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: '.cursor/rules/*.mdc', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: 'nested/AGENTS.md', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: 'nested/CLAUDE.md', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: 'nested/GEMINI.md', scope: 'project', scanned: false, evidence: { basis: 'table' } },
  { path: 'nested/.cursor/rules/*.mdc', scope: 'project', scanned: false, evidence: { basis: 'table' } },
]

// Change the current BRANDED annotation to `Readonly<Record<string, LocationInput>>`
// and preserve its existing literal rows, adding `rules` arrays from asked
// results and unscanned table candidates.

const withEvidence = <T extends { readonly scanned: boolean; readonly evidence?: LocationEvidence }>(row: T): T & { readonly evidence: LocationEvidence } => ({
  ...row,
  evidence: row.evidence ?? { basis: 'build', measured: '2026-08-28' },
})
const withBrandEvidence = (locations: LocationInput): BrandLocations => ({
  skills: locations.skills.map(withEvidence),
  mcp: locations.mcp.map(withEvidence),
  rules: (locations.rules ?? RULE_CANDIDATES).map(withEvidence),
})

const NORMALIZED_BRANDED = Object.fromEntries(
  Object.entries(BRANDED).map(([brand, locations]) => [brand, withBrandEvidence(locations)]),
)
export const LOCATIONS: Readonly<Record<string, BrandLocations>> = {
  ...NORMALIZED_BRANDED,
  ...(NORMALIZED_BRANDED.deepseek ? { deepseekharness: NORMALIZED_BRANDED.deepseek } : {}),
  ...(NORMALIZED_BRANDED.cursor ? { cursoragent: NORMALIZED_BRANDED.cursor } : {}),
  ...(NORMALIZED_BRANDED.claudecode ? { claude: NORMALIZED_BRANDED.claudecode } : {}),
  ...(NORMALIZED_BRANDED.codex ? { openaicodex: NORMALIZED_BRANDED.codex } : {}),
  ...(NORMALIZED_BRANDED.geminicli ? { gemini: NORMALIZED_BRANDED.geminicli } : {}),
}

export const extraSkillRoots: readonly LocationSpec[] = [
  withEvidence({ path: '~/.agents/skills', scope: 'user', scanned: false, evidence: { basis: 'table' } }),
  withEvidence({ path: '.agents/skills', scope: 'project', scanned: false, evidence: { basis: 'table' } }),
]
```

- [ ] **Step 4: Add the four fields to `RuntimeCapabilities` and `NO_CAPABILITIES`.** Both adapters start from false/`'none'`; Codex and ACP may override a value only when an exact-version checked-in result file has `status: 'asked'`, and their tests read that same file to compare every claimed fact before enabling it. If there is no matching asked result, the adapter reports the defaults. Never infer facts from `brand`, commands, or build strings.

```ts
// packages/protocol/src/runtime.ts: append to RuntimeCapabilities.
readonly reportsCatalogue: boolean
readonly reportsRejections: boolean
readonly skillToggle: boolean
readonly catalogueRefresh: 'live' | 'restart' | 'none'

// packages/protocol/src/runtime.ts: add to NO_CAPABILITIES.
reportsCatalogue: false,
reportsRejections: false,
skillToggle: false,
catalogueRefresh: 'none',

// packages/ui/src/state/context.tsx: import the value and replace the current
// exhaustive fallback capability literal. RuntimeCapabilities now requires
// all fields, and the fallback must stay in sync with the protocol default.
import { NO_CAPABILITIES } from '@harnessdesk/protocol'
const FALLBACK_RUNTIME: RuntimeInfo = {
  id: '' as RuntimeInfo['id'], name: 'No runtime',
  capabilities: { ...NO_CAPABILITIES },
  presentation: { name: 'No runtime' },
}

// packages/server/test/fixtures/fake-runtime.ts: add NO_CAPABILITIES to the
// existing @harnessdesk/protocol value import and spread before explicit fake
// values so all newly-added facts default false/'none'.
capabilities: {
  ...NO_CAPABILITIES,
  sessionEnvironment: true, resume: true, fork: true, steer: true,
  interrupt: true, listHistory: true, searchHistory: true, imageInput: false,
  mcp: false, skills: false, plans: true, reasoning: true, metered: false,
  account: false, goals: false, undo: false, compaction: false, memory: false,
  review: true, extensionStore: false, hooks: false, pluginTools: false,
  instructions: false, backgroundTasks: true, archiveHistory: true,
  nameHistory: true, deleteHistory: true,
},

// packages/ui/src/preview/harness.tsx: add NO_CAPABILITIES to its protocol
// import and use this complete default instead of the current `{}` cast.
export const runtime = (id: string, name: string): RuntimeInfo =>
  ({ id: runtimeId(id), name, capabilities: { ...NO_CAPABILITIES }, presentation: { name } }) as unknown as RuntimeInfo

// packages/adapter-codex/src/runtime.ts: select facts by the exact version
// whose asked result is checked in. Start from false for every other build.
export const CODEX_SKILL_MEASUREMENTS: ReadonlyMap<string, {
  readonly result: string
  readonly reportsCatalogue: boolean
  readonly reportsRejections: boolean
  readonly skillToggle: boolean
  readonly catalogueRefresh: 'live' | 'restart' | 'none'
}> = new Map<string, {
  readonly result: string
  readonly reportsCatalogue: boolean
  readonly reportsRejections: boolean
  readonly skillToggle: boolean
  readonly catalogueRefresh: 'live' | 'restart' | 'none'
}>([])

// For each Codex result whose status is 'asked', add one literal row keyed by
// result.version, with result set to its exact JSON path and the four values
// copied from result.facts. Leave the map empty for a missing or refused ask.

const codexCapabilitiesFor = (version: string | null) => {
  const measured = version ? CODEX_SKILL_MEASUREMENTS.get(version) : undefined
  const evidence = measured?.result === `docs/verification/library-measurements/codex-${version}.json` ? measured : undefined
  return {
    ...CAPABILITIES,
    reportsCatalogue: evidence?.reportsCatalogue ?? false,
    reportsRejections: evidence?.reportsRejections ?? false,
    skillToggle: evidence?.skillToggle ?? false,
    catalogueRefresh: evidence?.catalogueRefresh ?? 'none',
  }
}

// RuntimeInfo.info replaces both existing positive branches with:
capabilities: !this.#everStarted
  ? NO_CAPABILITIES
  : this.#sharesHistory
    ? { ...codexCapabilitiesFor(this.#version), listHistory: false, searchHistory: false }
    : codexCapabilitiesFor(this.#version),

// packages/adapter-acp/src/runtime.ts: default to NO_CAPABILITIES and override
// only when an asked result is checked in for this exact ACP id and CLI version.
export const ACP_SKILL_MEASUREMENTS: ReadonlyMap<string, {
  readonly result: string
  readonly facts: {
    readonly reportsCatalogue: boolean
    readonly reportsRejections: boolean
    readonly skillToggle: boolean
    readonly catalogueRefresh: 'live' | 'restart' | 'none'
  }
}> = new Map([])

const acpLibraryCapabilitiesFor = (id: string, version: string | null) => {
  const measured = version ? ACP_SKILL_MEASUREMENTS.get(`${id}@${version}`) : undefined
  const evidencePathMatchesVersion = measured?.result.endsWith(`-${version}.json`) ?? false
  return evidencePathMatchesVersion ? measured.facts : {
    reportsCatalogue: false,
    reportsRejections: false,
    skillToggle: false,
    catalogueRefresh: 'none' as const,
  }
}

// Inside #capabilities(), after `const shaken = ...`, spread this only after
// handshake so unstarted ACP runtimes retain all NO_CAPABILITIES defaults:
...(shaken ? acpLibraryCapabilitiesFor(this.#config.id, this.#executable?.version ?? null) : {}),
```

- [ ] **Step 5: Run the focused suites after implementation.**

```sh
pnpm build:node
node --test packages/agent-inventory/dist/test/inventory.test.js packages/protocol/dist/test/validate.test.js packages/adapter-codex/dist/test/verbs.test.js packages/adapter-acp/dist/test/acp.test.js
```

Expected: PASS. The tests read each map's `result` path and check all four facts against the JSON; a missing, unasked, wrong-version, or changed result makes the claim fail. ACP remains false/`'none'` unless a matching asked result exists. `RuntimeCapabilities`' sole additional full literals are `FALLBACK_RUNTIME`, `FakeRuntime.info`, and the preview runtime; the code above updates all three.
- [ ] **Step 6: Commit** the location, protocol, adapter and regression-test changes.

```sh
git add packages/agent-inventory/src/locations.ts packages/agent-inventory/test/inventory.test.ts packages/protocol/src/runtime.ts packages/protocol/test/validate.test.ts packages/adapter-codex/src/runtime.ts packages/adapter-codex/test/verbs.test.ts packages/adapter-acp/src/runtime.ts packages/adapter-acp/test/acp.test.ts packages/ui/src/state/context.tsx packages/server/test/fixtures/fake-runtime.ts packages/ui/src/preview/harness.tsx
git commit -m "feat: record measured library capabilities"
```

### Task 11: Resulting tier table, runbook and final phase-0 check

**Files:**
- Modify: `docs/verification/library-measurements/README.md`
- Modify: `script/measure/README.md`
- Modify: `docs/verification/library-measurements/<agent>-<version>.json` for each measured build
- Test: `script/measure/library.test.mjs`

**Interfaces:**
- Consumes: all eight measurement result groups, the evidence schema, and final adapter capability values.
- Produces: a reproducible manual runbook and tier table whose every cell links its result file/version or says `could-not-ask`.

- [ ] **Step 1: Add a failing documentation consistency test** that checks every asked result has agent, version, date, question, raw answer and parsed facts; every table cell with a measured claim links to a matching file; and every referenced file exists.

```js
import { readdir, readFile } from 'node:fs/promises'
const resultDir = new URL('../../docs/verification/library-measurements/', import.meta.url)
const README = new URL('../../docs/verification/library-measurements/README.md', import.meta.url)
const MEASUREMENT_CELLS = [
  ['rulesFiles', 'rules read and load order'],
  ['catalogue', 'skill bundle to catalogue reach'],
  ['precedence', 'same-name user/project precedence'],
  ['rejections', 'manifest limits and rejection reasons'],
  ['skillRoots', 'tier C user/project skill roots'],
  ['refresh', 'catalogue refresh and open-session visibility'],
  ['mcp', 'MCP config recognition and status'],
  ['signedOutCatalogue', 'signed-out catalogue availability'],
]
test('every tier-table measurement cell links its exact asked result', async () => {
  const table = await readFile(README, 'utf8')
  for (const [fact, cell] of MEASUREMENT_CELLS) assert.match(table, new RegExp(`${fact}.*${cell}|${cell}.*${fact}`, 'i'))
  for (const name of await readdir(resultDir)) {
    if (!name.endsWith('.json')) continue
    const result = JSON.parse(await readFile(new URL(name, resultDir), 'utf8'))
    assert.ok(result.agent && result.version && result.measured && result.question && result.interface && result.rawAnswer !== undefined && result.facts)
    if (result.status === 'asked') assert.match(table, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    else assert.match(table, new RegExp(`could-not-ask[^\\n]*${result.agent}|${result.agent}[^\\n]*could-not-ask`, 'i'))
  }
})
```
- [ ] **Step 2: Run** `node --test script/measure/library.test.mjs`. Expected: FAIL until the results and tier table are complete.
- [ ] **Step 3: Write the runbook** with the command `pnpm build:node && node script/measure/library.mjs --all`, the exact isolation guard behavior, fixture matrix, per-agent interface selection, help/version discovery procedure, fixture-only answer normalization, sign-in handling, cleanup behavior, and the rule that this harness never runs in CI. Include columns for rules, skill roots, catalogue, duplicate precedence, manifest limits/rejections, refresh, MCP, and signed-out listing. List all sixteen supported agents by name; absent/unaskable builds remain visible with reason. Each table cell names the fact key and links the exact `<agent>-<version>.json` result or records `could-not-ask`.

The explicit measurement-to-JSON-fact-to-README-cell mapping is: `facts.rulesFiles` → rules read and load order; `facts.catalogue` plus `facts.reportsCatalogue` → bundle reach and catalogue reporting; `facts.precedence` → duplicate-name precedence; `facts.rejections` plus `facts.reportsRejections` → manifest acceptance/reason and rejection reporting; `facts.skillRoots` → tier C root paths; `facts.refresh.catalogueRefresh`, `facts.refresh.skillToggle`, and `facts.refresh.openSessionSeesChange` → reload mode, toggle persistence, and open-session visibility; `facts.mcp` → config recognition and connection status; `facts.signedOutCatalogue` → available/empty/unknown while signed out. Each README cell links the corresponding result JSON.
- [ ] **Step 4: Run final checks.** Run `node --test script/measure/library.test.mjs`, then `pnpm build:node && node --test packages/agent-inventory/dist/test/inventory.test.js packages/adapter-codex/dist/test/*.test.js packages/adapter-acp/dist/test/*.test.js packages/protocol/dist/test/*.test.js`. Expected: PASS for the focused checks; manual live measurements are reported only for results actually produced.
- [ ] **Step 5: Commit** the README, consistency test, and final versioned results.

```sh
git add docs/verification/library-measurements/README.md script/measure/README.md script/measure/library.test.mjs docs/verification/library-measurements/*.json
git commit -m "docs: record library phase 0 measurements"
```

## Self-Review

- Spec coverage: all eight measurements are Tasks 2–9; fixture, isolation, evidence schema, capability defaults, adapter evidence, result storage and resulting tier table are Tasks 1, 10 and 11.
- Placeholder scan: no TBD, TODO, “implement later,” or unassigned test steps; every unaskable case has a concrete recorded status and reason.
- Type consistency: Task 1 defines `MeasurementResult`, `status`, and the harness exports; Tasks 2–9 add named `facts` fields; Task 10 defines the evidence and capability types consumed by Task 11.
- Safety and execution: fixture paths stay under a guarded temporary root, vendor credentials are excluded, tests use fakes, and the only network or real-agent behavior is the explicitly manual measurement invocation.
