import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertIsolatedEnv,
  askAgent,
  createFixture,
  installReadRoot,
  installRootIsSafe,
  installDiscoveryState,
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
  discoveryIsolation,
  shouldAskAgent,
  KEYCHAIN_READ_ONLY,
  nodeInstallPrefix,
  nodeInstallPrefixFor,
} from './library.mjs'
import { parseAcpOutput, parseCodexOutput, parseRejectionWords, summarizeAcpMessages } from './probes/index.mjs'

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
  const profile = sandboxProfileText('/Users/dev', { readPaths: ['/opt/homebrew/Cellar/node'] })
  assert.match(profile, /\(allow default\)/)
  assert.doesNotMatch(profile, /\(deny default\)/)
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Users"))'))
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Volumes"))'))
  assert.ok(profile.includes('(deny file-write*)'))
  assert.ok(profile.includes('(allow file-write* (subpath "/tmp/fixture"))'))
  assert.ok(profile.includes('(allow file-read* (subpath "/tmp/fixture"))'))
  assert.ok(profile.includes('(allow file-write* (literal "/dev/null"))'))
  assert.ok(profile.includes('(allow file-write* (regex #"^/dev/tty"))'))
  assert.ok(profile.includes('(allow file-read* (subpath "/opt/homebrew/Cellar/node"))'))
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Users/dev/.codex"))'))
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Users/dev/.claude"))'))
  assert.ok(profile.includes('(deny file-read* file-write* (subpath "/Users/dev/Library/Keychains"))'))
  assert.match(profile, /\(deny mach-lookup \(global-name "com\.apple\.securityd"\)\)/)
  assert.match(profile, /\(deny mach-lookup \(global-name "com\.apple\.SecurityServer"\)\)/)
  assert.doesNotMatch(profile, /sandbox-canary-home/)
  const exception = sandboxProfileText('/Users/dev', { fixtureRoot: '/tmp/fixture', readPaths: ['/Users/dev/.cursor/cli/versions/1'], isolation: KEYCHAIN_READ_ONLY })
  assert.doesNotMatch(exception, /\(deny mach-lookup/)
  assert.match(exception, /\(allow file-read\* \(subpath "\/Users\/dev\/Library\/Keychains"\)\)/)
  assert.match(exception, /\(subpath "\/Users\/dev\/\.cursor\/cli\/versions\/1"\)/)
  assert.match(exception, /\(deny file-read\* file-write\* \(subpath "\/Library\/Keychains"\)\)/)
  assert.match(exception, /\(deny file-read\* file-write\* \(subpath "\/Users\/dev\/\.cursor"\)\)/)
  assert.doesNotMatch(exception, /\(allow file-read\* \(subpath "\/Users\/dev"\)\)/)
  assert.match(exception, /\(allow default\)/)
})

test('strict and keychain-read-only profiles differ only by keychain read and Mach service rules', () => {
  const realHome = '/Users/dev'
  const options = { fixtureRoot: '/tmp/fixture', readPaths: ['/opt/homebrew/Cellar/node'] }
  const strict = sandboxProfileText(realHome, options)
  const exception = sandboxProfileText(realHome, { ...options, isolation: KEYCHAIN_READ_ONLY })
  const strictLines = strict.trimEnd().split('\n')
  const exceptionLines = exception.trimEnd().split('\n')
  const keychainRead = '(allow file-read* (subpath "/Users/dev/Library/Keychains"))'
  const machDenials = [
    '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    '(deny mach-lookup (global-name "com.apple.securityd"))',
  ]
  assert.equal(strictLines.filter((line) => line === keychainRead).length, 0)
  assert.equal(exceptionLines.filter((line) => line === keychainRead).length, 1)
  const firstMachIndex = Math.min(...machDenials.map((line) => strictLines.indexOf(line)))
  assert.ok(firstMachIndex >= 0)
  for (const denial of machDenials) {
    assert.equal(strictLines.filter((line) => line === denial).length, 1)
    const index = strictLines.indexOf(denial)
    assert.ok(index >= 0)
    strictLines.splice(index, 1)
    assert.equal(exceptionLines.includes(denial), false)
  }
  strictLines.splice(firstMachIndex, 0, keychainRead)
  assert.deepEqual(exceptionLines, strictLines)
  assert.ok(strict.includes('(deny file-read* file-write* (subpath "/Users/dev/Library/Keychains"))'))
  assert.ok(exception.includes('(deny file-read* file-write* (subpath "/Users/dev/Library/Keychains"))'))
})

