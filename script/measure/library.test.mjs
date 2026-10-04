import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

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
  safeEnv,
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
import { installProbes, parseAcpOutput, parseCodexOutput, parseRejectionWords, summarizeAcpMessages } from './probes/index.mjs'
// Namespace imports for what this round adds: a missing export fails its own test rather than the whole file.
import * as probeModule from './probes/index.mjs'
import * as harness from './library.mjs'

const under = (root, path) => path.startsWith(`${root}/`) || path === root

test('bundled model bridges use the app package entries and a fake bridge receives the selected CLI', async (t) => {
  for (const [id, name, variable] of [['claude-code', 'claude-acp', 'CLAUDE_CODE_EXECUTABLE'], ['cursor', 'cursor-acp', 'CURSOR_ACP_COMMAND']]) {
    const fixture = await createFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const packagesRoot = join(fixture.root, 'packages')
    const entry = join(packagesRoot, name, 'dist/src/main.js')
    const requests = join(fixture.root, 'bridge-requests.jsonl')
    const source = await readFile(new URL('../../packages/adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url), 'utf8')
    await mkdir(join(packagesRoot, name, 'dist/src'), { recursive: true })
    await writeFile(join(packagesRoot, name, 'package.json'), '{"type":"module"}')
    await writeFile(entry, source.replace('const handler = handlers[message.method]', `appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: message.method, executable: process.env.${variable}, nested: process.env.CLAUDECODE }) + '\\n');\n  const handler = handlers[message.method]`))
    const agent = { id, command: process.execPath, acp: { args: [], bridge: { command: name, args: [], executableEnv: variable } } }
    const resolved = await harness.resolveModelBridge(agent, { packagesRoot, realHome: join(fixture.root, 'real-home') })
    assert.equal(resolved.agent.acp.bridge.command, process.execPath)
    assert.deepEqual(resolved.agent.acp.bridge.args, [fs.realpathSync(entry)])
    assert.ok(resolved.readPaths.includes(fs.realpathSync(join(packagesRoot, name))))
    assert.ok(!resolved.readPaths.includes(packagesRoot))
    const staged = await harness.stageModelBridge(resolved.agent, fixture)
    assert.equal(await prepareSandbox(fixture, { isolation: KEYCHAIN_READ_ONLY }), true, fixture.isolation.reason)
    const probes = await import('./probes/index.mjs')
    installProbes({ registerProbe: () => {}, createPromptBudget: harness.createPromptBudget, run: async (command, args, passedFixture, options) => {
      assert.equal(passedFixture, fixture)
      return run(command, args, passedFixture, options)
    } })
    const result = await probes.probeAcpHandshake(staged, fixture)
    assert.equal(result.status, 'asked')
    assert.equal(result.prompted, false)
    const sent = (await readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(sent.map(request => request.method), ['initialize', 'session/new'])
    assert.ok(sent.every(request => request.executable === process.execPath))
    if (id === 'claude-code') assert.ok(sent.every(request => request.nested === ''))
  }
})

test('bundled bridge absence and unsafe read roots have distinct path-free refusals', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-bridge-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const agent = { id: 'cursor', acp: { bridge: { command: 'cursor-acp', args: [], executableEnv: 'CURSOR_ACP_COMMAND' } } }
  assert.equal((await harness.resolveModelBridge(agent, { packagesRoot: root })).reason, 'bridge not installed')
  const packageRoot = join(root, 'cursor-acp')
  await mkdir(join(packageRoot, 'dist/src'), { recursive: true })
  await writeFile(join(packageRoot, 'dist/src/main.js'), '')
  assert.equal((await harness.resolveModelBridge(agent, { packagesRoot: root, realHome: fs.realpathSync(packageRoot) })).reason, 'cannot isolate: bridge install directory unsafe')
})

test('bundled bridge modules and their dependency trees load under the approved profile without a session', async (t) => {
  const { KNOWN_AGENTS } = await import('../../packages/server/dist/src/installs/known-agents.js')
  for (const id of ['claude-code', 'cursor']) {
    const fixture = await createFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const resolved = await harness.resolveModelBridge(KNOWN_AGENTS.find(agent => agent.id === id))
    assert.equal(resolved.reason, undefined)
    const staged = await harness.stageModelBridge(resolved.agent, fixture)
    const args = staged.acp.bridge.args
    assert.ok(under(fixture.root, args.at(-1)))
    assert.equal(await prepareSandbox(fixture, { isolation: KEYCHAIN_READ_ONLY }), true, fixture.isolation.reason)
    const module = join(args.at(-1), '..', 'bridge.js')
    const result = await run(staged.acp.bridge.command, [...args.slice(0, -1), '--input-type=module', '-e', `import(${JSON.stringify(module)}).then(()=>process.stdout.write('loaded')).catch(()=>process.exit(2))`], fixture)
    assert.equal(result.code, 0, `${id} bundle import refused`)
    assert.equal(result.stdout, 'loaded')
  }
})

test('RPC failures reduce to fixed reasons and error classes', async () => {
  const { classifyRequestError } = await import('./probes/index.mjs')
  for (const [error, reason, errorClass] of [
    [{ code: -32000, message: 'synthetic-error-detail' }, 'sign-in not reachable under the approved profile', 'authentication-required'],
    [{ code: -32603, message: 'Internal error', data: { details: 'fetch failed: ENOTFOUND synthetic-error-detail' } }, 'network refused', 'internal-error'],
    [{ code: -32603, message: 'quota exceeded synthetic-error-detail' }, 'quota', 'internal-error'],
    [{ code: -32602, message: 'synthetic-error-detail' }, 'unknown', 'invalid-params'],
  ]) assert.deepEqual(classifyRequestError(error), { reason, errorClass })
  assert.deepEqual(classifyRequestError({ code: -32000 }, true), { reason: 'unknown', errorClass: 'server-error' })
})

test('fake ACP request failures persist only their stage and fixed error class', async (t) => {
  for (const method of ['initialize', 'session/new', 'session/prompt']) {
    const fixture = await createFixture()
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    const peer = join(fixture.root, 'failure.mjs')
    const requests = join(fixture.root, 'requests.jsonl')
    const source = await readFile(new URL('../../packages/adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url), 'utf8')
    await writeFile(peer, source.replace('const handler = handlers[message.method]', `appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: message.method }) + '\\n');\n  if (message.method === ${JSON.stringify(method)}) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'synthetic-error-detail', data: { detail: 'synthetic-env-value' } } }); return; }\n  const handler = handlers[message.method]`))
    const probes = new Map()
    const captures = []
    installProbes({ registerProbe: (id, probe) => probes.set(id, probe), createPromptBudget: harness.createPromptBudget, run: async (command, args, passedFixture, options) => {
      const { stdout, stderr } = await promisify(execFile)(command, args, { env: { ...safeEnv(passedFixture), ...options.envOverrides }, timeout: 15_000 })
      captures.push(stdout, stderr)
      return { code: 0, stdout, stderr }
    } })
    const result = await probes.get('grok-build')({ id: 'grok-build', command: process.execPath, acp: { args: [peer] } }, fixture, { ask: true })
    assert.equal(result.status, 'could-not-ask')
    assert.equal(result.reason, 'sign-in not reachable under the approved profile')
    assert.equal(result.prompted, method === 'session/prompt')
    assert.deepEqual(result.facts.requestFailure, { stage: method === 'initialize' ? 'initialize' : method === 'session/new' ? 'session-new' : 'prompt', errorClass: 'authentication-required' })
    const saved = await writeResult({ agent: 'Grok Build', agentId: 'grok-build', version: '1.0.0', measured: '2026-10-03', isolation: KEYCHAIN_READ_ONLY, auth: 'no sign-in used', ...result }, join(fixture.root, 'results'), fixture)
    assert.doesNotMatch(JSON.stringify({ result, captures }) + await readFile(saved, 'utf8'), /synthetic-error-detail|synthetic-env-value/)
    const sent = (await readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(sent.map(request => request.method), method === 'initialize' ? ['initialize'] : method === 'session/new' ? ['initialize', 'session/new'] : ['initialize', 'session/new', 'session/prompt'])
  }
})

test('ask fixtures distinguish every scope and skill root by its description', async (t) => {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-roots-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const entries = await populateSkillRoots(fixture, { user: ['~/.cursor/skills', '~/.cursor/skills-cursor'], project: ['.cursor/skills'] })
  const sentinels = entries.filter((entry) => entry.sentinel).map((entry) => entry.sentinel)
  assert.equal(new Set(sentinels).size, sentinels.length)
  assert.ok(entries.some((entry) => entry.sentinel === 'PROJECT_dot-cursor-skills_measure-user_SENTINEL'))
})

test('ask CLI requires one agent and admits no prompt text or ambiguous options', () => {
  assert.deepEqual(harness.parseArgs(['--all']), { all: true, ask: false })
  assert.deepEqual(harness.parseArgs(['--agent', 'gemini']), { agentId: 'gemini', ask: false })
  assert.deepEqual(harness.parseArgs(['--agent', 'gemini', '--ask', '--env', 'GEMINI_API_KEY']), { agentId: 'gemini', ask: true, envName: 'GEMINI_API_KEY' })
  for (const args of [['--ask'], ['--all', '--ask'], ['--all', '--agent', 'gemini'], ['--agent'], ['--agent', 'gemini', '--env', 'GEMINI_API_KEY'], ['--agent', 'gemini', '--ask', 'user words'], ['--agent', 'gemini', '--ask', '--ask']]) {
    assert.throws(() => harness.parseArgs(args), /usage/)
  }
})

test('profile selection enumerates every agent and every isolation selection call site', () => {
  const source = readFileSync(new URL('./library.mjs', import.meta.url), 'utf8')
  const registry = readFileSync(new URL('../../packages/server/src/installs/known-agents.ts', import.meta.url), 'utf8')
  const ids = ['codex', ...[...registry.matchAll(/^\s{4}id:\s*['"]([^'"]+)['"]/gm)].map((match) => match[1])]
  for (const id of ids) {
    assert.equal(discoveryIsolation({ id }), 'strict', id)
    for (const options of [{ all: true, ask: false }, { agentId: id, ask: false }, { all: true, ask: true }, { agentId: 'another-agent', ask: true }]) {
      assert.equal(harness.measurementIsolation({ id }, options), 'strict', JSON.stringify({ id, options }))
    }
    assert.equal(harness.measurementIsolation({ id }, { agentId: id, ask: true }), ['claude-code', 'cursor', 'grok-build'].includes(id) ? KEYCHAIN_READ_ONLY : 'strict', id)
  }
  // Pin all production selection sites; profile construction and canary checks
  // consume this choice, but cannot choose an exception themselves.
  assert.deepEqual(source.split('\n').filter((line) => /(?:const isolation =|prepareSandbox\(fixture, \{ isolation)/.test(line)).map((line) => line.trim()), [
    "export async function prepareSandbox(fixture, { isolation = 'strict', readPaths = [], nodeBinary } = {}) {",
    'const isolation = discoveryIsolation(agent)',
    "if (!await prepareSandbox(fixture, { isolation, readPaths: copyRoots })) return { chosen: null, copies: [], state: 'unsafe' }",
    'const isolation = measurementIsolation(agent, options)',
    'if (!await prepareSandbox(fixture, { isolation, readPaths })) return { ...base, reason: \'cannot isolate\' }',
  ])
  assert.equal(source.split('\n').filter((line) => /return .*KEYCHAIN_READ_ONLY/.test(line)).length, 2)
})

test('the harness prompt budget refuses a fourth request even after failed requests', () => {
  const take = harness.createPromptBudget()
  assert.equal(take(), 1)
  assert.equal(take(), 2)
  assert.equal(take(), 3)
  assert.throws(() => take(), /prompt cap/)
  assert.throws(() => take(), /prompt cap/)
})

test('ask environment refuses any name not declared by the registry', async () => {
  const { KNOWN_AGENTS } = await import('../../packages/server/dist/src/installs/known-agents.js')
  const gemini = KNOWN_AGENTS.find((agent) => agent.id === 'gemini')
  assert.equal(harness.askEnvironment(gemini, 'GEMINI_API_KEY', {}).reason, 'key not provided')
  assert.throws(() => harness.askEnvironment(gemini, 'GOOGLE_API_KEY', { GOOGLE_API_KEY: 'synthetic-key' }), /not declared/)
  assert.throws(() => harness.askEnvironment({ id: 'cursor' }, 'GEMINI_API_KEY', { GEMINI_API_KEY: 'synthetic-key' }), /not declared/)
  assert.deepEqual(harness.askEnvironment(gemini, undefined), { envOverrides: {}, allowedEnv: [] })
})

test('ask refuses a forged preflight before launching a model probe', async (t) => {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-ask-gate-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  fixture.isolation.preflightPassed = true
  fixture.isolation.profile = 'strict'
  const result = await askAgent({ id: 'gemini', name: 'Gemini CLI', home: { path: '~/.gemini' } }, fixture, { agentId: 'gemini', ask: true })
  assert.equal(result.status, 'could-not-ask')
  assert.equal(result.reason, 'cannot isolate')
  assert.equal(result.auth, 'no sign-in used')
})

test('ask records a missing declared key without using a sign-in or launching a child', async (t) => {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-key-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const result = await askAgent({ id: 'gemini', name: 'Gemini CLI', auth: { secrets: [{ env: 'MEASURE_MISSING_KEY' }] } }, fixture, { agentId: 'gemini', ask: true, envName: 'MEASURE_MISSING_KEY' })
  assert.equal(result.reason, 'key not provided')
  assert.equal(result.auth, 'no sign-in used')
})

test('CLI refuses an undeclared environment name without echoing caller values', async () => {
  const execution = await promisify(execFile)(process.execPath, ['script/measure/library.mjs', '--agent', 'gemini', '--ask', '--env', 'MEASURE_UNDECLARED'], { env: { ...process.env, MEASURE_UNDECLARED: 'synthetic-env-value' } }).catch((error) => error)
  assert.equal(execution.code, 1)
  assert.equal(execution.stdout, '')
  assert.doesNotMatch(execution.stderr, /synthetic-env-value|MEASURE_UNDECLARED/)
})

test('ask records an absent install before requiring or launching a sandbox', async (t) => {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-absent-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const result = await harness.findAgentInstall({ id: 'gemini', home: { path: '~/.gemini' }, cli: { commands: ['harnessdesk-measure-not-installed'] } }, fixture, { ask: true })
  assert.equal(result.state, 'absent')
  assert.equal(existsSync(fixture.isolation.profilePath), false)
})

test('CLI missing-key result keeps the specified refusal reason without a model launch', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-cli-')
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['script/measure/probes', 'packages/server/src/installs', 'packages/server/dist/src/installs']) fs.mkdirSync(join(root, path), { recursive: true })
  for (const path of ['script/measure/library.mjs', 'script/measure/probes/index.mjs', 'packages/server/src/installs/known-agents.ts']) {
    await writeFile(join(root, path), await readFile(new URL(`../../${path}`, import.meta.url)))
  }
  await writeFile(join(root, 'packages/server/dist/src/installs/known-agents.js'), `export const KNOWN_AGENTS = [{ id: 'gemini', name: 'Gemini CLI', home: { path: '~/.gemini' }, cli: { commands: [] }, auth: { secrets: [{ env: 'GEMINI_API_KEY' }] } }]`)
  await writeFile(join(root, 'packages/server/dist/src/installs/locate.js'), `export const candidatePaths = () => []; export const findInstalls = () => { throw new Error('must not launch') }; export const judgeInstalls = findInstalls;`)
  const env = { ...process.env }
  delete env.GEMINI_API_KEY
  const execution = await promisify(execFile)(process.execPath, [fs.realpathSync(join(root, 'script/measure/library.mjs')), '--agent', 'gemini', '--ask', '--env', 'GEMINI_API_KEY'], { env })
  const result = JSON.parse(await readFile(join(root, 'docs/verification/library-measurements/gemini-unknown.json'), 'utf8'))
  assert.equal(result.reason, 'key not provided')
  assert.equal(result.auth, 'no sign-in used')
  assert.equal(execution.stderr, '')
})

test('ask adds no sandbox rule and retains the exact strict and exception profiles', () => {
  assert.equal(createHash('sha256').update(sandboxProfileText.toString()).digest('hex'), '238f74c1b28b233d14a3e6449ecf35344e69027f5bfeb5f01868c89ff8a9c190')
})

test('discovery retains its numeric error codes while ask facts accept only bounded counts', () => {
  const fixture = { ruleSentinels: {}, skills: { sentinel: '/tmp/measure-sentinel' } }
  const discovery = { agent: 'Gemini CLI', agentId: 'gemini', version: '1.0.0', measured: '2026-10-02', interface: 'ACP initialize and session request', question: 'no session while signed out', rawAnswer: '', facts: { signedOutCatalogue: { status: 'unknown', observation: 'no-session', sessionNewErrorCode: 2_000_000 } }, status: 'asked' }
  assert.deepEqual(validateResult(discovery, fixture), discovery)
  const model = { ...discovery, interface: 'ACP model prompt', rawAnswer: 'measure-sentinel' }
  for (const count of [0, 3, 500]) assert.equal(validateResult({ ...model, facts: { precedence: { duplicateCount: count } } }, fixture).status, 'asked')
  for (const count of [-1, 0.5, 501, 1_000_001, null]) assert.throws(() => validateResult({ ...model, facts: { precedence: { duplicateCount: count } } }, fixture), /fixture-derived allowlist/)
})

async function fakeModelProbe(t, { invalid = 0, unknown = false, refresh = 'yes', codex = false, key = false, timeout = false, omitRefreshSkill = false, verified = false } = {}) {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-model-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const entries = await populateSkillRoots(fixture, { user: ['~/.gemini/skills'], project: ['.gemini/skills'] })
  if (verified) assert.equal(await prepareSandbox(fixture), true, fixture.isolation.reason)
  const selected = entries.filter((entry) => entry.scope === 'project' && entry.sentinel)
  const answer = { rules: [fixture.ruleSentinels[join(fixture.repo, 'GEMINI.md')]], skills: selected.map(({ name, sentinel }) => ({ name, description: sentinel })), mcp: ['measure_fixture'] }
  if (omitRefreshSkill) answer.skills = answer.skills.filter((skill) => skill.name !== 'measure-sentinel')
  if (unknown) answer.skills.push({ name: 'measure-user', description: 'NEVER_GIVEN_SENTINEL' }, { name: 'measure-sentinel', description: 'REFRESHED_SENTINEL' })
  const requests = join(fixture.root, 'requests.jsonl')
  const peer = join(fixture.root, 'peer.mjs')
  const fixtureURL = codex ? '../../packages/adapter-codex/test/fixtures/fake-codex.mjs' : '../../packages/adapter-acp/test/fixtures/fake-acp-agent.mjs'
  let source = await readFile(new URL(fixtureURL, import.meta.url), 'utf8')
  const body = `
    appendFileSync(${JSON.stringify(requests)}, JSON.stringify(params) + '\\n');
    const isRefresh = ${codex ? "params.input[0].text" : "params.prompt[0].text"}.includes('one JSON object with only');
    const ordinal = readFileSync(${JSON.stringify(requests)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(request => !${codex ? 'request.input[0].text' : 'request.prompt[0].text'}.includes('one JSON object with only')).length;
    if (${timeout}) return;
    const refreshed = readFileSync(${JSON.stringify(join(fixture.repo, '.gemini/skills/measure-sentinel/SKILL.md'))}, 'utf8').match(/^description: (.*)$/m)[1];
    const catalogueAnswer = ${JSON.stringify(answer)};
    if (!isRefresh && ordinal > 1) { const skill = catalogueAnswer.skills.find(skill => skill.name === 'measure-sentinel'); if (skill) skill.description = refreshed; }
    if (${key}) { catalogueAnswer.skills.push({ name: 'measure-user', description: process.env.GEMINI_API_KEY }); process.stderr.write(process.env.GEMINI_API_KEY); }
    const output = !isRefresh && ordinal <= ${invalid} || isRefresh && ${refresh === 'invalid'} ? 'invalid JSON' : JSON.stringify(isRefresh ? { description: ${refresh === 'yes' ? 'refreshed' : refresh === 'no' ? JSON.stringify(selected.find((entry) => entry.name === 'measure-sentinel').sentinel) : "'NEVER_GIVEN_SENTINEL'"} } : catalogueAnswer);
    ${codex ? "send({ id, result: { turn: { id: 'measure-turn' } } }); notify('item/agentMessage/delta', { threadId: params.threadId, turnId: 'measure-turn', delta: output }); notify('turn/completed', { threadId: params.threadId, turn: { id: 'measure-turn', status: 'completed' } }); return;" : "update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } }); return reply(id, { stopReason: 'end_turn' });"}
  `
  source = codex ? source.replace("case 'turn/start': {", `case 'turn/start': {${body}`) : source.replace("'session/prompt': (id, params) => void runPrompt(id, params),", `'session/prompt': (id, params) => {${body}},`)
  if (codex) source = source.replace(/^#!.*\n/, `#!${process.execPath}\n`)
  await writeFile(peer, source + '\nif (process.env.GEMINI_API_KEY) process.stdout.write(process.env.GEMINI_API_KEY + "\\n");\n')
  if (codex) fs.chmodSync(peer, 0o755)
  const probes = new Map()
  const captures = []
  installProbes({
    registerProbe: (id, probe) => probes.set(id, probe), createPromptBudget: harness.createPromptBudget,
    run: async (command, args, passedFixture, options) => {
      assert.equal(passedFixture, fixture)
      const result = verified ? await run(command, args, passedFixture, options)
        : await promisify(execFile)(command, args, { cwd: fixture.repo, env: { ...safeEnv(fixture), ...options.envOverrides }, timeout: 15_000 })
      captures.push(result.stdout + result.stderr)
      return { code: 0, ...result }
    },
  })
  const agent = { id: codex ? 'codex' : 'gemini', name: codex ? 'Codex' : 'Gemini CLI', version: '1.0.0', home: { path: '~/.gemini' }, auth: { secrets: [{ env: 'GEMINI_API_KEY' }] }, command: codex ? peer : process.execPath, acp: { args: [peer] } }
  if (verified) registerProbe(agent.id, probes.get(agent.id))
  const result = verified ? await askAgent(agent, fixture, { agentId: agent.id, ask: true, envName: key ? 'GEMINI_API_KEY' : undefined })
    : await probes.get(agent.id)(agent, fixture, { ask: true, promptTimeoutMs: timeout ? 30 : undefined, envOverrides: key ? { GEMINI_API_KEY: 'synthetic-env-value' } : {}, allowedEnv: key ? ['GEMINI_API_KEY'] : [] })
  const sent = existsSync(requests) ? (await readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse) : []
  return { result, sent, fixture, captures, agent }
}

test('fake ACP ask measures fixture facts and refresh in one session with fixed prompts', async (t) => {
  const { result, sent, fixture } = await fakeModelProbe(t)
  assert.equal(result.status, 'asked')
  assert.equal(sent.length, 2)
  assert.equal(new Set(sent.map((request) => request.sessionId)).size, 1)
  assert.equal(result.facts.refresh.openSessionSeesChange, 'yes')
  assert.deepEqual(result.facts.skillRoots, [{ path: '.gemini/skills', scope: 'project' }])
  assert.equal(result.facts.rejections.oversizedListed, true)
  assert.equal(result.facts.rejections.missingDescriptionListed, false)
  assert.deepEqual(result.facts.mcp.reported, ['measure_fixture'])
  for (const request of sent) for (const token of Object.values(fixture.ruleSentinels).concat(fixture.skillEntries.map((entry) => entry.sentinel).filter(Boolean))) assert.ok(!request.prompt[0].text.includes(token))
  validateResult({ agent: 'Gemini CLI', agentId: 'gemini', version: '1.0.0', measured: '2026-10-02', isolation: 'strict', auth: 'no sign-in used', ...result }, fixture)
})

test('fake ACP ask retries malformed catalogue JSON once within three prompts', async (t) => {
  const { result, sent, fixture } = await fakeModelProbe(t, { invalid: 1 })
  assert.equal(result.status, 'asked')
  assert.equal(sent.length, 3)
  assert.deepEqual(sent[0].prompt, sent[2].prompt)
  assert.match(sent[1].prompt[0].text, /one JSON object with only/)
  assert.match(result.rawAnswer, /REFRESHED_SENTINEL/)
  validateResult({ agent: 'Gemini CLI', agentId: 'gemini', version: '1.0.0', measured: '2026-10-02', ...result }, fixture)
})

test('fake ACP invalid JSON twice records could-not-ask without further prompts', async (t) => {
  const { result, sent } = await fakeModelProbe(t, { invalid: 2 })
  assert.equal(result.status, 'could-not-ask')
  assert.equal(result.reason, 'answer not requested JSON')
  assert.equal(sent.length, 3)
})

test('fake ACP discards never-given sentinels and an echoed environment value before capture or persistence', async (t) => {
  const { result, fixture, captures, sent } = await fakeModelProbe(t, { unknown: true, key: true })
  assert.equal(result.status, 'asked')
  assert.doesNotMatch(JSON.stringify({ result, captures, sent }), /NEVER_GIVEN_SENTINEL|REFRESHED_SENTINEL|synthetic-env-value/)
  const path = await writeResult({ agent: 'Gemini CLI', agentId: 'gemini', version: '1.0.0', measured: '2026-10-02', isolation: 'strict', auth: 'environment key', ...result }, join(fixture.root, 'results'), fixture)
  for (const name of await readdir(fixture.root)) if (name.endsWith('.jsonl') || name.endsWith('.json')) assert.doesNotMatch(await readFile(join(fixture.root, name), 'utf8'), /synthetic-env-value/)
  assert.doesNotMatch(await readFile(path, 'utf8'), /synthetic-env-value/)
})

test('fake ACP refresh distinguishes an old description from an unknown one', async (t) => {
  assert.equal((await fakeModelProbe(t, { refresh: 'no' })).result.facts.refresh.openSessionSeesChange, 'no')
  assert.equal((await fakeModelProbe(t, { refresh: 'unknown' })).result.facts.refresh.openSessionSeesChange, 'unknown')
})

test('fake ACP asks about refresh even when the initial catalogue omitted the skill', async (t) => {
  const { result, sent } = await fakeModelProbe(t, { omitRefreshSkill: true })
  assert.equal(sent.length, 2)
  assert.equal(result.facts.refresh.openSessionSeesChange, 'yes')
})

test('fake ACP invalid refresh JSON records a refusal and keeps only sanitized initial facts', async (t) => {
  const { result, sent } = await fakeModelProbe(t, { refresh: 'invalid' })
  assert.equal(result.status, 'could-not-ask')
  assert.equal(result.reason, 'answer not requested JSON')
  assert.equal(result.rawAnswer, '')
  assert.equal(sent.length, 2)
})

test('fake ACP unanswered model prompt times out without retry', async (t) => {
  const { result, sent } = await fakeModelProbe(t, { timeout: true })
  assert.equal(result.status, 'could-not-ask')
  assert.equal(result.reason, 'prompt timed out')
  assert.equal(sent.length, 1)
})

test('fake Codex ask sends turns in one thread under the same prompt budget', async (t) => {
  const { result, sent } = await fakeModelProbe(t, { codex: true })
  assert.equal(result.status, 'asked')
  assert.equal(sent.length, 2)
  assert.equal(new Set(sent.map((request) => request.threadId)).size, 1)
  assert.equal(result.facts.refresh.openSessionSeesChange, 'yes')
})

test('verified sandbox ask admits the declared key and cannot reopen a fixture to reset the prompt cap', async (t) => {
  const previous = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'synthetic-env-value'
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous })
  const { result, fixture, captures, agent } = await fakeModelProbe(t, { verified: true, key: true })
  assert.equal(result.status, 'asked')
  assert.equal(result.isolation, 'strict')
  assert.equal(result.auth, 'environment key')
  assert.doesNotMatch(JSON.stringify({ result, captures }), /synthetic-env-value/)
  const saved = await writeResult(result, join(fixture.root, 'results'), fixture)
  assert.doesNotMatch(await readFile(saved, 'utf8'), /synthetic-env-value/)
  assert.equal((await askAgent(agent, fixture, { agentId: agent.id, ask: true })).reason, 'model session already used')
})

async function fakeAcpProbe(t, overrides = {}, rejectInitialize = false) {
  const root = await mkdtemp('/tmp/hd-measure-acp-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const requests = join(root, 'requests.jsonl')
  const source = await readFile(new URL('../../packages/adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url), 'utf8')
  // Use the real scripted peer, adding request capture and strict v1 validation.
  const peer = join(root, 'fake-acp-agent.mjs')
  await writeFile(peer, source
    .replace('initialize: (id, params) => {', `initialize: (id, params) => {
      if (${rejectInitialize} || params?.protocolVersion !== 1) return fail(id, 'invalid protocol version');`)
    .replace('const handler = handlers[message.method]', `appendFileSync(${JSON.stringify(requests)}, JSON.stringify(message) + '\\n');
  const handler = handlers[message.method]`))
  const probes = new Map()
  installProbes({
    registerProbe: (id, probe) => probes.set(id, probe),
    run: async (command, args, passedFixture) => {
      assert.equal(passedFixture, fixture)
      const { stdout, stderr } = await promisify(execFile)(command, args, {
        cwd: fixture.repo, env: { ...safeEnv(fixture), ...overrides }, timeout: 25_000,
      })
      return { code: 0, stdout, stderr }
    },
  })
  const result = await probes.get('gemini')({ command: process.execPath, acp: { args: [peer] } }, fixture)
  const sent = (await readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse)
  return { result, sent, fixture }
}

test('ACP probe initializes and creates a session against the scripted peer without a prompt', async (t) => {
  const { result, sent, fixture } = await fakeAcpProbe(t)
  assert.equal(result.status, 'asked')
  assert.deepEqual(sent.map((request) => request.method), ['initialize', 'session/new'])
  assert.deepEqual(sent[0].params, { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'harnessdesk-measure', title: 'HarnessDesk', version: '1.0.0' } })
  assert.deepEqual(sent[1].params, { cwd: fixture.repo, mcpServers: [] })
  assert.equal(result.facts.signedOutCatalogue.observation, 'session-created')
  assert.equal(result.facts.signedOutCatalogue.initializeAnswered, true)
  assert.equal(result.facts.signedOutCatalogue.sessionNewAnswered, true)
  assert.equal(result.facts.signedOutCatalogue.signInMethodCount, 1)
  assert.equal(result.facts.reportsCatalogue, false)
  assert.doesNotMatch(JSON.stringify(result), /device|Sign in on the agent side|acp-session-/)
  validateResult({ agent: 'Gemini CLI', agentId: 'gemini', version: '1.0.0', measured: '2026-10-02', ...result }, fixture)
})

test('ACP probe records an auth error as an answered session refusal', async (t) => {
  const { result } = await fakeAcpProbe(t, { FAKE_ACP_AUTH_REQUIRED: '1' })
  assert.equal(result.status, 'asked')
  assert.equal(result.facts.signedOutCatalogue.observation, 'no-session')
  assert.equal(result.facts.signedOutCatalogue.sessionNewAnswered, true)
  assert.equal(result.facts.signedOutCatalogue.sessionNewErrorCode, -32000)
  assert.doesNotMatch(JSON.stringify(result), /Authentication|authenticate|device/)
})

test('ACP probe records an initialize error without requesting a session', async (t) => {
  const { result, sent } = await fakeAcpProbe(t, {}, true)
  assert.equal(result.status, 'asked')
  assert.equal(result.facts.signedOutCatalogue.observation, 'no-session')
  assert.equal(result.facts.signedOutCatalogue.initializeAnswered, true)
  assert.equal(result.facts.signedOutCatalogue.initializeErrorCode, -32600)
  assert.equal(result.facts.signedOutCatalogue.sessionNewAnswered, false)
  assert.deepEqual(sent.map((request) => request.method), ['initialize'])
})

test('ACP probe preserves the initialize answer when session/new times out', async (t) => {
  const { result } = await fakeAcpProbe(t, { FAKE_ACP_SLOW_OPEN_MS: '13000' })
  assert.equal(result.status, 'could-not-ask')
  assert.equal(result.facts.signedOutCatalogue.initializeAnswered, true)
  assert.equal(result.facts.signedOutCatalogue.sessionNewAnswered, false)
  assert.equal(result.reason, 'ACP session request unavailable')
})

test('ACP probe distinguishes a failed launch from a protocol timeout', async () => {
  const probes = new Map()
  installProbes({ registerProbe: (id, probe) => probes.set(id, probe), run: async () => ({ code: 2, stdout: '' }) })
  const result = await probes.get('gemini')({ command: 'not-installed', acp: { args: [] } }, { repo: '/tmp' })
  assert.equal(result.reason, 'ACP launch unavailable')
})

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
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'secret-command' }] } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'private-id' } }),
  ].join('\n'))
  assert.deepEqual(summarizeAcpMessages(messages), { initialized: true, sessionCreated: true, signedOutFailure: false, commandCount: 1, signedOutObservation: 'session-created', initializeAnswered: true, sessionNewAnswered: true, signInMethodCount: 0 })
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

