import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { MentionTriage } from '../src/intake/mentions.js'
import { tempDir } from './scratch.js'

const project = '/synthetic/project', trigger = 'ask', repository = 'demo/project'
const firing = 'a'.repeat(64)
const runTarget = JSON.stringify({ epoch: '00000000-0000-4000-8000-000000000001', version: 0, id: 'run-1', goal: 'goal-1', intake: firing })
const intent = (comment: string, state = 'inFlight') => {
  const key = { project, trigger, repository, comment }
  return { version: 1, id: `u-${createHash('sha256').update(JSON.stringify([project, trigger, repository, comment])).digest('hex')}`,
    key, bodyDigest: 'a'.repeat(64), threadId: 'thread-1', thread: { kind: 'issue', number: 1 }, author: 'preview-user',
    excerpt: '@dex stop', url: `https://example.invalid/issue#issuecomment-${comment}`, createdAt: 10, state, decisionId: null,
    goals: ['goal-1'], firings: [firing], queuedTargets: [], runTargets: [], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null,
    receipts: { queued: [], runs: [], interrupts: [], leadRuns: [], leadPlan: false } }
}
const file = (stopIntents: unknown[]) => ({ version: stopIntents.length ? 2 : 1, decisions: [], threads: [], pendingThreads: [], stopIntents, modes: {}, assessed: { day: '', count: 0 } })
const triage = (home: string, calls: { stops: number }) => new MentionTriage({ home, pendingFirings: () => [],
  stop: async () => { calls.stops++; throw new Error('stop must not be replayed') }, changed() {}, now: () => 20 } as never)

test('concurrent reads recover an interrupted stop once, without repeating effects', async () => {
  const home = tempDir('hd-stop-recovery-'), path = join(home, 'triggers-mentions.json'), calls = { stops: 0 }
  await writeFile(path, JSON.stringify(file([intent('1')])))
  const instance = triage(home, calls)
  const [first, second, phone] = await Promise.all([instance.page(project, trigger, null), instance.page(project, trigger, null), instance.phoneStops(1)])
  assert.equal(first.unconfirmedStops?.[0]?.state, 'unconfirmed')
  assert.deepEqual(second.unconfirmedStops, first.unconfirmedStops)
  assert.equal(phone.unconfirmedStops[0]?.project, 'project')
  assert.equal(calls.stops, 0)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).stopIntents[0].state, 'unconfirmed')
  const reviewed = await instance.reviewStop(project, trigger, first.unconfirmedStops![0]!.id)
  assert.equal(reviewed.state, 'reviewed')
  assert.deepEqual(await instance.reviewStop(project, trigger, reviewed.id), reviewed)
  await assert.rejects(instance.reviewStop('/other/project', trigger, reviewed.id))
  assert.equal(JSON.parse(await readFile(path, 'utf8')).stopIntents.length, 1, 'review retains the consumed identity')
  assert.equal(calls.stops, 0)
})

test('retained stop discovery remains project scoped after restart and review', async () => {
  const home = tempDir('hd-stop-discovery-'), path = join(home, 'triggers-mentions.json'), calls = { stops: 0 }
  await writeFile(path, JSON.stringify(file([intent('1', 'unconfirmed')])))
  const instance = triage(home, calls)
  const discover = instance as unknown as { retainedStops(project: string, current: readonly string[]): Promise<{ retainedStopTriggers: readonly { id: string; unconfirmedStops: readonly { id: string; state: string }[] }[] }> }
  assert.equal((await discover.retainedStops('/other/project', [])).retainedStopTriggers.length, 0)
  assert.equal((await discover.retainedStops(project, [trigger])).retainedStopTriggers.length, 0)
  const retained = (await discover.retainedStops(project, [])).retainedStopTriggers
  assert.equal(retained[0]?.id, trigger)
  assert.equal(retained[0]?.unconfirmedStops[0]?.state, 'unconfirmed')
  await assert.rejects(instance.reviewStop(project, 'other', retained[0]!.unconfirmedStops[0]!.id))
  await instance.reviewStop(project, trigger, retained[0]!.unconfirmedStops[0]!.id)
  const restarted = triage(home, calls) as unknown as typeof discover
  assert.equal((await restarted.retainedStops(project, [])).retainedStopTriggers[0]?.unconfirmedStops[0]?.state, 'reviewed')
  assert.equal(calls.stops, 0)
})

