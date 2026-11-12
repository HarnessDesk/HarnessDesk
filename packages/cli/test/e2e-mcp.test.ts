/**
 * The end-to-end proof the MCP surface exists for: a real MCP client
 * process, an agent's stand-in, starts a saved Flow on a desk and waits on
 * the run it started until the run settles. Its Seat is a scripted fake that
 * commits an answer; nothing here reaches a vendor or the network.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { McpStartsView } from '@harnessdesk/protocol'
import { bin, cleanEnv, LOADED_MACHINE_MS, type McpMessage } from './mcp-server.js'
const { openClientDoor } = await import(new URL('../../../server/dist/src/client-door.js', import.meta.url).href) as typeof import('../../server/src/client-door.js')
const { silent } = await import(new URL('../../../server/dist/test/fixtures/harness.js', import.meta.url).href) as typeof import('../../server/test/fixtures/harness.js')
const flowRig = await import(new URL('../../../server/dist/test/fixtures/flow-host-evidence.js', import.meta.url).href) as typeof import('../../server/test/fixtures/flow-host-evidence.js')

const client = fileURLToPath(new URL('../../test/fixtures/mcp-client.mjs', import.meta.url))
/** Saved in the project, so an MCP client may start it: one researcher, who commits its answer. */
const SAVED = [
  'version: 2', 'name: "MCP agent proof"',
  'inputs:', '  question:', '    label: "Question"',
  'roles:', '  research:', '    kind: agent', '    uses: [researcher]', '    grant: edit', '    independentOf: []',
  'seed: { role: research, title: "{{question}}" }', '',
].join('\n')

test('a real MCP client starts a saved Flow and waits on its run until it settles', flowRig.E2E, async t => {
  const directory = await mkdtemp('/tmp/hd-mcp-'); await chmod(directory, 0o700)
  const d = await flowRig.desk(t)
  const door = await openClientDoor({ host: d.host, logger: silent, home: d.stateDir, directory, hostVersion: '9.9.9' })
  assert.ok(door)
  t.after(async () => { await door.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  await mkdir(join(d.root, '.harnessdesk', 'flows'), { recursive: true })
  await writeFile(join(d.root, '.harnessdesk', 'flows', 'mcp-agent.yml'), SAVED)
  await flowRig.git(d.root, 'add', '.harnessdesk')
  await flowRig.git(d.root, 'commit', '-q', '-m', 'Save the MCP proof flow')
  const before = await d.host.call('app/mcpStarts/get', {}) as McpStartsView
  await d.host.call('app/mcpStarts/set', { revision: before.revision, mayStart: true })

  const child = spawn(process.execPath, [client, JSON.stringify({ bin, flow: 'mcp-agent', project: d.root, input: ['question=Where does the time go?'], timeout: 120 })], {
    env: cleanEnv({ HARNESSDESK_CLIENT_DIR: directory, HARNESSDESK_HOME: d.stateDir }), stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  const changed = new Set<() => void>()
  child.stdout.on('data', chunk => { stdout += chunk.toString(); for (const wake of [...changed]) wake() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exit = new Promise<number | null>(resolve => child.once('close', resolve))
  const kill = setTimeout(() => child.kill('SIGKILL'), flowRig.SAFETY_MS)
  t.after(async () => { clearTimeout(kill); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit })
  const lines = () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as McpMessage)
  const when = (predicate: (message: McpMessage) => boolean, what: string) => new Promise<McpMessage>((resolve, reject) => {
    const timer = setTimeout(() => { changed.delete(check); reject(new Error(`no ${what} after ${LOADED_MACHINE_MS}ms: ${stdout}\n${stderr}`)) }, LOADED_MACHINE_MS)
    const check = () => { const found = lines().find(predicate); if (found) { clearTimeout(timer); changed.delete(check); resolve(found) } }
    changed.add(check); check()
  })

  const started = await when(message => message.id === 2, 'the flow_start answer')
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const runId = started.result.structuredContent.run as string
  d.runs.push(runId)
  const run = await flowRig.execution(d, runId)
  // The Seat does its work while the client waits.
  const [research] = await flowRig.claimed(d, run.goal, 'research', 1)
  await flowRig.write(d, research!, 'the answer', 'gathered')
  await flowRig.settled(d, runId)

  assert.equal(await exit, 0, `${stdout}\n${stderr}`)
  const waited = lines().find(message => message.id === 3)!
  assert.equal(waited.result.isError, undefined, JSON.stringify(waited))
  assert.equal(waited.result.structuredContent.exit, 0)
  assert.equal(waited.result.structuredContent.ended, 'settled')
  assert.equal(waited.result.structuredContent.state, 'settled')
  const progress = lines().filter(message => message.method === 'notifications/progress' && message.params.progressToken === 'example-wait')
  assert.ok(progress.length >= 1, 'progress arrived while the client waited')
  assert.ok(progress.every((one, index) => index === 0 || one.params.progress > progress[index - 1]!.params.progress), 'progress only goes up')
  assert.deepEqual((await flowRig.execution(d, runId)).startedBy, { via: 'mcp', client: 'example-client@1.0.0' })
  assert.equal((await d.host.call('app/mcpStarts/get', {}) as McpStartsView).started, 1)
  t.diagnostic(`MCP proof: flow_start → run ${runId} → ${progress.map(one => one.params.message).join(' → ')} → ${waited.result.structuredContent.ended}`)
})
