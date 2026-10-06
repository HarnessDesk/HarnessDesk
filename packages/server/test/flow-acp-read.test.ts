import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { CeilingLevel } from '@harnessdesk/protocol'
import { chooseSeat } from '../src/agent-seating.js'
import { holdCeiling } from '../src/ceilings/hold.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'

// Exercise the enforcing bridge's actual handshake, with its scripted SDK peer.
// No synthetic capability or runtime-name exception can offer this reader.
const BRIDGE = fileURLToPath(new URL('../../../claude-acp/dist/src/main.js', import.meta.url))
const FAKE = fileURLToPath(new URL('../../../claude-acp/dist/test/fixtures/fake-claude.mjs', import.meta.url))

test('Independent review offers a held ACP reader on another provider after a Codex builder', { timeout: 30_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'flow-acp-read-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const runtime = new AcpRuntime({
    id: 'acp-reader', name: 'ACP Reader', command: process.execPath, args: [BRIDGE],
    resolveProvider: async () => 'vendor-b',
    env: { HOME: cwd, CLAUDE_CODE_EXECUTABLE: FAKE, CLAUDE_CONFIG_DIR: join(cwd, 'config'), CLAUDE_ACP_STATE_DIR: join(cwd, 'state'), CLAUDECODE: '' },
  })
  t.after(() => runtime.dispose())
  await runtime.start()
  const need = { level: 'read' as const, unheld: 'refuse' as const, required: true as const }
  const chosen = chooseSeat([{ runtime: runtime.info.id }], [{
    runtime: runtime.info.id, models: [], efforts: [], signedIn: true, spent: false,
    holds: Object.keys(runtime.info.ceilings ?? {}) as CeilingLevel[],
  }], need)
  assert.equal(chosen.seat?.runtime, runtime.info.id, 'the negotiated ceiling supplies the read-only offer')
  const session = await runtime.createSession({ cwd, requestedCeiling: 'read' })
  assert.equal((await holdCeiling(session, 'read', runtime.info.ceilings?.read)).ceiling.hold, 'held')

  const rig = await goalRig(t)
  rig.providers.set('codex', 'vendor-a').set(runtime.info.id, (await runtime.providerAt(cwd))!)
  const run = await rig.start(`
version: 2
name: Independent review
roles:
  build: { kind: agent, uses: builder, seats: [codex], grant: edit, independentOf: [] }
  review: { kind: agent, uses: reader, seats: [${chosen.seat!.runtime}], grant: read, independentOf: [build] }
seed: { role: build, title: Build it }
rules:
  - { id: review, on: build, when: { every: [done] }, then: { role: review, title: Review it } }
`, [agent('builder', ['done']), agent('reader', ['approve'])])
  await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'running')
  const reader = rig.seats.get('seat-2')!
  assert.equal(reader.seat.runtime, runtime.info.id)
  assert.deepEqual(reader.standing, { kind: 'ceiling', level: 'read' })
  assert.notEqual(rig.providers.get(reader.seat.runtime), rig.providers.get('codex'))
  assert.deepEqual(rig.events.filter(one => one.startsWith('order:')), ['order:seat-1', 'order:seat-2'])
})