test('malformed or over-cap stop history stays unreadable and is never overwritten', async () => {
  for (const stops of [[{ ...intent('1'), receipts: { queued: ['not-owned'], runs: [], interrupts: [], leadRuns: [], leadPlan: false } }],
    [{ ...intent('1'), runTargets: [JSON.stringify({ ...JSON.parse(runTarget), goal: 'other-goal' })] }],
    Array.from({ length: 501 }, (_, n) => intent(String(n + 1), 'reviewed'))]) {
    const home = tempDir('hd-stop-invalid-'), path = join(home, 'triggers-mentions.json'), bytes = JSON.stringify(file(stops))
    await writeFile(path, bytes)
    await assert.rejects(triage(home, { stops: 0 }).page(project, trigger, null))
    assert.equal(await readFile(path, 'utf8'), bytes)
  }
})

test('failed recovery persistence blocks all reads and retains the original authority', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses directory permissions')
  const home = tempDir('hd-stop-recovery-save-'), path = join(home, 'triggers-mentions.json'), bytes = JSON.stringify(file([intent('1')]))
  await writeFile(path, bytes)
  const calls = { stops: 0 }, instance = triage(home, calls)
  await chmod(home, 0o500)
  try {
    const results = await Promise.allSettled([instance.page(project, trigger, null), instance.phoneStops(1)])
    assert.ok(results.every(result => result.status === 'rejected'))
    assert.equal(await readFile(path, 'utf8'), bytes)
    assert.equal(calls.stops, 0)
  } finally { await chmod(home, 0o700) }
  assert.equal((await instance.page(project, trigger, null)).unconfirmedStops?.[0]?.state, 'unconfirmed')
  assert.equal(calls.stops, 0)
})

test('a full protected history refuses before any stop effect and keeps its attention after restart', async () => {
  const home = tempDir('hd-stop-full-'), path = join(home, 'triggers-mentions.json')
  const full = Array.from({ length: 500 }, (_, n) => intent(String(n + 1), 'reviewed'))
  const thread = { id: 'thread-1', trigger, project, repository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'open', closed: null, resumes: 0, observations: 0,
    openedAt: 0, firings: [firing], seen: [] }
  const disk = { ...file(full), threads: [thread], modes: { [`${project}\u0000${trigger}`]: { mode: 'act', armedAt: 1 } } }
  await writeFile(path, JSON.stringify(disk))
  let effects = 0, released = 0
  const port = { home, pendingFirings: () => [], leadName: () => 'dex', changed() {}, now: () => 20,
    closeThread: async (close: () => Promise<void>) => close(),
    planStop: async () => ({ queuedTargets: [], runTargets: [], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null,
      releaseUncommitted: () => { released++ } }),
    stopOnce: async () => { effects++; return { complete: true } }, signal: new AbortController().signal } as never
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  const fact = { source: 'mention', project, repository, subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/issue#issuecomment-9999', at: 15 } as never
  const instance = new MentionTriage(port)
  await assert.rejects(instance.judge(arm, fact, async () => { throw new Error('must not admit') }), /cannot safely hold/)
  assert.equal(effects, 0)
  assert.equal(released, 1, 'a definite pre-write capacity refusal releases the captured child hold')
  assert.equal((await instance.page(project, trigger, null)).stopHistoryFull, true)
  assert.equal((await triage(home, { stops: 0 }).page(project, trigger, null)).stopHistoryFull, true)
  const recovered = await triage(home, { stops: 0 }).retainedStops(project, [])
  assert.equal(recovered.stopHistoryFull, true)
  assert.equal(recovered.retainedStopTriggers[0]?.stopHistoryFull, true)
  assert.equal(recovered.retainedStopTriggers[0]?.unconfirmedStops.length, 500)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).threads[0].state, 'open', 'no effects or stop fence was committed')
})

