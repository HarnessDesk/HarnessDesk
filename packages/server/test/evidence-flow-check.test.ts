import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { BoardEvidence, FlowRun, GoalView, TeamState, WireNotification } from '@harnessdesk/protocol'

import { assertCheckCleanup } from '../src/evidence/check-processes.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { runCommand } from '../src/evidence/run.js'
import { runCheck } from '../src/flows.js'
import { evidenceDesk, makeRepo, until } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

for (const advisory of [true, false]) {
  test(`a Flow check tells its command whether it is advisory (${advisory})`, async (t) => {
    const repo = await makeRepo()
    const dir = tempDir('hd-flow-advisory-')
    const plane = new EvidencePlane({ dir, seenFile: join(dir, 'seen.json') }, {
      board: () => ({ id: 'goal-1', root: repo.dir, intents: [] } as unknown as TeamState),
      cwdOf: () => null, push: () => {}, log: () => {},
    })
    const inherited = process.env['HARNESSDESK_FLOW_ADVISORY']
    process.env['HARNESSDESK_FLOW_ADVISORY'] = advisory ? '0' : '1'
    t.after(() => {
      if (inherited === undefined) delete process.env['HARNESSDESK_FLOW_ADVISORY']
      else process.env['HARNESSDESK_FLOW_ADVISORY'] = inherited
    })
    const outcome = await plane.runFlowCheck(
      'printf "%s" "$HARNESSDESK_FLOW_ADVISORY"; if [ "$HARNESSDESK_FLOW_ADVISORY" = 1 ]; then exit 7; fi; touch acted',
      { cwd: repo.dir, timeoutSec: 5 },
      { goal: 'goal-1', card: 3, name: 'gate', round: 1, ...(advisory ? { advisory: true as const } : {}) },
    )
    assert.equal(outcome.result.tail, advisory ? '1' : '0', 'the host overrides any inherited flag')
    assert.equal(outcome.result.exit, advisory ? 7 : 0)
    if (advisory) await assert.rejects(readFile(join(repo.dir, 'acted')), { code: 'ENOENT' })
    else assert.equal(await readFile(join(repo.dir, 'acted'), 'utf8'), '')
    assert.equal(outcome.problem, null)
    assert.ok(outcome.evidence)
    const line = (await plane.store.read(await canonical(repo.dir), 'evidence')).lines[0]!
    assert.equal(line.type, 'evidence')
    if (line.type !== 'evidence') return
    const saved = line.record.fact
    assert.equal(saved.kind, 'check')
    if (saved.kind === 'check') {
      assert.equal(saved.advisory, advisory ? true : undefined)
      assert.equal(saved.counted, advisory ? false : undefined)
    }
  })
}

test('a legacy Flow command receives the ordinary check flag', async () => {
  const repo = await makeRepo()
  const dir = tempDir('hd-legacy-flow-advisory-')
  const plane = new EvidencePlane({ dir, seenFile: join(dir, 'seen.json') }, {
    board: () => null, cwdOf: () => null, push: () => {}, log: () => {},
  })
  const result = await plane.flowCheck(
    '[ "$HARNESSDESK_FLOW_ADVISORY" = 0 ]',
    { cwd: repo.dir, timeoutSec: 5 },
    runCheck,
  )
  assert.equal(result.status, 0)
})

for (const producer of ['named', 'legacy Flow'] as const) {
  test(`a running ${producer} check does not block Flow checks on another board`, async () => {
    const repo = await makeRepo()
    await mkdir(join(repo.dir, '.harnessdesk'))
    await writeFile(join(repo.dir, '.harnessdesk', 'checks.yml'), 'hold: { run: sleep 30, timeout: 30 }\n')
    await repo.git('add', '.')
    await repo.git('commit', '-q', '-m', 'declare the holding check')
    const dir = tempDir('hd-check-coexistence-')
    const processDir = join(dir, 'check-processes')
    const plane = new EvidencePlane({ dir, seenFile: join(dir, 'seen.json') }, {
      board: (room) => ['goal-a', 'goal-b'].includes(room)
        ? ({ id: room, root: repo.dir, intents: [{ id: 3, state: 'open' }] } as unknown as TeamState)
        : null,
      cwdOf: () => null, push: () => {}, log: () => {},
    })
    const controller = new AbortController()
    let legacy: Promise<unknown> | undefined
    try {
      if (producer === 'named') {
        await plane.checks.run('goal-a', 3, 'hold', {
          seen: 'sleep 30', digest: await repo.git('rev-parse', 'HEAD:.harnessdesk/checks.yml'),
        })
      } else {
        legacy = plane.flowCheck('sleep 30', {
          cwd: repo.dir, timeoutSec: 30, card: { room: 'goal-a', intent: 3, name: 'hold', round: 1 },
        }, (command, where) => {
          const launch = { ...where, signal: controller.signal }
          return runCheck(command, launch)
        })
      }
      const file = await until(async () => {
        const files = (await readdir(processDir).catch(() => [])).filter((name) => name.endsWith('.json'))
        return files.length === 1 ? files[0]! : null
      }, `the ${producer} check's launch journal`)

      // Same card number, different board: both automatic and subsequent
      // launches on B must finish while A's command is still running.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await plane.runFlowCheck('true', { cwd: repo.dir, timeoutSec: 5 }, {
          goal: 'goal-b', card: 3, name: 'gate', round: 1,
        })
        assert.equal(result.result.exit, 0)
        assert.equal(result.problem, null)
        assert.ok(result.evidence)
      }
      const saved = JSON.parse(await readFile(join(processDir, file), 'utf8')) as { owner?: unknown }
      assert.deepEqual(saved.owner, { board: 'goal-a', card: 3 })
      assert.throws(() => assertCheckCleanup(processDir, { board: 'goal-a', card: 3 }), /cleanup/)
    } finally {
      controller.abort()
      await plane.checks.stop()
      if (legacy) await legacy
    }
    assert.deepEqual(await readdir(processDir), [], 'both commands clean up their own journals')
  })
}