// ---------------------------------------------------------------------------
// Round B2c: the permission answer, what a failed prompt saw, how an agent is
// stopped, how a fixture is removed, and Cursor's version and install layout.
// ---------------------------------------------------------------------------

async function waitFor(condition, what, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

// The probes' `run` without the sandbox: a scripted peer is a plain Node script and needs none.
const unsandboxedRun = (fixture, captures = []) => async (command, args, passedFixture, options = {}) => {
  assert.equal(passedFixture, fixture)
  const result = await promisify(execFile)(command, args, { cwd: fixture.repo, env: { ...safeEnv(fixture), ...options.envOverrides }, timeout: 30_000 })
  captures.push(result.stdout + result.stderr)
  return { code: 0, ...result }
}

const askedRefreshQuestion = "params.prompt[0].text.includes('one JSON object with only')"
const finishingTheTurn = (answer) => `
  update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(${askedRefreshQuestion} ? { description: 'REFRESHED_SENTINEL' } : ${JSON.stringify(answer)}) } });
  return reply(id, { stopReason: 'end_turn' });
`

// The real scripted ACP peer with its session/prompt handler (and, when given, a
// tail of startup code) replaced, so a test can play an agent that asks for
// permission, goes quiet, fails or leaves a helper running. `messages` is
// everything the client wrote to the peer, answers to the peer's own requests
// included.
async function scriptedAcpAsk(t, { prompt = ({ answer }) => finishingTheTurn(answer), startup = '', verified = false, discovery = false, promptTimeoutMs = 5000 } = {}) {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-script-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const entries = await populateSkillRoots(fixture, { user: ['~/.gemini/skills'], project: ['.gemini/skills'] })
  if (verified) assert.equal(await prepareSandbox(fixture), true, fixture.isolation.reason)
  const answer = {
    rules: [fixture.ruleSentinels[join(fixture.repo, 'GEMINI.md')]],
    skills: entries.filter((entry) => entry.scope === 'project' && entry.sentinel).map(({ name, sentinel }) => ({ name, description: sentinel })),
    mcp: ['measure_fixture'],
  }
  const log = join(fixture.root, 'client-messages.jsonl')
  let source = await readFile(new URL('../../packages/adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url), 'utf8')
  for (const [anchor, replacement] of [
    ["if (typeof message.id === 'number' && pendingOutgoing.has(message.id)) {", `appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + '\\n');\n  if (typeof message.id === 'number' && pendingOutgoing.has(message.id)) {`],
    ["'session/prompt': (id, params) => void runPrompt(id, params),", `'session/prompt': async (id, params) => {${prompt({ answer })}},`],
    // The peer announces its commands right after it opens a session. Through a busy pipe that can arrive after the
    // client has already sent its prompt, and the driver then counts it, rightly: but which prompt it lands in is not
    // what these tests are about, so the staged peer does not send it and every count below is the prompt handler's own.
    ["    update(state.id, {\n      sessionUpdate: 'available_commands_update',", "    if (false) update(state.id, {\n      sessionUpdate: 'available_commands_update',"],
  ]) {
    assert.ok(source.includes(anchor), `the scripted ACP peer changed under this test: ${anchor}`)
    source = source.replace(anchor, () => replacement)
  }
  const peer = join(fixture.root, 'scripted-peer.mjs')
  await writeFile(peer, source + startup)
  const probes = new Map()
  const captures = []
  const sandboxed = async (command, args, passedFixture, options) => {
    const result = await run(command, args, passedFixture, options)
    captures.push(result.stdout + result.stderr)
    return result
  }
  installProbes({ registerProbe: (id, probe) => probes.set(id, probe), createPromptBudget: harness.createPromptBudget, run: verified ? sandboxed : unsandboxedRun(fixture, captures) })
  const agent = { id: 'gemini', name: 'Gemini CLI', version: '1.0.0', home: { path: '~/.gemini' }, auth: { secrets: [{ env: 'GEMINI_API_KEY' }] }, command: process.execPath, acp: { args: [peer] } }
  let result
  if (discovery) result = await probes.get('gemini')(agent, fixture)
  else if (verified) {
    registerProbe('gemini', probes.get('gemini'))
    result = await askAgent(agent, fixture, { agentId: 'gemini', ask: true })
  } else result = await probes.get('gemini')(agent, fixture, { ask: true, promptTimeoutMs, envOverrides: {}, allowedEnv: [] })
  const messages = existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  return { result, fixture, captures, messages }
}

const permissionOptions = [
  { optionId: 'allow-once-1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always-1', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once-1', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always-1', name: 'Always reject', kind: 'reject_always' },
]

// An agent that will not finish its turn until the client has answered a
// permission request with a valid refusal: a `cancelled` outcome, or the option
// it offered to reject once. With `retryOnError` it behaves the way Gemini was
// seen to: an answer that is a JSON-RPC error does not end the turn, it is asked again.
const askingPermission = ({ options, retryOnError = false }) => ({ answer }) => `
  if (!${askedRefreshQuestion}) {
    const options = ${JSON.stringify(options)};
    const ask = () => request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'synthetic-call', title: 'synthetic tool', kind: 'other', status: 'pending' }, options });
    let outcome;
    ${retryOnError
      ? 'for (;;) { try { ({ outcome } = await ask()); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) } }'
      : "try { ({ outcome } = await ask()) } catch { return fail(id, 'the permission request was answered with an error') }"}
    const picked = options.find((option) => option.optionId === outcome?.optionId);
    const refused = outcome?.outcome === 'cancelled' || (outcome?.outcome === 'selected' && picked?.kind === 'reject_once');
    if (!refused) return fail(id, 'the client did not refuse the permission request');
  }
  ${finishingTheTurn(answer)}
`

// An agent that talks and asks for things and then never ends its turn. Every
// string it uses says CANARY; none of them may come back out of the harness.
const goingQuiet = () => `
  const session = params.sessionId;
  const say = (kind, body = {}) => update(session, { sessionUpdate: kind, ...body });
  for (let n = 0; n < 3; n += 1) say('agent_thought_chunk', { content: { type: 'text', text: 'CANARY_THOUGHT_TEXT' } });
  for (let n = 0; n < 2; n += 1) say('tool_call', { toolCallId: 'CANARY_TOOL_CALL_ID', title: 'CANARY_TOOL_NAME', kind: 'execute', status: 'pending', rawInput: { command: 'CANARY_COMMAND', path: '/CANARY/path' } });
  for (let n = 0; n < 2; n += 1) say('tool_call_update', { toolCallId: 'CANARY_TOOL_CALL_ID', status: 'in_progress' });
  say('plan', { entries: [{ content: 'CANARY_PLAN_TEXT', priority: 'high', status: 'pending' }] });
  say('agent_message_chunk', { content: { type: 'text', text: 'CANARY_MESSAGE_TEXT' } });
  say('CANARY_UNKNOWN_KIND', { content: 'CANARY_UNKNOWN_PAYLOAD' });
  notify('CANARY/notification', { detail: 'CANARY_NOTIFICATION_PAYLOAD' });
  for (const [method, body] of [
    ['session/request_permission', { toolCall: { toolCallId: 'CANARY_TOOL_CALL_ID', title: 'CANARY_TOOL_NAME' }, options: [{ optionId: 'CANARY_OPTION_ID', name: 'CANARY_OPTION_NAME', kind: 'allow_once' }] }],
    ['fs/read_text_file', { path: '/CANARY/path/to/file' }],
    ['terminal/create', { command: 'CANARY_COMMAND' }],
    ['CANARY/request', { detail: 'CANARY_REQUEST_PAYLOAD' }],
  ]) request(method, { sessionId: session, ...body }).catch(() => {});
`

test('an ACP permission request is refused the way the protocol specifies and nothing else is answered', () => {
  const { answerClientRequest } = probeModule
  const permission = (params) => answerClientRequest({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params }, true)
  assert.deepEqual(permission({ options: permissionOptions }), { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'selected', optionId: 'reject-once-1' } } })
  // The request's own reject_once option wherever it sits; never an allow, never a standing reject.
  assert.equal(permission({ options: permissionOptions.toReversed() }).result.outcome.optionId, 'reject-once-1')
  for (const options of [
    permissionOptions.filter((option) => option.kind.startsWith('allow')),
    permissionOptions.filter((option) => option.kind !== 'reject_once'),
    [], undefined, null, 'reject_once', { kind: 'reject_once', optionId: 'reject-once-1' },
    [null, 7, 'reject_once', {}], [{ kind: 'reject_once' }], [{ kind: 'reject_once', optionId: '' }], [{ kind: 'reject_once', optionId: 7 }],
  ]) assert.deepEqual(permission({ options }), { jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } }, JSON.stringify(options))
  assert.deepEqual(permission(undefined).result, { outcome: { outcome: 'cancelled' } })
  // The client advertises neither fs nor terminal, so those, and anything the harness has no name for,
  // keep the method-not-found error; so does every request to a peer that is not ACP.
  for (const method of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill', 'unknown/method']) {
    assert.deepEqual(answerClientRequest({ id: 9, method, params: {} }, true), { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'not available' } }, method)
  }
  assert.deepEqual(answerClientRequest({ id: 3, method: 'session/request_permission', params: { options: permissionOptions } }, false), { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'not available' } })
})

