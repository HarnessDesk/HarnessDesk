import assert from 'node:assert/strict'
import { readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { scratch } from './scratch.js'

const make = (env: Record<string, string> = {}) => new AcpRuntime({
  id: 'claude-code', name: 'Claude Code', command: process.execPath,
  args: [fileURLToPath(new URL('../src/main.js', import.meta.url))],
  env: { HOME: scratch('loadout-home-'), CLAUDE_CONFIG_DIR: scratch('loadout-config-'),
    CLAUDE_ACP_STATE_DIR: scratch('loadout-state-'), CLAUDECODE: '',
    CLAUDE_CODE_EXECUTABLE: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)), ...env },
})
const lists = {
  skills: [{ name: 'demo', source: 'user', tokens: 12 }],
  mcpTools: [{ name: 'read', serverName: 'docs', tokens: 30, isLoaded: false }],
  memoryFiles: [{ path: '/home/jane/CLAUDE.md', type: 'user', tokens: 40 }],
  agents: [{ agentType: 'Explore', source: 'builtin', tokens: 20 }],
}

// Opening a session starts an asynchronous SDK window probe. Its log entry
// can arrive after createSession resolves, so wait for that observed boundary
// before measuring only the extension's own requests below.
const waitForOpenProbe = (log: string): Promise<void> => new Promise((resolve, reject) => {
  const hasProbe = () => readFileSync(log, 'utf8').split('\n').some(line => line.startsWith('context-detail '))
  const done = (error?: Error) => {
    clearTimeout(deadline)
    watcher.close()
    if (error) reject(error)
    else resolve()
  }
  const watcher = watch(log, () => { if (hasProbe()) done() })
  const deadline = setTimeout(() => done(new Error('The session-open SDK context probe did not arrive.')), 10_000)
  watcher.once('error', done)
  if (hasProbe()) done()
})

test('loadout crosses the bridge as plain lists and asks the SDK for summary only', async () => {
  const log = join(scratch('loadout-log-'), 'calls')
  const runtime = make({ FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_CONTEXT: JSON.stringify({ ...lists, skills: { skillFrontmatter: lists.skills }, model: 'private-sdk-field' }) })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: scratch('loadout-cwd-') })
    // The upstream bridge also probes the window in the background at open.
    // Only the requests caused by our extension belong to this assertion.
    await waitForOpenProbe(log)
    const before = readFileSync(log, 'utf8').length
    const result = await runtime.connectionFor(session.id).request('_harnessdesk/session/loadout', { sessionId: session.id })
    assert.deepEqual(result, { ready: true, ...lists })
    assert.deepEqual(readFileSync(log, 'utf8').slice(before).split('\n').filter(line => line.startsWith('context-detail ')), ['context-detail summary'])
    for (const sessionId of ['', 'unknown']) await assert.rejects(
      runtime.connectionFor(session.id).request('_harnessdesk/session/loadout', { sessionId }), { code: -32602 })
    await assert.rejects(runtime.connectionFor(session.id).request('_harnessdesk/session/loadout', {}), { code: -32602 })
  } finally { await runtime.dispose() }
})

test('an omitted SDK skills field is null, and the advertised readback maps through the adapter', async () => {
  const runtime = make({ FAKE_CLAUDE_CONTEXT: JSON.stringify({ ...lists, skills: undefined }) })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: scratch('loadout-cwd-') })
    const result = await runtime.connectionFor(session.id).request<any>('_harnessdesk/session/loadout', { sessionId: session.id })
    assert.equal(result.skills, null)
    const loadout = await (runtime as import('@harnessdesk/protocol').AgentRuntime).loadout!(session.id, '/home/jane')
    assert.deepEqual(loadout.skills, { reported: false, reason: 'This agent did not report its skills.' })
    assert.equal(loadout.source, 'getContextUsage (summary)')
  } finally { await runtime.dispose() }
})

test('an SDK throw becomes a first-line not-ready report through the bridge and adapter', async () => {
  const runtime = make({ FAKE_CLAUDE_CONTEXT_ERROR: 'The query is not ready.\nInternal details.' })
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: scratch('loadout-cwd-') })
    const raw = await runtime.connectionFor(session.id).request<any>('_harnessdesk/session/loadout', { sessionId: session.id })
    assert.equal(raw.ready, false)
    assert.match(raw.reason, /The query is not ready\./)
    assert.doesNotMatch(raw.reason, /\n|Internal details/)
    const result = await (runtime as import('@harnessdesk/protocol').AgentRuntime).loadout!(session.id, '/home/jane')
    for (const part of ['skills', 'mcp', 'memory', 'agents'] as const) assert.deepEqual(result[part], { reported: false, reason: raw.reason, notReady: true })
  } finally { await runtime.dispose() }
})
