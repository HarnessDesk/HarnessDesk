import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ExtensionKernel, setForgeEngine, setTeamEngine } from '../../packages/cordis-host/dist/src/index.js'
import { gitPlugin, teamPlugin } from '../../packages/plugins/dist/src/index.js'
import { Host, Logger, StateStore } from '../../packages/server/dist/src/index.js'
import { GatedRegistry } from '../../packages/server/dist/src/ceilings/gate.js'
import { CodexRuntime } from '../../packages/adapter-codex/dist/src/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const TEMPLATE_TASK = 'Repair checkout retry'
export const TEMPLATE_CHECK = 'node .harnessdesk/rig-check.mjs'
export const TEMPLATE_PUBLISH_BRANCH = 'rig-write-review-1'

/** The two identities use the shipping native read/edit controls. */
class TemplateRuntime extends CodexRuntime {
  constructor(options, provider, readOnly = false) { super(options); this.scriptedProvider = provider; this.scriptedName = options.name; this.scriptedReadOnly = readOnly }
  get info() {
    const info = super.info
    return { ...info, ...(this.scriptedReadOnly && info.ceilings ? { ceilings: { read: info.ceilings.read } } : {}), provider: this.scriptedProvider, presentation: { ...info.presentation, name: this.scriptedName } }
  }
  async providerAt() { return this.scriptedProvider }
}

