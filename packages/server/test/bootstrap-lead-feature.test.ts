import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { tempDir } from './scratch.js'

// Exercise the real desktop parser -> bootstrap -> host/hello boundary in an
// isolated process: no real agent homes, login shell, keys or update checks.
const CHECK = `
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'node:test'
const { ToolGateway } = await import(process.env.HD_TOOL_GATEWAY)
// Capability negotiation does not use the plugin socket. Keep this test
// independent of local listener permissions while exercising real bootstrap.
mock.method(ToolGateway.prototype, 'start', () => {})
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { leadEnabled } = await import(process.env.HD_LEAD_FEATURE)
const cases = [undefined, true, 1, '1', ...[undefined, '0', '', 'true', ' 1', '1'].map(value =>
  leadEnabled(value === undefined ? {} : { HARNESSDESK_LEAD: value }))]
const capabilities = []
for (const [index, enabled] of cases.entries()) {
  const stateDir = join(process.env.HD_STATE, String(index))
  await mkdir(stateDir)
  const { host, extensions, pathReady } = createDefaultHost({ stateDir, console: false, logLevel: 'error',
    codexHome: join(stateDir, 'codex'), codexBinaryPath: null,
    ...(enabled === undefined ? {} : { leadEnabled: enabled }) })
  try {
    await pathReady
    capabilities.push((await host.call('host/hello', { clientVersion: 'test' })).capabilities ?? null)
  } finally { await host.dispose(); await extensions.dispose() }
}
process.stdout.write(JSON.stringify(capabilities) + '\\n')
`

test('bootstrap advertises Lead only for exact true, including the real desktop flag parser', { timeout: 60_000 }, async () => {
  const stateDir = tempDir('hd-bootstrap-lead-')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tempDir('hd-bootstrap-lead-home-'), HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: stateDir, HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_TOOL_GATEWAY: new URL('../src/tool-gateway.js', import.meta.url).href,
    HD_LEAD_FEATURE: new URL('../../../desktop/electron/lead-feature.mjs', import.meta.url).href }
  delete env['SHELL']
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHECK], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
  const exited = await new Promise<number | null | 'hung'>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung') }, 45_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(exited, 0, `bootstrap child exits; stderr: ${err}`)
  assert.deepEqual(JSON.parse(out.trim()), [null, { lead: true }, null, null, null, null, null, null, null, { lead: true }])
})