test('agent messages are classified only into the fixed vocabulary', () => {
  const { classifyAgentMessage, ACP_ACTIVITY } = probeModule
  const kind = (message) => classifyAgentMessage(message, ACP_ACTIVITY)
  for (const update of ACP_ACTIVITY.updates) assert.equal(kind({ method: 'session/update', params: { update: { sessionUpdate: update } } }), update)
  for (const [method, name] of Object.entries(ACP_ACTIVITY.requests)) assert.equal(kind({ id: 4, method, params: {} }), name)
  // A kind or a method the harness has no name for is counted, never echoed.
  for (const message of [
    { method: 'session/update', params: { update: { sessionUpdate: 'private_kind_name' } } },
    { method: 'session/update', params: { update: { sessionUpdate: '__proto__' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'constructor' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 42 } } },
    { method: 'session/update', params: { update: null } }, { method: 'session/update' },
    { method: 'private/notification', params: {} },
    { id: 5, method: 'private/request', params: {} }, { id: 5, method: '__proto__' }, { id: 5, method: 'constructor' }, { id: 5, method: 'toString' },
    // A notification named like a request is not that request: it carries no id.
    { method: 'fs/read_text_file', params: {} },
  ]) assert.equal(kind(message), 'other', JSON.stringify(message))
  // Answers to the client's own requests, and anything that is not a message, count for nothing.
  for (const message of [{ id: 1, result: {} }, { id: 2, error: { code: -32000, message: 'private detail' } }, null, 'text', 7, []]) assert.equal(kind(message), null)
})