/** The shipped templates, actual Host, fake agent processes and a local forge. */
export async function createTemplateRig({ home, work, template = 'comparison', readOnlyReviewer = false, reviewerId = 'codex-review', defaultPreferences = false }) {
  const previous = { path: process.env.PATH, home: process.env.HARNESSDESK_HOME }
  const identityKeys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  const previousIdentity = Object.fromEntries(identityKeys.map(key => [key, process.env[key]]))
  const restoreEnvironment = () => {
    for (const [key, value] of Object.entries({ PATH: previous.path, HARNESSDESK_HOME: previous.home, ...previousIdentity })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  // Inherited identity overrides the seed's local placeholder config. Remove
  // it only inside this isolated fixture process so ordinary git config wins.
  for (const key of identityKeys) delete process.env[key]
  process.env.HARNESSDESK_HOME = home
  try {
  execFileSync(process.execPath, [join(root, 'script/shots/seed.mjs')], {
    env: { ...process.env, HD_SHOTS_HOME: home, HD_SHOTS_WORK: work, HD_SHOTS_NATIVE_CODEX: '1' }, stdio: 'pipe',
  })
  const repo = join(work, 'storefront')
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const gates = join(home, 'template-gates')
  mkdirSync(gates, { recursive: true })
  const packageFile = join(repo, 'package.json')
  const project = JSON.parse(readFileSync(packageFile, 'utf8'))
  project.packageManager = 'pnpm@10.0.0'
  project.scripts = { ...project.scripts, test: 'node .harnessdesk/rig-check.mjs' }
  writeFileSync(packageFile, `${JSON.stringify(project, null, 2)}\n`)
  writeFileSync(join(repo, '.harnessdesk', 'rig-check.mjs'), `import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const until = Date.now() + 90000
const gate = ${JSON.stringify(join(gates, 'checks'))}
console.log('Checking the committed retry attempt')
while (!existsSync(gate)) {
  if (Date.now() > until) throw new Error('The scripted check camera gate was not released')
  await delay(50)
}
if (!existsSync('rig-attempt.txt') || !readFileSync('rig-attempt.txt', 'utf8').startsWith('Attempt ')) throw new Error('No committed retry attempt')
console.log('Retry attempt passed')
`)
  if (defaultPreferences) {
    // The camera seed has a project reviewer pinned to the writer. A fresh
    // desk instead reads the shipped Agent and its preference list.
    unlinkSync(join(repo, '.harnessdesk', 'agents', 'code-reviewer', 'AGENT.md'))
    git('add', '.harnessdesk/agents/code-reviewer/AGENT.md')
  }
  git('add', 'package.json', '.harnessdesk/rig-check.mjs')
  git('commit', '-m', 'rig: declare a deterministic project check')
  const remote = join(home, 'storefront.git')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
  // Replace the seeded demo URL with a disposable local remote before any push.
  if (git('remote').split('\n').includes('origin')) git('remote', 'set-url', 'origin', remote)
  else git('remote', 'add', 'origin', remote)
  git('push', '-u', 'origin', 'main')
  // The Host records the branch a Seat opens on. Prepare the publication
  // branch before startup, as a person working on an existing feature branch.
  if (template === 'fix-and-review') git('switch', '-c', TEMPLATE_PUBLISH_BRANCH)

  const stateFile = join(home, 'state.json')
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  saved.workspaces = [{ id: 'ws-storefront', path: repo, name: 'Storefront', lastOpenedAt: Date.now() }]
  writeFileSync(stateFile, `${JSON.stringify(saved)}\n`)
  writeFileSync(join(home, 'seating.json'), JSON.stringify(defaultPreferences ? {} : { implementer: ['codex'], judge: [reviewerId], 'code-reviewer': [reviewerId] }))
  const state = join(home, 'template-passes.json')
  writeFileSync(state, JSON.stringify({ passes: {}, done: [] }))
  const forgeFile = join(home, 'template-forge.json')
  writeFileSync(forgeFile, JSON.stringify({ pr: null }))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const executable = join(bin, 'gh')
  writeFileSync(executable, `#!${process.execPath}\nprocess.env.HD_TEMPLATE_FORGE = ${JSON.stringify(forgeFile)}\nawait import('${new URL('./template-forge.mjs', import.meta.url).href}')\n`)
  chmodSync(executable, 0o755)
  process.env.PATH = `${bin}:${previous.path}`
  const gh = async (args, cwd = repo) => {
    try { return { stdout: execFileSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', exitCode: 0 } }
    catch (error) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), exitCode: typeof error.status === 'number' ? error.status : 1 } }
  }
  const logFile = join(home, 'template-host.ndjson')
  const logger = new Logger('shots-templates', { level: 'warn', console: false, file: logFile })
  const extensions = new ExtensionKernel()
  const host = new Host({ logger, state: new StateStore(stateFile), extensions, catalogRefreshMs: 0, libraryHome: join(home, 'person'), evidence: { gh }, forge: { gh } })
  setTeamEngine(host.teamPlane)
  setForgeEngine(host.forgePlane)
  const steps = {
    attempts: { kind: 'write', title: TEMPLATE_TASK, outcomes: ['committed'], file: 'rig-attempt.txt', contents: 'Attempt {{intent}}: retry transient checkout responses.\n', context: 'The committed retry attempt is ready to check.' },
    judge: { kind: 'review', title: 'Pick the best attempt', outcomes: ['picked'], context: 'Attempt A handles transient checkout responses.' },
    writer: { kind: 'write', title: `${TEMPLATE_TASK} for review`, outcomes: ['committed'], file: 'rig-review.txt', contents: 'Retry transient checkout responses.\n', context: 'The committed retry change is ready on branch rig-write-review-1.' },
    reviewer: { kind: 'review', title: 'Review the committed change', outcomes: ['approve'], context: 'The committed retry change is ready for the person to approve publishing.' },
  }
  const runtimes = [new TemplateRuntime({ id: 'codex', name: 'Scripted writer', codexHome: join(home, 'codex-home'), binaryPath: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'), capabilities: new GatedRegistry(extensions, () => host.ceilingGate),
    env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0', FAKE_CODEX_FLOW: JSON.stringify({ state, gates, steps }) } }, 'scripted-writer'),
  new TemplateRuntime({ id: reviewerId, name: 'Scripted reviewer', codexHome: join(home, 'review-home'), binaryPath: join(root, 'packages/adapter-codex/test/fixtures/fake-codex.mjs'), capabilities: new GatedRegistry(extensions, () => host.ceilingGate),
    env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0', FAKE_CODEX_FLOW: JSON.stringify({ state, gates, steps }) } }, 'scripted-reviewer', readOnlyReviewer)]
  const errors = []
  for (const runtime of runtimes) { host.register(runtime); runtime.subscribe(event => { if (event.type === 'turn/completed' && event.turn?.error) errors.push(event.turn.error) }) }
  const dispose = async () => {
    try {
      await host.dispose()
      await extensions.dispose()
    } finally {
      setTeamEngine(null)
      setForgeEngine(null)
      restoreEnvironment()
    }
  }
  try {
    await extensions.load(teamPlugin)
    await extensions.load(gitPlugin)
    await host.start()
    for (const runtime of runtimes) await runtime.start()
    return { host, logger, logFile, repo, errors, stateFile, git, publish: async () => { git('push', '-u', 'origin', TEMPLATE_PUBLISH_BRANCH); const result = await gh(['pr', 'create', '--title', TEMPLATE_TASK, '--body', 'Reviewed retry change.']); if (result.exitCode !== 0) throw new Error(result.stderr) }, release: name => writeFileSync(join(gates, name), ''), dispose }
  } catch (error) { await dispose(); throw error }
  } catch (error) { restoreEnvironment(); throw error }
}
