import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from './scratch.js'

// Exercise the production callbacks and socket, without substituting a caller map.
const PROBE = `
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const { createDefaultHost, toolSocketPath } = await import(process.env.HD_BOOTSTRAP)
const root = process.env.HD_STATE, cwd = join(root, 'widgets'), dump = join(root, 'servers.json')
mkdirSync(cwd, { recursive: true })
writeFileSync(join(root, 'agents.json'), JSON.stringify({ agents: [{ id: 'fixture', name: 'Fixture', command: process.execPath, args: [process.env.HD_ACP], env: { FAKE_ACP_DUMP_SERVERS: dump } }] }))
const { host, extensions, pathReady } = createDefaultHost({ stateDir: root, codexHome: join(root, 'codex'), codexBinaryPath: process.env.HD_FAKE, console: false, logLevel: 'error' })
const tokens = new Map(), original = host.gitSteering.environment.bind(host.gitSteering)
host.gitSteering.environment = async (cwd, caller, path) => { tokens.set(caller, cwd); return original(cwd, caller, path) }
const notices = []
host.addBroadcaster(message => { if (message.method === 'event' && message.params.event.type === 'notice') notices.push(message.params.event.message) })
const call = (method, params) => new Promise((resolve, reject) => {
  const socket = connect(toolSocketPath(root)); let buffer = ''
  socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('socket timeout')) })
  socket.on('error', reject); socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\\n'))
  socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\\n')) { socket.destroy(); resolve(JSON.parse(buffer.split('\\n')[0])) } })
})
try {
  await pathReady; await host.start(); await host.call('workspace/open', { path: cwd })
  await host.call('session/create', { runtime: 'codex', options: { cwd } })
  const codexToken = [...tokens.keys()][0]; assert.ok(codexToken)
  // The native adapter receives the real bootstrap HD_TOOLS_SOCKET addition.
  const started = notices.find(text => text.startsWith('STARTED ')); assert.ok(started)
  const config = JSON.parse(started.slice(8)).config['shell_environment_policy.set']
  assert.equal(config.HD_TOOLS_SOCKET, toolSocketPath(root)); assert.equal(config.HD_GIT_CALLER, codexToken)
  assert.deepEqual((await call('git/steer', { caller: codexToken, modeOnly: true })).result, { action: 'done' })
  const denied = await call('tools/invoke', { caller: codexToken, namespace: 'fixture', name: 'probe', args: {} })
  assert.equal(denied.result.ok, false); assert.match(denied.result.error, /steering-only/)
  const mcp = await call('mcp/list', { caller: codexToken }); assert.deepEqual(mcp.result, { tools: [] }, 'steering token has no MCP scope')
  await host.call('session/create', { runtime: 'fixture', options: { cwd } })
  const servers = JSON.parse(readFileSync(dump, 'utf8')), bridge = servers.find(server => server.name === 'harnessdesk')
  assert.ok(bridge); const caller = bridge.env.find(entry => entry.name === 'HD_TOOLS_CALLER').value
  const unscoped = await call('git/steer', { caller, modeOnly: true })
  assert.equal(unscoped.result.ok, false); assert.match(unscoped.result.output, /no conversation caller/)
} finally { await host.dispose(); await extensions.dispose() }
`
test('default host keeps steering and general tool caller tokens separate on the real socket', { timeout: 60_000 }, async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tempDir('hd-steer-bootstrap-home-'), HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: tempDir('hd-steer-bootstrap-'), HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_FAKE: fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url)),
    HD_ACP: fileURLToPath(new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url)), FAKE_CODEX_ECHO_STARTS: '1',
  }
  delete env['SHELL']; delete env['CODEX_HOME']
  const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 55_000)
  const code = await new Promise(resolve => child.once('exit', resolve)); clearTimeout(deadline)
  assert.equal(code, 0, output)
})