test('an agent that asks for permission finishes its turn only after a valid refusal, and nothing is allowed', async (t) => {
  for (const [offered, outcome] of [
    [permissionOptions, { outcome: 'selected', optionId: 'reject-once-1' }],
    [permissionOptions.filter((option) => option.kind.startsWith('allow')), { outcome: 'cancelled' }],
    [permissionOptions.filter((option) => option.kind !== 'reject_once'), { outcome: 'cancelled' }],
  ]) {
    const kinds = offered.map((option) => option.kind).join(',')
    const { result, messages } = await scriptedAcpAsk(t, { prompt: askingPermission({ options: offered }) })
    assert.equal(result.status, 'asked', kinds)
    assert.equal(Object.hasOwn(result.facts, 'promptActivity'), false, 'a turn that completed carries no failure diagnostic')
    const answers = messages.filter((message) => message.id > 1000)
    assert.deepEqual(answers.map((message) => message.result), [{ outcome }], kinds)
    assert.ok(answers.every((message) => message.error === undefined), kinds)
  }
})

test('an agent that asks again after an error answer is no longer left waiting', async (t) => {
  const { result, messages } = await scriptedAcpAsk(t, { prompt: askingPermission({ options: permissionOptions, retryOnError: true }), promptTimeoutMs: 10_000 })
  assert.equal(result.status, 'asked', result.reason)
  assert.equal(messages.filter((message) => message.id > 1000).length, 1, 'one valid answer, not an error repeated until the deadline')
})

test('the refusal also ends the turn under the verified sandbox', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const { result } = await scriptedAcpAsk(t, { prompt: askingPermission({ options: permissionOptions }), verified: true })
  assert.equal(result.status, 'asked', result.reason)
  assert.equal(result.isolation, 'strict')
})

