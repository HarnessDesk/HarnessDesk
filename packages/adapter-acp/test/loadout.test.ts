import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentRuntime } from '@harnessdesk/protocol'
import { AcpRuntime } from '../src/index.js'
const make = (env: Record<string, string> = {}) => new AcpRuntime({ id: 'fake-acp', name: 'Fake ACP Agent', command: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))], env })
const answer = () => ({ ready: true, skills: [{ name: 'demo', source: 'user', tokens: 12 }],
  mcpTools: [{ name: 'a', serverName: 'docs', tokens: 10, isLoaded: true }, { name: 'b', serverName: 'docs', tokens: 99, isLoaded: false },
    { name: 'c', serverName: 'docs', tokens: 20 }, { name: 'd', serverName: 'git', tokens: 40, isLoaded: false }],
  memoryFiles: [{ path: '/home/jane/CLAUDE.md', type: 'user', tokens: 50 }], agents: [{ agentType: 'Explore', source: 'builtin', tokens: 60 }] })
const item = (name: string, tokens: number | null, extra = {}) => ({ name, tokens, origin: null, group: null, path: null, count: null, enabled: null, ...extra })

test('ACP loadout maps all four lists, groups MCP tools and counts only loaded sizes, without caching', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-loadout-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'answer.json'); writeFileSync(file, JSON.stringify(answer()))
  const runtime = make({ FAKE_ACP_LOADOUT_FILE: file }); await runtime.start(); t.after(() => runtime.dispose())
  const session = await runtime.createSession({ cwd: dir })
  const read = () => (runtime as AgentRuntime).loadout!(session.id, dir)
  const result = await read()
  assert.equal(result.approximate, true); assert.equal(result.source, 'getContextUsage (summary)')
  assert.deepEqual(result.skills, { reported: true, items: [item('demo', 12, { origin: 'user' })], more: 0 })
  assert.deepEqual(result.mcp, { reported: true, items: [item('docs', 30, { count: 3 }), item('git', 0, { count: 1 })], more: 0 })
  assert.deepEqual(result.memory, { reported: true, items: [item('CLAUDE.md', 50, { group: 'user', path: '/home/jane/CLAUDE.md' })], more: 0 })
  assert.deepEqual(result.agents, { reported: true, items: [item('Explore', 60, { origin: 'builtin' })], more: 0 })
  writeFileSync(file, JSON.stringify({ ready: false, reason: 'Still opening.' }))
  for (const part of Object.values(await read()).filter(value => typeof value === 'object')) assert.deepEqual(part, { reported: false, reason: 'Still opening.', notReady: true })
  writeFileSync(file, JSON.stringify({ ...answer(), skills: null }))
  assert.deepEqual((await read()).skills, { reported: false, reason: 'This agent did not report its skills.' })
})

test('ACP refuses malformed loadouts and bounds every list before mapping or truncating', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-loadout-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'answer.json'); writeFileSync(file, JSON.stringify(answer()))
  const runtime = make({ FAKE_ACP_LOADOUT_FILE: file }); await runtime.start(); t.after(() => runtime.dispose())
  const session = await runtime.createSession({ cwd: dir })
  const read = () => (runtime as AgentRuntime).loadout!(session.id, dir)
  const invalid = [null, {}, { ready: false }, { ready: false, reason: 1 }, { ...answer(), ready: 'true' },
    { ...answer(), skills: {} }, { ...answer(), skills: [{ name: 'x'.repeat(257), source: 'user', tokens: 0 }] },
    { ...answer(), agents: [{ agentType: 'a', source: null, tokens: 0 }] },
    { ...answer(), memoryFiles: [{ path: 'relative/CLAUDE.md', type: 'user', tokens: 0 }] },
    { ...answer(), memoryFiles: [{ path: '/' + 'x'.repeat(4096), type: 'user', tokens: 0 }] },
    { ...answer(), mcpTools: [{ name: 'a', serverName: 'docs', tokens: 0, isLoaded: 'true' }] },
    { ...answer(), skills: [{ name: '', source: 'user', tokens: 0 }] },
    { ...answer(), skills: [{ name: 'a', source: 'user', tokens: -1 }] },
    { ...answer(), skills: [{ name: 'a', source: 'user', tokens: null }] }]
  for (const value of invalid) {
    writeFileSync(file, JSON.stringify(value)); await assert.rejects(read(), /The agent returned an invalid loadout\./, JSON.stringify(value))
  }
  for (const key of ['skills', 'mcpTools', 'memoryFiles', 'agents'] as const) {
    const base = answer(); writeFileSync(file, JSON.stringify({ ...base, [key]: Array(10_001).fill(base[key][0]) }))
    await assert.rejects(read(), /invalid loadout/)
    writeFileSync(file, JSON.stringify({ ...base, [key]: Array.from({ length: 502 }, (_, i) => ({ ...base[key][0], ...(key === 'mcpTools' ? { serverName: `server-${i}` } : {}) })) }))
    const result = (await read())[key === 'mcpTools' ? 'mcp' : key === 'memoryFiles' ? 'memory' : key]
    assert.ok(result.reported); assert.equal(result.items.length, 500); assert.equal(result.more, 2)
    // The invalid entry is beyond the retained 500: it still refuses the whole report.
    writeFileSync(file, JSON.stringify({ ...base, [key]: [...Array(501).fill(base[key][0]), null] }))
    await assert.rejects(read(), /invalid loadout/)
  }
  writeFileSync(file, JSON.stringify(answer()).replace('"tokens":12', '"tokens":1e999'))
  await assert.rejects(read(), /invalid loadout/)
})

test('without the extension ACP reports command names only, or not ready before commands are heard', async t => {
  const runtime = make({ FAKE_ACP_NO_COMMANDS: '1' }); await runtime.start(); t.after(() => runtime.dispose())
  const session = await runtime.createSession({ cwd: '/home/jane' })
  const read = () => (runtime as AgentRuntime).loadout!(session.id, '/home/jane')
  assert.deepEqual((await read()).skills, { reported: false, reason: 'This agent has not listed its commands yet.', notReady: true })
  runtime.learnCommands([{ name: 'demo', description: 'not part of the loadout' }])
  const result = await read()
  assert.equal(result.approximate, false); assert.equal(result.source, 'available commands')
  assert.deepEqual(result.skills, { reported: true, items: [item('demo', null)], more: 0 })
  for (const [key, label] of [['mcp', 'servers'], ['memory', 'memory files'], ['agents', 'agents']] as const) assert.deepEqual(result[key], { reported: false, reason: `This agent does not report its ${label}.` })
})
