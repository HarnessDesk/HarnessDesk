import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

// Build the real wiring without starting the host or any agent. A sentinel
// executable makes even an accidental agent probe a test failure.
const READ_SLOTS = `
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
if (process.env.HD_DUPLICATE_IDS === '1') {
  const saved = JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8'))
  for (const id of ['codex', extraCodex.id]) saved.agents.push({ id, name: 'Duplicate runtime', command: process.execPath, args: [sentinel] })
  writeFileSync(join(root, 'agents.json'), JSON.stringify(saved))
}
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, logger, pathReady } = createDefaultHost({
  stateDir: root, codexHome, codexBinaryPath: process.env.HD_DUPLICATE_IDS === '1' ? process.env.HD_NATIVE_FIXTURE : sentinel,
  console: false, logLevel: process.env.HD_DUPLICATE_IDS === '1' ? 'warn' : 'error'
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
  if (process.env.HD_DUPLICATE_IDS === '1') {
    assert.equal(new Set(infos.map(info => info.id)).size, infos.length)
    await host.start()
    const account = await host.call('runtime/account', { runtime: 'codex' })
    assert.ok(account.accounts.length > 0, 'the native runtime still starts')
    await logger.flush()
    const warnings = readFileSync(join(root, 'logs', 'host.ndjson'), 'utf8').trim().split('\\n').map(JSON.parse)
      .filter(record => record.level === 'warn' && record.message === 'an agent in agents.json was ignored')
    assert.deepEqual(warnings.map(record => record.details.agent), ['codex', extraCodex.id])
    assert.ok(warnings.every(record => record.details.reason === 'runtime id is already registered'))
  }
} finally {
  await host.dispose()
  await extensions.dispose()
}
`

for (const duplicates of [false, true]) {
  test(duplicates ? 'bootstrap skips configured ids already held by native runtimes and starts the host' : 'bootstrap declares naming and private sessions for ACP accounts, and gateways only for native accounts', { timeout: 30_000 }, async () => {
    const root = tempDir('hd-slot-wiring-')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempDir('hd-slot-home-'),
      HARNESSDESK_NO_UPDATE_CHECK: '1',
      HD_STATE: root,
      HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
      HD_ACCOUNTS: new URL('../src/accounts.js', import.meta.url).href,
      HD_DUPLICATE_IDS: duplicates ? '1' : '0',
      HD_NATIVE_FIXTURE: new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url).pathname,
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
}