// A Codex-shaped peer, as small as the model driver needs: during its turn it makes one request of its client and
// logs the answer. The request is shaped like an ACP permission request on purpose, so a driver that answered it
// with an outcome would show. Only ACP agents are refused that way; this driver is the one that was not changed.
test('the app-server driver still answers every request it is sent with method-not-found', async (t) => {
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-codex-requests-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  await populateSkillRoots(fixture, { user: ['~/.codex/skills'], project: ['.codex/skills'] })
  const log = join(fixture.root, 'client-answers.jsonl')
  const peer = join(fixture.root, 'codex-peer.mjs')
  await writeFile(peer, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === 'peer-request') {
    appendFileSync(${JSON.stringify(log)}, line + '\\n')
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
  } else if (message.method === 'initialize') send({ id: message.id, result: {} })
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } })
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } })
    send({ id: 'peer-request', method: 'session/request_permission', params: { options: ${JSON.stringify(permissionOptions)} } })
  }
})
`)
  fs.chmodSync(peer, 0o755)
  const probes = new Map()
  installProbes({ registerProbe: (id, probe) => probes.set(id, probe), createPromptBudget: harness.createPromptBudget, run: unsandboxedRun(fixture) })
  const agent = { id: 'codex', name: 'Codex', version: '1.0.0', home: { path: '~/.codex' }, auth: { secrets: [] }, command: peer }
  await probes.get('codex')(agent, fixture, { ask: true, promptTimeoutMs: 10_000, envOverrides: {}, allowedEnv: [] })
  const answers = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(answers.length >= 1, 'the peer was answered')
  for (const answer of answers) assert.deepEqual(answer, { jsonrpc: '2.0', id: 'peer-request', error: { code: -32601, message: 'not available' } })
})

test('a prompt that times out persists counts of the message kinds it saw and nothing else', async (t) => {
  const { result, captures, fixture } = await scriptedAcpAsk(t, { prompt: goingQuiet, promptTimeoutMs: 3000 })
  assert.equal(result.status, 'could-not-ask')
  assert.equal(result.reason, 'prompt timed out')
  assert.deepEqual(result.facts.promptActivity, {
    agent_thought_chunk: 3, tool_call: 2, tool_call_update: 2, plan: 1, agent_message_chunk: 1,
    session_request_permission: 1, fs_read_text_file: 1, terminal_create: 1, other: 3,
  })
  const saved = await writeResult({ agent: 'Gemini CLI', agentId: 'gemini', version: '0.62.0', measured: '2026-10-03', isolation: 'strict', auth: 'environment key', ...result }, join(fixture.root, 'results'), fixture)
  const persisted = await readFile(saved, 'utf8')
  assert.match(persisted, /"promptActivity"/)
  assert.doesNotMatch(JSON.stringify(result) + persisted + captures.join('\n'), /CANARY|acp-session-/)
  assert.ok(!persisted.includes(fixture.root), 'no path of the machine')
})

test('the activity counted is the failing prompt\'s own, and a rejected prompt carries it too', async (t) => {
  const { result, captures } = await scriptedAcpAsk(t, {
    prompt: ({ answer }) => `
      if (${askedRefreshQuestion}) {
        update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'CANARY_TOOL_CALL_ID', title: 'CANARY_TOOL_NAME', kind: 'other', status: 'pending' });
        return send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { details: 'CANARY_ERROR_DETAIL' } } });
      }
      update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'CANARY_FIRST_PROMPT' } });
      update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'CANARY_FIRST_PROMPT' } });
      ${finishingTheTurn(answer)}
    `,
  })
  assert.equal(result.status, 'could-not-ask')
  assert.deepEqual(result.facts.requestFailure, { stage: 'prompt', errorClass: 'internal-error' })
  assert.deepEqual(result.facts.promptActivity, { tool_call: 1 }, 'the first prompt\'s two thought chunks belong to a prompt that succeeded')
  assert.doesNotMatch(JSON.stringify(result) + captures.join('\n'), /CANARY/)
})

test('a flood of agent messages is counted up to the cap and still persists', async (t) => {
  const { result, fixture } = await scriptedAcpAsk(t, {
    prompt: () => `for (let n = 0; n < 600; n += 1) update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } });`,
    promptTimeoutMs: 4000,
  })
  assert.equal(result.reason, 'prompt timed out')
  assert.deepEqual(result.facts.promptActivity, { agent_thought_chunk: 500 })
  await writeResult({ agent: 'Gemini CLI', agentId: 'gemini', version: '0.62.0', measured: '2026-10-03', isolation: 'strict', auth: 'environment key', ...result }, join(fixture.root, 'results'), fixture)
})

test('persisted prompt activity admits only the fixed vocabulary with bounded counts', () => {
  const fixture = { ruleSentinels: {}, skills: { sentinel: '/tmp/measure-sentinel' } }
  const failed = { agent: 'Gemini CLI', agentId: 'gemini', version: '0.62.0', measured: '2026-10-03', interface: 'ACP model prompt', question: 'rules catalogue precedence rejections refresh mcp', rawAnswer: '', status: 'could-not-ask', reason: 'prompt timed out', facts: {} }
  const { ACP_ACTIVITY } = probeModule
  const everyKind = [...ACP_ACTIVITY.updates, ...Object.values(ACP_ACTIVITY.requests), 'other']
  for (const promptActivity of [{}, { other: 1 }, Object.fromEntries(everyKind.map((kind) => [kind, 500]))]) {
    assert.equal(validateResult({ ...failed, facts: { promptActivity } }, fixture).status, 'could-not-ask')
  }
  for (const promptActivity of [
    { read_file: 1 }, { bash: 1 }, { read_secret_file: 1 }, { 'tool_call ': 1 }, { Tool_Call: 1 }, { tool_call: 501 }, { tool_call: -1 }, { tool_call: 1.5 },
    { tool_call: '2' }, { tool_call: null }, { tool_call: { count: 1 } }, [], [1], 'tool_call', null, 3,
  ]) assert.throws(() => validateResult({ ...failed, facts: { promptActivity } }, fixture), /fixture-derived allowlist/, JSON.stringify(promptActivity))
})

test('a probe that reports activity outside the vocabulary loses its facts, not the run', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  // A tool's name is the kind of key an agent could put here, and it passes every generic rule on facts, so only the
  // vocabulary refuses it. (A key that names a secret is refused by those rules already and would prove nothing.)
  let answer
  registerProbe('activity-test-agent', async () => answer)
  const agent = { id: 'activity-test-agent', name: 'Test Agent', home: { path: '~/.activity-test' }, auth: { secrets: [{ env: 'GEMINI_API_KEY' }] } }
  const previous = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'synthetic-env-value'
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous })
  // A model run is allowed once per fixture, so each answer gets a fixture of its own.
  const ask = async (reply) => {
    answer = reply
    const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-activity-'))
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    assert.equal(await prepareSandbox(fixture), true, fixture.isolation.reason)
    return askAgent(agent, fixture, { agentId: agent.id, ask: true, envName: 'GEMINI_API_KEY' })
  }
  const question = 'rules catalogue precedence rejections refresh mcp'
  const failed = (promptActivity) => ({ status: 'could-not-ask', reason: 'prompt timed out', interface: 'ACP model prompt', question, facts: { promptActivity } })
  const reached = (promptActivity) => ({ status: 'asked', rawAnswer: '', interface: 'ACP model prompt', question, facts: { signedOutCatalogue: { status: 'unknown', observation: 'session-created' }, promptActivity } })

  assert.deepEqual((await ask(failed({ tool_call: 1 }))).facts.promptActivity, { tool_call: 1 }, 'a name from the vocabulary is kept')
  const unnamed = await ask(failed({ read_file: 1 }))
  assert.equal(unnamed.status, 'could-not-ask')
  assert.equal(unnamed.reason, 'prompt timed out', 'the run keeps its reason')
  assert.equal(Object.hasOwn(unnamed.facts, 'promptActivity'), false, 'and loses the facts')
  // The same guard on an answer that claims success, which a probe never sends for a failed prompt. Its own reason tells
  // it from the final check in validateResult, which the stand-in agent below would trip over later.
  assert.equal((await ask(reached({ read_file: 1 }))).reason, 'parsed facts failed the privacy allowlist')
  assert.notEqual((await ask(reached({ tool_call: 1 }))).reason, 'parsed facts failed the privacy allowlist', 'the same facts under a name from the vocabulary pass that guard')
})

test('stopping an agent waits for every process it started and kills the ones that will not leave', async (t) => {
  const { stopProcessGroup } = probeModule
  const root = await mkdtemp('/tmp/hd-measure-group-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const startGroup = async (name, helper) => {
    const ready = join(root, `${name}.ready`)
    const late = join(root, `${name}.late`)
    const leader = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(helper(ready, late))}], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `], { detached: true, stdio: 'ignore' })
    t.after(() => { try { process.kill(-leader.pid, 'SIGKILL') } catch { /* already gone */ } })
    await waitFor(() => existsSync(ready), `${name} helper`)
    return { leader, late }
  }
  const slow = await startGroup('slow', (ready, late) => `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(late)}, 'flushed'); process.exit(0) }, 400));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `)
  // The grace is generous here: what is asserted is that the stop waits for the helper, and a busy machine must not turn that into a kill.
  await stopProcessGroup(slow.leader, 10_000)
  assert.throws(() => process.kill(-slow.leader.pid, 0), { code: 'ESRCH' }, 'the helper was still running when the stop returned')
  assert.equal(existsSync(slow.late), true, 'the helper was given its time to finish, not killed on the spot')

  const stubborn = await startGroup('stubborn', (ready) => `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `)
  const started = Date.now()
  await stopProcessGroup(stubborn.leader, 150)
  assert.throws(() => process.kill(-stubborn.leader.pid, 0), { code: 'ESRCH' }, 'a helper that ignores the stop signal was not killed')
  assert.ok(Date.now() - started < 5000)

  const gone = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
  await new Promise((resolve) => gone.once('close', resolve))
  await stopProcessGroup(gone)
  await stopProcessGroup({})
})

// An agent that starts a helper of its own, as real ones start bridges and
// language servers, and does not answer anything until that helper is up. The
// helper takes a third of a second to leave once told to stop, and writes as it goes: long enough that a stop which
// only waits for the agent itself returns first, short enough to finish well inside the one second the model driver allows.
const lingeringHelper = (ready, late) => `
  const fs = require('node:fs');
  process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(late)}, 'written after the stop signal'); process.exit(0) }, 300));
  fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  setInterval(() => {}, 1000);
`
const peerWithLingeringHelper = (ready, late) => `
const { spawn: helperSpawn } = process.getBuiltinModule('node:child_process');
const { existsSync: helperReady } = process.getBuiltinModule('node:fs');
helperSpawn(process.execPath, ['-e', ${JSON.stringify(lingeringHelper(ready, late))}], { stdio: 'ignore' });
for (let waited = 0; !helperReady(${JSON.stringify(ready)}) && waited < 20000; waited += 10) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
`

