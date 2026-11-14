import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import test, { after } from 'node:test'
import { tempDir } from './scratch.js'

// A desk stuck the way one was found: the Lead read a worker chat the person had stopped mid-run, one line of that
// read is a config line the desk clipped to `authorization: …`, the request carrying it went uncertain and was
// written off, and the Lead waits on `lead-request-uncertain`. Every later request carried the same read, so every
// one failed the same way. The desk is built by the desktop's own path (`createDefaultHost`) in an isolated process,
// the stuck state is written by the production journal and context store, and the desk is then restarted.
const KEY = 'sk-ant-stuck-desk-not-a-real-key-0002' // hd-secrets-ok: a stand-in the key store must never leak
const CHECK = `
import { join } from 'node:path'
import { mock } from 'node:test'
const { ToolGateway } = await import(process.env.HD_TOOL_GATEWAY)
mock.method(ToolGateway.prototype, 'start', () => {})
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { LeadFileJournal } = await import(process.env.HD_LEAD_FILE_JOURNAL)
const { LeadContextStore } = await import(process.env.HD_CONTEXT_STORE)
const { createLeadJournal, LEAD_MESSAGES_DEFAULTS } = await import(process.env.HD_LEAD)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const out = {}
const clipped = '  authorization: … keys}'
const chatRead = JSON.stringify({ id: 'chat-1', title: 'Fix the config loader', agent: { name: 'Agent' }, status: 'stopped', turns: [
  { type: 'you', id: 'm1', text: 'Fix the loader', attachments: [] },
  { type: 'work', id: 'm2', summary: 'Ran a command', steps: [{ kind: 'run', title: 'a command', output: ['config:', '  name: demo', clipped, '  retries: 3'] }] }],
  omittedSourceTurns: 0, omittedPhoneEntries: 0, truncated: true })
const answer = text => ({ status: 200, body: JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: LEAD_MESSAGES_DEFAULTS.model,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) })
const requests = []
const transport = { async send(request) {
  requests.push(request.body)
  return answer(request.body.includes('Are you still there?') ? 'Yes. The loader chat was stopped while it printed its config.' : 'Which loader do you mean?')
} }
const cipher = { protection: 'synthetic cipher', encrypt: plain => Buffer.from(Buffer.from(plain).toString('hex')), decrypt: blob => Buffer.from(blob.toString(), 'hex').toString() }
const stateDir = process.env.HD_STATE
const start = async () => {
  const made = createDefaultHost({ stateDir, console: false, logLevel: 'error', codexHome: join(stateDir, 'codex'), codexBinaryPath: null, credentialCipher: cipher, leadEnabled: true, leadMessagesTransport: transport })
  await made.pathReady
  await made.host.start()
  return made
}
const stop = async made => { await made.host.dispose(); await made.extensions.dispose() }
// The stopped desk's Lead child lets go of the journal's writer lease as it exits.
const openJournal = async () => {
  for (let attempt = 0; ; attempt++) {
    try { return await LeadFileJournal.open(stateDir, 'desk') }
    catch (error) { if (attempt >= 100) throw error; await sleep(100) }
  }
}
const settled = async (made, text) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await made.host.call('lead/thread/read', {})
    if (!snapshot.requestInFlight && (snapshot.thread.messages.some(message => message.role === 'assistant' && message.text === text) || snapshot.waitReason)) return snapshot
    await sleep(100)
  }
  throw new Error('lead-request-not-settled')
}

// 1. An ordinary desk with a key and one answered message.
let made = await start()
await made.host.call('workspace/open', { path: process.env.HD_PROJECT })
const settings = await made.host.call('lead/settings/read', {})
await made.host.call('lead/settings/update', { expectedRevision: settings.revision, credential: { provider: 'anthropic', key: process.env.HD_KEY } })
await made.host.call('lead/thread/send', { idempotencyKey: 'first', text: 'Look at the loader chat' })
out.first = (await settled(made, 'Which loader do you mean?')).thread.messages.map(message => message.text)
await stop(made)

// 2. The stuck state, written as the desk wrote it: the read stored, the request carrying it uncertain and written off,
// the Lead waiting on it, and the wake that ran it recorded.
{
  const storage = await openJournal(), journal = await createLeadJournal(storage)
  const context = await LeadContextStore.open({ directory: join(stateDir, 'lead'), journal, model: LEAD_MESSAGES_DEFAULTS.model, now: Date.now, nextId: () => 'context-stuck' })
  await context.record({ epoch: Number.MAX_SAFE_INTEGER, base: 0, extend: [], turns: [
    { role: 'user', content: [{ type: 'text', text: 'Desk observation: ordinary chat states changed. Read the relevant chat before reporting its result.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stuck_read', name: 'chat_read', input: { id: 'chat-1' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stuck_read', content: chatRead, is_error: false }] }] })
  const price = { inputUsdMicrosPerMillion: 3_000_000, outputUsdMicrosPerMillion: 15_000_000, cacheReadUsdMicrosPerMillion: 300_000, cacheWriteUsdMicrosPerMillion: 3_750_000 }
  await journal.updateBudget({ version: 1, type: 'reserve', now: Date.now(), requestId: 'stuck-request', inputTokens: 77_974, maxOutputTokens: 4096, ...price })
  await journal.updateBudget({ version: 1, type: 'uncertain', now: Date.now(), requestId: 'stuck-request' })
  await journal.updateBudget({ version: 1, type: 'write-off', now: Date.now(), requestId: 'stuck-request' })
  await journal.setManagementPhase('waiting-for-user', 'lead-request-uncertain')
  await journal.recordWake({ id: 'stuck-wake', at: Date.now(), source: 'desk-change', decision: 'silent', modelTurn: true, usdMicros: null })
  await storage.close()
}

// 3. The fixed desk restarts on that state. The person sends a message, as the wait tells them to.
made = await start()
const stuck = await made.host.call('lead/thread/read', {})
out.stuck = [stuck.thread.state, stuck.waitReason]
out.stuckFailure = stuck.failure ?? null
const before = requests.length
await made.host.call('lead/thread/send', { idempotencyKey: 'again', text: 'Are you still there?' })
const after = await settled(made, 'Yes. The loader chat was stopped while it printed its config.')
out.sent = requests.length - before
out.carried = requests.slice(before).some(body => body.includes('authorization: … keys}') && body.includes('Are you still there?'))
out.after = [after.thread.state, after.waitReason, after.requestInFlight]
out.afterFailure = after.failure ?? null
out.reply = after.thread.messages.at(-1).text
out.stage = after.stage
await stop(made)
{
  const storage = await openJournal(), journal = await createLeadJournal(storage)
  out.uncertain = journal.state.budget.requests.filter(request => request.uncertain).length
  out.open = journal.state.budget.requests.length
  const wakes = journal.state.wakes, stuckAt = wakes.findIndex(wake => wake.id === 'stuck-wake')
  out.stuckWake = wakes[stuckAt]?.decision ?? null
  out.wakesAfter = wakes.slice(stuckAt + 1).map(wake => wake.decision)
  await storage.close()
}
process.stdout.write(JSON.stringify(out) + '\\n')
`

