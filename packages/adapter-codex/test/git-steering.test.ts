import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CodexRuntime } from '../src/index.js'
import { testProcessEnv } from './fixtures/test-process-env.js'

test('start, resume without cwd, and fork each bind a fresh steering token and preserve configured PATH', async t => {
  const home = await mkdtemp(join(tmpdir(), 'hd-native-git-')), log = join(home, 'env.ndjson')
  const claims: { caller: string; session: string }[] = [], roots: string[] = [], paths: (string | undefined)[] = []
  const path = process.env['PATH']!
  const runtime = new CodexRuntime({ binaryPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)), clientName: 'test',
    env: testProcessEnv({ FAKE_CODEX_LANE_ENV_LOG: log, PATH: path }),
    gitEnvironment: async (cwd, caller, basePath) => { roots.push(cwd); paths.push(basePath); return { PATH: path, HD_TOOLS_CALLER: caller, HD_GIT_STEER: 'ask' } },
    onGitSession: (caller, session) => { claims.push({ caller, session }) } })
  t.after(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }) })
  await runtime.start()
  const original = await runtime.createSession({ cwd: home }); await original.close()
  const resumed = await runtime.resumeSession(original.id)
  const forked = await runtime.forkSession(resumed.id)
  const rows = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { environment: Record<string, string> })
  assert.equal(claims.length, 3); assert.equal(new Set(claims.map(claim => claim.caller)).size, 3)
  assert.deepEqual(claims.map(claim => claim.session), [String(original.id), String(original.id), String(forked.id)])
  assert.deepEqual(roots, [home, home, home]); assert.deepEqual(paths, [path, path, path])
  assert.deepEqual(rows.map(row => row.environment['HD_TOOLS_CALLER']), claims.map(claim => claim.caller))
})
