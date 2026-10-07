import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { RuntimeId } from '@harnessdesk/protocol'

import { AgentDirectory, AgentRegistryStore } from '../../src/agent-registry.js'
import { knownAgent } from '../../src/installs/known-agents.js'
import { knowledgeOverlay } from '../../src/installs/overlay.js'
import { FakeRuntime } from '../fixtures/fake-runtime.js'

/**
 * What the desk lays over a row it recognises — today's name, the identity
 * reader, the usage record — read through the same function the spawn path
 * calls, since that path is a closure inside the host's construction that no
 * test builds.
 */

const folder = (t: TestContext, files: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-overlay-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, body] of Object.entries(files)) {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(body))
  }
  return dir
}

const antigravityRow = {
  id: 'antigravity-acp',
  name: 'Google Antigravity',
  command: '/state/acp-agents/antigravity-acp/1.1.1/agy_acp_server.par',
  registry: { id: 'antigravity-acp', version: '1.1.1' },
}

test('Gemini opens eight sessions on one ACP process and reaps it after the last close', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-overlay-release-'))
  const log = join(dir, 'lifetime.ndjson')
  const row = { id: 'gemini-alias', name: 'Gemini CLI', command: process.execPath }
  const runtime = new AcpRuntime({ ...row,
    ...knowledgeOverlay(row, knownAgent('gemini'), { env: {} }),
    args: [fileURLToPath(new URL('../../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))],
    env: { FAKE_ACP_NO_CLOSE: '1', FAKE_ACP_NO_LIST: '1', FAKE_ACP_STORE_DRAFTS: '1',
      FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_LIFETIME: log },
  })
  t.after(async () => { await runtime.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const rows = (): { type: string; pid: number; helper?: number }[] => {
    // Reaped zombies still answer kill(pid, 0); count runnable processes,
    // using only ids and states so the snapshot contains no account or path.
    const live = new Set(execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' })
      .trim().split('\n').flatMap(line => {
        const [pid, state] = line.trim().split(/\s+/)
        return state && !/[ZE]/.test(state) ? [Number(pid)] : []
      }))
    return readFileSync(log, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; pid: number; helper?: number })
      .filter(row => live.has(row.helper ?? row.pid))
  }
  await runtime.start()
  await runtime.defaultSessionOptions(dir)
  const sessions = []
  for (let n = 1; n <= 8; n++) {
    sessions.push(await runtime.createSession({ cwd: dir }))
    assert.equal(rows().filter(r => r.type === 'bridge').length, 1,
      `${n} open sessions must share the runtime process`)
  }
  const first = sessions[0]!
  const sibling = sessions[1]!
  const completed = new Promise<void>(resolve => {
    const off = runtime.subscribe(event => {
      if (event.type === 'turn/completed' && event.sessionId === sibling.id) { off(); resolve() }
    })
  })
  await sibling.send([{ type: 'text', text: 'slow' }])
  await first.close()
  assert.equal(await runtime.resumeSession(sibling.id), sibling, 'a working sibling retains its handle')
  await sibling.interrupt()
  await completed
  const resumed = await runtime.resumeSession(first.id)
  await first.close()
  assert.equal(await runtime.resumeSession(first.id), resumed, 'stale close cannot retire its replacement')
  await resumed.close()
  for (const session of sessions.slice(1)) await session.close()
  assert.equal(rows().filter(r => r.type === 'bridge').length, 0)
  assert.equal(rows().filter(r => r.helper).length, 0, 'last close reaps every retained helper')
  assert.equal(runtime.health().state, 'idle')
  assert.ok((await runtime.defaultSessionOptions(dir)).length > 0, 'the cached catalogue survives release')
  await runtime.start()
  const reopened = await runtime.resumeSession(first.id)
  assert.equal(reopened.id, first.id, 'the no-list accepted folder survives process release')
  await reopened.close()
  assert.equal(runtime.health().state, 'idle')
})

test("a row under Antigravity's retired name gets today's name, its reader and its record", (t) => {
  const gemini = folder(t, { 'antigravity-acp/settings.json': { auth: { type: 'oauth-personal' } } })
  const overlay = knowledgeOverlay(antigravityRow, knownAgent('antigravity-acp'), { env: { GEMINI_HOME: gemini } })
  assert.equal(overlay.name, 'Antigravity')
  assert.deepEqual(overlay.resolveIdentity?.(), { kind: 'agent', label: 'Google account', anonymous: true })
  assert.equal(typeof overlay.usageRecord?.since, 'function', 'the store it counts its usage in')
  /* And no account commands — #749. The two this row used to carry were the
     `agy` CLI, which is a different download from the ACP server the row
     runs: `agy --print /help` exits 0 without starting a sign-in, so the desk
     reported one that never happened, and `agy --print /logout` exits 2
     always, print mode refusing a command whose effect outlives the run. The
     server declares ACP's own `logout` instead, which the adapter drives. */
  assert.equal(overlay.account, undefined)
  assert.equal(knownAgent('antigravity-acp')?.auth.login, undefined)
  assert.equal(knownAgent('antigravity-acp')?.auth.logout, undefined)
})

test('Gemini CLI gets a reader and no record; an agent the desk does not know keeps its name and gets neither', () => {
  const gemini = knowledgeOverlay({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }, knownAgent('gemini'), {
    env: {},
  })
  assert.equal(gemini.name, 'Gemini CLI')
  assert.equal(typeof gemini.resolveIdentity, 'function')
  assert.equal(gemini.usageRecord, undefined)
  const custom = knowledgeOverlay({ id: 'my-agent', name: 'Google Antigravity', command: 'my-agent' }, undefined, { env: {} })
  assert.deepEqual(custom, { name: 'Google Antigravity', coAuthor: null }, 'a retired name is retired only for the agent it belonged to')
})

test('OpenCode asks its CLI nothing and reads its own record instead — #749', (t) => {
  const data = folder(t, { 'opencode/auth.json': { opencode: { type: 'api', key: 'secret' } } })
  const overlay = knowledgeOverlay({ id: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] }, knownAgent('opencode'), {
    env: { XDG_DATA_HOME: data },
  })
  /* `opencode auth list` drew a box of provider names that never parsed as an
     account, and a declared status replaces the session observation — so the
     desk reported OpenCode signed out for good and put a sign-in wall where
     its composer should be. No command now, and the record answers. */
  assert.equal(overlay.account, undefined)
  assert.equal(knownAgent('opencode')?.auth.status, undefined)
  assert.deepEqual(overlay.resolveIdentity?.(), { kind: 'agent', label: 'opencode', anonymous: true })
})

test("a Cline row's relative --data-dir is read where that row runs", (t) => {
  const root = folder(t, {
    'state/settings/providers.json': {
      lastUsedProvider: 'cline',
      providers: { cline: { settings: { auth: { metadata: { userInfo: { email: 'dev@example.com' } } } } } },
    },
  })
  const overlay = knowledgeOverlay(
    { id: 'cline', name: 'Cline', command: 'cline', args: ['--acp', '--data-dir', 'state'], cwd: root },
    knownAgent('cline'),
    { env: {} },
  )
  assert.equal(overlay.resolveIdentity?.()?.email, 'dev@example.com')
})

test("a managed update leaves the row's name as it was, and the overlay still shows today's", async (t) => {
  const stateDir = folder(t, {})
  const store = new AgentRegistryStore(join(stateDir, 'agents.json'))
  store.add({ ...antigravityRow, registry: { id: 'antigravity-acp', version: '1.1.0' } })
  const directory = new AgentDirectory({
    store,
    build: (config) => new FakeRuntime({ id: config.id as RuntimeId, name: config.name }),
    usageFor: () => null,
    which: async () => null,
    registry: {
      async catalog() {
        return { fetchedAt: 1, agents: [] }
      },
      async resolve() {
        const entry = { ...antigravityRow }
        return { entry, config: entry as never }
      },
      uninstall() {},
    },
  })
  assert.deepEqual(await directory.updateManaged('antigravity-acp'), { from: '1.1.0', to: '1.1.1' })
  assert.equal(store.entry('antigravity-acp')?.['name'], 'Google Antigravity', 'the file is the person’s own')
  const config = directory.configOf('antigravity-acp')
  assert.ok(config)
  assert.equal(knowledgeOverlay(config, knownAgent('antigravity-acp'), { env: {} }).name, 'Antigravity')
})

test('a row the desk knows gets a reader for which vendor its models come from; an unknown row gets none', async () => {
  const env = { ANTHROPIC_BASE_URL: 'https://proxy.example.com' }
  const claude = knowledgeOverlay({ id: 'claude-code', name: 'Claude Code', command: 'claude-acp' }, knownAgent('claude-code'), { env })
  assert.equal(typeof claude.resolveProvider, 'function')
  assert.equal(await claude.resolveProvider?.(), null, 'read with the environment the row is started with')
  const stranger = knowledgeOverlay({ id: 'someone-else', name: 'Someone', command: 'someone' }, undefined, { env: {} })
  assert.equal(stranger.resolveProvider, undefined)
})

test('native commit credit follows the executable command, never the row id', () => {
  const claude = knownAgent('claude-code')!
  const cursor = knownAgent('cursor')!
  const claudeCredit = Reflect.get(claude, 'coAuthor')
  const cursorCredit = Reflect.get(cursor, 'coAuthor')
  const creditOf = (row: Parameters<typeof knowledgeOverlay>[0], known: Parameters<typeof knowledgeOverlay>[1]) =>
    Reflect.get(knowledgeOverlay(row, known, { env: {} }), 'coAuthor')
  const shippedClaudeRow: Parameters<typeof knowledgeOverlay>[0] = {
    id: 'claude-code',
    name: 'Claude Code',
    command: '/usr/local/bin/node',
    executable: { command: 'claude', env: 'CLAUDE_CODE_EXECUTABLE' },
  }
  const shippedCursorRow: Parameters<typeof knowledgeOverlay>[0] = {
    id: 'cursor',
    name: 'Cursor',
    command: '/usr/local/bin/node',
    executable: { command: 'cursor-agent', env: 'CURSOR_AGENT_EXECUTABLE' },
  }

  assert.ok(claudeCredit, 'native credits live in the known-agent table')
  assert.deepEqual(creditOf(shippedClaudeRow, claude), claudeCredit,
    'the shipped Claude template is credited')
  assert.deepEqual(creditOf(shippedCursorRow, cursor), cursorCredit,
    'the shipped Cursor template is credited')
  assert.deepEqual(creditOf({ id: 'renamed-claude', name: 'My Claude', command: '/vendor/bin/claude' }, undefined), claudeCredit,
    'a person-named row running the Claude CLI is credited')
  assert.equal(creditOf({ id: 'cursor', name: 'Unrelated', command: 'unrelated-agent' }, cursor), null,
    'a matching id cannot lend a credit to another command')
  assert.equal(creditOf({ id: 'constructor', name: 'Unrelated', command: 'unrelated-agent' }, undefined), null,
    'prototype property names are not native credits')
})

test("a Claude row's sign-in declares the prompt its command prints when it wants a pasted code", () => {
  /* `claude auth login` prints its link, then `Paste code here if prompted > `,
     and reads its input for the code a browser page shows when it cannot
     reach the command's own callback (read from 2.1.258's source). The
     prompt is declared on the row, not recognised by the adapter, so the
     adapter keeps no agent's words of its own. */
  const overlay = knowledgeOverlay({ id: 'claude-code', name: 'Claude Code', command: 'claude-acp' }, knownAgent('claude-code'))
  assert.equal(overlay.account?.login?.pasteCode, 'Paste code here if prompted')
  // And what it says when it refuses a paste and reads on, which the desk hears to ask again.
  assert.equal(overlay.account?.login?.pasteCodeRejected, 'Invalid code. Please make sure the full code was copied.')
  assert.deepEqual(overlay.account?.login?.args, ['auth', 'login'])
  // A row that declares no prompt keeps its command's input closed.
  assert.equal(knownAgent('cursor')?.auth.login?.pasteCode, undefined)
})