test('an unresolved stop retains its thread through ordinary eviction and a distinct retry after restart', async () => {
  const home = tempDir('hd-stop-thread-retention-'), path = join(home, 'triggers-mentions.json')
  const thread = (n: number) => ({ id: `thread-${n}`, project, trigger, repository, origin: { kind: 'issue', number: n },
    links: { issues: [n], pulls: [], goals: [`goal-${n}`] }, state: 'closed', closed: { reason: 'closed', at: 10 }, resumes: 0, observations: 0,
    openedAt: 0, firings: [n === 1 ? firing : createHash('sha256').update(String(n)).digest('hex')], seen: [] })
  await writeFile(path, JSON.stringify({ ...file([intent('1', 'unconfirmed')]), threads: Array.from({ length: 257 }, (_, i) => thread(i + 1)) }))
  let attempts = 0, admitted = 0
  const port = { home, pendingFirings: () => [], leadName: () => 'dex', changed() {}, now: () => 20, signal: new AbortController().signal,
    forge: { thread: async () => ({ labels: [], state: 'open', title: 'Synthetic' }) },
    closeThread: async (close: () => Promise<void>) => close(),
    planStop: async () => { attempts++; return { queuedTargets: [], runTargets: [], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null } },
    stopOnce: async () => ({ complete: false }) } as never
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  const fact = { source: 'mention', project, repository, subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/issue#issuecomment-1', at: 15 }
  const admit = async () => { admitted++; throw new Error('a stop must not admit work') }
  const instance = new MentionTriage(port)
  await instance.setMode(arm, 'act')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.threads.length, 257, '256 ordinary threads plus the protected thread remain')
  assert.ok(saved.threads.some((one: { id: string }) => one.id === 'thread-1'))
  const restarted = new MentionTriage(port)
  await restarted.judge(arm, fact as never, admit)
  assert.equal(attempts, 0, 'the original comment remains deduplicated')
  const otherTrigger = { project, id: 'other', armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  await restarted.judge(otherTrigger, { ...fact, url: 'https://example.invalid/issue#issuecomment-3' } as never, admit)
  const otherProject = '/synthetic/other'
  const otherArm = { project: otherProject, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  await restarted.judge(otherArm, { ...fact, project: otherProject, url: 'https://example.invalid/issue#issuecomment-4' } as never, admit)
  assert.equal(attempts, 0, 'another project or trigger cannot retry the retained scope')
  await restarted.judge(arm, { ...fact, repository: 'DEMO/PROJECT', url: 'https://example.invalid/issue#issuecomment-2' } as never, admit)
  assert.equal(attempts, 1, 'a distinct comment retries the retained scope with case-insensitive repository identity')
  assert.equal(admitted, 0)
  const page = await restarted.page(project, trigger, arm)
  assert.equal(page.unconfirmedStops?.length, 2)
  assert.equal(page.decisions.some(one => one.comment.id === '2'), false)
})

test('protected thread retention remains bounded by 500 identities plus 256 ordinary threads', async () => {
  const home = tempDir('hd-stop-thread-bound-'), path = join(home, 'triggers-mentions.json')
  const firingFor = (n: number) => createHash('sha256').update(String(n)).digest('hex')
  const thread = (n: number) => ({ id: `thread-${n}`, project, trigger, repository, origin: { kind: 'issue', number: n },
    links: { issues: [n], pulls: [], goals: [`goal-${n}`] }, state: 'closed', closed: { reason: 'closed', at: 10 }, resumes: 0, observations: 0,
    openedAt: 0, firings: [firingFor(n)], seen: [] })
  const stops = Array.from({ length: 500 }, (_, i) => ({ ...intent(String(i + 1), 'reviewed'), threadId: `thread-${i + 1}`,
    thread: { kind: 'issue', number: i + 1 }, goals: [`goal-${i + 1}`], firings: [firingFor(i + 1)] }))
  await writeFile(path, JSON.stringify({ ...file(stops), threads: Array.from({ length: 757 }, (_, i) => thread(i + 1)) }))
  const port = { home, pendingFirings: () => [], leadName: () => 'dex', changed() {}, now: () => 20 } as never
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  await new MentionTriage(port).setMode(arm, 'act')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.stopIntents.length, 500)
  assert.equal(saved.threads.length, 756)
  assert.ok(saved.threads.some((one: { id: string }) => one.id === 'thread-1'))
  assert.equal(saved.threads.some((one: { id: string }) => one.id === 'thread-501'), false)
  assert.equal(saved.threads.some((one: { id: string }) => one.id === 'thread-502'), true)
})

test('a stop never borrows a retained thread from a different repository', async () => {
  const home = tempDir('hd-stop-repository-'), path = join(home, 'triggers-mentions.json')
  const thread = { id: 'thread-1', project, trigger, repository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'closed', closed: { reason: 'closed', at: 10 }, resumes: 0, observations: 0,
    openedAt: 0, firings: [firing], seen: [] }
  await writeFile(path, JSON.stringify({ ...file([intent('1', 'unconfirmed')]), threads: [thread], modes: { [`${project}\u0000${trigger}`]: { mode: 'act', armedAt: 1 } } }))
  let attempts = 0, admitted = 0
  const port = { home, pendingFirings: () => [], leadName: () => 'dex', changed() {}, now: () => 20, signal: new AbortController().signal,
    forge: { thread: async () => ({ labels: [], state: 'open', title: 'Synthetic' }) }, closeThread: async (close: () => Promise<void>) => close(),
    planStop: async () => { attempts++; return { queuedTargets: [], runTargets: [], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null } },
    stopOnce: async () => ({ complete: false }) } as never
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository: 'other/project' } } as never
  const fact = { source: 'mention', project, repository: 'other/project', subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/other#issuecomment-2', at: 15 }
  const instance = new MentionTriage(port)
  await instance.judge(arm, fact as never, async () => { admitted++; throw new Error('a stop must not admit work') })
  assert.equal(attempts, 0, 'an old repository is never targeted')
  assert.equal(admitted, 0)
  assert.match((await instance.page(project, trigger, arm)).decisions[0]!.reason, /no work follows this thread/)
})

