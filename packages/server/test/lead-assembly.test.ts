import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo } from './fixtures/evidence-desk.js'
import { readChecks } from '../src/evidence/checks-file.js'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import test, { after } from 'node:test'
import { createLeadJournal, type LeadJournalRecord, type LeadPermissionCall } from '@harnessdesk/lead'
import { parseLeadAcceptanceContract } from '@harnessdesk/protocol'
import { freezeLeadPlan, LeadAssembly, leadPreviewUnfit, leadProjectOf, leadSeatable, leadSeatChoices, readLeadEvidence } from '../src/lead/assembly.js'
import { tempDir } from './scratch.js'

// The desktop's own path (`createDefaultHost`) in an isolated process: no real agent homes, login shell,
// Keychain or network. The provider is a scripted transport; the key is a canary that must never leave
// the credential broker, the request headers and the process memory.
const CANARY = 'sk-ant-canary-not-a-real-key-0001' // hd-secrets-ok: a stand-in the key store must never leak
const CHECK = `
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'node:test'
const { ToolGateway } = await import(process.env.HD_TOOL_GATEWAY)
mock.method(ToolGateway.prototype, 'start', () => {})
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const out = {}
const walk = async directory => (await readdir(directory, { withFileTypes: true }).catch(() => [])).flatMap(entry =>
  entry.isDirectory() ? [] : [join(directory, entry.name)])
const everything = async root => {
  const files = []
  const visit = async directory => { for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await visit(path); else files.push(path) } }
  await visit(root)
  return files
}
const codes = async run => { try { await run(); return null } catch (error) { return error.wireCode ?? error.code ?? String(error.message) } }
const scripted = () => {
  const requests = []
  return { requests, transport: { async send(request) {
    requests.push({ headers: request.headers, body: request.body })
    return { status: 200, body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'Which retry status list do you mean?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) } } } }
}
const cipher = { protection: 'synthetic cipher', encrypt: plain => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: blob => Buffer.from(blob.toString(), 'hex').toString() }
const start = async (stateDir, options) => {
  const made = createDefaultHost({ stateDir, console: false, logLevel: 'error', codexHome: join(stateDir, 'codex'), codexBinaryPath: null, credentialCipher: cipher, ...options })
  await made.pathReady
  await made.host.start()
  const pushes = []
  made.host.addBroadcaster(notification => pushes.push(notification))
  return { ...made, pushes }
}
const stop = async made => { await made.host.dispose(); await made.extensions.dispose() }
const project = process.env.HD_PROJECT;

// Off: no assembly, no journal, every lead method refuses.
{
  const stateDir = join(process.env.HD_STATE, 'off')
  await mkdir(stateDir)
  const made = await start(stateDir, {})
  out.offThread = await codes(() => made.host.call('lead/thread/read', {}))
  out.offSettings = await codes(() => made.host.call('lead/settings/read', {}))
  out.offFiles = await everything(join(stateDir, 'lead'))
  await stop(made)
}
// On, no folder open: a calm refusal, still no journal.
{
  const stateDir = join(process.env.HD_STATE, 'nofolder')
  await mkdir(stateDir)
  const made = await start(stateDir, { leadEnabled: true })
  out.noFolder = await codes(() => made.host.call('lead/thread/read', {}))
  out.noFolderFiles = (await everything(join(stateDir, 'lead'))).length
  await stop(made)
}
// On, folder open: the page answers, a send without a key says so, then a key goes in through Settings.
const stateDir = join(process.env.HD_STATE, 'on')
await mkdir(stateDir)
const provider = scripted()
let made = await start(stateDir, { leadEnabled: true, leadMessagesTransport: provider.transport })
await made.host.call('workspace/open', { path: project })
const settings = await made.host.call('lead/settings/read', {})
out.settingsKeyBefore = settings.settings.key.configured
out.settingsCaps = settings.settings.caps
const thread = await made.host.call('lead/thread/read', {})
out.threadRevision = thread.revision
out.noKey = await codes(() => made.host.call('lead/thread/send', { idempotencyKey: 'goal-1', text: 'Make the retry status list complete' }))
out.requestsWithoutKey = provider.requests.length
const stored = await made.host.call('lead/settings/update', { expectedRevision: settings.revision, credential: { provider: 'anthropic', key: process.env.HD_CANARY } })
out.keyAfter = (stored.settings ?? {}).key?.configured ?? null
const receipt = await made.host.call('lead/thread/send', { idempotencyKey: 'goal-2', text: 'Make the retry status list complete' })
for (let waited = 0; provider.requests.length === 0 && waited < 30_000; waited += 100) await sleep(100)
out.requestsWithKey = provider.requests.length
out.requestHeaderHasKey = provider.requests.length > 0 && JSON.stringify(provider.requests[0].headers).includes(process.env.HD_CANARY)
await sleep(500)
const after = await made.host.call('lead/thread/read', {})
const bytes = []
for (const file of await everything(stateDir)) bytes.push([file, (await readFile(file).catch(() => Buffer.alloc(0))).includes(process.env.HD_CANARY)])
out.leaks = bytes.filter(([, hit]) => hit).map(([file]) => file.slice(stateDir.length))
out.resultLeak = JSON.stringify([thread, settings, stored, receipt, after, made.pushes]).includes(process.env.HD_CANARY)
out.journalFiles = (await everything(join(stateDir, 'lead'))).map(file => file.slice(stateDir.length))
out.seq = after.revision
out.messages = after.thread.messages.map(one => one.text)
out.state = [after.thread.state, after.waitReason, after.requestInFlight]
await stop(made)
// Restart: the same thread and caps come back.
made = await start(stateDir, { leadEnabled: true, leadMessagesTransport: provider.transport })
const again = await made.host.call('lead/thread/read', {})
out.restartRevision = again.revision
out.restartMessages = again.thread.messages.map(one => one.text)
out.restartCaps = (await made.host.call('lead/settings/read', {})).settings.caps
await stop(made)
process.stdout.write(JSON.stringify(out) + '\\n')
`

