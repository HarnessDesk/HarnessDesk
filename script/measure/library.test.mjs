import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
  validateResult,
  writeResult,
  registerProbe,
  run,
  prepareSandbox,
  knownAgentHomeEntries,
  deniedHomePaths,
  agentHomeIsIsolated,
  normalizeVersion,
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

test('sandbox profile blocks real agent homes, credentials, and keychain paths', () => {
  const profile = sandboxProfileText('/Users/dev')
  for (const path of ['.harnessdesk', '.claude', '.claude.json', '.codex', '.cursor', '.gemini', '.agents', '.copilot', '.cline', '.kimi', '.devin', '.config', '.ssh', '.aws', '.netrc', '.npmrc', '.npm', '.docker', '.gnupg', '.pki', '.git-credentials', 'Library/Keychains', 'Library/Application Support']) {
    assert.ok(profile.includes(`(subpath "/Users/dev/${path}")`), `${path} is denied`)
  }
  assert.ok(profile.includes('(subpath "/Library/Keychains")'))
  assert.ok(profile.includes('(subpath "/System/Library/Keychains")'))
  assert.match(profile, /com\.apple\.securityd/)
  assert.match(profile, /com\.apple\.SecurityServer/)
  assert.doesNotMatch(profile, /sandbox-canary-home/)
})

test('the actual run profile denies every independently listed known-agent home', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-homes-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = readFileSync(new URL('../../packages/server/src/installs/known-agents.ts', import.meta.url), 'utf8')
  const independentHomes = [...source.matchAll(/\bhome:\s*\{([\s\S]*?)^\s{4}\},/gm)]
    .map((match) => match[1].match(/^\s*path:\s*['"]([^'"]+)['"]/m)?.[1]).filter(Boolean)
  assert.deepEqual(knownAgentHomeEntries().map(({ path }) => path), independentHomes)
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const profile = makeSandboxProfile(root)
  assert.ok(profile)
  const realHome = await import('node:fs/promises').then(({ realpath }) => realpath(homedir()))
  for (const home of independentHomes) {
    const expanded = home.startsWith('~/') ? join(realHome, home.slice(2)) : home
    assert.ok(profile.includes(`(subpath ${JSON.stringify(expanded)})`), `${home} is denied in run profile`)
  }
  for (const path of deniedHomePaths(realHome)) assert.ok(profile.includes(`(subpath ${JSON.stringify(path)})`), `${path} is denied`)
})

test('sandbox preflight proves the exact run profile, fixture keychain and file denials', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const root = await mkdtemp('/tmp/hd-measure-sandbox-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const passed = await prepareSandbox(fixture)
  assert.equal(fixture.isolation.preflightPassed, passed)
  assert.equal(existsSync(join(root, 'canary.keychain-db')), false)
  assert.equal(passed, true, fixture.isolation.reason)
})

test('run refuses to launch before this fixture passes the sandbox preflight', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-run-gate-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  fixture.isolation.available = true
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(0)'], fixture), /preflight has not passed/)
})

test('result validation requires an answer only for asked results', () => {
  const valid = {
    agent: 'Codex', agentId: 'codex', version: '0.149.0', measured: '2026-10-01', interface: 'codex app-server skills/list',
    question: 'Which skill sentinel is loaded?', rawAnswer: 'measure-sentinel', facts: { catalogue: ['measure-sentinel'] }, status: 'asked',
  }
  const fixture = { ruleSentinels: {}, skills: { sentinel: '/tmp/measure-sentinel' } }
  assert.deepEqual(validateResult(valid, fixture), valid)
  assert.throws(() => validateResult({ ...valid, rawAnswer: '' }, fixture), /rawAnswer/)
  assert.throws(() => validateResult({ ...valid, rawAnswer: '', status: 'could-not-ask' }, fixture), /reason/)
  assert.throws(() => validateResult({ ...valid, status: 'could-not-ask', reason: 'needs sign-in, not measured' }, fixture), /cannot persist an answer/)
  assert.equal(validateResult({ ...valid, rawAnswer: '', status: 'could-not-ask', reason: 'needs sign-in, not measured' }, fixture).status, 'could-not-ask')
  assert.throws(() => validateResult({ ...valid, rawAnswer: '', status: 'asked' }, fixture), /rawAnswer/)
})

test('raw-answer allowlist rejects account names, structured secrets, and outside paths', () => {
  const unsafe = 'Signed in as Jane Doe {"access_token":"eyJhbGciOiJIUzI1NiJ9","refresh_token":"r1"} /Users/dev/.claude/config.json' // hd-secrets-ok: a deliberate lookalike the redactor must reject
  assert.equal(redact(unsafe, ['HOME_AGENTS_SENTINEL', 'measure-sentinel'], '/tmp/fixture'), '')
  assert.equal(redact('HOME_AGENTS_SENTINEL and Jane Doe', ['HOME_AGENTS_SENTINEL'], '/tmp/fixture'), '')
  const valid = { agent: 'Codex', agentId: 'codex', version: '0.149.0', measured: '2026-10-01', interface: 'skills/list', question: 'Which skill?', facts: {}, status: 'asked' }
  const fixture = { ruleSentinels: {}, skills: { sentinel: '/tmp/measure-sentinel' } }
  assert.throws(() => validateResult({ ...valid, rawAnswer: 'Jane Doe', facts: {} }, fixture), /fixture-derived tokens/)
  assert.throws(() => validateResult({ ...valid, rawAnswer: 'measure-sentinel', facts: { catalogue: { access_token: 'secret' } } }, fixture), /fixture-derived allowlist/)
})

