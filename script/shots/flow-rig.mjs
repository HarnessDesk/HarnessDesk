import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, setTeamEngine } from '../../packages/cordis-host/dist/src/index.js'
import { teamPlugin } from '../../packages/plugins/dist/src/index.js'
import { Host, Logger, StateStore } from '../../packages/server/dist/src/index.js'
import { GatedRegistry } from '../../packages/server/dist/src/ceilings/gate.js'
import { CodexRuntime } from '../../packages/adapter-codex/dist/src/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const FLOW_SOURCE = readFileSync(new URL('./flow.yml', import.meta.url), 'utf8')

/** Own one synthetic desk. No install discovery, vendor accounts or forge. */
export async function createFlowRig({ home, work, delayMs = 0, scriptedTurns = true, gates, evidenceNow }) {
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '1' }, stdio: 'pipe',
  })
  const repo = join(work, 'storefront')
  const flows = join(repo, '.harnessdesk', 'flows')
  mkdirSync(flows, { recursive: true })
  writeFileSync(join(flows, 'scripted-repair.yml'), FLOW_SOURCE)
  execFileSync('git', ['add', '.harnessdesk/flows/scripted-repair.yml'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'rig: stage the scripted repair flow'], { cwd: repo, stdio: 'pipe' })
  writeFileSync(join(home, 'seating.json'), JSON.stringify({ 'code-reviewer': ['codex'] }))
  mkdirSync(join(home, 'flow-passes'), { recursive: true })
  const state = join(home, 'flow-passes', 'scripted.json')
  writeFileSync(state, JSON.stringify({ passes: {}, done: [] }))
  const logger = new Logger('shots-flow', { level: 'error', console: false })
  const extensions = new ExtensionKernel()
  const host = new Host({
    logger, state: new StateStore(join(home, 'state.json')), extensions, catalogRefreshMs: 0, libraryHome: join(home, 'person'),
    evidence: { gh: async () => ({ stdout: '', stderr: 'This rig has no forge.', exitCode: 1 }), ...(evidenceNow ? { now: evidenceNow } : {}) },
  })
  setTeamEngine(host.teamPlane)
  const codex = new CodexRuntime({
    binaryPath: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'),
    codexHome: join(home, 'codex-home'), capabilities: new GatedRegistry(extensions, () => host.ceilingGate),
    env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0', ...(scriptedTurns ? { FAKE_CODEX_FLOW: JSON.stringify({ state, delayMs, gates, steps: {
      RIG_FLOW_WRITE: { kind: 'write', outcomes: ['committed', 'committed'], file: 'rig-retry.txt' },
      RIG_FLOW_REVIEW: { kind: 'review', outcomes: ['request-changes', 'approve'] },
    } }) } : {}) },
  })
  host.register(codex)
  const errors = []
  codex.subscribe((event) => { if (event.type === 'turn/completed' && event.turn?.error) errors.push(event.turn.error) })
  const dispose = async () => {
    await host.dispose()
    await extensions.dispose()
    setTeamEngine(null)
  }
  try {
    await extensions.load(teamPlugin)
    await host.start()
    await codex.start()
    await host.call('workspace/open', { path: repo })
    return { host, logger, codex, repo, errors, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

export async function startFlowScene(rig) {
  const preview = await rig.host.call('authoring/start/preview', {
    context: { kind: 'project', root: rig.repo }, source: FLOW_SOURCE, vars: {},
  })
  if (!preview.flow.token) throw new Error(JSON.stringify(preview.flow.problems))
  return rig.host.call('flow/start-goal', {
    root: rig.repo, source: FLOW_SOURCE, token: preview.flow.token, sentence: 'Repair the checkout retry',
  })
}
