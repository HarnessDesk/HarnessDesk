import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Proves that `thread/start` can define a model provider that exists in no
 * configuration file, by passing dotted `config` overrides — the mechanism
 * the model routes depend on. Evidence for the gateway decision.
 *
 *   node script/probe/responses-capture.mjs &
 *   node script/probe/appserver-inject.mjs --codex-home /tmp/probe-home
 *
 * `--codex-home` must contain a config.toml naming NO provider called
 * `injected`; the point is that the override alone is enough.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const HOME = arg('codex-home', join(tmpdir(), 'harnessdesk-probe-home'))
const CWD = arg('cwd', join(HOME, 'probe'))
const GW = arg('gateway', 'http://127.0.0.1:8791/v1')
mkdirSync(CWD, { recursive: true })
if (!existsSync(join(HOME, 'config.toml'))) {
  writeFileSync(join(HOME, 'config.toml'), 'model = "probe-model"\napproval_policy = "never"\nsandbox_mode = "read-only"\n')
}

// The base config names no provider called `injected`. If the per-thread
// `config` override works, the turn's request still lands on the gateway.
const child = spawn('codex', ['app-server'], {
  env: { ...process.env, CODEX_HOME: HOME, PROBE_API_KEY: 'dummy-key', GW_API_KEY: 'gw-key' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let id = 0
const pending = new Map()
const send = (method, params) => {
  const rid = ++id
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  return new Promise((res, rej) => pending.set(rid, { res, rej }))
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

const notes = []
createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
  } else if (m.method) {
    notes.push(m.method)
    if (m.id) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n')
  }
})
child.stderr.on('data', () => {})

await send('initialize', {
  clientInfo: { name: 'harnessdesk-probe', version: '0.0.1', title: 'probe' },
  capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
})
notify('initialized', undefined)

const thread = await send('thread/start', {
  cwd: CWD,
  model: 'probe-model',
  modelProvider: 'injected',            // a provider that exists in NO config file
  approvalPolicy: 'never',
  sandbox: 'read-only',
  ephemeral: true,
  config: {                              // ← the question
    'model_providers.injected.name': 'Injected',
    'model_providers.injected.base_url': GW,
    'model_providers.injected.env_key': 'GW_API_KEY',
    'model_providers.injected.wire_api': 'responses',
    'model_providers.injected.request_max_retries': 0,
    'model_providers.injected.stream_max_retries': 0,
  },
})
console.log('thread/start OK ->', JSON.stringify(thread).slice(0, 160))

const turn = await send('turn/start', {
  threadId: thread.thread?.id ?? thread.threadId ?? thread.id,
  input: [{ type: 'text', text: 'say hi' }],
}).catch((e) => ({ __err: String(e).slice(0, 400) }))
console.log('turn/start ->', JSON.stringify(turn).slice(0, 300))

await new Promise((r) => setTimeout(r, 6000))
console.log('notifications:', [...new Set(notes)].join(', '))
child.kill()
