import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'

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

test("a row under Antigravity's retired name gets today's name, its reader and its record", (t) => {
  const gemini = folder(t, { 'antigravity-acp/settings.json': { auth: { type: 'oauth-personal' } } })
  const overlay = knowledgeOverlay(antigravityRow, knownAgent('antigravity-acp'), { env: { GEMINI_HOME: gemini } })
  assert.equal(overlay.name, 'Antigravity')
  assert.deepEqual(overlay.resolveIdentity?.(), { kind: 'agent', label: 'Google account', anonymous: true })
  assert.equal(typeof overlay.usageRecord?.since, 'function', 'the store it counts its usage in')
})

test('Gemini CLI gets a reader and no record; an agent the desk does not know keeps its name and gets neither', () => {
  const gemini = knowledgeOverlay({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] }, knownAgent('gemini'), {
    env: {},
  })
  assert.equal(gemini.name, 'Gemini CLI')
  assert.equal(typeof gemini.resolveIdentity, 'function')
  assert.equal(gemini.usageRecord, undefined)
  const custom = knowledgeOverlay({ id: 'my-agent', name: 'Google Antigravity', command: 'my-agent' }, undefined, { env: {} })
  assert.deepEqual(custom, { name: 'Google Antigravity' }, 'a retired name is retired only for the agent it belonged to')
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