test('an agent helper still shutting down is gone before a probe returns, so nothing writes into the fixture afterwards', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-linger-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const afterwards = async (mode, ready, late) => {
    const pid = Number(await readFile(ready, 'utf8'))
    t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } })
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${mode}: the agent's helper outlived the probe`)
    assert.equal(existsSync(late), true, `${mode}: the helper was killed instead of being let finish`)
  }
  for (const [mode, options] of [['ask', {}], ['discovery', { discovery: true }]]) {
    const ready = join(root, `${mode}.ready`)
    const late = join(root, `${mode}.late`)
    await scriptedAcpAsk(t, { ...options, startup: peerWithLingeringHelper(ready, late) })
    await afterwards(mode, ready, late)
  }
  // The Codex app-server driver stops its child through the same call.
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-linger-codex-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const ready = join(root, 'codex.ready')
  const late = join(root, 'codex.late')
  const peer = join(fixture.root, 'codex-peer.mjs')
  const source = (await readFile(new URL('../../packages/adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url), 'utf8')).replace(/^#!.*\n/, `#!${process.execPath}\n`)
  await writeFile(peer, source + peerWithLingeringHelper(ready, late))
  fs.chmodSync(peer, 0o755)
  const probes = new Map()
  installProbes({ registerProbe: (id, probe) => probes.set(id, probe), createPromptBudget: harness.createPromptBudget, run: unsandboxedRun(fixture) })
  await probes.get('codex')({ id: 'codex', name: 'Codex', command: peer }, fixture)
  await afterwards('codex discovery', ready, late)
})

test('a fixture folder that cannot be removed is reported by name and code alone, after bounded retries', async () => {
  const { removeFixtureRoot } = harness
  const calls = []
  assert.equal(await removeFixtureRoot('/tmp/hd-measure-AbC123', async (path, options) => { calls.push({ path, options }) }), null)
  assert.deepEqual(calls, [{ path: '/tmp/hd-measure-AbC123', options: { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } }])
  const refused = (error) => async () => { throw error }
  assert.deepEqual(
    await removeFixtureRoot('/tmp/hd-measure-AbC123', refused(Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir '/tmp/hd-measure-AbC123/home/Library'"), { code: 'ENOTEMPTY', path: '/tmp/hd-measure-AbC123/home/Library' }))),
    { folder: 'hd-measure-AbC123', code: 'ENOTEMPTY' },
  )
  // Whatever else an error carries is not reported: not a message, not a path, not a code that is not an errno name.
  for (const error of [new Error('plain failure in /tmp/hd-measure-AbC123'), Object.assign(new Error('x'), { code: 'not an errno /tmp/secret' }), Object.assign(new Error('x'), { code: 13 }), null, undefined, 'text']) {
    assert.deepEqual(await removeFixtureRoot('/tmp/hd-measure-AbC123', refused(error)), { folder: 'hd-measure-AbC123', code: 'unknown' })
  }
})

test('a folder that cannot be removed leaves the written result alone, on its own line with its own exit code', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const root = await mkdtemp('/tmp/hd-measure-cli-')
  const startedAt = Date.now()
  t.after(async () => {
    // The folder this test makes unremovable on purpose: only one born during this test, holding this test's sentinel.
    for (const name of await readdir('/tmp')) {
      const kept = join('/tmp', name)
      if (!name.startsWith('hd-measure-') || fs.statSync(kept).birthtimeMs < startedAt - 1000 || !existsSync(join(kept, 'home/kept/inner/sentinel'))) continue
      spawnSync('chmod', ['-R', 'u+rwx', kept])
      await rm(kept, { recursive: true, force: true })
    }
    await rm(root, { recursive: true, force: true })
  })
  for (const path of ['script/measure/probes', 'packages/server/src/installs', 'packages/server/dist/src/installs', 'bin']) fs.mkdirSync(join(root, path), { recursive: true })
  for (const path of ['script/measure/library.mjs', 'script/measure/probes/index.mjs', 'packages/server/src/installs/known-agents.ts']) {
    await writeFile(join(root, path), await readFile(new URL(`../../${path}`, import.meta.url)))
  }
  // An agent whose sandboxed run leaves behind a folder nothing can empty: a directory it made and then took write permission from.
  const agent = join(root, 'bin/synthetic-agent')
  await writeFile(agent, '#!/bin/sh\nmkdir -p "$HOME/kept/inner" && echo kept > "$HOME/kept/inner/sentinel" && chmod 500 "$HOME/kept"\necho 1.2.3\n', { mode: 0o755 })
  const real = fs.realpathSync(agent)
  await writeFile(join(root, 'packages/server/dist/src/installs/known-agents.js'), `export const KNOWN_AGENTS = [{ id: 'cursor', name: 'Cursor', brand: 'cursor', home: { path: '~/.cursor' }, cli: { commands: ['synthetic-agent'] } }]`)
  await writeFile(join(root, 'packages/server/dist/src/installs/locate.js'), [
    `export const candidatePaths = () => [${JSON.stringify(real)}]`,
    `export const findInstalls = async (spec, { probe }) => (await probe(${JSON.stringify(real)}, ['--version'])) ? [{ path: ${JSON.stringify(real)}, realPath: ${JSON.stringify(real)}, version: '1.2.3' }] : []`,
    `export const judgeInstalls = (found) => ({ chosen: found[0] ? { ...found[0], standing: 'chosen' } : null, copies: found })`,
  ].join('\n'))
  const execution = await promisify(execFile)(process.execPath, [fs.realpathSync(join(root, 'script/measure/library.mjs')), '--agent', 'cursor'], { env: process.env }).catch((error) => error)
  assert.equal(execution.code, 3, execution.stderr)
  assert.match(execution.stdout, /^could-not-ask: cursor 1\.2\.3$/m, 'the result line was printed')
  const written = JSON.parse(await readFile(join(root, 'docs/verification/library-measurements/cursor-1.2.3.json'), 'utf8'))
  assert.equal(written.reason, 'needs sign-in, not measured', 'the result file was written and kept')
  const lines = execution.stderr.trim().split('\n')
  assert.equal(lines.length, 1, execution.stderr)
  assert.match(lines[0], /^cleanup incomplete: hd-measure-[A-Za-z0-9]{6} was kept \(EACCES\)$/)
  assert.doesNotMatch(execution.stderr, /measurement refused|invalid arguments|isolation|\//)
})

test('Cursor\'s calendar version is read exactly and nothing looser is', () => {
  assert.equal(normalizeVersion('2026.09.28-64d2043'), '2026.09.28-64d2043')
  for (const value of [
    '2026.09.28-64D2043', '2026.9.28-64d2043', '2026.09.28-64d204', '2026.09.28-64d20431', '2026.09.28-64d204g', '2026.09.28-',
    '2026.09.28-64d2043+build', '2026.09.28-64d2043-rc', '26.09.28-64d2043', '1.2.3-abcdef1', 'v2026.09.28-64d2043', ' 2026.09.28-64d2043', '2026.09.28-64d2043\n',
  ]) assert.equal(normalizeVersion(value), 'unknown', value)
})

// Cursor's install layout, staged: a launcher on PATH that points into
// share/cursor-agent/versions/<version>/, where a script launcher finds its own
// runtime and bundle beside it. The runtime is a file of its own in the folder,
// as Cursor's is; a link out of the folder is what staging refuses.
function stageCursorInstall(base, version = '2026.09.28-64d2043', { launcher = 'cursor-agent', folder = join('share/cursor-agent/versions', version) } = {}) {
  const versionDir = join(base, folder)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.mkdirSync(join(base, 'bin'), { recursive: true })
  fs.writeFileSync(join(versionDir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(join(versionDir, 'index.js'), `if (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(`${version}\n`)})\n`)
  fs.writeFileSync(join(versionDir, launcher), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'HERE="$(dirname "$(realpath "$0")")"',
    'exec "$HERE/node" "$HERE/index.js" "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
  fs.symlinkSync(join(versionDir, launcher), join(base, 'bin', launcher))
  return { version, versionDir, launcher: join(versionDir, launcher), onPath: join(base, 'bin', launcher), bin: join(base, 'bin') }
}

test('a Cursor-shaped launcher-plus-versions install is discovered and its version read from a copy under strict isolation', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-cursor-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const install = stageCursorInstall(base)
  const priorPath = process.env.PATH
  process.env.PATH = `${install.bin}:/usr/bin:/bin`
  t.after(() => { process.env.PATH = priorPath })
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-cursor-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const agent = { id: 'cursor', name: 'Cursor', brand: 'cursor', home: { path: '~/.cursor' }, cli: { commands: ['cursor-agent'] } }
  const found = await harness.findAgentInstall(agent, fixture)
  assert.equal(found.state, 'chosen', JSON.stringify(found.copies))
  // What runs is the copy in the fixture, never the install it was copied from.
  assert.ok(under(fixture.root, found.chosen.path), 'the launcher that runs is inside the fixture')
  assert.notEqual(found.chosen.path, install.launcher)
  assert.equal(found.chosen.version, install.version)
  const captured = await harness.captureHelpVersion({ ...agent, command: found.chosen.path }, fixture)
  assert.equal(captured.version.code, 0, captured.version.stderr)
  // main() asks the model only when the two agree; a version this function would not normalize reads as "changed during discovery".
  assert.equal(captured.value, found.chosen.version)
})

test('a launcher script under a credential root is refused by the unchanged profile, and only that rule refuses it', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-credential-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  // A stand-in home: the profile is built for it exactly as the harness builds it for the real one.
  const stagedHome = join(base, 'stand-in-home')
  const fixtureRoot = join(base, 'fixture')
  fs.mkdirSync(join(fixtureRoot, 'home'), { recursive: true })
  const underCredentialRoot = stageCursorInstall(join(stagedHome, '.local'))
  const elsewhere = stageCursorInstall(join(base, 'elsewhere'))
  const profile = sandboxProfileText(stagedHome, { fixtureRoot, readPaths: [underCredentialRoot.versionDir, elsewhere.versionDir] })
  const denial = `(deny file-read* file-write* (subpath ${JSON.stringify(join(stagedHome, '.local/share'))}))`
  const lines = profile.split('\n')
  assert.ok(lines.indexOf(`(allow file-read* (subpath ${JSON.stringify(underCredentialRoot.versionDir)}))`) < lines.indexOf(denial), 'the install folder is allowed first and denied last')
  const profilePath = join(base, 'strict.sb')
  const controlPath = join(base, 'control.sb')
  fs.writeFileSync(profilePath, profile)
  fs.writeFileSync(controlPath, lines.filter((line) => line !== denial).join('\n'))
  assert.equal(lines.filter((line) => line !== denial).length, lines.length - 1, 'the control differs by that one rule')
  const version = (profileFile, launcher) => spawnSync('/usr/bin/sandbox-exec', ['-f', profileFile, launcher, '--version'], { encoding: 'utf8', cwd: fixtureRoot, env: { PATH: '/usr/bin:/bin', HOME: join(fixtureRoot, 'home') }, timeout: 30_000 })
  const refused = version(profilePath, underCredentialRoot.launcher)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /Operation not permitted/)
  const control = version(controlPath, underCredentialRoot.launcher)
  assert.equal(control.stdout.trim(), underCredentialRoot.version, control.stderr)
  const outside = version(profilePath, elsewhere.launcher)
  assert.equal(outside.stdout.trim(), elsewhere.version, outside.stderr)
})

// ---------------------------------------------------------------------------
// Round B2d: Cursor's launcher cannot run in place under the approved profile
// (the credential-root test above shows why, rule by rule), so its one version
// folder is copied into the fixture and launched from the copy, as the bundled
// bridges are. No sandbox rule changes: the profile text stays pinned by the
// test near the top of this file.
// ---------------------------------------------------------------------------

const CURSOR_AGENT = { id: 'cursor', name: 'Cursor', brand: 'cursor', home: { path: '~/.cursor' }, cli: { commands: ['cursor-agent'] } }

// The harness reads the real home and PATH from the process. A test that needs
// another home or another PATH sets them for its own length only.
function usingEnv(t, vars) {
  const prior = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]))
  Object.assign(process.env, vars)
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

// Everything under a root, in a stable order, each with its kind, size and mode.
async function walkTree(root) {
  const entries = []
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name)
      const info = fs.lstatSync(path)
      const kind = info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : info.isFile() ? 'file' : 'other'
      entries.push({ rel: relative(root, path), kind, size: kind === 'file' ? info.size : 0, mode: info.mode & 0o777 })
      if (kind === 'dir') await walk(path)
    }
  }
  await walk(root)
  return entries
}

const totalOf = (tree) => ({ files: tree.filter((entry) => entry.kind === 'file').length, bytes: tree.reduce((sum, entry) => sum + entry.size, 0) })

