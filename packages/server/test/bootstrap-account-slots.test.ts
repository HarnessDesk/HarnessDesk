import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

// Build the real wiring without starting the host or any agent. A sentinel
// executable makes even an accidental agent probe a test failure.
const READ_SLOTS = `
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.HD_STATE
const codexHome = join(root, 'codex')
mkdirSync(codexHome, { recursive: true })
const marker = join(root, 'agent-was-started')
const sentinel = join(root, 'sentinel.mjs')
writeFileSync(sentinel, '#!' + process.execPath + '\\nimport { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "unexpected"); process.exit(1);\\n')
chmodSync(sentinel, 0o755)
const extraHome = join(root, 'accounts', 'fixture-work')
mkdirSync(extraHome, { recursive: true })
writeFileSync(join(root, 'agents.json'), JSON.stringify({ agents: [
  { id: 'fixture-agy', name: 'Agent', agent: 'antigravity-acp', command: process.execPath, args: [sentinel] },
  { id: 'fixture-work', name: 'Work', agent: 'antigravity-acp', command: process.execPath, args: [sentinel],
    accountOf: 'fixture-agy', env: { GEMINI_HOME: extraHome, AGY_ACP_FORCE_FILE_STORAGE: '1' } }
] }))
const { AccountSlots } = await import(process.env.HD_ACCOUNTS)
const slots = new AccountSlots(join(root, 'accounts.json'))
const extraCodex = slots.add('codex', codexHome, root)
writeFileSync(join(extraCodex.home, 'auth.json'), '{}')
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: root, codexHome, codexBinaryPath: sentinel, console: false, logLevel: 'error'
})
try {
  await pathReady
  const infos = host.syncPayload().params.runtimes
  const slot = id => { const info = infos.find(entry => entry.id === id); assert.ok(info, id); return info.slot }
  for (const id of ['fixture-agy', 'fixture-work']) {
    const value = slot(id)
    assert.equal(value.asksName, true)
    assert.equal(value.ownSessions, true)
    assert.equal(Object.hasOwn(value, 'gateways'), false)
  }
  for (const id of ['codex', extraCodex.id]) {
    const value = slot(id)
    assert.equal(value.gateways, true)
    assert.equal(Object.hasOwn(value, 'asksName'), false)
    assert.equal(Object.hasOwn(value, 'ownSessions'), false)
  }
  assert.equal(existsSync(marker), false, 'no agent binary was invoked')
} finally {
  await host.dispose()
  await extensions.dispose()
}
`

test('bootstrap declares naming and private sessions for ACP accounts, and gateways only for native accounts', { timeout: 30_000 }, async () => {
  const root = tempDir('hd-slot-wiring-')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempDir('hd-slot-home-'),
    HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: root,
    HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
    HD_ACCOUNTS: new URL('../src/accounts.js', import.meta.url).href,
  }
  delete env['SHELL']
  delete env['CODEX_HOME']
  const child = spawn(process.execPath, ['--input-type=module', '-e', READ_SLOTS], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000)
    child.once('exit', value => { clearTimeout(deadline); resolve(value) })
  })
  assert.equal(code, 0, stderr)
})