test('a proven complete stop retains its ordinary decision and deduplicates the comment', async () => {
  const home = tempDir('hd-stop-complete-'), path = join(home, 'triggers-mentions.json')
  const thread = { id: 'thread-1', trigger, project, repository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'open', closed: null, resumes: 0, observations: 0,
    openedAt: 0, firings: [firing], seen: [] }
  await writeFile(path, JSON.stringify({ ...file([]), threads: [thread], modes: { [`${project}\u0000${trigger}`]: { mode: 'act', armedAt: 1 } } }))
  let attempts = 0
  const port = { home, pendingFirings: () => [], leadName: () => 'dex', changed() {}, now: () => 20,
    closeThread: async (close: () => Promise<void>) => close(),
    planStop: async () => ({ queuedTargets: [], runTargets: [runTarget], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null }),
    stopOnce: async (_work: unknown, _reason: string, _plan: unknown, receipt: (effect: unknown) => Promise<void>) => {
      attempts++; await receipt({ kind: 'run', target: runTarget }); return { complete: true }
    }, signal: new AbortController().signal } as never
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  const request = { source: 'mention', project, repository, subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/issue#issuecomment-9999', at: 15 } as never
  const instance = new MentionTriage(port)
  await instance.judge(arm, request, async () => { throw new Error('must not admit') })
  const page = await instance.page(project, trigger, null)
  assert.equal(page.unconfirmedStops?.length ?? 0, 0)
  assert.deepEqual(page.decisions.map(one => [one.decision, one.by, one.acted]), [['stop', 'rules', true]])
  assert.match(page.decisions[0]!.reason, /1 run of its work was stopped/)
  assert.equal(page.threads[0]?.closed?.reason, 'stopped')
  await instance.judge(arm, request, async () => { throw new Error('must not admit') })
  assert.equal(attempts, 1)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.stopIntents[0].state, 'consumed')
  assert.equal(saved.stopIntents[0].decisionId, page.decisions[0]!.id)
})

test('a partial stop persists its exact receipt, stays separate, and never repeats that comment', async () => {
  const home = tempDir('hd-stop-once-'), path = join(home, 'triggers-mentions.json')
  const thread = { id: 'thread-1', trigger, project, repository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'open', closed: null, resumes: 0, observations: 0,
    openedAt: 0, firings: [firing], seen: [] }
  await writeFile(path, JSON.stringify({ ...file([]), threads: [thread], modes: { [`${project}\u0000${trigger}`]: { mode: 'act', armedAt: 1 } } }))
  let attempts = 0, rereads = 0
  const port = { home, pendingFirings: () => [], leadName: () => 'dex', changed() {}, now: () => 20,
    closeThread: async (close: () => Promise<void>) => close(),
    forge: { comment: async () => { rereads++; throw new Error('must not read a consumed comment') } },
    planStop: async () => ({ queuedTargets: [], runTargets: [runTarget], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null }),
    stopOnce: async (_work: unknown, _reason: string, _plan: unknown, receipt: (effect: unknown) => Promise<void>) => {
      attempts++
      await receipt({ kind: 'run', target: runTarget })
      throw new Error('synthetic later failure')
    }, signal: new AbortController().signal } as never
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  const request = { source: 'mention', project, repository, subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/issue#issuecomment-9999', at: 15 }
  const instance = new MentionTriage(port)
  await instance.judge(arm, request as never, async () => { throw new Error('must not admit') })
  const page = await instance.page(project, trigger, null)
  assert.equal(page.decisions.length, 0)
  assert.equal(page.unconfirmedStops?.[0]?.state, 'unconfirmed')
  assert.equal(page.unconfirmedStops?.[0]?.progress.runsMarkedStopped, 1)
  assert.equal('acted' in page.unconfirmedStops![0]!, false)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.version, 2, 'older hosts must refuse protected stop history')
  assert.deepEqual(saved.stopIntents[0].receipts.runs, [runTarget])
  await instance.judge(arm, { ...request, body: '@dex stop again, edited' } as never, async () => { throw new Error('must not admit') })
  const priorDecision = `d-${createHash('sha256').update(JSON.stringify([project, trigger, '9999'])).digest('hex').slice(0, 20)}`
  await assert.rejects(instance.reevaluate(arm, priorDecision, async () => { throw new Error('must not admit') }), /cannot be evaluated again/)
  assert.equal(rereads, 0)
  assert.equal(attempts, 1)
  await instance.judge(arm, { ...request, url: 'https://example.invalid/issue#issuecomment-10000' } as never, async () => { throw new Error('must not admit') })
  assert.equal(attempts, 2, 'a distinct authorized comment may ask again')
})

