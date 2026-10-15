/** Eleven synthetic peers; eager reproduces the former launch barrier through the host's start gate. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { Host, Logger, StateStore } from '../../src/index.js'

const costs = [[60, 50], [170, 0], [90, 140], [570, 0], [290, 720], [870, 50], [1400, 1500], [340, 2900], [2800, 1100], [1900, 2000], [1300, 3200]]
const mode = process.argv[2] ?? 'lazy'
const home = await mkdtemp(join(tmpdir(), 'hd-start-probe-'))
const spawns = join(home, 'spawns')
const peer = fileURLToPath(new URL('../../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const runtimes = costs.map(([processMs, modelMs], i) => new AcpRuntime({
  id: `synthetic-${i + 1}`, name: `Synthetic ${i + 1}`, command: process.execPath, args: [peer],
  env: { HOME: home, FAKE_ACP_START_DELAY_MS: String(processMs), FAKE_ACP_MODEL_DELAY_MS: String(modelMs), FAKE_ACP_SPAWNS: spawns },
}))
const host = new Host({ logger: new Logger('probe', { console: false, level: 'error' }), state: new StateStore(join(home, 'state.json')), idleStopMs: 0, catalogRefreshMs: 0, retryDelaysMs: [], startTimeoutMs: 10_000 })
for (const runtime of runtimes) host.register(runtime)
const until = async predicate => {
  const deadline = performance.now() + 15_000
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error('Synthetic probe timed out.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
let defaultReadyMs = null
const start = performance.now()
runtimes[0].onHealthChange(health => { if (health.state === 'ready') defaultReadyMs = performance.now() - start })
try {
  await host.start()
  if (mode === 'eager') {
    await Promise.all(runtimes.map(runtime => host.call('runtime/warm', { runtime: runtime.info.id })))
    await until(() => runtimes.every(runtime => runtime.health().state === 'ready'))
  }
  const hostStartMs = performance.now() - start
  await until(async () => {
    try { return JSON.parse(await readFile(join(home, 'runtime-cache.json'), 'utf8')).runtimes['synthetic-1']?.start?.modelsMs != null } catch { return false }
  })
  const measured = JSON.parse(await readFile(join(home, 'runtime-cache.json'), 'utf8')).runtimes['synthetic-1'].start
  const defaultModelsMs = defaultReadyMs + measured.modelsMs
  const spawned = (await readFile(spawns, 'utf8')).trim().split('\n').length
  console.log(JSON.stringify({ mode, registered: runtimes.length, spawned, hostStartMs: Math.round(hostStartMs), defaultReadyMs: Math.round(defaultReadyMs), defaultModelsMs: Math.round(defaultModelsMs) }))
} finally { await host.dispose(); await rm(home, { recursive: true, force: true }) }