test('a legacy Flow check refuses unresolved cleanup to its caller without an unhandled rejection', async () => {
  const repo = await makeRepo()
  const dir = tempDir('hd-legacy-check-refusal-')
  const plane = new EvidencePlane({ dir, seenFile: join(dir, 'seen.json') }, {
    board: () => ({ id: 'goal-1', root: repo.dir, intents: [] } as unknown as TeamState),
    cwdOf: () => null, push: () => {}, log: () => {},
  })
  const controller = new AbortController()
  let launched!: () => void
  const launch = new Promise<void>((resolve) => { launched = resolve })
  const earlier = runCommand('sleep 30', {
    cwd: repo.dir, timeoutSec: 30, signal: controller.signal,
    processDir: join(dir, 'check-processes'), processOwner: { board: 'goal-1', card: 3 }, onStarted: launched,
  })
  const unhandled: unknown[] = []
  const probe = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', probe)
  try {
    await launch
    await assert.rejects(plane.flowCheck('touch duplicate', {
      cwd: repo.dir, timeoutSec: 5, card: { room: 'goal-1', intent: 3, name: 'gate', round: 1 },
    }, runCheck), /Cleanup of an earlier check could not be confirmed/)
    await assert.rejects(readFile(join(repo.dir, 'duplicate')), { code: 'ENOENT' })
    assert.deepEqual((await plane.store.read(await canonical(repo.dir), 'evidence')).lines, [])
  } finally {
    controller.abort()
    await earlier
    await new Promise<void>((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', probe)
  }
  assert.deepEqual(unhandled, [])
})

test('a Flow check journals its host-owned card identity and stays busy through the Goal evidence barrier', async () => {
  const repo = await makeRepo()
  const dir = tempDir('hd-flow-check-barrier-')
  const plane = new EvidencePlane({ dir, seenFile: join(dir, 'seen.json') }, {
    board: () => ({ id: 'goal-1', root: repo.dir, intents: [] } as unknown as TeamState),
    cwdOf: () => null, push: () => {}, log: () => {},
  })
  const controller = new AbortController()
  let launched!: () => void
  const launch = new Promise<void>((resolve) => { launched = resolve })
  const running = plane.runFlowCheck('sleep 30', { cwd: repo.dir, timeoutSec: 30, signal: controller.signal, onStarted: launched }, { goal: 'goal-1', card: 3, name: 'gate', round: 1 })
  try {
    await launch
    const processDir = join(dir, 'check-processes')
    const [file] = await readdir(processDir)
    const saved = JSON.parse(await readFile(join(processDir, file!), 'utf8')) as { owner?: unknown }
    assert.deepEqual(saved.owner, { board: 'goal-1', card: 3 })
    let drained = false
    const settling = plane.settledFor('goal-1').then(() => { drained = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(drained, false, 'settledFor cannot finish before the command and evidence do')
    assert.equal(plane.running.of('goal-1').length, 1)
    controller.abort()
    await running
    await settling
    assert.equal(plane.running.of('goal-1').length, 0)
  } finally {
    controller.abort()
    await running
  }
})

/*
 * A flow's check step leaves check evidence on its card, as a named check does:
 * every run the desk makes leaves a fact without being asked. The legacy
 * `flowCheck` path (below) stays best-effort, for old phase-4 callers; the v2
 * path (`runFlowCheck`) is the durable gate: a card is never marked done on a
 * fact that did not actually reach disk.
 */

test("a flow's check is recorded on its card, in its round, bound to the commit it started at", async () => {
  const repo = await makeRepo()
  const state = tempDir('hd-flow-check-state-')
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'seen.json'), now: () => 42 },
    {
      board: (room) => (room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  const ran: string[] = []
  const answer = await plane.flowCheck(
    'pnpm test',
    { cwd: repo.dir, timeoutSec: 60, card: { room: 'room-1', intent: 5, name: 'gate', round: 2 } },
    async (command) => {
      ran.push(command)
      return { status: 1 }
    },
  )
  assert.deepEqual(answer, { status: 1 }, 'the flow is answered exactly as its runner answered')
  assert.deepEqual(ran, ['pnpm test'])
  const facts = (await plane.store.read(await canonical(repo.dir), 'evidence')).lines
  assert.equal(facts.length, 1)
  assert.ok(facts[0]?.type === 'evidence')
  const record = facts[0].record
  assert.deepEqual(record.fact, {
    kind: 'check',
    name: 'gate',
    run: 'pnpm test',
    exit: 1,
    timedOut: false,
    at: await repo.git('rev-parse', 'HEAD'),
    dirty: false,
    tail: '',
  })
  assert.deepEqual([record.card, record.round, record.seat, record.observedAt], [{ board: 'room-1', id: 5 }, 2, null, 42])
  await until(() => heard.find((one) => one.method === 'evidence/changed') ?? null, 'the evidence/changed notice')

  // A check step for no card — the flow engine's own runner, asked directly — leaves nothing.
  await plane.flowCheck('pnpm test', { cwd: repo.dir, timeoutSec: 60 }, async () => ({ status: 0 }))
  assert.equal((await plane.store.read(await canonical(repo.dir), 'evidence')).lines.length, 1)
})

test('runFlowCheck (v2): the exact command result is kept whether or not its evidence could be saved, and a storage failure never leaves a silent success', async () => {
  const repo = await makeRepo()
  const state = tempDir('hd-flow-check-v2-state-')
  const heard: WireNotification[] = []
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'seen.json'), now: () => 99 },
    {
      board: (room) => (room === 'goal-1' ? ({ id: 'goal-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: () => null,
      push: (notification) => void heard.push(notification),
      log: () => {},
    },
  )
  const head = await repo.git('rev-parse', 'HEAD')

  // The healthy path: the exact command result, plus a durable fact, before this resolves.
  const ok = await plane.runFlowCheck(
    'true',
    { cwd: repo.dir, timeoutSec: 5 },
    { goal: 'goal-1', card: 5, name: 'gate', round: 2 },
  )
  assert.equal(ok.problem, null)
  assert.ok(ok.evidence, 'a fact id is returned once it is durable')
  assert.equal(ok.result.exit, 0)
  const facts = (await plane.store.read(await canonical(repo.dir), 'evidence')).lines
  assert.equal(facts.length, 1)
  assert.ok(facts[0]?.type === 'evidence' && facts[0].record.fact.kind === 'check' && facts[0].record.fact.at === head)

  // Storage refuses the append (the project's own evidence file is made
  // read-only): the command's own exact result is still reported — never
  // discarded — but `problem` is set and `evidence` is null, so a caller must
  // not mark the card done on this.
  const project = await canonical(repo.dir)
  const factsFile = join(plane.store.folderOf(project), 'evidence.ndjson')
  await chmod(factsFile, 0o400)
  try {
    const failed = await plane.runFlowCheck(
      'true',
      { cwd: repo.dir, timeoutSec: 5 },
      { goal: 'goal-1', card: 5, name: 'gate', round: 2 },
    )
    assert.equal(failed.result.exit, 0, 'the command still ran and its exact result is reported')
    assert.equal(failed.evidence, null, 'no fact id: nothing durable was produced')
    assert.match(failed.problem ?? '', /evidence could not be saved/)
    assert.equal((await plane.store.read(project, 'evidence')).lines.length, 1, 'no half-written or extra line was left behind')
  } finally {
    await chmod(factsFile, 0o600)
  }
})

const GATE = `
name: Gate
roles:
  gate:
    kind: check
    check:
      run: "true"
      exits:
        "0": pass
      otherwise: fail
    outcomes: [pass, fail]
seed:
  role: gate
  title: Run the gate
`

test("through the host: a flow's check step leaves a check fact on its card", async (t) => {
  const { host, repo } = await evidenceDesk(t)
  const room = (await host.call('goal/create', { root: repo.dir, sentence: 'Gate' })) as GoalView
  const run = (await host.call('flow/start', { room: room.goal.id, source: GATE })) as FlowRun
  const board = await until(async () => {
    const read = (await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence
    return read.cards.length > 0 ? read : null
  }, "the gate's check fact")
  const fact = board.cards[0]?.facts[0]?.record
  assert.equal(fact?.fact.kind, 'check')
  assert.equal(fact?.fact.kind === 'check' ? [fact.fact.name, fact.fact.run, fact.fact.exit].join(' ') : '', 'gate true 0')
  assert.equal(fact?.round, 1)
  await host.call('flow/stop', { run: run.id })
})