test('a failed receipt recovery notifies only after uncertainty is durable and starts no next effect', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses directory permissions')
  const home = tempDir('hd-stop-receipt-failure-'), path = join(home, 'triggers-mentions.json')
  const thread = { id: 'thread-1', trigger, project, repository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'open', closed: null, resumes: 0, observations: 0,
    openedAt: 0, firings: [firing], seen: [] }
  await writeFile(path, JSON.stringify({ ...file([]), threads: [thread], modes: { [`${project}\u0000${trigger}`]: { mode: 'act', armedAt: 1 } } }))
  const seen: string[] = []
  let nextEffects = 0
  const instance = new MentionTriage({ home, pendingFirings: () => [], leadName: () => 'dex', now: () => 20,
    changed() { seen.push(JSON.parse(readFileSync(path, 'utf8')).stopIntents[0]?.state) },
    closeThread: async (close: () => Promise<void>) => close(),
    planStop: async () => ({ queuedTargets: [], runTargets: [runTarget], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null }),
    stopOnce: async (_work: unknown, _why: string, _plan: unknown, receipt: (effect: unknown) => Promise<void>) => {
      await chmod(home, 0o500)
      try { await receipt({ kind: 'run', target: runTarget }) } finally { await chmod(home, 0o700) }
      nextEffects++
      return { complete: false }
    }, signal: new AbortController().signal } as never)
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  const fact = { source: 'mention', project, repository, subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/issue#issuecomment-9999', at: 15 } as never
  await assert.rejects(instance.judge(arm, fact, async () => { throw new Error('must not admit') }), /no longer current/)
  assert.equal(nextEffects, 0)
  assert.deepEqual(seen, ['inFlight', 'unconfirmed'], 'the recovery notification observes the saved uncertainty')
  assert.equal((await instance.page(project, trigger, null)).unconfirmedStops?.[0]?.progress.runsMarkedStopped, 0)
})

test('an uncertain intent write never releases its captured child as ordinary', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses directory permissions')
  const home = tempDir('hd-stop-intent-failure-'), path = join(home, 'triggers-mentions.json')
  const thread = { id: 'thread-1', trigger, project, repository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'open', closed: null, resumes: 0, observations: 0,
    openedAt: 0, firings: [firing], seen: [] }
  await writeFile(path, JSON.stringify({ ...file([]), threads: [thread], modes: { [`${project}\u0000${trigger}`]: { mode: 'act', armedAt: 1 } } }))
  let released = 0, effects = 0
  const instance = new MentionTriage({ home, pendingFirings: () => [], leadName: () => 'dex', now: () => 20, changed() {},
    closeThread: async (close: () => Promise<void>) => close(),
    planStop: async () => { await chmod(home, 0o500); return { queuedTargets: [], runTargets: [], interruptTargets: [], leadRunTargets: [], leadPlanTarget: null,
      releaseUncommitted: () => { released++ } } },
    stopOnce: async () => { effects++; return { complete: false } }, signal: new AbortController().signal } as never)
  const arm = { project, id: trigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository } } as never
  const fact = { source: 'mention', project, repository, subject: '1', thread: 'issue', author: '7', login: 'preview-user',
    body: '@dex stop', url: 'https://example.invalid/issue#issuecomment-9999', at: 15 } as never
  try { await assert.rejects(instance.judge(arm, fact, async () => { throw new Error('must not admit') })) }
  finally { await chmod(home, 0o700) }
  assert.equal(released, 0)
  assert.equal(effects, 0)
})
