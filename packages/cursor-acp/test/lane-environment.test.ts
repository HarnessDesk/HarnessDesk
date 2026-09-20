import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent, AgentSession } from '@harnessdesk/protocol'

import { childEnvironment, environmentAck, environmentIn } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('bridge parses only negotiated metadata and preserves response metadata', () => {
  assert.equal(environmentIn({ environment: env(30_000) }), undefined)
  assert.deepEqual(environmentIn({ harnessdesk: { environment: env(30_000) } }), env(30_000))
  assert.throws(
    () => environmentIn({ harnessdesk: { environment: { PORT: '30000' } } }),
    /incomplete/,
  )
  assert.deepEqual(environmentAck({ _meta: { vendor: true } }, env(30_000)), {
    _meta: { vendor: true, harnessdesk: { environment: env(30_000) } },
  })
})

test('two real children inherit separate lane values without changing the parent', async () => {
  const before = { ...process.env }
  const run = promisify(execFile)
  const results = await Promise.all(
    [30_000, 30_020].map(async (port) =>
      JSON.parse(
        (
          await run(
            process.execPath,
            [
              '-e',
              'process.stdout.write(JSON.stringify([process.env.PORT,process.env.HARNESSDESK_PORT_END,process.env.KEPT]))',
            ],
            { env: childEnvironment({ ...process.env, KEPT: 'present' }, env(port)) },
          )
        ).stdout,
      ),
    ),
  )
  assert.deepEqual(results, [
    ['30000', '30019', 'present'],
    ['30020', '30039', 'present'],
  ])
  assert.ok(Object.entries(before).every(([key, value]) => process.env[key] === value))
})

test('plain sessions keep the base environment', () => {
  const base = { PATH: '/work/bin', PORT: '9000' }
  assert.deepEqual(childEnvironment(base), base)
  assert.notEqual(childEnvironment(base), base)
  assert.deepEqual(environmentAck({ sessionId: 'plain' }, undefined), { sessionId: 'plain' })
})

const BRIDGE = fileURLToPath(new URL('../src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-cursor-agent.mjs', import.meta.url))

async function turn(runtime: AcpRuntime, session: AgentSession): Promise<void> {
  let off = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error('The fake turn did not finish.'))
    }, 5_000)
    off = runtime.subscribe((event: AgentEvent) => {
      if (event.type === 'turn/completed' && event.sessionId === session.id) {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
  done.catch(() => {})
  try {
    await session.send([{ type: 'text', text: 'Read the fixture.' }])
    await done
  } finally {
    off()
  }
}

test('the actual bridge child gets both environments and re-applies one after restart', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-lane-bridge-'))
  const log = join(home, 'environment.ndjson')
  const make = () =>
    new AcpRuntime({
      id: 'lane-fixture',
      name: 'Fixture Runtime',
      command: process.execPath,
      args: [BRIDGE],
      env: {
        CURSOR_ACP_COMMAND: FAKE,
        CURSOR_CONFIG_DIR: join(home, 'config'),
        CURSOR_ACP_STATE_DIR: join(home, 'state'),
        FAKE_LANE_ENV_LOG: log,
      },
    })
  const first = make()
  let second: AcpRuntime | null = null
  t.after(async () => {
    await first.dispose()
    await second?.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await first.start()
  assert.equal(first.info.capabilities.sessionEnvironment, true)
  const a = await first.createSession({ cwd: home, environment: env(30000) })
  const b = await first.createSession({ cwd: home, environment: env(30020) })
  await Promise.all([turn(first, a), turn(first, b)])
  await first.dispose()
  second = make()
  await second.start()
  const resumed = await second.resumeSession(a.id, { environment: env(30000) })
  await turn(second, resumed)
  const lines = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, string>)
  assert.ok(lines.some((line) => JSON.stringify(line) === JSON.stringify(env(30000))))
  assert.ok(lines.some((line) => JSON.stringify(line) === JSON.stringify(env(30020))))
  assert.ok(lines.filter((line) => line.HARNESSDESK_LANE_ID === 'lane-30000').length >= 2)
  assert.equal(lines.every((line) => Object.keys(line).length === 6), true)
})
