import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

// Build the real wiring without starting the host or any agent. A sentinel
// executable makes even an accidental agent probe a test failure.
const READ_SLOTS = `
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
const ignoredHome = join(root, 'accounts', 'ignored-acp')
const trashed = []
if (process.env.HD_REMOVE_FOREIGN_FIRST === '1') {
  mkdirSync(ignoredHome, { recursive: true })
  writeFileSync(join(ignoredHome, 'auth.json'), '{"marker":"preserved"}')
  const saved = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8'))
  saved.accounts.unshift({ ...extraCodex, agent: 'future-runtime', home: ignoredHome })
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(saved))
}
if (process.env.HD_DUPLICATE_SLOTS) {
  const saved = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8'))
  saved.accounts.push({ ...extraCodex, id: process.env.HD_DUPLICATE_SLOTS === 'primary' ? 'codex' : extraCodex.id })
  writeFileSync(join(root, 'accounts.json'), JSON.stringify(saved))
}
if (process.env.HD_DUPLICATE_IDS === '1') {
  const saved = JSON.parse(readFileSync(join(root, 'agents.json'), 'utf8'))
  for (const id of ['codex', extraCodex.id]) saved.agents.push({ id, name: 'Duplicate runtime', command: process.execPath, args: [sentinel] })
  if (process.env.HD_INSTALL_READ === '1') {
    for (const entry of saved.agents.filter(entry => entry.id === 'codex' || entry.id === extraCodex.id)) entry.agent = 'antigravity-acp'
  }
  if (process.env.HD_ACCOUNT_LIFECYCLE === '1') {
    mkdirSync(ignoredHome, { recursive: true })
    writeFileSync(join(ignoredHome, 'auth.json'), '{"marker":"preserved"}')
    Object.assign(saved.agents.find(entry => entry.id === extraCodex.id), {
      agent: 'antigravity-acp', accountOf: 'fixture-agy',
      env: { GEMINI_HOME: ignoredHome, AGY_ACP_FORCE_FILE_STORAGE: '1' }
    })
  }
  writeFileSync(join(root, 'agents.json'), JSON.stringify(saved))
}
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: root, codexHome, codexBinaryPath: process.env.HD_DUPLICATE_IDS === '1' || process.env.HD_DUPLICATE_SLOTS || process.env.HD_REMOVE_FOREIGN_FIRST === '1' ? process.env.HD_NATIVE_FIXTURE : sentinel,
  ...(process.env.HD_ACCOUNT_LIFECYCLE === '1' ? { trashPath: async home => { trashed.push(home); renameSync(home, home + '.trashed') } } : {}),
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
  if (process.env.HD_ALLOCATOR_CONTROL === '1') {
    const state = join(root, 'allocator')
    const file = join(state, 'accounts.json')
    const occupied = join(state, 'accounts', 'kept-credential')
    const orphan = join(state, 'accounts', 'codex-222222')
    for (const folder of [occupied, orphan]) { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'auth.json'), '{"marker":"preserved"}') }
    writeFileSync(file, JSON.stringify({ accounts: [{ id: 'codex-111111', agent: 'codex', home: occupied, createdAt: 1 }] }))
    const bounded = new AccountSlots(file)
    const randomBytes = crypto.randomBytes
    let sequence = ['111111', '222222', '333333', '444444']
    crypto.randomBytes = size => size === 3 ? Buffer.from(sequence.shift() ?? '333333', 'hex') : randomBytes(size)
    syncBuiltinESMExports()
    try {
      const fresh = bounded.add('codex', codexHome, state, undefined, id => id !== 'codex-333333')
      assert.equal(fresh.id, 'codex-444444', 'allocation skips saved ids, occupied homes and reserved runtime ids')
      const before = readFileSync(file, 'utf8')
      assert.throws(() => bounded.add('codex', codexHome, state, undefined, () => false), /unused account id/, 'exhaustion is bounded before persistence')
      assert.equal(readFileSync(file, 'utf8'), before)
      assert.equal(existsSync(join(state, 'accounts', 'codex-333333')), false)
      for (const folder of [occupied, orphan]) assert.equal(readFileSync(join(folder, 'auth.json'), 'utf8'), '{"marker":"preserved"}')
    } finally { crypto.randomBytes = randomBytes; syncBuiltinESMExports() }
  }
  if (process.env.HD_INSTALL_READ === '1') {
    for (const id of ['codex', extraCodex.id]) {
      await assert.rejects(host.call('runtime/installs', { runtime: id }), /no install knowledge/, 'an ignored registry row cannot describe the native install')
      assert.equal(host.syncPayload().params.runtimes.find(info => info.id === id).install ?? null, null)
    }
    assert.equal(existsSync(marker), false, 'an ignored install command is never scanned')
  }
  if (process.env.HD_REMOVE_FOREIGN_FIRST === '1') {
    await host.start()
    await host.call('runtime/account/remove', { runtime: extraCodex.id })
    const retained = new AccountSlots(join(root, 'accounts.json')).list()
    assert.equal(retained.length, 1, 'only the registered native slot is forgotten')
    assert.equal(retained[0].agent, 'future-runtime', 'the foreign row is preserved')
    assert.equal(retained[0].home, ignoredHome)
    assert.equal(existsSync(extraCodex.home), false, 'the registered native home is purged')
    assert.equal(readFileSync(join(ignoredHome, 'auth.json'), 'utf8'), '{"marker":"preserved"}', 'the foreign home is untouched')
    const remaining = host.syncPayload().params.runtimes
    assert.equal(remaining.some(info => info.id === extraCodex.id), false)
    assert.equal(remaining.find(info => info.id === 'codex').slot.removable, false)
    assert.equal(existsSync(marker), false, 'only the requested fake runtime was invoked')
  }
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
    if (process.env.HD_ACCOUNT_LIFECYCLE === '1') {
      await host.call('runtime/account/remove', { runtime: extraCodex.id })
      assert.equal(new AccountSlots(join(root, 'accounts.json')).find(extraCodex.id), null, 'removal forgets the registered native slot')
      assert.equal(existsSync(extraCodex.home), false, 'the removed native account home is purged')
      assert.equal(readFileSync(join(ignoredHome, 'auth.json'), 'utf8'), '{"marker":"preserved"}', 'the ignored ACP account home is untouched')
      assert.deepEqual(trashed, [], 'a native removal never follows the ignored ACP home')
      const registryFile = join(root, 'agents.json')
      const kept = JSON.parse(readFileSync(registryFile, 'utf8'))
      assert.ok(kept.agents.some(entry => entry.id === extraCodex.id), 'native removal preserves ignored ACP configuration')
      // The person removes that ignored row, then registers an ACP agent with
      // the released id through the ordinary public door.
      kept.agents = kept.agents.filter(entry => entry.id !== extraCodex.id)
      writeFileSync(registryFile, JSON.stringify(kept))
      const replacement = await host.call('acp/register', { custom: {
        id: extraCodex.id, name: 'Replacement agent', command: process.execPath, args: [process.env.HD_ACP_FIXTURE]
      } })
      assert.equal(replacement.info.slot ?? null, null, 'the replacement ACP runtime inherits no stale native slot')
      assert.equal(replacement.info.origin, 'registry')
      const randomBytes = crypto.randomBytes
      let collided = false
      if (process.env.HD_ADD_COLLISION === '1') {
        crypto.randomBytes = size => {
          if (size === 3 && !collided) { collided = true; return Buffer.from(extraCodex.id.slice('codex-'.length), 'hex') }
          return randomBytes(size)
        }
        syncBuiltinESMExports()
      }
      let added
      try { added = await host.call('runtime/account/add', { runtime: 'codex', name: 'Fixture account',
        ...(process.env.HD_GATEWAY_ADD === '1' ? { gateway: { name: 'Fixture gateway', endpoint: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' } } : {}) }) }
      finally { crypto.randomBytes = randomBytes; syncBuiltinESMExports() }
      if (process.env.HD_ADD_COLLISION === '1') {
        assert.equal(collided, true, 'the allocator was forced to encounter the registered ACP id')
        assert.notEqual(added.runtime, extraCodex.id)
        const preserved = host.syncPayload().params.runtimes.find(info => info.id === extraCodex.id)
        assert.equal(preserved.slot ?? null, null, 'the existing ACP runtime retains its account metadata')
        assert.equal(preserved.origin, 'registry')
      }
      const addedInfo = host.syncPayload().params.runtimes.find(info => info.id === added.runtime)
      assert.ok(addedInfo.slot, 'a registered native allocation commits its account metadata')
      assert.equal(addedInfo.slot.removable, true, 'a dynamically added native account owns its slot')
      assert.equal(addedInfo.slot.gateways, true)
      assert.notEqual(addedInfo.slot.home, codexHome)
      assert.equal(addedInfo.slot.home, new AccountSlots(join(root, 'accounts.json')).find(added.runtime).home)
      if (process.env.HD_GATEWAY_ADD === '1') {
        const config = readFileSync(join(addedInfo.slot.home, 'config.toml'), 'utf8')
        assert.ok(config.includes('harnessdesk_gateway'), 'the pending native allocation is prepared before registration')
        assert.match(config, /127[.]0[.]0[.]1:/)
        assert.equal(config.includes('http://127.0.0.1:9/v1'), false, 'the runtime receives the loopback gateway, not the unused upstream')
        assert.equal(config.includes('fixture-only'), false, 'the raw gateway key is never written to runtime config')
      }
      await host.call('runtime/account/remove', { runtime: added.runtime })
      assert.equal(new AccountSlots(join(root, 'accounts.json')).find(added.runtime), null)
      assert.equal(host.syncPayload().params.runtimes.some(info => info.id === added.runtime), false)
      if (process.env.HD_ADD_ROLLBACK === '1') {
        const { FakeRuntime } = await import(process.env.HD_FAKE_RUNTIME)
        const register = host.register.bind(host)
        let failedId
        host.register = runtime => {
          failedId = runtime.info.id
          register(new FakeRuntime({ id: failedId, name: 'Surviving runtime' }))
          const survivor = host.syncPayload().params.runtimes.find(info => info.id === failedId)
          assert.equal(survivor.slot ?? null, null, 'pending account ownership never describes a competing runtime')
          register(runtime)
        }
        try { await assert.rejects(host.call('runtime/account/add', { runtime: 'codex' }), /already registered/) }
        finally { host.register = register }
        assert.ok(failedId)
        assert.equal(new AccountSlots(join(root, 'accounts.json')).find(failedId), null, 'failed registration rolls back its allocated slot')
        assert.equal(existsSync(join(root, 'accounts', failedId)), false, 'failed registration removes only its new home')
        const survivor = host.syncPayload().params.runtimes.find(info => info.id === failedId)
        assert.ok(survivor, 'rollback preserves the runtime that won registration')
        assert.equal(survivor.slot ?? null, null, 'failed native registration leaves no native ownership')
        await host.unregister(failedId)
        const randomBytes = crypto.randomBytes
        let retried = false
        crypto.randomBytes = size => {
          if (size === 3 && !retried) { retried = true; return Buffer.from(failedId.slice('codex-'.length), 'hex') }
          return randomBytes(size)
        }
        syncBuiltinESMExports()
        let retriedAccount
        try { retriedAccount = await host.call('runtime/account/add', { runtime: 'codex' }) }
        finally { crypto.randomBytes = randomBytes; syncBuiltinESMExports() }
        assert.equal(retriedAccount.runtime, failedId, 'rollback releases its pending id for a later account')
        await host.call('runtime/account/remove', { runtime: failedId })
      }
      assert.equal(existsSync(marker), false, 'only the requested fake runtimes were invoked')
    }
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
  { name: 'native account removal preserves an ignored ACP account and releases ownership for later registrations', agents: true, slots: '', lifecycle: true },
  { name: 'native account allocation skips an id held by an ACP runtime', agents: true, slots: '', lifecycle: true, addCollision: true },
  { name: 'failed native account registration preserves the competing runtime and rolls back the allocation', agents: true, slots: '', lifecycle: true, addRollback: true },
  { name: 'native install reads ignore retained colliding ACP configuration', agents: true, slots: '', installRead: true },
  { name: 'native slot allocation preserves occupied homes and bounds exhaustion', agents: false, slots: '', allocatorControl: true },
  { name: 'a pending native gateway account is prepared before registration', agents: true, slots: '', lifecycle: true, gatewayAdd: true },
  { name: 'native account removal preserves a foreign slot that precedes its registered slot with the same id', agents: false, slots: '', foreignFirst: true },
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
      HD_ACCOUNT_LIFECYCLE: 'lifecycle' in scenario && scenario.lifecycle ? '1' : '0',
      HD_ADD_COLLISION: 'addCollision' in scenario && scenario.addCollision ? '1' : '0',
      HD_ADD_ROLLBACK: 'addRollback' in scenario && scenario.addRollback ? '1' : '0',
      HD_INSTALL_READ: 'installRead' in scenario && scenario.installRead ? '1' : '0',
      HD_ALLOCATOR_CONTROL: 'allocatorControl' in scenario && scenario.allocatorControl ? '1' : '0',
      HD_GATEWAY_ADD: 'gatewayAdd' in scenario && scenario.gatewayAdd ? '1' : '0',
      HD_REMOVE_FOREIGN_FIRST: 'foreignFirst' in scenario && scenario.foreignFirst ? '1' : '0',
      HD_NATIVE_FIXTURE: new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url).pathname,
      HD_ACP_FIXTURE: new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url).pathname,
      HD_FAKE_RUNTIME: new URL('./fixtures/fake-runtime.js', import.meta.url).href,
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
