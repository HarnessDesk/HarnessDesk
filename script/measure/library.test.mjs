import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import * as harness from './library.mjs'

const under = (root, path) => path.startsWith(`${root}/`) || path === root

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
    "export async function prepareSandbox(fixture, { isolation = 'strict', readPaths = [] } = {}) {",
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