const shortDirs: string[] = []
after(() => { for (const dir of shortDirs) rmSync(dir, { recursive: true, force: true }) })
const shortDir = (): string => { const dir = realpathSync(mkdtempSync('/tmp/hdla-')); shortDirs.push(dir); return dir }

test('the desktop path assembles the Lead only when enabled, keeps its journal under the home and never leaks the key', { timeout: 180_000 }, async () => {
  // The Lead's private socket lives under the home and a unix socket path is capped near 104 bytes, so the
  // home is a short directory: macOS's own temporary directory is long enough to push the socket over.
  const stateDir = shortDir(), projectDir = realpathSync(tempDir('hd-lead-assembly-project-'))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: realpathSync(tempDir('hd-lead-assembly-home-')), HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: stateDir, HD_PROJECT: projectDir, HD_CANARY: CANARY, HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_TOOL_GATEWAY: new URL('../src/tool-gateway.js', import.meta.url).href }
  delete env['SHELL']
  // The Lead's own child must not inherit this runner's context, or it would report to it.
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST')) delete env[name]
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHECK], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
  const exited = await new Promise<number | null | 'hung'>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung') }, 170_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(exited, 0, `assembly child exits; stderr: ${err.replaceAll(CANARY, '<key>')}`)
  const result = JSON.parse(out.trim()) as Record<string, any>
  assert.equal(JSON.stringify(result).includes(CANARY), false)
  // Off, and on with nothing open, never creates a journal.
  assert.equal(result.offThread, 'lead-unavailable')
  assert.equal(result.offSettings, 'lead-unavailable')
  assert.deepEqual(result.offFiles, [])
  assert.equal(result.noFolder, 'lead-project-missing')
  assert.equal(result.noFolderFiles, 0)
  // On: the page answers, the journal is inside the given home, and caps are the defaults.
  assert.equal(result.settingsKeyBefore, false)
  assert.deepEqual(result.settingsCaps, { usdMicros: 1_000_000, rounds: 16 })
  assert.ok(result.journalFiles.length > 0 && result.journalFiles.every((file: string) => file.startsWith('/lead/')), `journal under the home: ${result.journalFiles}`)
  // No key: the thread says what is missing, and the provider is never called.
  assert.equal(result.noKey, 'lead-key-missing')
  assert.equal(result.requestsWithoutKey, 0)
  // With the key stored through Settings the provider is called, and the key reaches only that request.
  assert.equal(result.keyAfter, true)
  assert.ok(result.requestsWithKey >= 1, `the provider was called: ${JSON.stringify(result.state)}`)
  assert.equal(result.requestHeaderHasKey, true)
  assert.deepEqual(result.leaks, [], 'no journal, log or state file holds the key')
  assert.equal(result.resultLeak, false, 'no lead/* result or push holds the key')
  // A restart reopens the same journal.
  assert.ok(result.restartRevision >= result.seq)
  assert.deepEqual(result.restartMessages, result.messages)
  assert.equal(result.messages.length, 2, 'the goal and the reply are in the thread')
  assert.deepEqual(result.restartCaps, { usdMicros: 1_000_000, rounds: 16 })
})