test('install runtime allowance resolves to narrow version and dependency-tree directories', () => {
  assert.equal(installReadRoot('/Users/dev/.claude/local/versions/1.2.3/bin/claude'), '/Users/dev/.claude/local/versions/1.2.3')
  assert.equal(installReadRoot('/Users/dev/.npm/node_modules/@vendor/agent/bin/agent'), '/Users/dev/.npm/node_modules')
  assert.equal(installReadRoot('/Users/dev/.npm/node_modules/agent/bin/agent'), '/Users/dev/.npm/node_modules')
  const scopedRuntime = installReadRoot('/Users/dev/.npm/node_modules/@vendor/agent/bin/agent')
  const scopedProfile = sandboxProfileText('/Users/dev', { fixtureRoot: '/tmp/fixture', readPaths: [scopedRuntime] })
  assert.ok(scopedProfile.includes(`(allow file-read* (subpath "${scopedRuntime}"))`))
  assert.equal(scopedProfile.includes('(allow file-read* (subpath "/Users/dev/.npm/credential-sibling"))'), false)
  assert.equal(installDiscoveryState({ candidateCount: 0 }), 'absent')
  assert.equal(installDiscoveryState({ candidateCount: 1, copies: [{ standing: 'unreadable' }] }), 'unreadable')
  assert.equal(installDiscoveryState({ candidateCount: 1, unsafeCount: 1 }), 'unsafe')
})

test('install roots that encompass a home or a whole volume cannot be allowed', () => {
  const realHome = '/Users/dev'
  const usersRoot = join('/', 'Users')
  const volumesRoot = join('/', 'Volumes')
  const otherHome = join(usersRoot, 'other')
  const diskRoot = join(volumesRoot, 'Disk')
  const separator = String.fromCharCode(47)
  const refused = [
    otherHome, `${otherHome}${separator}`, `${usersRoot}//other`, join(otherHome, 'tools', 'v1'),
    join(diskRoot, 'tools', 'node_modules'), realHome, `${realHome}/..`, usersRoot, volumesRoot, diskRoot, '/',
  ]
  assert.deepEqual(refused.filter((root) => installRootIsSafe(root, realHome)), [])
  const accepted = [
    '/opt/homebrew/lib/node_modules',
    join(realHome, '.claude/local/versions/1.2.3'),
    join('/', 'UsersX'), join('/', 'Volumesfoo'),
  ]
  assert.deepEqual(accepted.filter((root) => !installRootIsSafe(root, realHome)), [])
})

test('Node install prefixes are safe read roots only when they stay outside unrelated homes and volumes', () => {
  const realHome = '/Users/dev'
  const refused = [
    ['/Users/other/.nvm/versions/node/v22/bin/node', realHome], // hd-secrets-ok synthetic path
    ['/Volumes/Disk/node/bin/node', realHome],
    ['/Users/dev/bin/node', realHome],
    ['/Users/node', realHome], // hd-secrets-ok synthetic path
    ['/Volumes/node', realHome],
    ['/Users/Shared/node/bin/node', realHome], // hd-secrets-ok synthetic path
  ]
  for (const [binary, home] of refused) {
    assert.throws(() => nodeInstallPrefixFor(binary, home), (error) => {
      assert.equal(error.message, 'cannot isolate: the Node install directory is not a safe read root')
      assert.doesNotMatch(error.message, /\/Users|\/Volumes/)
      return true
    }, binary)
  }
  assert.equal(nodeInstallPrefixFor('/opt/homebrew/Cellar/node/22.1.0/bin/node', realHome), '/opt/homebrew/Cellar/node/22.1.0')
  assert.equal(nodeInstallPrefixFor('/usr/local/bin/node', realHome), '/usr/local')
  assert.equal(nodeInstallPrefixFor('/Users/dev/.nvm/versions/node/v22/bin/node', realHome), '/Users/dev/.nvm/versions/node/v22')
  assert.equal(nodeInstallPrefixFor('/UsersX/node/bin/node', realHome), '/UsersX/node')
})

test('the current Node install prefix passes its real-home safety check', () => {
  assert.doesNotThrow(() => nodeInstallPrefix())
})

test('sandbox preparation refuses an unsafe Node prefix without writing a profile or exposing a path', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const root = await mkdtemp('/tmp/hd-measure-unsafe-node-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const nodeBinary = '/Volumes/Fixture/node/bin/node' // synthetic install path
  assert.equal(await prepareSandbox(fixture, { nodeBinary }), false)
  assert.equal(fixture.isolation.reason, 'cannot isolate: the Node install directory is not a safe read root')
  assert.doesNotMatch(fixture.isolation.reason, /[/\\]/)
  assert.equal(fixture.isolation.available, false)
  assert.equal(fixture.isolation.preflightPassed, false)
  assert.equal(existsSync(fixture.isolation.profilePath), false)
})

