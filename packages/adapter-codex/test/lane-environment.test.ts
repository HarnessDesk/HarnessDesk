import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '../src/index.js'
import { codexEnvironmentConfig } from '../src/lane-environment.js'

const env = (start: number) => ({
  HARNESSDESK_GOAL_ID: 'g1',
  HARNESSDESK_LANE_ID: `lane-${start}`,
  HARNESSDESK_PORT_START: String(start),
  HARNESSDESK_PORT_END: String(start + 19),
  HARNESSDESK_PORT_COUNT: '20',
  PORT: String(start),
})

test('native configuration preserves model-route and sandbox fields', () => {
  const config = { 'model_providers.test.name': 'Fixture', sandbox_mode: 'workspace-write' }
  assert.deepEqual(codexEnvironmentConfig(config, env(30000)), {
    ...config,
    'shell_environment_policy.set': env(30000),
  })
  assert.deepEqual(config, { 'model_providers.test.name': 'Fixture', sandbox_mode: 'workspace-write' })
})

test('start, resume and fork deliver each thread config to a real fixture child', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'hd-native-lanes-'))
  const log = join(home, 'observed.jsonl')
  const runtime = new CodexRuntime({
    binaryPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    clientName: 'harnessdesk-test',
    env: { FAKE_CODEX_LANE_ENV_LOG: log },
  })
  t.after(async () => {
    await runtime.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await runtime.start()
  const a = await runtime.createSession({ cwd: home, environment: env(30000) })
  const b = await runtime.createSession({ cwd: home, environment: env(30020) })
  await a.close()
  await b.close()
  await runtime.resumeSession(a.id)
  await runtime.resumeSession(b.id)
  await runtime.forkSession(a.id)
  const rows = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string
          environment: Record<string, string>
          child: Record<string, string>
        },
    )
  assert.deepEqual(
    rows.map((row) => row.method),
    ['thread/start', 'thread/start', 'thread/resume', 'thread/resume', 'thread/fork'],
  )
  assert.deepEqual(
    rows.map((row) => row.environment),
    [env(30000), env(30020), env(30000), env(30020), env(30000)],
  )
  assert.deepEqual(
    rows.map((row) => row.child),
    rows.map((row) => row.environment),
  )
})
