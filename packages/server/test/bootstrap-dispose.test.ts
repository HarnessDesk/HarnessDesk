import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { toolSocketPath } from '../src/bootstrap.js'
import { tempDir } from './scratch.js'

/**
 * The desktop's own wiring, disposed the way the app quits it (#869).
 *
 * Only `createDefaultHost` starts the tool gateway, and every other test
 * builds a `Host` directly — so nothing proved that disposing the host the
 * app actually runs closes the gateway's socket. Left open, a process that
 * disposes that host and expects to exit hangs on it, and the socket file
 * outlives the desk.
 *
 * Run in a process of its own because "nothing is left holding it open" is a
 * fact about a whole process: it exits by itself, or it does not.
 */

const QUIT = `
import { connect } from 'node:net'
const { createDefaultHost, toolSocketPath } = await import(process.env.HD_BOOTSTRAP)
const stateDir = process.env.HD_STATE
const reach = (path) => new Promise((resolve) => {
  const socket = connect(path)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('error', () => resolve(false))
})
const { host, extensions, pathReady } = createDefaultHost({ stateDir, console: false, logLevel: 'error', codexHome: process.env.HD_CODEX, codexBinaryPath: null })
await pathReady
const socket = toolSocketPath(stateDir)
let up = false
for (let tries = 0; !up && tries < 200; tries += 1) {
  up = await reach(socket)
  if (!up) await new Promise((resolve) => setTimeout(resolve, 10))
}
process.stdout.write(JSON.stringify({ up }) + '\\n')
await host.dispose()
await extensions.dispose()
`

test('disposing the default host stops its tool gateway: the socket is gone and the process exits on its own', { timeout: 60_000 }, async () => {
  const stateDir = tempDir('hd-bootstrap-state-')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // No real home is read, no login shell is asked, no update is checked.
    HOME: tempDir('hd-bootstrap-home-'),
    HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_STATE: stateDir,
    HD_CODEX: join(stateDir, 'codex'),
  }
  delete env['SHELL']
  const child = spawn(process.execPath, ['--input-type=module', '-e', QUIT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
  const exited = await new Promise<number | null | 'hung'>((resolve) => {
    const hung = setTimeout(() => { child.kill('SIGKILL'); resolve('hung') }, 30_000)
    child.once('exit', (code) => { clearTimeout(hung); resolve(code) })
  })
  assert.match(out, /"up":true/, `the gateway was listening before the quit; stderr: ${err}`)
  assert.equal(exited, 0, `the process exits by itself once the host is disposed; stderr: ${err}`)
  assert.equal(existsSync(toolSocketPath(stateDir)), false, 'the socket file is removed')
})
