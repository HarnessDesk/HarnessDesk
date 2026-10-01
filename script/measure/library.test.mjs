import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
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
} from './library.mjs'

const under = (root, path) => path.startsWith(`${root}/`) || path === root

test('fixture contains user/project skills, invalid and oversized skills, rule sentinels, and MCP configs', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-test-')
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
  const root = await mkdtemp('/tmp/hd-measure-guard-')
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
  const profile = sandboxProfileText('/Users/dev')
  for (const path of ['.harnessdesk', '.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.agents', '.copilot', '.config', '.ssh', '.aws', '.netrc', '.npmrc', '.npm', '.docker', '.gnupg', '.pki', '.git-credentials', 'Library/Keychains', 'Library/Application Support']) {
    assert.ok(profile.includes(`(subpath "/Users/dev/${path}")`), `${path} is denied`)
  }
  assert.ok(profile.includes('(subpath "/Library/Keychains")'))
  assert.ok(profile.includes('(subpath "/System/Library/Keychains")'))
  assert.match(profile, /com\.apple\.securityd/)
  assert.match(profile, /com\.apple\.SecurityServer/)
})

test('sandbox preflight proves file denials and refuses unless keychain access fails', async (t) => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return t.skip('macOS sandbox-exec unavailable')
  const root = await mkdtemp('/tmp/hd-measure-sandbox-')
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
  const unsafe = 'Signed in as Jane Doe {"access_token":"eyJhbGciOiJIUzI1NiJ9","refresh_token":"r1"} /Users/dev/.claude/config.json' // hd-secrets-ok: a deliberate lookalike the redactor must reject
  assert.equal(redact(unsafe, ['HOME_AGENTS_SENTINEL', 'measure-sentinel'], '/tmp/fixture'), '')
  assert.equal(redact('HOME_AGENTS_SENTINEL and Jane Doe', ['HOME_AGENTS_SENTINEL'], '/tmp/fixture'), '')
  const valid = { agent: 'Codex', agentId: 'codex', version: '0.149.0', measured: '2026-10-01', interface: 'skills/list', question: 'Which skill?', facts: {}, status: 'asked' }
  assert.throws(() => validateResult({ ...valid, rawAnswer: 'Jane Doe' }), /normalized fixture tokens/)
  assert.throws(() => validateResult({ ...valid, rawAnswer: 'measure-sentinel', facts: { access_token: 'secret' } }), /sensitive facts/)
})

test('a missing probe persists a redacted could-not-ask result', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-result-')
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
  const root = await mkdtemp('/tmp/hd-measure-run-')
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
  const root = await mkdtemp('/tmp/hd-measure-refusal-')
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
