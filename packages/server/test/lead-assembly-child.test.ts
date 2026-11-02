import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import test, { after } from 'node:test'
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
const reply = 'Which retry status list do you mean?'
const waitForReply = async (read, attempts = 300, interval = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await read()
    if (snapshot.requestInFlight === false && snapshot.thread.messages.some(message => message.role === 'assistant' && message.text === reply)) return snapshot
    if (attempt + 1 < attempts) await sleep(interval)
  }
  throw new Error('lead-reply-not-settled')
}
out.missingReply = await codes(() => waitForReply(async () => ({ requestInFlight: false, thread: { messages: [] } }), 2, 0))
out.inFlightReply = await codes(() => waitForReply(async () => ({ requestInFlight: true, thread: { messages: [{ role: 'assistant', text: reply }] } }), 2, 0))
const scripted = () => {
  const requests = []
  let release
  const held = new Promise(resolve => { release = resolve })
  return { requests, release, transport: { async send(request) {
    requests.push({ headers: request.headers, body: request.body })
    await held
    return { status: 200, body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) } } } }
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
// Seeing the request is not seeing its reply in the journal. Hold it until a
// real read proves that the first projection still contains only the goal.
const held = await made.host.call('lead/thread/read', {})
out.heldMessages = held.thread.messages.map(one => one.text)
out.heldInFlight = held.requestInFlight
provider.release()
const after = await waitForReply(() => made.host.call('lead/thread/read', {}))
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
  assert.equal(result.missingReply, 'lead-reply-not-settled')
  assert.equal(result.inFlightReply, 'lead-reply-not-settled')
  assert.deepEqual(result.heldMessages, ['Make the retry status list complete'])
  assert.equal(result.heldInFlight, true)
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