// A stand-in home holding Cursor's install where it really lives, behind
// ~/.local/bin and under the .local/share credential root. The harness takes
// the real home from the process, so the stand-in is the home for this test.
async function standInHome(t, version) {
  const home = fs.realpathSync(await mkdtemp('/tmp/hd-measure-cursor-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const install = stageCursorInstall(join(home, '.local'), version)
  usingEnv(t, { HOME: home, PATH: `${install.bin}:/usr/bin:/bin` })
  return { home, install }
}

test('only a launcher named for the agent, directly inside a versions/<version> folder, is staged', () => {
  const folder = '/h/.local/share/cursor-agent/versions/2026.10.01-e373342'
  assert.equal(harness.stagedInstallRoot({ id: 'cursor' }, `${folder}/cursor-agent`), folder)
  for (const [agent, path] of [
    [{ id: 'claude-code' }, `${folder}/cursor-agent`],
    [{ id: 'constructor' }, `${folder}/cursor-agent`],
    [undefined, `${folder}/cursor-agent`],
    [{ id: 'cursor' }, `${folder}/bin/cursor-agent`],
    [{ id: 'cursor' }, `${folder}/agent`],
    [{ id: 'cursor' }, '/opt/homebrew/Caskroom/cursor-cli/2026.02.13-41ac335/dist-package/cursor-agent'],
    [{ id: 'cursor' }, undefined],
  ]) assert.equal(harness.stagedInstallRoot(agent, path), null, `${agent?.id} ${path}`)
})

test('a Cursor install under a credential root is read from a copy in the fixture, where the same launcher in place is refused', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const { install } = await standInHome(t)
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-cursor-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const found = await harness.findAgentInstall(CURSOR_AGENT, fixture)
  assert.equal(found.state, 'chosen', JSON.stringify({ reason: fixture.isolation.reason, copies: found.copies }))
  assert.ok(under(fixture.root, found.chosen.path), 'the launcher that runs is inside the fixture')
  assert.equal(found.chosen.version, install.version)
  // The chosen install carries the copy's own numbers: the folder's files and bytes, and the time the copy took.
  assert.deepEqual({ files: found.chosen.staged.files, bytes: found.chosen.staged.bytes }, totalOf(await walkTree(install.versionDir)))
  assert.ok(Number.isInteger(found.chosen.staged.milliseconds) && found.chosen.staged.milliseconds >= 0)
  const captured = await harness.captureHelpVersion({ ...CURSOR_AGENT, command: found.chosen.path }, fixture)
  assert.equal(captured.version.code, 0, captured.version.stderr)
  assert.equal(captured.value, install.version)
  // Under the very profile that ran the copy, the install itself is refused: by the credential-root denial.
  const inPlace = await run(install.launcher, ['--version'], fixture)
  assert.notEqual(inPlace.code, 0)
  assert.match(inPlace.stderr, /Operation not permitted/)
  // No rule is added and none names the install: this is the plain strict profile, with no install allowance at all.
  assert.deepEqual(fixture.isolation.readPaths, [])
  assert.equal(fixture.isolation.profileText.includes(install.versionDir), false)
  assert.equal(fixture.isolation.profileText, makeSandboxProfile(fixture.root, homedir(), { isolation: 'strict' }))
})

test('only the one resolved version folder is copied, with its modes, and nothing beside it', async (t) => {
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-stage-'))
  t.after(() => { spawnSync('chmod', ['-R', 'u+rwx', base]); return rm(base, { recursive: true, force: true }) })
  const install = stageCursorInstall(base, '2026.10.01-e373342')
  // Inside the folder: nested folders and files, and a read-only folder.
  fs.mkdirSync(join(install.versionDir, 'node_modules/pkg'), { recursive: true })
  fs.writeFileSync(join(install.versionDir, 'node_modules/pkg/index.js'), 'module.exports = 1\n')
  fs.writeFileSync(join(install.versionDir, '1268.index.js'), 'chunk\n')
  fs.mkdirSync(join(install.versionDir, 'sealed'))
  fs.writeFileSync(join(install.versionDir, 'sealed/data.bin'), 'sealed data\n', { mode: 0o444 })
  fs.chmodSync(join(install.versionDir, 'sealed'), 0o555)
  // Beside it, none of which may leave: an older version, a file next to the versions folder, an unrelated app's data.
  fs.mkdirSync(join(base, 'share/cursor-agent/versions/2026.09.18-9a7762b'), { recursive: true })
  fs.writeFileSync(join(base, 'share/cursor-agent/versions/2026.09.18-9a7762b/cursor-agent'), 'OLDER_VERSION_SENTINEL\n')
  fs.writeFileSync(join(base, 'share/cursor-agent/beside-versions.json'), 'BESIDE_VERSIONS_SENTINEL\n')
  fs.mkdirSync(join(base, 'share/other-app'), { recursive: true })
  fs.writeFileSync(join(base, 'share/other-app/token.txt'), 'OTHER_APP_SENTINEL\n')
  const before = await walkTree(install.versionDir)
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-stage-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const staged = await harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture)

  // The fixture's install area holds that one folder and the folders above it, nothing else.
  const area = join(fixture.root, 'agent-install')
  assert.deepEqual(fs.readdirSync(area), ['0'])
  assert.deepEqual(fs.readdirSync(join(area, '0')), [install.version])
  const copy = join(area, '0', install.version)
  assert.equal(staged.launcher, join(copy, 'cursor-agent'))
  // The copy equals the folder, file modes kept. A folder keeps its mode too, except that its owner can always write
  // to it, so the fixture can always be removed.
  const copied = await walkTree(copy)
  assert.deepEqual(copied.map(({ rel, kind, size }) => ({ rel, kind, size })), before.map(({ rel, kind, size }) => ({ rel, kind, size })))
  for (const [index, entry] of before.entries()) assert.equal(copied[index].mode, entry.kind === 'dir' ? entry.mode | 0o700 : entry.mode, entry.rel)
  assert.ok(fs.statSync(join(copy, 'cursor-agent')).mode & 0o100, 'the launcher is still executable')
  assert.equal(fs.statSync(copy).mode & 0o777, (fs.statSync(install.versionDir).mode & 0o777) | 0o700, 'the folder itself too')
  // The numbers recorded are the copy's own: files, bytes, and the time it took, as whole numbers.
  assert.deepEqual({ files: staged.files, bytes: staged.bytes }, totalOf(before))
  assert.ok(Number.isInteger(staged.milliseconds) && staged.milliseconds >= 0, String(staged.milliseconds))
  // Nothing from beside the folder is anywhere in the fixture.
  const leaked = []
  for (const entry of await walkTree(fixture.root)) {
    if (entry.kind !== 'file') continue
    const text = await readFile(join(fixture.root, entry.rel), 'utf8')
    for (const sentinel of ['OLDER_VERSION_SENTINEL', 'BESIDE_VERSIONS_SENTINEL', 'OTHER_APP_SENTINEL']) if (text.includes(sentinel)) leaked.push(`${entry.rel}: ${sentinel}`)
  }
  assert.deepEqual(leaked, [])
  // The read-only folder does not stop the fixture from being removed.
  await rm(fixture.root, { recursive: true })
  assert.equal(existsSync(fixture.root), false)
})

test('a link that points outside the version folder is refused, and nothing is copied', async (t) => {
  const refusal = 'cannot isolate: install directory links outside itself'
  for (const [name, plant] of [
    ['an absolute link to a file outside', (dir) => { fs.rmSync(join(dir, 'node')); fs.symlinkSync(process.execPath, join(dir, 'node')) }],
    ['a relative link up and out', (dir, outside) => fs.symlinkSync(relative(dir, outside.file), join(dir, 'up'))],
    ['a link to a folder outside', (dir, outside) => fs.symlinkSync(outside.dir, join(dir, 'lib'))],
    ['a link that spells a path inside the folder and resolves outside through another link', (dir) => {
      fs.mkdirSync(join(dir, 'x/y'), { recursive: true })
      fs.symlinkSync('../..', join(dir, 'x/y/d'))
      fs.symlinkSync('x/y/d/../..', join(dir, 'l'))
    }],
  ]) {
    await t.test(name, async (t) => {
      const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-links-'))
      t.after(() => rm(base, { recursive: true, force: true }))
      const install = stageCursorInstall(base)
      const outside = { dir: join(base, 'outside'), file: join(base, 'outside/secret.txt') }
      fs.mkdirSync(outside.dir)
      fs.writeFileSync(outside.file, 'OUTSIDE_SENTINEL\n')
      plant(install.versionDir, outside)
      const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-links-fixture-'))
      t.after(() => rm(fixture.root, { recursive: true, force: true }))
      await assert.rejects(harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture), { message: refusal })
      assert.equal(existsSync(join(fixture.root, 'agent-install')), false, 'nothing was copied')
    })
  }
})

test('a link that stays inside the version folder is kept as a link inside the copy', async (t) => {
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-inner-links-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const install = stageCursorInstall(base)
  fs.mkdirSync(join(install.versionDir, 'node_modules'))
  fs.symlinkSync('index.js', join(install.versionDir, 'current.js'))
  fs.symlinkSync(join(install.versionDir, 'index.js'), join(install.versionDir, 'absolute.js'))
  fs.symlinkSync('node_modules', join(install.versionDir, 'modules'))
  fs.symlinkSync('missing.js', join(install.versionDir, 'dangling.js'))
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-inner-links-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const staged = await harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture)
  const copy = join(fixture.root, 'agent-install/0', install.version)
  for (const name of ['current.js', 'absolute.js', 'modules', 'dangling.js']) assert.ok(fs.lstatSync(join(copy, name)).isSymbolicLink(), name)
  // Every link is spelled relative to its own folder, so it means the same in the copy, and none points back at the install.
  assert.equal(fs.readlinkSync(join(copy, 'current.js')), 'index.js')
  assert.equal(fs.readlinkSync(join(copy, 'absolute.js')), 'index.js')
  assert.equal(fs.readlinkSync(join(copy, 'modules')), 'node_modules')
  assert.equal(fs.readlinkSync(join(copy, 'dangling.js')), 'missing.js')
  assert.ok(under(fs.realpathSync(copy), fs.realpathSync(join(copy, 'absolute.js'))))
  assert.equal(fs.readFileSync(join(copy, 'absolute.js'), 'utf8'), fs.readFileSync(join(install.versionDir, 'index.js'), 'utf8'))
  assert.equal(staged.files, totalOf(await walkTree(install.versionDir)).files, 'links are not counted as files')
})

test('a folder that is not Cursor\'s launcher with its runtime and bundle is not copied', async (t) => {
  const layout = 'cannot isolate: install layout not recognized'
  for (const [name, plant] of [
    ['no runtime', (install) => fs.rmSync(join(install.versionDir, 'node'))],
    ['no bundle', (install) => fs.rmSync(join(install.versionDir, 'index.js'))],
    ['a runtime that is a folder', (install) => { fs.rmSync(join(install.versionDir, 'node')); fs.mkdirSync(join(install.versionDir, 'node')) }],
  ]) {
    await t.test(name, async (t) => {
      const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-layout-'))
      t.after(() => rm(base, { recursive: true, force: true }))
      const install = stageCursorInstall(base)
      plant(install)
      const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-layout-fixture-'))
      t.after(() => rm(fixture.root, { recursive: true, force: true }))
      await assert.rejects(harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture), { message: layout })
      assert.equal(existsSync(join(fixture.root, 'agent-install')), false, 'nothing was copied')
    })
  }
  await t.test('a launcher that is not in a versions folder, or is another agent\'s', async (t) => {
    const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-layout-'))
    t.after(() => rm(base, { recursive: true, force: true }))
    const install = stageCursorInstall(base, '2026.02.13-41ac335', { folder: 'Caskroom/cursor-cli/2026.02.13-41ac335/dist-package' })
    const versions = stageCursorInstall(join(base, 'second'))
    const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-layout-fixture-'))
    t.after(() => rm(fixture.root, { recursive: true, force: true }))
    await assert.rejects(harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture), { message: layout })
    await assert.rejects(harness.stageInstallFolder({ id: 'claude-code' }, versions.launcher, fixture), { message: layout })
    assert.equal(existsSync(join(fixture.root, 'agent-install')), false, 'nothing was copied')
  })
})

test('a folder that holds anything but files, folders and links, or the home itself, is not copied', async (t) => {
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-entries-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const install = stageCursorInstall(base)
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-entries-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  // A folder that holds the home is never an install root the harness allows; staging refuses it too, whoever calls it.
  await assert.rejects(harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture, { realHome: install.versionDir }), { message: 'cannot isolate: install directory unsafe' })
  // A named pipe would block a copy forever, so it is refused before anything is read.
  assert.equal(spawnSync('mkfifo', [join(install.versionDir, 'pipe')]).status, 0)
  await assert.rejects(harness.stageInstallFolder(CURSOR_AGENT, install.launcher, fixture), { message: 'cannot isolate: install directory holds an entry that is not a file, a folder or a link' })
  assert.equal(existsSync(join(fixture.root, 'agent-install')), false, 'nothing was copied')
})

test('an install that is not Cursor\'s versions layout is launched in place, as before, with its folder allowed', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  for (const [name, agent, options] of [
    ['another agent with a versions folder', { id: 'claude-code', name: 'Claude Code', brand: 'claude', home: { path: '~/.claude' }, cli: { commands: ['claude'] } }, { launcher: 'claude' }],
    ['Cursor\'s launcher outside a versions folder', CURSOR_AGENT, { folder: 'Caskroom/cursor-cli/2026.02.13-41ac335/dist-package' }],
  ]) {
    await t.test(name, async (t) => {
      const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-inplace-'))
      t.after(() => rm(base, { recursive: true, force: true }))
      const install = stageCursorInstall(base, '2026.02.13-41ac335', options)
      usingEnv(t, { PATH: `${install.bin}:/usr/bin:/bin` })
      const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-inplace-fixture-'))
      t.after(() => rm(fixture.root, { recursive: true, force: true }))
      const found = await harness.findAgentInstall(agent, fixture)
      assert.equal(found.state, 'chosen', JSON.stringify(found.copies))
      assert.equal(found.chosen.path, install.launcher)
      assert.equal(found.chosen.staged, undefined)
      assert.deepEqual(fixture.isolation.readPaths, [install.versionDir])
      assert.equal(existsSync(join(fixture.root, 'agent-install')), false)
    })
  }
})

test('when the copy is refused nothing is launched in place instead', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  // Outside any credential root, where running in place would work: a fallback would show as a chosen install.
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-refused-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const install = stageCursorInstall(base)
  fs.rmSync(join(install.versionDir, 'node'))
  fs.symlinkSync(process.execPath, join(install.versionDir, 'node'))
  usingEnv(t, { PATH: `${install.bin}:/usr/bin:/bin` })
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-refused-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const found = await harness.findAgentInstall(CURSOR_AGENT, fixture)
  assert.equal(found.chosen, null)
  assert.equal(found.state, 'unsafe')
  assert.deepEqual(found.copies.map((copy) => copy.reason), ['cannot isolate: install directory links outside itself'])
  assert.equal(existsSync(join(fixture.root, 'agent-install')), false)
})