const project = { id: 'acme', path: '/work/acme' }
const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Make the retry list complete', project, policyRevision: 1,
  steps: [{ id: 'work', title: 'Complete the list', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended',
    assignments: [{ role: 'implement', agent: 'implementer', seat: { runtime: 'fixture' }, ceiling: 'edit' }, { role: 'review', agent: 'code-reviewer', seat: { runtime: 'fixture' }, ceiling: 'read' }] }],
  assertions: [{ id: 'unit', kind: 'check', description: 'Tests pass' }, { id: 'review', kind: 'review', description: 'Review approves' }, { id: 'blockers', kind: 'blocking-findings', description: 'No blockers' }],
  caps: { usdMicros: 1_000_000, rounds: 16 } })
const evidenceJournal = async () => {
  const records: LeadJournalRecord[] = []
  const journal = await createLeadJournal({ async read() { return records }, async append(record) { records.push(record) } })
  await journal.setPolicy({ version: 1, revision: 1, mode: 'manage', rules: [] })
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 60_000 })
  return journal
}
const fact = (id: string, kind: 'check' | 'review', at: string, freshness: 'fresh' | 'stale', more: object = {}) =>
  ({ record: { id, fact: { kind, at, ...more } }, freshness: { state: freshness } })
const reads = (cards: unknown[], blocking = false, embargoed = false) => async (call: LeadPermissionCall): Promise<unknown> => {
  if (call.method === 'flow/execution') return { rounds: [{ cards: [1] }] }
  if (call.method === 'evidence/board') return { cards }
  if (call.method === 'finding/run') return { blocking, embargoed }
  throw new Error(`unexpected read ${call.method}`)
}

test('evidence is incomplete when a fact is missing or stale, and complete only from fresh facts at the reviewed revision', async () => {
  const journal = await evidenceJournal()
  const repo = await makeRepo('lead-required-checks-')
  await mkdir(join(repo.dir, '.harnessdesk'))
  await writeFile(join(repo.dir, '.harnessdesk/checks.yml'), 'unit: { run: node unit.mjs }\nlint: { run: node lint.mjs }\n')
  await repo.git('add', '.harnessdesk')
  await repo.git('commit', '-qm', 'Declare required checks')
  const revision = await repo.git('rev-parse', 'HEAD'), file = await readChecks(repo.dir)
  const check = (name: string, more: object = {}) => fact(name, 'check', revision, 'fresh', { name, run: `node ${name}.mjs`, digest: file.digest, exit: 0, counted: true, ...more })
  const reviewed = fact('r1', 'review', revision, 'fresh', { verdict: 'approve' })
  // No run or contract yet: nothing to read, nothing guessed.
  assert.equal((await readLeadEvidence(journal, 'run-1', reads([]), () => 1000)).complete, false)
  const withRun = { state: { ...journal.state, contract: { ...contract, project: { ...project, path: repo.dir } }, runs: [{ runId: 'run-1', teamId: 'team-1', correlationId: 'c1' }] } } as unknown as Pick<typeof journal, 'state'>
  const read = (cards: unknown[]) => readLeadEvidence(withRun, 'run-1', reads(cards), () => 1000)
  assert.equal((await read([])).complete, false, 'no review yet')
  assert.equal((await read([{ card: 1, facts: [fact('r1', 'review', revision, 'fresh', { verdict: 'approve' })] }])).complete, false, 'no check fact')
  assert.equal((await read([{ card: 1, facts: [fact('r1', 'review', revision, 'fresh', { verdict: 'approve' }), fact('c1', 'check', revision, 'stale', { exit: 0 })] }])).complete, false, 'a stale check')
  assert.equal((await read([{ card: 1, facts: [fact('r1', 'review', revision, 'fresh', { verdict: 'approve' }), fact('c0', 'check', 'old', 'fresh', { exit: 0 })] }])).complete, false, 'a check for another revision')
  for (const facts of [
    [reviewed, check('unit')],
    [reviewed, check('unit'), check('lint', { counted: false })],
    [reviewed, check('unit'), check('lint', { run: 'node another.mjs' })],
    [reviewed, check('unit'), check('lint', { digest: 'wrong' })],
    [reviewed, check('unit'), check('lint', { exit: 1 })],
  ]) assert.equal((await read([{ card: 1, facts }])).complete, false, 'every declared check needs matching counted passing evidence')
  const complete = await read([{ card: 1, facts: [reviewed, check('unit'), check('lint')] }])
  assert.equal(complete.complete, true)
  assert.equal(complete.revision, revision)
  assert.equal(complete.checks.length, 2)
  assert.deepEqual(complete.reviews.map(one => [one.assertionId, one.verdict]), [['review', 'approve']])
})

