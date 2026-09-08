/**
 * A gateway account, end to end, with a real Codex and no network.
 *
 * Chains the three pieces the feature is made of — the credential-holding
 * loopback child, the `config.toml` a gateway account is pointed with, and the
 * agent itself — in front of a fake provider that records what arrives.
 *
 *   pnpm build:node && node script/probe/gateway-account.mjs
 *
 * What it answers, and why each matters:
 *
 * - **Codex accepts a keyless provider.** No `auth.json`, no `env_key`: the
 *   gateway token rides in the base URL. Verified on codex-cli 0.149.0.
 * - **The real key never reaches the agent.** It is in the child's address
 *   space only; the config the agent reads has no trace of it.
 * - **The `namespace` tool survives.** That is HarnessDesk's own plugin
 *   projection, and it is the thing a translating gateway drops
 *   ([the gateway decision](../../docs/decisions.md#other-models-reach-codex-through-a-gateway-never-a-fork)). A gateway
 *   account keeps the model, so the payload reaches a Responses endpoint
 *   unchanged and the projection lives — which is the whole argument for
 *   holding these accounts to the agent's own models.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const { GatewaySupervisor } = await import(join(REPO, 'packages/responses-gateway/dist/src/index.js'))
const { writeGatewayConfig } = await import(join(REPO, 'packages/server/dist/src/accounts.js'))

// The stand-in the fake provider below is handed: this string is the thing
// being traced through the chain, not a credential.
const KEY = 'sk-the-real-provider-key' // hd-secrets-ok
const captured = []

// --- the "provider": a minimal Responses endpoint, as script/probe does ------
const provider = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    captured.push({ url: req.url, auth: req.headers.authorization, body })
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.2-codex' }] }))
      return
    }
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const base = { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5.6-sol', status: 'in_progress', output: [] }
    send('response.created', { type: 'response.created', response: base, sequence_number: 0 })
    send('response.in_progress', { type: 'response.in_progress', response: base, sequence_number: 1 })
    const item = { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item, sequence_number: 2 })
    send('response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 3 })
    send('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'GATEWAY-OK', sequence_number: 4 })
    send('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: 'GATEWAY-OK', sequence_number: 5 })
    send('response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'GATEWAY-OK', annotations: [] }, sequence_number: 6 })
    const done = { ...item, status: 'completed', content: [{ type: 'output_text', text: 'GATEWAY-OK', annotations: [] }] }
    send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: done, sequence_number: 7 })
    send('response.completed', { type: 'response.completed', response: { ...base, status: 'completed', output: [done], usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } }, sequence_number: 8 })
    res.end()
  })
})
await new Promise((r) => provider.listen(0, '127.0.0.1', r))
const upstream = `http://127.0.0.1:${provider.address().port}/codex/v1`
console.log('provider at', upstream)

// --- the gateway account: exactly what the host builds ----------------------
const supervisor = new GatewaySupervisor({ info: (m, d) => console.log('[gw]', m, d ?? '') })
const gateway = await supervisor.ensure('acct-test', { upstream, resolveKey: async () => KEY })
console.log('gateway at', gateway.endpoint)

const home = mkdtempSync(join(tmpdir(), 'gw-codex-home-'))
writeGatewayConfig(home, 'Fake Gateway', gateway.endpoint)
console.log('--- config.toml ---\n' + readFileSync(join(home, 'config.toml'), 'utf8'))

// Codex needs a workspace; give it a throwaway one.
const cwd = mkdtempSync(join(tmpdir(), 'gw-codex-cwd-'))
writeFileSync(join(cwd, 'README.md'), '# scratch\n')

// --- real Codex -------------------------------------------------------------
const child = spawn('codex', ['exec', '--skip-git-repo-check', '-C', cwd, 'Reply with exactly: hi'], {
  env: { ...process.env, CODEX_HOME: home, HARNESSDESK_NO_UPDATE_CHECK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = '', err = ''
child.stdout.on('data', (c) => (out += c))
child.stderr.on('data', (c) => (err += c))
const code = await new Promise((r) => {
  const t = setTimeout(() => { child.kill('SIGKILL'); r('timeout') }, 90_000)
  child.on('exit', (c) => { clearTimeout(t); r(c) })
})

console.log('\n=== codex exit:', code, '===')
console.log('--- stdout ---\n' + out.slice(-3000))
if (err.trim()) console.log('--- stderr ---\n' + err.slice(-3000))
console.log('\n=== provider saw', captured.length, 'request(s) ===')
for (const c of captured) {
  console.log(` ${c.url}  auth=${c.auth}  ${c.body.length}B`)
}
const bodies = captured.map((c) => c.body).join('')
console.log('key reached provider :', captured.some((c) => c.auth === `Bearer ${KEY}`))
console.log('key in codex config  :', readFileSync(join(home, 'config.toml'), 'utf8').includes(KEY))
console.log('namespace tool sent  :', /"type"\s*:\s*"namespace"/.test(bodies))
writeFileSync(join(home, 'captured.json'), JSON.stringify(captured, null, 1))
console.log('capture written to', join(home, 'captured.json'))
await supervisor.dispose()
provider.close()
process.exit(0)
