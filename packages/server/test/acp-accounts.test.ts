import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AgentRegistryStore } from '../src/agent-registry.js'
import { AcpAccounts } from '../src/acp-accounts.js'

/**
 * More than one Antigravity account.
 *
 * Antigravity's server keeps its Google token in the macOS keychain unless
 * `AGY_ACP_FORCE_FILE_STORAGE=1` moves it into `acp_token.json` under
 * `GEMINI_HOME` — measured 2026-10-17 with two Google accounts, where each
 * row's token stayed in its own folder, both survived a restart, and signing
 * one out left the other signed in. So a second account here is a second
 * agent row over a folder of its own, and the desk's part of that is: make
 * the row, make the folder, and take the folder away when the row goes.
 *
 * The original row — the keychain, the default home — is never touched, and
 * nothing here ever deletes a folder: a removal moves it to the Trash.
 */

const AGY_ROW = {
  id: 'antigravity-acp',
  name: 'Antigravity',
  command: '/opt/demo/antigravity/bin/agy_acp_server',
  registry: { id: 'antigravity-acp', version: '1.1.1' },
  agent: 'antigravity-acp',
  brand: 'antigravity',
  tagline: "Google's Antigravity agent, through its own ACP server.",
}

const OTHER_ROW = { id: 'claude-code', name: 'Claude Code', command: 'claude-code-acp' }

const rig = async (
  t: { after(fn: () => void): void },
  entries: Record<string, unknown>[],
  trash?: (path: string) => Promise<void>,
): Promise<{ dir: string; store: AgentRegistryStore; accounts: AcpAccounts }> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-accounts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  for (const entry of entries) store.add(entry as Record<string, unknown> & { id: string })
  const accounts = new AcpAccounts({ store, stateDir: dir, ...(trash ? { trash } : {}) })
  return { dir, store, accounts }
}

test('only an Antigravity row can hold another account', async (t) => {
  const { accounts } = await rig(t, [AGY_ROW, OTHER_ROW])

  assert.equal(accounts.canAdd('antigravity-acp'), true)
  assert.equal(accounts.canAdd('claude-code'), false)
  assert.equal(accounts.canAdd('nobody'), false)

  // And an account already added is one more person can add from.
  const extra = accounts.add('antigravity-acp')
  assert.equal(accounts.canAdd(extra.id), true)
})

test('a new account is a row of its own with a folder of its own', async (t) => {
  const { dir, store, accounts } = await rig(t, [AGY_ROW])
  const config = accounts.add('antigravity-acp')

  assert.match(config.id, /^antigravity-acp-[0-9a-f]{6}$/)
  const entry = store.entry(config.id)
  assert.ok(entry)
  assert.equal(entry['accountOf'], 'antigravity-acp')
  assert.equal(entry['agent'], 'antigravity-acp')
  // The original's row would have uninstalled its own download had this been
  // carried: `AgentDirectory.remove` reads `registry` to do exactly that.
  assert.equal('registry' in entry, false)
  assert.equal(entry['command'], AGY_ROW.command)
  assert.equal(entry['brand'], AGY_ROW.brand)
  assert.equal(entry['tagline'], AGY_ROW.tagline)
  assert.equal(entry['name'], 'Antigravity 2')

  const env = entry['env'] as Record<string, string>
  const folder = join(dir, 'accounts', config.id)
  assert.equal(env['GEMINI_HOME'], folder)
  assert.equal(env['AGY_ACP_FORCE_FILE_STORAGE'], '1')

  assert.equal(existsSync(folder), true)
  assert.equal((await stat(folder)).mode & 0o777, 0o700)
})

test('accounts are numbered, and a name a person gives is used as it was typed', async (t) => {
  const { accounts } = await rig(t, [AGY_ROW])

  assert.equal(accounts.add('antigravity-acp').name, 'Antigravity 2')
  assert.equal(accounts.add('antigravity-acp').name, 'Antigravity 3')
  assert.equal(accounts.add('antigravity-acp', '  Work account  ').name, 'Work account')
  // The given name is a name already in use, so the series skips past it.
  assert.equal(accounts.add('antigravity-acp').name, 'Antigravity 4')
})

test('a slot names the account it is, and the one it is an account of', async (t) => {
  const { dir, accounts } = await rig(t, [AGY_ROW, OTHER_ROW])

  assert.deepEqual(accounts.slotOf('antigravity-acp'), {
    agent: 'antigravity-acp',
    home: join(homedir(), '.gemini'),
    removable: false,
  })
  assert.equal(accounts.slotOf('claude-code'), null)
  assert.equal(accounts.slotOf('nobody'), null)

  const extra = accounts.add('antigravity-acp')
  assert.deepEqual(accounts.slotOf(extra.id), {
    agent: 'antigravity-acp',
    home: join(dir, 'accounts', extra.id),
    removable: true,
  })
})

