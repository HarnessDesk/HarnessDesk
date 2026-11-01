import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { ExtensionKernel, setForgeEngine } from '@harnessdesk/cordis-host'
import { gitPlugin } from '@harnessdesk/plugins'
import type { FlowExecution, FrontDoorPreview } from '@harnessdesk/protocol'
import { GitGateway } from '../src/git-gateway/index.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { projectOf } from '../src/evidence/revision.js'
import { HoldFake, HOLD_CEILINGS } from './fixtures/hold-runtime.js'
import { answer, board, claimed, desk, E2E, execution, git, scopeOf, whenChanged } from './fixtures/flow-host-evidence.js'

const execute = promisify(execFile)
const source = `version: 2
name: Review and merge the selected PR
roles:
  reviewer: { kind: agent, uses: code-reviewer, grant: read }
  merger: { kind: agent, uses: merger, grant: merge }
seed: { role: reviewer, title: Review the selected pull request }
rules:
  - { id: merge, on: reviewer, when: { evidence: [{ review: approve }] }, then: { role: merger, title: Merge the reviewed pull request } }
layout: { frontDoor: { contexts: [pull-request] } }
`

for (const mode of ['bound', 'unpinned', 'released', 'closed', 'pr-observation', 'base-stale', 'head-stale', 'retarget-stale', 'unreadable-stale', 'person-stale', 'retired-person', 'retired-queue', 'retired-busy-queue', 'retired-internal-queue', 'retired-old-queue', 'retired-allow', 'held-retirement', 'late-manual', 'delayed-person', 'reused-turn'] as const) test(`public Host ${mode === 'reused-turn' ? 'refuses a reused retired Flow turn ID' : mode === 'delayed-person' ? 'recognizes a later person turn whose start event arrives after acceptance' : mode === 'retired-allow' ? 'merges after an explicit later person allows the disclosed question' : mode === 'late-manual' ? 'refuses a late manual answer from a retired person turn' : mode === 'held-retirement' ? 'keeps an old in-flight merge fenced across Seat retirement' : mode === 'retired-internal-queue' ? 'keeps an internal queued request guarded after Seat retirement' : mode === 'retired-busy-queue' ? 'offers a manual decision for a later busy composer queue after Seat retirement' : mode === 'retired-old-queue' ? 'keeps a message queued before Seat retirement guarded' : mode === 'retired-queue' ? 'offers a manual decision for a later idle composer queue after Seat retirement' : mode === 'retired-person' ? 'offers a manual decision for a later person turn after Seat retirement' : mode === 'person-stale' ? 'explains the moved base to the person' : mode.endsWith('-stale') ? `explains ${mode} to the reviewer` : mode === 'bound' ? 'authorizes its exact target' : mode === 'unpinned' ? 'does not promote an unpinned review after pinning' : mode === 'closed' ? 'refuses a PR closed before review' : mode === 'pr-observation' ? 'records the explicit PR observation' : 'does not fall back after release'} through the Git plugin and gateway`, E2E, async t => {
  const pinned = mode !== 'unpinned'
  const temp = await mkdtemp(join(tmpdir(), 'hd-601-host-')), bin = join(temp, 'bin'), state = join(temp, 'forge.json'), trace = join(temp, 'trace.ndjson')
  await mkdir(bin)
  const ghPath = join(bin, 'gh')
  await copyFile(fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url)), ghPath)
  await chmod(ghPath, 0o755)
  const prior = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_TRACE: process.env.FAKE_GH_TRACE }
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_TRACE: trace })
  t.after(async () => {
    setForgeEngine(null)
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(temp, { recursive: true, force: true })
  })
  let unreadable = false, holdRead = false, entered!: () => void, releaseRead!: () => void
  const readEntered = new Promise<void>(resolve => { entered = resolve })
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve })
  t.after(() => releaseRead())
  const fakeGh = async (args: readonly string[], cwd: string) => {
    if (unreadable && args[0] === 'pr' && args[1] === 'view') return { stdout: '', stderr: 'synthetic failure', exitCode: 1 }
    if (holdRead && args[0] === 'pr' && args[1] === 'view') { holdRead = false; entered(); await readHeld }
    try { const result = await execute(process.execPath, [ghPath, ...args], { cwd, env: process.env }); return { ...result, exitCode: 0 } }
    catch (error) { const e = error as { stdout?: string; stderr?: string }; return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: 1 } }
  }
  let gateway!: GitGateway
  const d = await desk(t, undefined, { evidenceGh: fakeGh, gatewayFactory: (stateDir) => gateway = new GitGateway({ directory: join(stateDir, 'gateway'), stateDirectory: stateDir, gh: (cwd, args) => fakeGh(args, cwd) }) })
  await git(d.root, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  const mergeBase = await git(d.root, 'rev-parse', 'HEAD')
  await git(d.root, 'checkout', '-q', 'main')
  await writeFile(join(d.root, 'base-only.txt'), 'Destination-only change.\n')
  await git(d.root, 'add', 'base-only.txt')
  await git(d.root, 'commit', '-q', '-m', 'Advance destination')
  const baseTip = await git(d.root, 'rev-parse', 'HEAD')
  await git(d.root, 'checkout', '-q', 'work')
  await writeFile(join(d.root, 'head-only.txt'), 'Head-only change.\n')
  await git(d.root, 'add', 'head-only.txt')
  await git(d.root, 'commit', '-q', '-m', 'Advance head')
  const head = await git(d.root, 'rev-parse', 'HEAD')
  assert.equal(await git(d.root, 'merge-base', head, baseTip), mergeBase)
  assert.notEqual(baseTip, mergeBase)
  await writeFile(state, JSON.stringify({ repo: 'acme/widgets', publicationHead: head, baseTips: { main: baseTip }, user: { login: 'jane-doe' }, view: { nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } }, protectedBranches: [], pulls: [{ number: 7, branch: 'work', base: 'main', head, state: 'open', checks: [{ name: 'build', id: 1, status: 'completed', conclusion: 'success' }] }], issues: [] }))
  if (pinned) await gateway.pins.pin(d.root, 'acme/widgets', { kind: 'person', id: 'fixture-person' })
  const held = new HoldFake()
  ;(held as { info: typeof held.info }).info = { ...held.info, ceilings: { ...HOLD_CEILINGS, merge: { settings: [{ option: 'sandbox', value: 'full' }], how: 'Full access' } } }
  d.host.register(held)
  for (const [id, body] of [['code-reviewer', 'ceiling: read\nanswers: [approve]\nproduces: [review]'], ['merger', 'ceiling: merge\nanswers: [merged]']] as const) {
    await mkdir(join(d.stateDir, 'agents', id), { recursive: true })
    await writeFile(join(d.stateDir, 'agents', id, 'AGENT.md'), `---\nname: ${id}\n${body}\nprefer: [holdfake]\n---\nDo the task.\n`)
  }
  const runSource = mode === 'pr-observation' ? source.replace('[{ review: approve }]', '[{ review: approve }, { pr: open }]') : mode === 'person-stale' ? source.replace('merger: { kind: agent, uses: merger, grant: merge }', 'merger: { kind: person, review: true, outcomes: [picked] }') : source
  const preview = await d.host.call('authoring/start/preview', { context: { kind: 'pull-request', root: d.root, number: 7 }, source: runSource, vars: {} }) as FrontDoorPreview
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  const run = await d.host.call('flow/start-goal', { root: d.root, source: runSource, token: preview.flow.token!, sentence: preview.sentence, vars: preview.vars }) as FlowExecution
  d.runs.push(run.id)
  const [reviewer] = await claimed(d, run.goal, 'reviewer', 1)
  if (mode === 'closed') {
    const [offered] = await d.host.teamPlane.reviewCandidates(reviewer!.id, scopeOf(reviewer!))
    assert.ok(offered)
    const closed = JSON.parse(await readFile(state, 'utf8'))
    closed.pulls[0].state = 'closed'
    await writeFile(state, JSON.stringify(closed))
    await assert.rejects(d.host.teamPlane.reviewCandidates(reviewer!.id, scopeOf(reviewer!)), /closed|open review candidate/i)
    await assert.rejects(d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: offered.id, verdict: 'approve' }, scopeOf(reviewer!)), /closed|moved on|open review candidate/i)
    return
  }
  const [candidate] = await d.host.teamPlane.reviewCandidates(reviewer!.id, scopeOf(reviewer!))
  assert.equal(candidate?.reviewTarget?.baseTip, pinned ? baseTip : undefined)
  if (['base-stale', 'head-stale', 'retarget-stale', 'unreadable-stale'].includes(mode)) {
    const moved = JSON.parse(await readFile(state, 'utf8'))
    if (mode === 'base-stale') moved.baseTips.main = 'b'.repeat(40)
    if (mode === 'head-stale') moved.pulls[0].head = 'c'.repeat(40)
    if (mode === 'retarget-stale') { moved.pulls[0].base = 'release'; moved.baseTips.release = 'd'.repeat(40) }
    if (mode === 'unreadable-stale') unreadable = true
    await writeFile(state, JSON.stringify(moved))
    await assert.rejects(d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: candidate!.id, verdict: 'approve' }, scopeOf(reviewer!)), (error: Error) => {
      assert.match(error.message, new RegExp(baseTip.slice(0, 12)))
      assert.match(error.message, /main/)
      if (mode === 'base-stale') assert.match(error.message, /bbbbbbbbbbbb/)
      if (mode === 'head-stale') assert.match(error.message, /cccccccccccc/)
      if (mode === 'retarget-stale') assert.match(error.message, /release@dddddddddddd/)
      if (mode === 'unreadable-stale') { assert.match(error.message, /pull request.*unavailable|could not be read/i); assert.doesNotMatch(error.message, /observed/i) }
      return true
    })
    return
  }
  if (mode === 'pr-observation') {
    const journal = await new EvidenceStore(join(d.stateDir, 'evidence')).read(await projectOf(d.root), 'evidence')
    assert.ok(journal.lines.some(line => line.type === 'evidence' && line.record.card?.id === reviewer!.id && line.record.fact.kind === 'pr' && line.record.fact.number === 7 && line.record.fact.state === 'open'))
    await d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: candidate!.id, verdict: 'approve' }, scopeOf(reviewer!))
    await answer(d, reviewer!, 'approve')
    assert.ok((await claimed(d, run.goal, 'merger', 1))[0], 'the real PR-open evidence guard advances')
    return
  }
  if (pinned) {
    const comparison = await d.host.call('git/diffRange', { root: d.root, from: baseTip, to: head })
    assert.match(comparison.diff, /Destination-only change/)
    assert.match(comparison.diff, /Head-only change/)
  }
  await d.host.teamPlane.recordReview({ intent: reviewer!.id, candidate: candidate!.id, verdict: 'approve' }, scopeOf(reviewer!))
  await answer(d, reviewer!, 'approve')
  if (mode === 'person-stale') {
    const card = await whenChanged(d, async () => (await board(d, run.goal)).find(one => one.role === 'merger' && one.state === 'open') ?? null, 'person review')
    const [offered] = await d.host.call('flow/review/candidates', { run: run.id, card: card.id })
    assert.ok(offered)
    const moved = JSON.parse(await readFile(state, 'utf8'))
    moved.baseTips.main = 'b'.repeat(40)
    await writeFile(state, JSON.stringify(moved))
    await assert.rejects(d.host.call('flow/review/decide', { run: run.id, card: card.id, candidate: offered.id, verdict: 'picked' }), (error: Error) => {
      assert.match(error.message, new RegExp(baseTip.slice(0, 12)))
      assert.match(error.message, /bbbbbbbbbbbb/)
      return true
    })
    return
  }
  const [merger] = await claimed(d, run.goal, 'merger', 1)
  if (!pinned) await gateway.pins.pin(d.root, 'acme/widgets', { kind: 'person', id: 'fixture-person' })
  setForgeEngine(d.host.forgePlane)
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(gitPlugin)
  await new Promise(resolve => setTimeout(resolve, 60))
  kernel.setWorkspace({ root: d.root, branch: 'work' })
  const tool = kernel.list('tool').find(one => one.name === 'pr_merge')!
  // `claimed` permits a prepared order while the Seat is still answering its
  // brief. Wait until this particular card order has actually started before
  // completing its turn and retiring the Seat.
  if (['retired-person', 'retired-queue', 'retired-busy-queue', 'retired-internal-queue', 'retired-old-queue', 'retired-allow', 'held-retirement', 'late-manual', 'delayed-person', 'reused-turn'].includes(mode)) {
    const session = held.held.find(one => one.id === merger!.claim!.sessionId)!
    const cardTurn = () => {
      const record = d.host.registry.get(held.info.id, session.id)!
      return record.session.turns.find(turn => record.running.has(turn.id) && turn.items.some(item => item.type === 'notice' && item.text.includes(`Card #${merger!.id} `)))?.id ?? null
    }
    if (!cardTurn()) session.finish()
    await whenChanged(d, cardTurn, 'the merger card order to start')
    await whenChanged(d, async () => (await execution(d, run.id)).operations.some(one => one.kind === 'turn' && one.card === merger!.id && one.state === 'finished') ? true : null, 'the merger card dispatch to finish')
  }
  if (mode === 'retired-old-queue') {
    const session = held.held.find(one => one.id === merger!.claim!.sessionId)!
    const before = await d.host.call('goal/read', { goal: run.goal })
    const seat = before.members.find(one => one.session.runtime === merger!.claim!.runtime && one.session.sessionId === merger!.claim!.sessionId)!
    assert.ok(seat)
    const queued = await d.host.call('turn/queue', { runtime: held.info.id, sessionId: session.id, input: [{ type: 'text', text: 'Earlier queued request.' }] })
    assert.equal(queued.sent, false, 'the message was queued before retirement')
    await d.host.call('flow/execution/stop', { run: run.id, reason: 'Synthetic person stop' })
    assert.ok((await d.host.call('goal/read', { goal: run.goal })).pastMembers?.some(one => one.id === seat.id && one.closed), 'stop durably retires the Seat')
    assert.equal(d.host.registry.get(held.info.id, session.id)!.queue.status, 'paused')
    await d.host.call('turn/queue/flush', { runtime: held.info.id, sessionId: session.id })
    const turnId = await whenChanged(d, () => {
      const record = d.host.registry.get(held.info.id, session.id)!
      return record.queue.messages.length === 0 && record.running.size ? String([...record.running].at(-1)) : null
    }, 'the old queued message to start')
    const answer = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId, signal: new AbortController().signal } as never)
    assert.equal(answer.ok, false)
    assert.match(JSON.stringify(answer), /fresh review/i, 'a pre-retirement queued message is not a later person turn')
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
    session.finish()
    return
  }
  if (mode === 'retired-person' || mode === 'retired-queue' || mode === 'retired-busy-queue' || mode === 'retired-internal-queue' || mode === 'retired-allow' || mode === 'held-retirement' || mode === 'late-manual' || mode === 'delayed-person' || mode === 'reused-turn') {
    const session = held.held.find(one => one.id === merger!.claim!.sessionId)!
    assert.ok(session)
    const oldTurn = [...(d.host.registry.get(held.info.id, session.id)?.running ?? [])].at(-1)
    assert.ok(oldTurn, 'the Flow turn is live before retirement')
    let heldInvocation: ReturnType<typeof kernel.invokeTool> | null = null
    if (mode === 'held-retirement') {
      holdRead = true
      heldInvocation = kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId: oldTurn, signal: new AbortController().signal } as never)
      await readEntered
    }
    const before = await d.host.call('goal/read', { goal: run.goal })
    const seat = before.members.find(one => one.session.runtime === merger!.claim!.runtime && one.session.sessionId === merger!.claim!.sessionId)
    assert.ok(seat)
    await d.host.call('flow/execution/stop', { run: run.id, reason: 'Synthetic person stop' })
    const after = await d.host.call('goal/read', { goal: run.goal })
    assert.ok(after.pastMembers?.some(one => one.id === seat.id && one.closed), 'stop durably retires the Seat before the new turn')
    const beforeNew = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId: oldTurn, signal: new AbortController().signal } as never)
    assert.equal(beforeNew.ok, false)
    assert.match(JSON.stringify(beforeNew), /fresh review/i)
    const syntheticTurn = mode === 'reused-turn' ? oldTurn : 'fixture-delayed-person' as typeof oldTurn
    if (mode === 'reused-turn') d.host.registry.forgetTurns(held.info.id, session.id, 1)
    if (mode === 'reused-turn' || mode === 'delayed-person') session.send = async () => syntheticTurn
    const input = { runtime: held.info.id, sessionId: session.id, input: [{ type: 'text' as const, text: 'Please merge the pull request.' }] }
    const turnId = mode === 'retired-queue'
      ? await (async () => { const queued = await d.host.call('turn/queue', input); assert.equal(queued.sent, true); return String([...d.host.registry.get(held.info.id, session.id)!.running].at(-1)) })()
      : mode === 'retired-busy-queue' || mode === 'retired-internal-queue'
        ? await (async () => {
          const busy = await d.host.call('turn/send', { ...input, input: [{ type: 'text', text: 'Earlier active person request.' }] })
          if (mode === 'retired-internal-queue') {
            d.host.registry.enqueue(d.host.registry.get(held.info.id, session.id)!, 'fixture-internal-queued', input.input)
          } else {
            const queued = await d.host.call('turn/queue', input)
            assert.equal(queued.sent, false)
          }
          session.finish()
          return whenChanged(d, () => {
            const record = d.host.registry.get(held.info.id, session.id)!
            const next = [...record.running].find(id => String(id) !== busy.turnId)
            return record.queue.messages.length === 0 && next ? String(next) : null
          }, 'the later queued person request to start')
        })()
        : (await d.host.call('turn/send', input)).turnId
    if (mode === 'reused-turn' || mode === 'delayed-person') held.emit({ type: 'turn/started', sessionId: session.id, turn: { id: syntheticTurn, items: [], status: 'inProgress' } })
    if (mode === 'reused-turn') {
      assert.equal(turnId, String(oldTurn))
      const reused = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId, signal: new AbortController().signal } as never)
      assert.equal(reused.ok, false)
      assert.match(JSON.stringify(reused), /fresh review/i, 'a recycled turn ID cannot inherit a person marker')
      held.emit({ type: 'turn/completed', sessionId: session.id, turn: { id: syntheticTurn, items: [], status: 'completed' } })
      return
    }
    assert.notEqual(turnId, String(oldTurn))
    if (heldInvocation) {
      releaseRead()
      const old = await heldInvocation
      assert.equal(old.ok, false, 'old invocation remains fenced after the new turn starts')
      const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
    }
    const stale = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId: oldTurn, signal: new AbortController().signal } as never)
    assert.equal(stale.ok, false)
    assert.match(JSON.stringify(stale), /fresh review/i, 'an old Flow invocation cannot borrow the later person turn')
    const unknown = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), signal: new AbortController().signal } as never)
    assert.equal(unknown.ok, false)
    assert.match(JSON.stringify(unknown), /fresh review/i, 'an absent turn cannot be assumed to be the person turn')
    if (mode === 'retired-internal-queue') {
      const result = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId, signal: new AbortController().signal } as never)
      assert.equal(result.ok, false)
      assert.match(JSON.stringify(result), /fresh review/i, 'an internal queued message is not promoted to a person turn')
      const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
      session.finish()
      return
    }
    let question!: (value: { id: string; reason?: string | null }) => void
    const asked = new Promise<{ id: string; reason?: string | null }>(resolve => { question = resolve })
    const off = d.host.addBroadcaster(notification => {
      if (notification.method === 'event' && notification.params.event.type === 'approval/requested') {
        const approval = notification.params.event.approval
        if (approval.type === 'permission' && approval.gateway && approval.sessionId === session.id) question({ id: String(approval.id), reason: approval.reason })
      }
    })
    t.after(off)
    const controller = new AbortController()
    const invoked = kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), turnId, signal: controller.signal } as never)
    const first = await Promise.race([asked.then(value => ({ kind: 'question' as const, value })), invoked.then(value => ({ kind: 'result' as const, value }))])
    assert.equal(first.kind, 'question', JSON.stringify(first))
    if (first.kind !== 'question') return
    assert.match(first.value.reason ?? '', /No fresh review proof/i)
    if (mode === 'retired-allow') {
      await d.host.call('approval/respond', { runtime: held.info.id, sessionId: session.id, approvalId: first.value.id as never, decision: { type: 'option', optionId: 'allow' } })
      assert.equal((await invoked).ok, true, 'only the later person may approve the ordinary merge')
      const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 1)
      session.finish()
      return
    }
    if (mode === 'late-manual') {
      session.finish()
      const next = await d.host.call('turn/send', { runtime: held.info.id, sessionId: session.id, input: [{ type: 'text', text: 'A different later request.' }] })
      assert.notEqual(next.turnId, turnId)
      await d.host.call('approval/respond', { runtime: held.info.id, sessionId: session.id, approvalId: first.value.id as never, decision: { type: 'option', optionId: 'allow' } })
      assert.equal((await invoked).ok, false, 'a late answer cannot authorize a retired turn')
      const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
      session.finish()
      return
    }
    await d.host.call('approval/respond', { runtime: held.info.id, sessionId: session.id, approvalId: first.value.id as never, decision: { type: 'option', optionId: 'refuse' } })
    assert.equal((await invoked).ok, false)
    if (mode === 'delayed-person') held.emit({ type: 'turn/completed', sessionId: session.id, turn: { id: syntheticTurn, items: [], status: 'completed' } })
    else session.finish()
    return
  }
  if (mode === 'released') {
    assert.match(await d.host.teamPlane.release(merger!.id, {}, scopeOf(merger!)), /^Released/)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('unexpected manual approval wait')), 5000)
    const refused = await kernel.invokeTool(tool.id, { number: 7, head }, { ...scopeOf(merger!), signal: controller.signal } as never)
    clearTimeout(timeout)
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused), /fresh review/i)
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
    return
  }
  if (!pinned) {
    const refused = await kernel.invokeTool(tool.id, { number: 7, head }, scopeOf(merger!) as never)
    assert.equal(refused.ok, false)
    assert.match(JSON.stringify(refused), /fresh review/i)
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
    return
  }
  const moved = JSON.parse(await readFile(state, 'utf8'))
  moved.baseTips = { main: 'b'.repeat(40) }
  await writeFile(state, JSON.stringify(moved))
  const stale = await kernel.invokeTool(tool.id, { number: 7, head }, scopeOf(merger!) as never)
  assert.equal(stale.ok, false)
  assert.match(JSON.stringify(stale), /target changed|fresh review/i)
  const before = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(before.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 0)
  moved.baseTips = { main: baseTip }
  await writeFile(state, JSON.stringify(moved))
  const result = await kernel.invokeTool(tool.id, { number: 7, head }, scopeOf(merger!) as never)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(JSON.parse(await readFile(state, 'utf8')).pulls[0].merged, true)
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(call => call.argv[0] === 'pr' && call.argv[1] === 'merge').length, 1)
})