test('writeResult rejects unsafe strings in every persisted field', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-write-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const valid = {
    agent: 'Codex', agentId: 'codex', version: '0.149.0', measured: '2026-10-01',
    interface: 'codex app-server skills/list', question: 'Which skill sentinel is loaded?',
    rawAnswer: 'measure-sentinel', facts: { catalogue: ['measure-sentinel'] }, status: 'asked',
  }
  for (const unsafe of [
    { agent: 'Jane Doe' },
    { agentId: 'account-owner' },
    { version: 'sk-live-abcdefgh123456' },
    { interface: 'Jane Doe' },
    { question: 'token sk-live-abcdefgh123456' },
    { facts: { catalogue: ['/Users/owner/.claude/config.json'] } }, // hd-secrets-ok: synthetic path must be rejected by the writer
    { facts: { account_name: 'none' } },
    { rawAnswer: 'SENTINEL_SUPPLIED_BY_PROBE' },
    { status: 'could-not-ask', reason: 'Jane Doe', rawAnswer: '' },
  ]) {
    await assert.rejects(writeResult({ ...valid, ...unsafe }, join(root, 'out'), fixture))
  }
  await assert.rejects(writeResult({ ...valid, unexpected: 'none' }, join(root, 'out'), fixture), /strict schema/)
})

test('build metadata is normalized before a version can reach writeResult', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-version-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const discovered = '1.2.3+sk-live-abcdefgh123456'
  const normalized = normalizeVersion(discovered)
  assert.equal(normalized, 'unknown')
  const result = {
    agent: 'Codex', agentId: 'codex', version: normalized, measured: '2026-10-01',
    interface: 'not selected', question: 'Which skill sentinel is loaded?', rawAnswer: '',
    facts: {}, status: 'could-not-ask', reason: 'could not capture an exact version',
  }
  const path = await writeResult(result, join(root, 'out'), fixture)
  const saved = await readFile(path, 'utf8')
  assert.match(saved, /"version": "unknown"/)
  assert.doesNotMatch(saved, /sk-live-abcdefgh123456/)
})

test('a missing probe persists a redacted could-not-ask result', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-result-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  if (process.platform !== 'darwin') return t.skip('macOS only')
  assert.equal(await prepareSandbox(fixture), true, fixture.isolation.reason)
  const result = await askAgent({ id: 'codex', name: 'Codex' }, fixture)
  assert.equal(result.status, 'could-not-ask')
  assert.match(result.reason, /no safe probe registered/)
  const path = await writeResult(result, join(root, 'results'), fixture)
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
  if (process.platform !== 'darwin') return t.skip('macOS only')
  assert.equal(await prepareSandbox(fixture), true, fixture.isolation.reason)
  const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], fixture)
  assert.equal(result.code, 0)
  const env = JSON.parse(result.stdout)
  assert.equal(env.HOME, fixture.home)
  assert.equal(env.CODEX_HOME, join(fixture.home, '.codex'))
  assert.equal(env.MEASURE_SENTINEL_SECRET, undefined)
})

test('unprepared fixtures refuse registered probes before launch', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-refusal-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  let launches = 0
  registerProbe('unsafe-test-agent', async () => { launches += 1; throw new Error('must not launch') })
  const unsafe = await askAgent({ id: 'unsafe-test-agent', name: 'Test Agent' }, fixture)
  assert.equal(unsafe.status, 'could-not-ask')
  assert.match(unsafe.reason, /cannot isolate/)
  assert.equal(launches, 0)
  assert.equal(agentHomeIsIsolated({ id: 'claude', home: { path: '~/.claude', env: 'CLAUDE_CONFIG_DIR' } }, fixture), false)
})

test('versioned measurement records are linked from the tier table', async () => {
  const directory = new URL('../../docs/verification/library-measurements/', import.meta.url)
  const readme = await readFile(new URL('README.md', directory), 'utf8')
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  assert.ok(names.length > 0)
  for (const name of names) {
    const result = JSON.parse(await readFile(new URL(name, directory), 'utf8'))
    assert.equal(result.status, 'could-not-ask')
    assert.ok(result.agent && result.agentId && result.version && result.measured && result.interface && result.question)
    assert.equal(result.rawAnswer, '')
    assert.ok(result.reason)
    assert.match(readme, new RegExp(`\\(${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\)`))
    assert.deepEqual(Object.keys(result.facts).sort(), ['catalogue','mcp','precedence','refresh','rejections','rulesFiles','signedOutCatalogue','skillRoots'].sort())
  }
  for (const heading of ['rules', 'catalogue', 'precedence', 'limits', 'roots', 'refresh', 'MCP', 'signed out']) {
    assert.ok(readme.toLowerCase().includes(heading.toLowerCase()), `tier table includes ${heading}`)
  }
})