test('the ask path is handed the copy, and the copy runs under keychain-read-only too', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const { install } = await standInHome(t)
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-cursor-ask-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const found = await harness.findAgentInstall(CURSOR_AGENT, fixture)
  assert.equal(found.state, 'chosen', JSON.stringify({ reason: fixture.isolation.reason, copies: found.copies }))
  // A model run's steps in the order the harness takes them, with a scripted bridge in place of Cursor's and the
  // handshake alone: no prompt is sent, and no vendor agent runs.
  const packagesRoot = join(fixture.root, 'packages')
  const requests = join(fixture.root, 'bridge-requests.jsonl')
  const source = await readFile(new URL('../../packages/adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url), 'utf8')
  await mkdir(join(packagesRoot, 'cursor-acp/dist/src'), { recursive: true })
  await writeFile(join(packagesRoot, 'cursor-acp/package.json'), '{"type":"module"}')
  await writeFile(join(packagesRoot, 'cursor-acp/dist/src/main.js'), source.replace('const handler = handlers[message.method]', `appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: message.method, executable: process.env.CURSOR_ACP_COMMAND }) + '\\n');\n  const handler = handlers[message.method]`))
  const agent = { ...CURSOR_AGENT, command: found.chosen.path, acp: { args: [], bridge: { command: 'cursor-acp', args: [], executableEnv: 'CURSOR_ACP_COMMAND' } } }
  const resolved = await harness.resolveModelBridge(agent, { packagesRoot, realHome: join(fixture.root, 'real-home') })
  const stagedBridge = await harness.stageModelBridge(resolved.agent, fixture)
  assert.equal(await prepareSandbox(fixture, { isolation: KEYCHAIN_READ_ONLY, readPaths: fixture.isolation.readPaths }), true, fixture.isolation.reason)
  installProbes({ registerProbe: () => {}, createPromptBudget: harness.createPromptBudget, run })
  const result = await probeModule.probeAcpHandshake(stagedBridge, fixture)
  assert.equal(result.status, 'asked')
  assert.equal(result.prompted, false)
  const sent = (await readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(sent.length > 0 && sent.every((request) => request.executable === found.chosen.path), 'the bridge is handed the copy')
  const version = await run(found.chosen.path, ['--version'], fixture)
  assert.equal(version.stdout.trim(), install.version, version.stderr)
})

test('a staged copy and an install run in place are found side by side, and the newest wins', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  // The shape of a real machine: Cursor's own install and an older cask copy, each behind a bin folder of its own,
  // and a second link to the first. The older one is first on PATH, so only the versions can put the newer first.
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-side-by-side-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const newer = stageCursorInstall(join(base, 'own'), '2026.10.01-e373342')
  const older = stageCursorInstall(join(base, 'cask'), '2026.02.13-41ac335', { folder: 'Caskroom/cursor-cli/2026.02.13-41ac335/dist-package' })
  fs.mkdirSync(join(base, 'twin/bin'), { recursive: true })
  fs.symlinkSync(newer.launcher, join(base, 'twin/bin/cursor-agent'))
  usingEnv(t, { PATH: `${older.bin}:${newer.bin}:${join(base, 'twin/bin')}:/usr/bin:/bin` })
  const fixture = await createFixture(await mkdtemp('/tmp/hd-measure-side-by-side-fixture-'))
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const found = await harness.findAgentInstall(CURSOR_AGENT, fixture)
  assert.equal(found.state, 'chosen', JSON.stringify(found.copies))
  assert.ok(under(fixture.root, found.chosen.path), 'the newer install is run from its copy')
  assert.equal(found.chosen.version, newer.version)
  assert.deepEqual(found.copies.map((copy) => [copy.version, copy.standing]), [[newer.version, 'chosen'], [older.version, 'older']])
  // The older one was read in place, and only its folder is allowed. The newer one's folder is not.
  assert.deepEqual(fixture.isolation.readPaths, [older.versionDir])
  // One folder is one copy, however many paths lead to it.
  assert.deepEqual(fs.readdirSync(join(fixture.root, 'agent-install')), ['0'])
  assert.deepEqual(fs.readdirSync(join(fixture.root, 'agent-install/0')), [newer.version])
})

test('a persisted result may carry the copy\'s size and time as plain numbers, and nothing looser', async (t) => {
  const root = await mkdtemp('/tmp/hd-measure-staged-result-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createFixture(root)
  const discovery = {
    agent: 'Cursor', agentId: 'cursor', version: '2026.10.01-e373342', measured: '2026-10-03', interface: 'not launched',
    question: 'Is an installed build available?', rawAnswer: '', facts: {}, status: 'could-not-ask', reason: 'needs sign-in, not measured',
    isolation: 'strict', auth: 'no sign-in used',
  }
  const staged = { bytes: 619_000_000, files: 451, milliseconds: 1234 }
  assert.deepEqual(validateResult({ ...discovery, stagedInstall: staged }, fixture).stagedInstall, staged)
  assert.equal(validateResult(discovery, fixture).stagedInstall, undefined, 'a run that launched no copy records none')
  // On disk they are plain numbers under their own names.
  const path = await writeResult({ ...discovery, stagedInstall: staged }, join(root, 'results'), fixture)
  const saved = await readFile(path, 'utf8')
  assert.deepEqual(JSON.parse(saved).stagedInstall, staged)
  assert.match(saved, /"stagedInstall": \{\n {4}"bytes": 619000000,\n {4}"files": 451,\n {4}"milliseconds": 1234\n {2}\}/)
  // A model result carries them too. Counts among its facts stop at 500; these are not facts the agent reported.
  const asked = {
    ...discovery, status: 'asked', interface: 'ACP model prompt', question: 'rules catalogue precedence rejections refresh mcp', rawAnswer: 'measure-sentinel',
    facts: { precedence: { duplicateCount: 1 } }, isolation: KEYCHAIN_READ_ONLY, auth: 'owner subscription sign-in', stagedInstall: staged,
  }
  delete asked.reason
  assert.deepEqual(validateResult(asked, fixture).stagedInstall, staged)
  for (const bad of [
    { bytes: 1, files: 1 }, { ...staged, extra: 1 }, { ...staged, bytes: -1 }, { ...staged, files: 0.5 }, { ...staged, milliseconds: '12' },
    { ...staged, bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...staged, bytes: Number.NaN }, { ...staged, bytes: Infinity }, { ...staged, files: null },
    [staged.bytes, staged.files, staged.milliseconds], null, 'text', 12, {},
  ]) assert.throws(() => validateResult({ ...discovery, stagedInstall: bad }, fixture), /stagedInstall/, JSON.stringify(bad))
  // Only an agent that is staged can carry them.
  assert.throws(() => validateResult({ ...discovery, agent: 'Codex', agentId: 'codex', stagedInstall: staged }, fixture), /stagedInstall/)
})

// The command itself, from a staged copy of the harness against a scripted locator that finds exactly one install, under a stand-in home.
async function runCommandOn(t, { install, home, version, refused = false }) {
  const root = await mkdtemp('/tmp/hd-measure-cli-')
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['script/measure/probes', 'packages/server/src/installs', 'packages/server/dist/src/installs']) fs.mkdirSync(join(root, path), { recursive: true })
  for (const path of ['script/measure/library.mjs', 'script/measure/probes/index.mjs', 'packages/server/src/installs/known-agents.ts']) {
    await writeFile(join(root, path), await readFile(new URL(`../../${path}`, import.meta.url)))
  }
  await writeFile(join(root, 'packages/server/dist/src/installs/known-agents.js'), `export const KNOWN_AGENTS = [{ id: 'cursor', name: 'Cursor', brand: 'cursor', home: { path: '~/.cursor' }, cli: { commands: ['cursor-agent'] } }]`)
  await writeFile(join(root, 'packages/server/dist/src/installs/locate.js'), [
    `export const candidatePaths = () => [${JSON.stringify(install.onPath)}]`,
    `export const findInstalls = async (spec, { probe }) => (await probe(${JSON.stringify(install.onPath)}, ['--version'])) ? [{ path: ${JSON.stringify(install.onPath)}, realPath: ${JSON.stringify(install.launcher)}, version: ${JSON.stringify(version)} }] : []`,
    `export const judgeInstalls = (found) => ({ chosen: found[0] ? { ...found[0], standing: 'chosen' } : null, copies: found })`,
  ].join('\n'))
  const execution = await promisify(execFile)(process.execPath, [fs.realpathSync(join(root, 'script/measure/library.mjs')), '--agent', 'cursor'], { env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' } }).catch((error) => error)
  assert.ok(!(execution instanceof Error), `${execution.stderr}`)
  const named = refused ? 'unknown' : version
  assert.equal(execution.stdout, `could-not-ask: cursor ${named}\n`)
  assert.equal(execution.stderr, '', 'nothing was kept')
  return JSON.parse(await readFile(join(root, `docs/verification/library-measurements/cursor-${named}.json`), 'utf8'))
}

test('the copy lives in the fixture and goes with it, and the written result records its size and time', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  const home = fs.realpathSync(await mkdtemp('/tmp/hd-measure-cursor-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  // A version no other test and no real install has, so a copy left behind could not be mistaken for another run's.
  const version = '2031.07.04-c0ffee1'
  const startedAt = Date.now()
  // Whatever a failing run leaves behind goes too: only a fixture born during this test, holding this test's copy.
  const copies = async () => (await readdir('/tmp')).filter((name) => name.startsWith('hd-measure-') && existsSync(join('/tmp', name, 'agent-install/0', version)))
  t.after(async () => {
    for (const name of await copies()) if (fs.statSync(join('/tmp', name)).birthtimeMs >= startedAt - 1000) await rm(join('/tmp', name), { recursive: true, force: true })
  })
  const install = stageCursorInstall(join(home, '.local'), version)
  const before = await walkTree(install.versionDir)
  const written = await runCommandOn(t, { install, home, version })
  assert.equal(written.version, version, 'the version was read, and only the copy can have printed it here')
  assert.equal(written.reason, 'needs sign-in, not measured')
  assert.ok(written.stagedInstall, 'the result records the copy it launched')
  assert.deepEqual(Object.keys(written.stagedInstall), ['bytes', 'files', 'milliseconds'])
  assert.deepEqual({ files: written.stagedInstall.files, bytes: written.stagedInstall.bytes }, totalOf(before))
  assert.ok(Number.isInteger(written.stagedInstall.milliseconds) && written.stagedInstall.milliseconds >= 0)
  // The copy was made inside a fixture, and that fixture, copy and all, is gone with the run.
  assert.deepEqual(await copies(), [])
  // The install it was copied from is exactly as it was.
  assert.deepEqual(await walkTree(install.versionDir), before)
})

test('a run that launched the install in place records no copy', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  // Outside the home, as a Homebrew cask install is, so the stand-in home holds nothing of it.
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-inplace-'))
  const home = fs.realpathSync(await mkdtemp('/tmp/hd-measure-cursor-home-'))
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]))
  const install = stageCursorInstall(base, '2031.07.05-c0ffee2', { folder: 'Caskroom/cursor-cli/2031.07.05-c0ffee2/dist-package' })
  const written = await runCommandOn(t, { install, home, version: '2031.07.05-c0ffee2' })
  assert.equal(written.reason, 'needs sign-in, not measured')
  assert.equal(Object.hasOwn(written, 'stagedInstall'), false)
})

test('a run whose copy is refused records could-not-ask: cannot isolate, and no copy', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS only')
  // Outside any credential root, where running in place would work: a fallback to it would read the version, and it
  // would show here as a result that names one.
  const base = fs.realpathSync(await mkdtemp('/tmp/hd-measure-refused-'))
  const home = fs.realpathSync(await mkdtemp('/tmp/hd-measure-cursor-home-'))
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]))
  // A runtime linked out of the folder: the copy is refused.
  const install = stageCursorInstall(base, '2031.07.06-c0ffee3')
  fs.rmSync(join(install.versionDir, 'node'))
  fs.symlinkSync(process.execPath, join(install.versionDir, 'node'))
  const written = await runCommandOn(t, { install, home, version: '2031.07.06-c0ffee3', refused: true })
  assert.equal(written.version, 'unknown')
  assert.equal(written.status, 'could-not-ask')
  assert.equal(written.reason, 'cannot isolate')
  assert.equal(Object.hasOwn(written, 'stagedInstall'), false)
})