test('the original home is the one its row already names', async (t) => {
  const { accounts } = await rig(t, [
    { ...AGY_ROW, env: { GEMINI_HOME: '/tmp/hd-not-a-real-home' } },
  ])
  assert.equal(accounts.slotOf('antigravity-acp')?.home, '/tmp/hd-not-a-real-home')
})

test('removing an account forgets the row and moves the folder to the Trash', async (t) => {
  const trashed: string[] = []
  const { dir, store, accounts } = await rig(t, [AGY_ROW], async (path) => {
    trashed.push(path)
  })
  const extra = accounts.add('antigravity-acp')
  const folder = join(dir, 'accounts', extra.id)

  await accounts.remove(extra.id)

  assert.deepEqual(trashed, [folder])
  assert.equal(store.entry(extra.id), null)
})

test('without a Trash the folder is left where it is', async (t) => {
  const { dir, store, accounts } = await rig(t, [AGY_ROW])
  const extra = accounts.add('antigravity-acp')
  const folder = join(dir, 'accounts', extra.id)

  await accounts.remove(extra.id)

  assert.equal(store.entry(extra.id), null)
  assert.equal(existsSync(folder), true)
})

test("the agent's original account is not an account this can remove", async (t) => {
  const { store, accounts } = await rig(t, [AGY_ROW])
  await assert.rejects(() => accounts.remove('antigravity-acp'))
  assert.notEqual(store.entry('antigravity-acp'), null)
})

test('a row whose home points outside the accounts folder is refused', async (t) => {
  // A hand-edited `agents.json` is the user's file, and a folder named there
  // is not one this desk made. Moving it to the Trash would take whatever
  // the path really holds with it.
  const elsewhere = await mkdtemp(join(tmpdir(), 'hd-acp-elsewhere-'))
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  await mkdir(join(elsewhere, 'gemini'), { recursive: true })
  const forged = {
    id: 'antigravity-acp-deadbe',
    name: 'Forged account',
    command: AGY_ROW.command,
    accountOf: 'antigravity-acp',
    env: { GEMINI_HOME: join(elsewhere, 'gemini') },
  }
  const { store, accounts } = await rig(t, [AGY_ROW, forged])

  await assert.rejects(() => accounts.remove(forged.id))
  assert.notEqual(store.entry(forged.id), null)
  assert.equal(existsSync(join(elsewhere, 'gemini')), true)
})

for (const rows of [
  [{ id: 'self', accountOf: 'self' }],
  [{ id: 'one', accountOf: 'two' }, { id: 'two', accountOf: 'one' }],
  [{ id: 'antigravity-acp', agent: 'antigravity-acp', accountOf: 'antigravity-acp' }],
]) {
  test(`invalid account links are not accounts: ${rows.map((row) => row.id).join(', ')}`, async (t) => {
    const { accounts } = await rig(t, rows.map((row) => ({ ...row, command: 'fake' })))
    for (const row of rows) {
      assert.equal(accounts.canAdd(row.id), false)
      assert.equal(accounts.slotOf(row.id), null)
    }
  })
}

for (const field of [{ agent: 'antigravity-acp' }, { registry: AGY_ROW.registry }, { template: 'antigravity-acp' }]) {
  test(`Antigravity is recognised by ${Object.keys(field)[0]}`, async (t) => {
    const { accounts } = await rig(t, [{ id: 'custom', command: AGY_ROW.command, ...field }])
    assert.equal(accounts.canAdd('custom'), true)
    assert.equal(accounts.slotOf('custom')?.removable, false)
    const extra = accounts.add('custom')
    assert.equal(accounts.canAdd(extra.id), true)
    assert.equal(accounts.slotOf(extra.id)?.agent, 'custom')
  })
}

test('account names are trimmed, capped at 80 characters, and blank names use the next number', async (t) => {
  const { accounts } = await rig(t, [AGY_ROW])
  assert.equal(accounts.add(AGY_ROW.id, '   ').name, 'Antigravity 2')
  assert.equal(accounts.add(AGY_ROW.id, `  ${'x'.repeat(90)}  `).name, 'x'.repeat(80))
  assert.equal(accounts.add(AGY_ROW.id, '  Work  ').name, 'Work')
})

test('removal refuses a home symlink that escapes accounts', async (t) => {
  const trashed: string[] = []
  const { dir, store, accounts } = await rig(t, [AGY_ROW], async (path) => { trashed.push(path) })
  const extra = accounts.add(AGY_ROW.id)
  const folder = join(dir, 'accounts', extra.id)
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await rm(folder, { recursive: true })
  await symlink(outside, folder)
  await assert.rejects(accounts.remove(extra.id), /outside .*refusing to remove/)
  assert.ok(store.entry(extra.id))
  assert.deepEqual(trashed, [])
  assert.equal(existsSync(outside), true)
})
