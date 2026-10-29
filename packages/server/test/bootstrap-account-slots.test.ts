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
if (process.env.HD_DUPLICATE_SLOTS) {
  const saved = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8'))
  saved.accounts.push({ ...extraCodex, id: process.env.HD_DUPLICATE_SLOTS === 'primary' ? 'codex' : extraCodex.id })
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(saved))
}
if (process.env.HD_DUPLICATE_IDS === '1') {
  const saved = JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8'))
  for (const id of ['codex', extraCodex.id]) saved.agents.push({ id, name: 'Duplicate runtime', command: process.execPath, args: [sentinel] })
  writeFileSync(join(root, 'agents.json'), JSON.stringify(saved))
}
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: root, codexHome, codexBinaryPath: process.env.HD_DUPLICATE_IDS === '1' || process.env.HD_DUPLICATE_SLOTS ? process.env.HD_NATIVE_FIXTURE : sentinel,
  console: false, logLevel: process.env.HD_DUPLICATE_IDS === '1' || process.env.HD_DUPLICATE_SLOTS ? 'warn' : 'error'
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
    assert.equal(value.removable, id !== 'codex', 'only the registered extra account is removable')
    assert.equal(value.home, id === 'codex' ? codexHome : extraCodex.home)
    assert.equal(infos.find(info => info.id === id).origin, undefined, 'skipped registry rows do not own native runtimes')
  }
  assert.equal(infos.find(info => info.id === 'fixture-agy').origin, 'registry', 'the registered ACP agent still owns its runtime')
  for (const id of ['codex', extraCodex.id]) {
    await assert.rejects(host.call('acp/remove', { runtime: id }), /not in the agent registry/)
  }
  assert.equal(existsSync(join(extraCodex.home, 'auth.json')), true, 'ignored rows never authorize deleting an account home')
  if (process.env.HD_DUPLICATE_IDS === '1') {
    assert.equal(JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8')).agents.some(row => row.id === 'codex'), true, 'ignored configuration is preserved')
  }
  assert.equal(existsSync(marker), false, 'no agent binary was invoked')
  if (process.env.HD_DUPLICATE_IDS === '1' || process.env.HD_DUPLICATE_SLOTS) {
    assert.equal(new Set(infos.map(info => info.id)).size, infos.length)
    const expected = process.env.HD_DUPLICATE_SLOTS ? [process.env.HD_DUPLICATE_SLOTS === 'primary' ? 'codex' : extraCodex.id] : ['codex', extraCodex.id]
    // Root flush does not cover child loggers. Wait for complete records on
    // disk rather than depending on the time taken to start the host.
    const file = join(root, 'logs', 'host.ndjson')
    const deadline = Date.now() + 5_000
    let warnings = []
    do {
      if (existsSync(file)) {
        warnings = readFileSync(file, 'utf8').split('\\n').slice(0, -1).map(JSON.parse)
          .filter(record => record.level === 'warn' && record.message === (process.env.HD_DUPLICATE_SLOTS ? 'an account in accounts.json was ignored' : 'an agent in agents.json was ignored'))
      }
      if (warnings.length >= expected.length) break
      await new Promise(resolve => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    assert.deepEqual(warnings.map(record => record.details.agent).sort(), expected.sort())
    assert.ok(warnings.every(record => record.details.reason === 'runtime id is already registered'))
    await host.start()
    const account = await host.call('runtime/account', { runtime: 'codex' })
    assert.ok(account.accounts.length > 0, 'the native runtime still starts')
  }
} finally {
  await host.dispose()
  await extensions.dispose()
}
`

for (const scenario of [
  { name: 'bootstrap declares naming and private sessions for ACP accounts, and gateways only for native accounts', agents: false, slots: '' },
  { name: 'bootstrap skips configured ids already held by native runtimes and starts the host', agents: true, slots: '' },
  { name: 'bootstrap skips a repeated account slot and starts the host', agents: false, slots: 'repeated' },
  { name: 'bootstrap skips an account slot with the primary runtime id and starts the host', agents: false, slots: 'primary' },
]) {
  test(scenario.name, { timeout: 30_000 }, async () => {
    const root = tempDir('hd-slot-wiring-')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempDir('hd-slot-home-'),
      HARNESSDESK_NO_UPDATE_CHECK: '1',
      HD_STATE: root,
      HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
      HD_ACCOUNTS: new URL('../src/accounts.js', import.meta.url).href,
      HD_DUPLICATE_IDS: scenario.agents ? '1' : '0',
      HD_DUPLICATE_SLOTS: scenario.slots,
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