test('sandbox preparation sanitizes profile and verification exceptions', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  for (const stage of ['profile', 'verification']) {
    for (const known of [true, false]) {
      await t.test(`${stage}: ${known ? 'unsafe prefix' : 'unknown error'}`, async (t) => {
        const root = await mkdtemp('/tmp/hd-measure-profile-error-')
        t.after(() => rm(root, { recursive: true, force: true }))
        const fixture = await createFixture(root)
        const realpath = fs.realpathSync
        let checks = 0
        const mock = t.mock.method(fs, 'realpathSync', (path, ...args) => {
          if (path === process.execPath && ++checks === (stage === 'profile' ? 1 : 2)) {
            if (known) return '/Volumes/Fixture/node/bin/node' // synthetic install path
            throw new Error('unreadable /Volumes/Fixture/node/bin/node') // synthetic diagnostic
          }
          return realpath(path, ...args)
        })
        syncBuiltinESMExports()
        t.after(() => {
          mock.mock.restore()
          syncBuiltinESMExports()
        })

        assert.equal(await prepareSandbox(fixture), false)
        assert.equal(fixture.isolation.reason, known
          ? 'cannot isolate: the Node install directory is not a safe read root'
          : 'cannot isolate: sandbox profile unavailable')
        assert.doesNotMatch(fixture.isolation.reason, /[/\\]/)
        assert.equal(fixture.isolation.available, false)
        assert.equal(fixture.isolation.preflightPassed, false)
        if (stage === 'profile') assert.equal(existsSync(fixture.isolation.profilePath), false)
        assert.throws(() => run(process.execPath, [], fixture), /preflight has not passed/)
      })
    }
  }
})

test('a Node prefix in the real home cannot be checked against the synthetic canary home', () => {
  const nodeInRealHome = '/Users/dev/.nvm/versions/node/v22/bin/node'
  assert.equal(nodeInstallPrefixFor(nodeInRealHome, '/Users/dev'), '/Users/dev/.nvm/versions/node/v22')
  assert.throws(() => nodeInstallPrefixFor(nodeInRealHome, '/tmp/sandbox-canary-home'), /Node install directory is not a safe read root/)
})

test('discovery always uses strict isolation, including keychain-only agents', () => {
  for (const id of ['claude-code', 'cursor', 'grok-build', 'codex']) {
    assert.equal(discoveryIsolation({ id }), 'strict', id)
  }
})

test('the three keychain-only agents retain version discovery but never receive a model prompt', () => {
  for (const id of ['claude-code', 'cursor', 'grok-build']) assert.equal(shouldAskAgent({ id }), false)
  for (const id of ['codex', 'cline', 'opencode']) assert.equal(shouldAskAgent({ id }), true)
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
  assert.match(profile, /\(allow default\)/)
  assert.doesNotMatch(profile, /\(deny default\)/)
  assert.ok(independentHomes.length > 0)
  assert.ok(deniedHomePaths().some((path) => path.endsWith('/.claude')))
})

