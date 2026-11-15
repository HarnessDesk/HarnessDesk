// PRIVATE DRAFT: parent review required. Called only by the guarded hosted controller.
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const FLOW = `version: 2
name: Synthetic person review
roles:
  person: { kind: person, outcomes: [done] }
seed: { role: person, title: Review the synthetic change }
rules: []
`

export async function seedFlow({ source, taskRoot, deskHome, project }) {
  const root = await realpath(taskRoot)
  for (const path of [deskHome, project]) {
    const rel = relative(root, await realpath(path))
    assert.ok(rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'owned path required')
  }
  const server = join(source, 'packages/server/dist/src')
  const { Host, Logger, StateStore } = await import(pathToFileURL(join(server, 'index.js')).href)
  const { executionOf } = await import(pathToFileURL(join(server, 'flow-recovery.js')).href)
  const { ExecutionFiles } = await import(pathToFileURL(join(server, 'flow-execution.js')).href)
  const host = new Host({ logger: new Logger('synthetic-flow', { level: 'error', console: false }),
    state: new StateStore(join(deskHome, 'state.json')), builtinAgents: join(taskRoot, 'empty-builtins'),
    catalogRefreshMs: 0, libraryHome: join(taskRoot, 'empty-library'),
    evidence: { gh: async () => ({ stdout: '', stderr: '', exitCode: 1 }) } })
  let id
  try {
    await host.start()
    await host.call('workspace/open', { path: project })
    const preview = await host.call('authoring/start/preview', { context: { kind: 'project', root: project }, source: FLOW, vars: {} })
    assert.ok(preview.flow.token, 'person-only preview must authorize')
    const run = await host.call('flow/start-goal', { root: project, source: FLOW, token: preview.flow.token, sentence: 'Review the synthetic change' })
    assert.ok(typeof run.id === 'string' && run.id.length > 0)
    id = run.id
  } finally { await host.dispose() }
  // Only the host-created owned record is changed after its host has stopped.
  const files = new ExecutionFiles(join(deskHome, 'flows-v2'))
  const entries = await files.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].error, null)
  const saved = executionOf(entries[0].raw)
  assert.equal(saved.id, id)
  assert.equal(saved.state, 'running')
  assert.ok(saved.rounds.every(round => round.seats.length === 0))
  assert.ok(saved.operations.every(operation => operation.kind === 'round'), 'only person-round operations permitted')
  const now = Date.now()
  const protectedRun = executionOf({ ...saved, version: 3, state: 'stopped', mentionStopOnce: `u-${'1'.repeat(64)}`,
    reason: 'Synthetic stop needs a person to finish.', end: { kind: 'stopped', by: 'desk' },
    updatedAt: now, endedAt: now, currentEndedAt: now,
    rounds: saved.rounds.map(round => round.state === 'closed' ? round : { ...round, state: 'closed' }) })
  await files.save(protectedRun)
  const actual = executionOf(JSON.parse(await readFile(join(deskHome, 'flows-v2', `${encodeURIComponent(id)}.json`), 'utf8')))
  assert.equal(actual.id, id)
  assert.equal(actual.state, 'stopped')
  assert.equal(actual.mentionStopOnce, `u-${'1'.repeat(64)}`)
  return { run: id, goal: actual.goal }
}