const shortDirs: string[] = []
after(() => { for (const dir of shortDirs) rmSync(dir, { recursive: true, force: true }) })
const shortDir = (): string => { const dir = realpathSync(mkdtempSync('/tmp/hdls-')); shortDirs.push(dir); return dir }

test('a desk stuck on a request that carried a clipped chat read recovers after a restart when the person sends a message', { timeout: 180_000 }, async () => {
  // The Lead's private socket lives under the home, and a unix socket path is capped near 104 bytes.
  const stateDir = shortDir(), projectDir = realpathSync(tempDir('hd-lead-stuck-project-'))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: realpathSync(tempDir('hd-lead-stuck-home-')), HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: stateDir, HD_PROJECT: projectDir, HD_KEY: KEY,
    HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_TOOL_GATEWAY: new URL('../src/tool-gateway.js', import.meta.url).href,
    HD_LEAD_FILE_JOURNAL: new URL('../src/lead/journal.js', import.meta.url).href,
    HD_CONTEXT_STORE: new URL('../src/lead/context-store.js', import.meta.url).href,
    HD_LEAD: import.meta.resolve('@harnessdesk/lead') }
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
  assert.equal(exited, 0, `recovery child exits; stderr: ${err.replaceAll(KEY, '<key>')}`)
  const result = JSON.parse(out.trim()) as Record<string, any>
  assert.deepEqual(result.first, ['Look at the loader chat', 'Which loader do you mean?'])
  // Restarted, the desk shows the wait it was left in.
  assert.deepEqual(result.stuck, ['waiting-for-user', 'lead-request-uncertain'])
  // The wire names the failed request for the phone as well as the desktop: its code and the sentence to show.
  assert.equal(result.stuckFailure?.reason, 'lead-request-uncertain'); assert.equal(typeof result.stuckFailure?.detail, 'string')
  // One message from the person is enough: the stored read goes with it, intact, and the Lead answers.
  assert.equal(result.sent, 1, 'the request reached the provider')
  assert.equal(result.carried, true, 'the stored chat read went with the person\'s message, its clipped line intact')
  assert.equal(result.reply, 'Yes. The loader chat was stopped while it printed its config.')
  assert.notEqual(result.after[0], 'waiting-for-user'); assert.equal(result.after[1], null); assert.equal(result.after[2], false)
  assert.notEqual(result.stage, 'you-blocked')
  assert.equal(result.afterFailure, null)
  assert.equal(result.uncertain, 0); assert.equal(result.open, 0)
  // The ledger keeps the stuck wake as it was recorded; after the restart the person's message ran as a wake the Lead
  // answered, and no wake after it failed. A desk observation may also wake the Lead and stay silent, so order is not fixed.
  assert.equal(result.stuckWake, 'silent')
  assert.ok(result.wakesAfter.includes('spoke'), JSON.stringify(result.wakesAfter))
  assert.ok(!result.wakesAfter.includes('failed'), JSON.stringify(result.wakesAfter))
  assert.equal(JSON.stringify(result).includes(KEY), false)
})