test('plans freeze to the sha256 of their canonical JSON, projects are named by path and seats come from ready runtimes', async () => {
  const frozen = await freezeLeadPlan({ ...contract, digest: '0'.repeat(64) })
  assert.match(frozen.digest, /^[0-9a-f]{64}$/)
  assert.notEqual(frozen.digest, '0'.repeat(64))
  assert.deepEqual(leadProjectOf('/work/acme'), leadProjectOf('/work/acme'))
  assert.notEqual(leadProjectOf('/work/acme').id, leadProjectOf('/work/other').id)
  assert.equal(leadSeatChoices([]), undefined)
  assert.deepEqual(leadSeatChoices(['fixture'])?.implement.map(seat => seat.runtime), ['fixture'])
})

test('a plan that could never be accepted is refused before any card, with its own code', async () => {
  const home = tempDir('lead-assembly-seats-'), checked: string[] = []
  let freeze!: (value: typeof contract) => Promise<typeof contract>
  let unfit: 'lead-plan-unseatable' | 'lead-plan-not-independent' | null = 'lead-plan-unseatable'
  const assembly = new LeadAssembly({ home, now: () => 1, workspace: async () => contract.project.path, readySeats: () => ['fixture'], heldPreview: () => null,
    seatsHold: async (_root, step) => { checked.push(step.id); return unfit }, create: async inputs => { freeze = inputs.freezePlan } })
  await assembly.ensure()
  await assert.rejects(freeze(contract), (error: any) => error.wireCode === 'lead-plan-unseatable')
  unfit = 'lead-plan-not-independent'
  await assert.rejects(freeze(contract), (error: any) => error.wireCode === 'lead-plan-not-independent')
  unfit = null
  assert.match((await freeze(contract)).digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(checked, [contract.steps[0]!.id, contract.steps[0]!.id, ...contract.steps.map(step => step.id)])
})

test('a seat passed over only for its provider is a plan that is not independent, not one that cannot hold', () => {
  const held = { level: 'read', hold: 'held' }
  const writer = { role: 'implement', plan: { id: 'implementer', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'held' },
    candidates: [{ seat: { runtime: 'fixture' }, label: 'Fixture', runtimeName: 'Fixture', state: 'taken', reason: null, fix: null, ceiling: { level: 'edit', hold: 'held' } }] } }
  const reviewer = (reasons: readonly (string | null)[], winner: number | null) => ({ role: 'review', plan: { id: 'code-reviewer', from: 'prefer', winner, blocked: null, ceiling: winner === null ? null : held,
    candidates: reasons.map(kind => ({ seat: { runtime: 'fixture' }, label: 'Fixture', runtimeName: 'Fixture', state: kind ? 'passed' : 'taken', reason: kind ? { kind } : null, fix: null, ceiling: held })) } })
  const preview = (review: object, token: string | null = null): any => ({ token, seats: [writer, review] })
  assert.equal(leadPreviewUnfit(preview(reviewer(['sameProvider'], null))), 'lead-plan-not-independent')
  assert.equal(leadPreviewUnfit(preview(reviewer(['unknownProvider', 'sameProvider'], null))), 'lead-plan-not-independent')
  // A seat that also failed for another reason is still a permissions answer.
  assert.equal(leadPreviewUnfit(preview(reviewer(['sameProvider', 'readOnlyUnheld'], null))), 'lead-plan-unseatable')
  assert.equal(leadPreviewUnfit(null), 'lead-plan-unseatable')
  assert.equal(leadPreviewUnfit(preview(reviewer([null], 0))), 'lead-plan-unseatable')
  assert.equal(leadPreviewUnfit(preview(reviewer([null], 0), 'token')), null)
})

test('a Lead plan may name a runtime stopped while idle, never one that cannot start', () => {
  assert.equal(leadSeatable({ state: 'ready' }), true)
  assert.equal(leadSeatable({ state: 'idle' }), true)
  assert.equal(leadSeatable({ state: 'starting' }), true)
  assert.equal(leadSeatable({ state: 'unavailable' }), false)
})