test('the run profile admits the temporary root aliases but denies a sibling credential directory', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const root = await mkdtemp('/tmp/hd-measure-alias-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  assert.equal(await prepareSandbox(fixture), true, fixture.isolation.reason)
  const canonical = await import('node:fs/promises').then(({ realpath }) => realpath(root))
  for (const alias of new Set([root, canonical])) {
    assert.ok(fixture.isolation.profileText.includes(`(allow file-read* (subpath "${alias}"))`), `read access covers ${alias === root ? 'the temporary-root alias' : 'the canonical temporary root'}`)
    assert.ok(fixture.isolation.profileText.includes(`(allow file-write* (subpath "${alias}"))`), `write access covers ${alias === root ? 'the temporary-root alias' : 'the canonical temporary root'}`)
  }
  const siblingCredential = join(canonical, '..', 'sibling-credentials')
  assert.doesNotMatch(fixture.isolation.profileText, new RegExp(siblingCredential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('sandbox preflight proves both profiles, fixture reads and writes, home denial, runtime carve-outs and executable spawning', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const root = await mkdtemp('/tmp/hd-measure-sandbox-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const passed = await prepareSandbox(fixture)
  assert.equal(fixture.isolation.preflightPassed, passed)
  assert.equal(existsSync(join(root, 'canary.keychain-db')), false)
  assert.equal(passed, true, fixture.isolation.reason)
  const exceptionPassed = await prepareSandbox(fixture, { isolation: KEYCHAIN_READ_ONLY })
  assert.equal(exceptionPassed, true, fixture.isolation.reason)
  assert.equal(fixture.isolation.profile, KEYCHAIN_READ_ONLY)
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
  assert.deepEqual(validateResult({ ...valid, isolation: 'strict', auth: 'no sign-in used' }, fixture).auth, 'no sign-in used')
  assert.throws(() => validateResult({ ...valid, rawAnswer: '' }, fixture), /rawAnswer/)
  assert.throws(() => validateResult({ ...valid, rawAnswer: '', status: 'could-not-ask' }, fixture), /reason/)
  assert.throws(() => validateResult({ ...valid, status: 'could-not-ask', reason: 'needs sign-in, not measured' }, fixture), /cannot persist an answer/)
  assert.equal(validateResult({ ...valid, rawAnswer: '', status: 'could-not-ask', reason: 'needs sign-in, not measured' }, fixture).status, 'could-not-ask')
  assert.throws(() => validateResult({ ...valid, rawAnswer: '', status: 'asked' }, fixture), /rawAnswer/)
  assert.equal(validateResult({ ...valid, rawAnswer: '', question: 'no session while signed out', facts: { signedOutCatalogue: { status: 'unknown', observation: 'no-session' } } }, fixture).status, 'asked')
  assert.equal(validateResult({ ...valid, facts: { skillRoots: [{ path: '.codex/skills', scope: 'project' }] } }, fixture).status, 'asked')
  assert.throws(() => validateResult({ ...valid, facts: { skillRoots: [{ path: '../outside', scope: 'project' }] } }, fixture), /fixture-derived allowlist/)
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
  assert.equal(normalizeVersion('1.2.3-sk8f7s9d8f7sd9f87sd'), 'unknown')
  assert.equal(normalizeVersion('1.2.3-abcdef123456'), 'unknown')
  assert.equal(normalizeVersion('0.1.7-rc.2'), '0.1.7-rc.2')
  assert.equal(normalizeVersion('1.0.0-beta'), '1.0.0-beta')
  assert.equal(normalizeVersion('2.0.0-next.12'), '2.0.0-next.12')
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

test('writeResult replaces a prior per-agent version so the report shows only the latest result', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-replace-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const base = {
    agent: 'Codex', agentId: 'codex', version: 'unknown', measured: '2026-10-01', interface: 'not launched',
    question: 'Is an installed build available?', rawAnswer: '', facts: {}, status: 'could-not-ask', reason: 'binary not installed',
  }
  const directory = join(root, 'results')
  await writeResult(base, directory, fixture)
  const latest = await writeResult({ ...base, version: '1.2.3' }, directory, fixture)
  assert.deepEqual(await readdir(directory), ['codex-1.2.3.json'])
  assert.equal(latest.endsWith('codex-1.2.3.json'), true)
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

const factStatus = (value) => value?.status ?? (typeof value === 'boolean' ? String(value) : 'unknown')
const mappedCells = (facts) => [
  `facts.rulesFiles=${factStatus(facts.rulesFiles)}`,
  `facts.catalogue=${facts.catalogue?.reported ? `${facts.catalogue.reported.length}-fixture-skills` : factStatus(facts.catalogue)}; facts.reportsCatalogue=${facts.reportsCatalogue}`,
  `facts.precedence=${facts.precedence?.duplicateCount ?? factStatus(facts.precedence)}`,
  `facts.rejections=${facts.rejections?.missingDescriptionListed ?? factStatus(facts.rejections)}/${facts.rejections?.oversizedListed ?? factStatus(facts.rejections)}; facts.reportsRejections=${facts.reportsRejections}`,
  `facts.skillRoots=user:${facts.skillRoots?.filter((root) => root.scope === 'user').map((root) => root.path).join(',') || 'unmeasured'}; project:${facts.skillRoots?.filter((root) => root.scope === 'project').map((root) => root.path).join(',') || 'unmeasured'}`,
  `facts.refresh.catalogueRefresh=${facts.refresh?.catalogueRefresh ?? 'none'}; facts.refresh.skillToggle=${facts.refresh?.skillToggle ?? false}; facts.refresh.openSessionSeesChange=${facts.refresh?.openSessionSeesChange ?? 'unknown'}`,
  `facts.mcp=${facts.mcp?.status ?? factStatus(facts.mcp)}`,
  `facts.signedOutCatalogue=${facts.signedOutCatalogue?.status ?? factStatus(facts.signedOutCatalogue)}${facts.signedOutCatalogue?.observation ? ` (${facts.signedOutCatalogue.observation})` : ''}`,
]

test('versioned measurement records and every tier-table cell use the planned fact mapping', async () => {
  const directory = new URL('../../docs/verification/library-measurements/', import.meta.url)
  const readme = await readFile(new URL('README.md', directory), 'utf8')
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  assert.ok(names.length > 0)
  for (const name of names) {
    const result = JSON.parse(await readFile(new URL(name, directory), 'utf8'))
    assert.ok(['asked', 'could-not-ask'].includes(result.status))
    assert.ok(result.agent && result.agentId && result.version && result.measured && result.interface && result.question)
    if (result.status === 'asked') {
      assert.ok(result.rawAnswer || ['no-session', 'session-created'].includes(result.facts.signedOutCatalogue?.observation))
      assert.equal(result.reason, undefined)
    } else {
      assert.equal(result.rawAnswer, '')
      assert.ok(result.reason)
    }
    const row = readme.split('\n').find((line) => line.startsWith('|') && line.includes(`(${name})`))
    assert.ok(row, `${name} is linked from its result row`)
    assert.deepEqual(Object.keys(result.facts).sort(), ['catalogue','reportsCatalogue','mcp','precedence','refresh','rejections','reportsRejections','rulesFiles','signedOutCatalogue','skillRoots'].sort())
    assert.equal(typeof result.facts.reportsCatalogue, 'boolean')
    assert.equal(typeof result.facts.reportsRejections, 'boolean')
    assert.equal(typeof result.facts.refresh.catalogueRefresh, 'string')
    assert.equal(typeof result.facts.refresh.skillToggle, 'boolean')
    assert.ok(Array.isArray(result.facts.skillRoots))
    assert.ok(result.facts.skillRoots.every((root) => typeof root.path === 'string' && ['user', 'project'].includes(root.scope)))
    assert.deepEqual(row.split('|').map((cell) => cell.trim()).slice(2, -1), mappedCells(result.facts), `${name} cell mapping`)
  }
  const normalizedTable = readme.toLowerCase().replaceAll('-', ' ')
  for (const heading of ['rules', 'catalogue', 'precedence', 'limits', 'roots', 'refresh', 'MCP', 'signed out']) {
    assert.ok(normalizedTable.includes(heading.toLowerCase()), `tier table includes ${heading}`)
  }
  for (const fact of ['facts.rulesFiles', 'facts.catalogue', 'facts.reportsCatalogue', 'facts.precedence', 'facts.rejections', 'facts.reportsRejections', 'facts.skillRoots', 'facts.refresh.catalogueRefresh', 'facts.refresh.skillToggle', 'facts.refresh.openSessionSeesChange', 'facts.mcp', 'facts.signedOutCatalogue']) {
    assert.ok(readme.includes(fact), `tier-table mapping includes ${fact}`)
  }
})

test('Codex protocol parser ignores diagnostics and keeps only JSON-RPC records', () => {
  const records = parseCodexOutput('diagnostic line\n{"jsonrpc":"2.0","id":2,"result":{"data":[]}}\nnot json\n')
  assert.equal(records.length, 1)
  assert.equal(records[0].id, 2)
})

test('ACP parser records signed-out session outcome without treating commands as skills', () => {
  const messages = parseAcpOutput([
    'startup diagnostic',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'secret-command' }] } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'private-id' } }),
  ].join('\n'))
  assert.deepEqual(summarizeAcpMessages(messages), { initialized: true, sessionCreated: true, signedOutFailure: false, commandCount: 1, signedOutObservation: 'session-created' })
  const failed = summarizeAcpMessages([{ id: 1, result: {} }, { id: 2, error: { code: -32000 } }])
  assert.equal(failed.signedOutObservation, 'no-session')
  assert.deepEqual({ status: 'unknown', observation: failed.signedOutObservation }, { status: 'unknown', observation: 'no-session' })
})

test('Codex rejection parser reduces vendor errors to safe word categories', () => {
  assert.deepEqual(parseRejectionWords([
    { message: 'missing description in skill manifest' },
    { message: 'fixture exceeds size limit' },
  ]), { description: true, size: true, manifest: true })
  assert.deepEqual(parseRejectionWords([{ message: 'other validation issue' }]), { description: false, size: false, manifest: false })
})
