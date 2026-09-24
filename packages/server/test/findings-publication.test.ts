import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, FindingView } from '@harnessdesk/protocol'

import { isFindingPublication, Publications, type PublicationEntry } from '../src/findings/publication.js'
import { FakeFindingForge, type SendOutcome } from './fixtures/fake-finding-forge.js'
import { findingsRig, SHA1, SHA2, type FindingsRig } from './fixtures/findings-rig.js'

/*
 * A closed round is released as one durable batch, and each of its comments
 * is posted once: never before the round closed, never a second time to find
 * out whether the first landed, and never "posted" without the forge's own
 * copy read back. A failure is left where the person sees it.
 */

const raise = (intent: number, candidate: string, title: string, over: Record<string, unknown> = {}) => ({
  intent, candidate, request: `raise-${title}`, title, body: `What ${title} is.`, category: 'ordinary' as const, blocking: true, ...over,
})

interface Rig {
  readonly f: FindingsRig
  readonly forge: FakeFindingForge
  readonly goal: { open: boolean; preference: boolean | undefined }
  pub: Publications
  /** The review round's number. */
  readonly round: number
  entries(): PublicationEntry[]
  posts(): EvidenceRecord[]
  bindPullRequest(head?: string): void
  restart(): Promise<void>
}

const publicationRig = async (t: { after(fn: () => Promise<void>): void }, options: { bind?: boolean } = {}): Promise<Rig> => {
  const f = await findingsRig(t)
  const forge = new FakeFindingForge(SHA1)
  const goal = { open: true, preference: undefined as boolean | undefined }
  const make = (): Publications => new Publications({
    journal: (run, step) => f.rig.flows.withPublicationJournal(run, step),
    runs: () => f.rig.flows.publicationRuns(),
    run: (run) => {
      const snapshot = f.rig.flows.findingRun(run)
      return snapshot ? { goal: snapshot.goal, rounds: snapshot.rounds, pendingFindings: snapshot.pendingFindings } : null
    },
    entry: (key) => f.rig.flows.publicationEntry(key),
    snapshot: (run) => f.rig.flows.publicationOf(run),
    roundClosed: (run, round) => f.rig.flows.roundClosed(run, round),
    goal: () => ({ open: goal.open, preference: goal.preference }),
    projectOf: async () => '/repo',
    facts: (id) => f.port.flows.facts!(id),
    ledger: (project) => f.plane.ledgerOf(project),
    seat: (id) => f.rig.seats.get(id) ?? null,
    template: () => '**Review by {seat} · via HarnessDesk**',
    appendPost: (input) => f.plane.appendPost(input),
    forge,
    now: () => 1_000,
    log: () => {},
  })
  const out = { f, forge, goal, pub: make(), round: 2 } as Rig
  // The host's wiring: every plane hears the publisher, and a person's Stop skips what was not sent.
  const attach = (): void => {
    f.plane.attachPublisher(out.pub)
    f.rig.flows.onRunStopped((run) => out.pub.cancel(run, 'The run was stopped before this was posted, so it stays on the desk.'))
  }
  attach()
  f.onPlane = () => {
    out.pub = make()
    attach()
  }
  let prs = 0
  out.bindPullRequest = (head = SHA1) => {
    prs += 1
    f.rig.facts.set(f.goal, [...(f.rig.facts.get(f.goal) ?? []), {
      id: `pr-${prs}`, fact: { kind: 'pr', number: 7, head, state: 'open', url: 'https://github.com/acme/widgets/pull/7' },
      card: { board: f.goal, id: 1 }, checkout: { cwd: '/repo', branch: 'fix' }, seat: null, round: null, observedAt: prs, posted: null,
    }])
  }
  if (options.bind !== false) out.bindPullRequest()
  out.entries = () => Object.values(f.rig.executions.stored(f.run)?.publication?.ops ?? {})
  out.posts = () => [] as EvidenceRecord[]
  out.restart = async () => {
    await out.pub.idle()
    await f.restart()
    await out.pub.recover()
    await out.pub.idle()
  }
  return out
}

const postsOf = async (f: FindingsRig): Promise<EvidenceRecord[]> =>
  (await f.records()).filter((record) => record.finding?.event.kind === 'post')

/** Both reviewers raise one finding each, the first of them anchored; the second only when asked. */
const review = async (r: Rig, options: { second?: boolean } = {}): Promise<{ first: FindingView; second: FindingView | null }> => {
  const { f } = r
  await f.finishFixer()
  const [one, two] = f.cards('reviewer')
  const c1 = await f.candidate(one!.id, 'seat-2')
  const first = await f.plane.raise(raise(one!.id, c1.id, 'Unbounded read', { anchor: { path: 'src/read.ts', line: 3, side: 'RIGHT' } }), f.scope('seat-2'))
  await f.rig.review.record({ intent: one!.id, candidate: c1.id, verdict: 'request-changes' }, f.scope('seat-2'))
  await f.rig.team.complete(one!.id, { outcome: 'request-changes' }, f.scope('seat-2'))
  await f.rig.flows.flush()
  let second: FindingView | null = null
  if (options.second !== false) {
    const c2 = await f.candidate(two!.id, 'seat-3')
    second = await f.plane.raise(raise(two!.id, c2.id, 'Missing check'), f.scope('seat-3'))
  }
  return { first, second }
}

test('first finisher publishes nothing', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r, { second: false })
  // One reviewer is done, the other still reviewing: asked to release the round now, the desk decides nothing.
  assert.equal(f.rig.flows.roundClosed(f.run, r.round), false)
  assert.equal(await r.pub.prepare(f.run, r.round), null)
  await r.pub.close(f.run, r.round)
  await r.pub.idle()
  assert.deepEqual(forge.calls, [], 'nothing reached the forge')
  assert.deepEqual(r.entries(), [], 'nothing was even staged')
  // The last reviewer finishes: the round closes, and every key is on disk before the first send.
  let staged: readonly PublicationEntry[] | null = null
  forge.onSend = () => {
    staged ??= r.entries()
    return 'ok'
  }
  await f.finishReviews('request-changes')
  await r.pub.idle()
  assert.equal(staged!.length, 3, 'one finding and both reviews were keyed before anything was sent')
  assert.ok(staged!.every((entry) => entry.state === 'prepared' || entry.state === 'started'))
  assert.deepEqual(r.entries().map((entry) => entry.state), ['posted', 'posted', 'posted'])
  assert.equal(forge.sends.length, 3)
  assert.deepEqual(forge.sends.map((one) => one.placement), ['inline', 'general', 'general'], 'the anchored finding is inline, both reviews are conversation comments')
  const reviews = forge.sends.filter((one) => one.body.includes('**Review**'))
  assert.ok(reviews.some((one) => /raised no findings/.test(one.body)), 'a review with no findings is posted too')
})

test('closed batch releases once', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const first = r.entries()
  const decided = f.rig.executions.stored(f.run)?.publication?.rounds[String(r.round)]
  assert.equal(first.length, 4)
  // The close heard again, a reconcile, and a restart: no second batch, no second post.
  await r.pub.close(f.run, r.round)
  await r.pub.close(f.run, r.round)
  await r.pub.reconcile(f.run, r.round)
  await f.plane.roundClosed(f.run, r.round)
  await r.restart()
  assert.deepEqual(r.f.rig.executions.stored(f.run)?.publication?.rounds[String(r.round)], decided, 'the decision is the one first journaled')
  assert.equal(forge.sends.length, 4, 'each operation was sent once')
  assert.equal(new Set(forge.sends.map((one) => one.key)).size, 4)
  const posts = await postsOf(f)
  assert.equal(posts.length, 2, 'one post event per finding')
  // The exact remote location survives the restart.
  const inline = first.find((one) => isFindingPublication(one) && one.placement === 'inline')
  assert.ok(inline && isFindingPublication(inline))
  const view = await f.view(inline.finding)
  assert.equal(view.posted.length, 1)
  assert.equal(view.posted[0]!.kind, 'review-comment')
  assert.match(view.posted[0]!.url, /^https:\/\/github\.com\/acme\/widgets\/pull\/7#discussion_r\d+$/)
})

test('append failure cannot release a round', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r, { second: false })
  const [, two] = f.cards('reviewer')
  // The second reviewer's finding is being written: its append is held, then refused.
  let release!: (error: Error) => void
  const held = new Promise<void>((_resolve, reject) => { release = reject })
  held.catch(() => {})
  let entered!: () => void
  const writing = new Promise<void>((resolve) => { entered = resolve })
  f.appendHook = async (record) => {
    if (record.finding?.event.kind === 'raise' && record.seat === 'seat-3') {
      entered()
      await held
    }
  }
  const c2 = await f.candidate(two!.id, 'seat-3')
  const raising = f.plane.raise(raise(two!.id, c2.id, 'Held'), f.scope('seat-3'))
  await writing
  // Its reviewer finishes while the write is in flight: the round cannot close under it.
  const recorded = f.rig.review.record({ intent: two!.id, candidate: c2.id, verdict: 'request-changes' }, f.scope('seat-3'))
    .then(() => f.rig.team.complete(two!.id, { outcome: 'request-changes' }, f.scope('seat-3')))
  assert.equal(f.rig.flows.roundClosed(f.run, r.round), false)
  const session = f.scope('seat-3')
  assert.match(f.plane.embargoOf(session.runtime, session.sessionId) ?? '', /blind round/, 'the round is still blind to its sibling')
  assert.deepEqual(forge.calls, [])
  release(new Error('ENOSPC: no space left on device'))
  await assert.rejects(raising, /ENOSPC/)
  f.appendHook = null
  await recorded
  await f.rig.flows.flush()
  await r.pub.idle()
  // Only what was durably recorded is released: the refused finding never reaches the forge.
  assert.equal(f.rig.flows.roundClosed(f.run, r.round), true)
  assert.equal(forge.sends.some((one) => one.body.includes('Held')), false)
  assert.equal(forge.sends.filter((one) => one.body.includes('Unbounded read')).length, 1)
})

test('a round whose close cannot be written releases nothing', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r, { second: false })
  f.rig.files.failOnce = (run) => run.rounds.some((round) => round.n === r.round && round.state === 'closed')
  const [, two] = f.cards('reviewer')
  const c2 = await f.candidate(two!.id, 'seat-3')
  await f.rig.review.record({ intent: two!.id, candidate: c2.id, verdict: 'approve' }, f.scope('seat-3'))
  await f.rig.team.complete(two!.id, { outcome: 'approve' }, f.scope('seat-3')).catch(() => {})
  await f.rig.flows.flush().catch(() => {})
  await r.pub.idle()
  assert.equal(f.rig.flows.roundClosed(f.run, r.round), false, 'the close never reached the disk')
  assert.deepEqual(forge.calls, [], 'so nothing was posted')
  assert.equal(r.entries().length, 0)
})

test('lost remote response reconciles', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  // The first send lands and its answer is lost.
  let first = true
  forge.onSend = () => {
    if (!first) return 'ok'
    first = false
    return 'lose'
  }
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const lost = r.entries().find((entry) => entry.key === forge.sends[0]!.key)!
  assert.equal(lost.state, 'uncertain', 'an answer that never came is not a success')
  assert.match(lost.reason ?? '', /may or may not have reached/)
  assert.equal((await postsOf(f)).some((one) => one.finding?.operation === lost.key), false, 'no location is claimed without read-back')
  // Reconciled: the one exact copy is found, recorded once, and nothing is sent again.
  await r.pub.reconcile(f.run, r.round)
  const after = r.entries().find((entry) => entry.key === lost.key)!
  assert.equal(after.state, 'posted')
  assert.equal(forge.sends.filter((one) => one.key === lost.key).length, 1, 'never sent twice')
  assert.equal(forge.comments.filter((one) => one.body.startsWith(lost.marker)).length, 1)
  assert.equal(after.location?.comment, forge.comments.find((one) => one.body.startsWith(lost.marker))!.id)
})

test('zero and duplicate marker matches remain uncertain', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  const outcomes = ['fail', 'duplicate'] as const
  let n = 0
  forge.onSend = () => outcomes[n++] ?? 'ok'
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const [zero, twice] = forge.sends.slice(0, 2).map((one) => one.key)
  await r.pub.reconcile(f.run, r.round)
  await r.pub.reconcile(f.run, r.round)
  const read = (key: string | undefined) => r.entries().find((entry) => entry.key === key)!
  assert.equal(read(zero).state, 'uncertain')
  assert.match(read(zero).reason ?? '', /shows no copy of it\. Look at the pull request before posting it again/)
  assert.equal(read(twice).state, 'uncertain')
  assert.match(read(twice).reason ?? '', /shows 2 copies/)
  assert.equal(forge.sends.filter((one) => one.key === zero).length, 1, 'no copy found is not a reason to send again')
  assert.equal(forge.sends.filter((one) => one.key === twice).length, 1)
  const posted = await postsOf(f)
  assert.equal(posted.some((one) => one.finding?.operation === zero || one.finding?.operation === twice), false)
  // Wrap sees both as gaps a person has to record.
  const gaps = await r.pub.gaps(f.goal)
  assert.equal(gaps.length, 2)
  assert.ok(gaps.every((gap) => /is uncertain/.test(gap)))
})

test('disk failure after remote success is recoverable', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  // The comment lands, and recording where fails: first the ledger's post event, then (next time) the journal.
  let failPost = true
  f.appendHook = async (record) => {
    if (record.finding?.event.kind === 'post' && failPost) {
      failPost = false
      throw new Error('EIO: the ledger write failed')
    }
  }
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const stuck = r.entries().filter((entry) => entry.state === 'started')
  assert.equal(stuck.length, 1, 'the one whose record failed is still started, not posted')
  assert.equal((await r.pub.status(f.run)).publication, 'pending')
  assert.match((await r.pub.status(f.run)).reason ?? '', /could not be recorded yet/)
  f.rig.files.failOnce = (run) => Object.values(run.publication?.ops ?? {}).some((entry) => entry.key === stuck[0]!.key && entry.state === 'posted')
  await r.pub.reconcile(f.run, r.round)
  assert.equal(r.entries().find((entry) => entry.key === stuck[0]!.key)!.state, 'started', 'the journal write failed this time')
  await r.restart()
  const recovered = r.entries().find((entry) => entry.key === stuck[0]!.key)!
  assert.equal(recovered.state, 'posted')
  assert.equal(forge.sends.filter((one) => one.key === stuck[0]!.key).length, 1, 'recovered from what the forge holds, never re-sent')
  const posts = (await postsOf(f)).filter((one) => one.finding?.operation === stuck[0]!.key)
  assert.equal(posts.length, 1, 'one location, one event')
  assert.deepEqual(posts[0]!.finding?.event, { kind: 'post', location: recovered.location })
})

test('no PR and preference off are local', async (t) => {
  const r = await publicationRig(t, { bind: false })
  const { f, forge } = r
  await review(r)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const decision = f.rig.executions.stored(f.run)?.publication?.rounds[String(r.round)]
  assert.equal(decision?.mode, 'local')
  assert.match(decision?.reason ?? '', /No open pull request is bound/)
  assert.deepEqual(forge.calls, [], 'no network at all')
  // A pull request appears later, with posting on: the closed round is not backfilled on its own.
  r.bindPullRequest()
  r.goal.preference = true
  await r.pub.close(f.run, r.round)
  await r.pub.reconcile(f.run, r.round)
  await r.restart()
  assert.deepEqual(forge.calls, [], 'history stays on the desk until a person previews it')
  // Posting off, with a pull request bound: the next round stays local too.
  r.goal.preference = false
  await r.f.finishFixer()
  await r.f.finishReviews('approve')
  await r.pub.idle()
  const later = Object.values(r.f.rig.executions.stored(f.run)?.publication?.rounds ?? {}).filter((one) => one.round > r.round)
  assert.ok(later.length > 0 && later.every((one) => one.mode === 'local' && /Posting is off/.test(one.reason ?? '')))
  assert.deepEqual(forge.calls, [])
})

test('stop during batch retains honest partial result', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  // The first posts; the second is held in flight; the third has not started.
  let proceed!: () => void
  const held = new Promise<void>((resolve) => { proceed = resolve })
  let inFlight!: () => void
  const sending = new Promise<void>((resolve) => { inFlight = resolve })
  let n = 0
  forge.onSend = async (): Promise<SendOutcome> => {
    n += 1
    if (n === 2) {
      inFlight()
      await held
    }
    return 'ok'
  }
  await f.finishReviews('request-changes')
  await sending
  const before = r.entries().map((entry) => entry.state)
  assert.deepEqual(before.filter((state) => state === 'posted').length, 1)
  assert.deepEqual(before.filter((state) => state === 'started').length, 1)
  await f.rig.flows.stopRun(f.run)
  proceed()
  await r.pub.idle()
  const states = r.entries().map((entry) => entry.state)
  assert.equal(states.filter((state) => state === 'posted').length, 2, 'the one in flight was not rolled back: it landed and was recorded')
  assert.equal(states.filter((state) => state === 'skipped').length, 2, 'only what was never sent is skipped')
  assert.ok(r.entries().filter((entry) => entry.state === 'skipped').every((entry) => /stopped before this was posted/.test(entry.reason ?? '')))
  assert.equal(forge.sends.length, 2)
})

test('a repair reaches its finding’s own thread, and a moved head waits for a person', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  forge.anchorOk = false
  const { first, second } = await review(r)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const root = (await f.view(first.id)).posted[0]!
  assert.equal(root.kind, 'issue-comment', 'an anchor the change does not touch is a conversation comment, said before posting')
  const threads = forge.comments.length
  // The fixer claims both repaired at a new head the pull request has.
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  forge.head = SHA2
  r.bindPullRequest(SHA2)
  const [, fixCard] = f.cards('fixer')
  const now = await f.view(first.id)
  await f.plane.repair({ intent: fixCard!.id, finding: first.id, request: 'fix-1', expected: now.sequence, note: 'Bounded it.' }, f.scope('seat-4'))
  const other = await f.view(second!.id)
  await f.plane.repair({ intent: fixCard!.id, finding: second!.id, request: 'fix-2', expected: other.sequence, note: 'Checked.' }, f.scope('seat-4'))
  await f.finishFixer()
  await r.pub.idle()
  const comment = forge.comments.find((one) => one.id === root.comment)!
  assert.match(comment.body, /Repair claimed/, 'the repair was appended to the finding’s own comment')
  assert.equal(forge.comments.length, threads, 'no second thread was started for either repair')
  const repaired = await f.view(first.id)
  assert.equal(repaired.posted.length, 2)
  assert.equal(repaired.posted[1]!.comment, root.comment)
  // The pull request moves before the next round's comments go out: nothing is relabelled at the new head.
  forge.head = '4'.repeat(40)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const paused = r.entries().filter((entry) => entry.round > 3)
  assert.ok(paused.length > 0 && paused.every((entry) => entry.state === 'prepared' && /moved from/.test(entry.reason ?? '')))
})

test('a person’s edit to a finding’s comment is left alone', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  forge.anchorOk = false
  const { first } = await review(r, { second: false })
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const root = (await f.view(first.id)).posted[0]!
  const comment = forge.comments.find((one) => one.id === root.comment)!
  comment.body = `${comment.body}\n\nEdited by a person.`
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  forge.head = SHA2
  r.bindPullRequest(SHA2)
  const [, fixCard] = f.cards('fixer')
  await f.plane.repair({ intent: fixCard!.id, finding: first.id, request: 'fix-1', expected: (await f.view(first.id)).sequence, note: 'Bounded it.' }, f.scope('seat-4'))
  await f.finishFixer()
  await r.pub.idle()
  assert.match(comment.body, /Edited by a person\.$/, 'the person’s words are exactly as they left them')
  const append = r.entries().find((entry) => entry.placement === 'append' || (entry.round === 3 && 'finding' in entry))!
  assert.equal(append.state, 'prepared')
  assert.match(append.reason ?? '', /Someone changed this finding’s comment/)
})

test('every reviewer of an open blind round is held back from the forge, the first finisher too, until it closes', async (t) => {
  const r = await publicationRig(t)
  const { f } = r
  await review(r, { second: false })
  const held = (seat: string): string | null => {
    const session = f.scope(seat)
    return f.plane.embargoOf(session.runtime, session.sessionId)
  }
  assert.match(held('seat-2') ?? '', /blind round that has not closed/, 'the first finisher, its card done')
  assert.match(held('seat-3') ?? '', /blind round that has not closed/)
  assert.equal(held('seat-1'), null, 'a writer outside the round is not held back')
  await f.finishReviews('request-changes')
  await r.pub.idle()
  assert.equal(held('seat-2'), null)
  assert.equal(held('seat-3'), null)
})

test('a wrap settles posting first: a lost answer is read back, a paused posting is left as a gap', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  let n = 0
  forge.onSend = () => (++n === 1 ? 'lose' : 'ok')
  // The pull request moves between the first send and the rest: those wait for a person.
  const moveAfterFirst = forge.onSend
  forge.onSend = (operation, body) => {
    const outcome = moveAfterFirst(operation, body)
    forge.head = '5'.repeat(40)
    return outcome
  }
  await f.finishReviews('request-changes')
  await r.pub.idle()
  assert.deepEqual(r.entries().map((entry) => entry.state).sort(), ['prepared', 'prepared', 'prepared', 'uncertain'])
  await r.pub.settleForWrap(f.goal)
  const states = r.entries().map((entry) => entry.state).sort()
  assert.deepEqual(states, ['posted', 'prepared', 'prepared', 'prepared'], 'the lost answer was read back; nothing paused was sent')
  assert.equal(forge.sends.length, 1)
  const gaps = await r.pub.gaps(f.goal)
  assert.equal(gaps.length, 3)
  assert.ok(gaps.every((gap) => /is not posted: Pull request #7 moved from/.test(gap)))
})

/*
 * The lock order (host.ts, "Lock order"): a run seating a card holds its run
 * queue and then asks for the Goal queue; a wrap preview holds the Goal queue
 * and reads what posting left unsettled. That read must take no queue at all,
 * or each waits on the other forever.
 */
test('a wrap preview holding the Goal queue never waits on a run that is seating a card', async (t) => {
  const r = await publicationRig(t)
  const { f } = r
  await review(r)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  assert.ok(f.rig.flows.publicationRuns().some((one) => one.run === f.run), 'the run has a journaled publication to read')
  let letPreviewRead!: () => void
  const previewGate = new Promise<void>((resolve) => { letPreviewRead = resolve })
  let inPreview!: () => void
  const previewHolds = new Promise<void>((resolve) => { inPreview = resolve })
  // The preview: the Goal queue held, then — after git answers — the publication gaps read.
  const preview = f.rig.goalSerial.run(async () => {
    inPreview()
    await previewGate
    return r.pub.gaps(f.goal)
  })
  await previewHolds
  // A run step that seats the next review's cards, taken while the preview holds the Goal queue.
  let asked!: () => void
  const seatAsked = new Promise<void>((resolve) => { asked = resolve })
  f.rig.seatAsked = () => asked()
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  const step = f.finishFixer()
  await seatAsked
  letPreviewRead()
  const stuck = new Promise<'stuck'>((resolve) => { const timer = setTimeout(() => resolve('stuck'), 3_000); timer.unref() })
  const [gaps, stepped] = await Promise.all([Promise.race([preview, stuck]), Promise.race([step.then(() => 'seated' as const), stuck])])
  assert.notEqual(gaps, 'stuck', 'the preview read its gaps without waiting on the run')
  assert.deepEqual(gaps, [], 'nothing of the closed round is unsettled')
  assert.equal(stepped, 'seated', 'the run seated its cards once the preview let the Goal queue go')
  assert.equal(f.cards('reviewer').filter((one) => one.state === 'claimed').length, 2)
})

test('a second event of one finding in the same batch waits for the first rather than reading its own landing as a person’s edit', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  forge.anchorOk = false
  const { first } = await review(r, { second: false })
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const root = (await f.view(first.id)).posted[0]!
  assert.equal(root.kind, 'issue-comment')
  // The fixer claims the repair twice in one round; the first append lands and its answer is lost.
  f.rig.heads.set('/repo', { at: SHA2, dirty: false })
  forge.head = SHA2
  r.bindPullRequest(SHA2)
  const [, fixCard] = f.cards('fixer')
  await f.plane.repair({ intent: fixCard!.id, finding: first.id, request: 'fix-1', expected: (await f.view(first.id)).sequence, note: 'First try.' }, f.scope('seat-4'))
  await f.plane.repair({ intent: fixCard!.id, finding: first.id, request: 'fix-2', expected: (await f.view(first.id)).sequence, note: 'Second try.' }, f.scope('seat-4'))
  let n = 0
  forge.onSend = () => (++n === 1 ? 'lose' : 'ok')
  await f.finishFixer()
  await r.pub.idle()
  const repairs = r.entries().filter((entry) => entry.round === 3)
  assert.equal(repairs.length, 2)
  const [one, two] = f.rig.executions.stored(f.run)!.publication!.rounds['3']!.keys.map((key) => repairs.find((entry) => entry.key === key)!)
  assert.equal(one!.state, 'uncertain', 'the first append’s answer was lost')
  assert.equal(two!.state, 'prepared')
  assert.match(two!.reason ?? '', /An earlier posting of this finding has not settled/)
  assert.doesNotMatch(two!.reason ?? '', /Someone changed/, 'the desk’s own landing is never taken for a person’s edit')
  assert.equal(forge.sends.filter((send) => send.key === two!.key).length, 0, 'nothing was sent for the second')
  const comment = forge.comments.find((c) => c.id === root.comment)!
  assert.doesNotMatch(comment.body, /Second try/)
})

// ------------------------------------------------ a person on a stuck posting

const entryOf = (r: Rig, key: string): PublicationEntry => r.entries().find((entry) => entry.key === key)!

test('post again reads back first: a lost answer is recorded from the pull request, never sent again', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  let n = 0
  forge.onSend = () => (++n === 1 ? 'lose' : 'ok')
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const lost = forge.sends[0]!.key
  assert.equal(entryOf(r, lost).state, 'uncertain')
  const listed = await r.pub.needs(f.run)
  assert.deepEqual(listed.items.map((item) => item.key), [lost], 'the person is shown exactly the posting that needs them')
  await r.pub.postAgain(f.run, lost)
  assert.equal(entryOf(r, lost).state, 'posted')
  assert.equal(forge.sends.filter((send) => send.key === lost).length, 1, 'found on the pull request, so never sent again')
  assert.equal(forge.comments.filter((one) => one.body.startsWith(entryOf(r, lost).marker)).length, 1)
  assert.deepEqual(entryOf(r, lost).person?.action, 'post-again', 'the person’s action is journaled on the operation')
  assert.deepEqual((await r.pub.needs(f.run)).items, [])
})

test('post again, with no copy on the pull request, sends it once more — only because a person asked — and a second press sends nothing', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  let n = 0
  forge.onSend = () => (++n === 1 ? 'fail' : 'ok')
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const failed = forge.sends[0]!.key
  assert.equal(entryOf(r, failed).state, 'uncertain')
  await r.pub.reconcile(f.run, r.round)
  assert.equal(forge.sends.filter((send) => send.key === failed).length, 1, 'no copy found is not a reason to send again on its own')
  await r.pub.postAgain(f.run, failed)
  assert.equal(entryOf(r, failed).state, 'posted')
  await r.pub.postAgain(f.run, failed)
  assert.equal(forge.sends.filter((send) => send.key === failed).length, 2, 'the person’s one fresh attempt, and no more')
  assert.equal(forge.comments.filter((one) => one.body.startsWith(entryOf(r, failed).marker)).length, 1, 'one copy on the pull request')
})

test('post again never picks between several copies', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  let n = 0
  forge.onSend = () => (++n === 1 ? 'duplicate' : 'ok')
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const twice = forge.sends[0]!.key
  await assert.rejects(r.pub.postAgain(f.run, twice), /shows 2 copies/)
  assert.equal(entryOf(r, twice).state, 'uncertain')
  assert.equal(forge.sends.filter((send) => send.key === twice).length, 1)
})

test('post again on a paused posting checks it again: still moved, it stays paused; back at the reviewed head, it posts', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  forge.head = '6'.repeat(40)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const paused = r.entries().filter((entry) => entry.state === 'prepared' && /moved from/.test(entry.reason ?? ''))
  assert.ok(paused.length > 0)
  const key = paused[0]!.key
  await r.pub.postAgain(f.run, key)
  assert.equal(entryOf(r, key).state, 'prepared')
  assert.match(entryOf(r, key).reason ?? '', /moved from/, 'nothing is relabelled at the new head')
  assert.equal(forge.sends.length, 0)
  forge.head = SHA1
  await r.pub.postAgain(f.run, key)
  assert.equal(entryOf(r, key).state, 'posted')
  assert.equal(forge.sends.filter((send) => send.key === key).length, 1)
})

test('skip records a gap the wrap carries without asking again, and a posting that did land is recorded instead', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  let n = 0
  forge.onSend = () => (++n === 1 ? 'lose' : 'ok')
  forge.onSend = ((original) => (operation: PublicationEntry, body: string) => {
    const outcome = original(operation, body)
    forge.head = '7'.repeat(40)
    return outcome
  })(forge.onSend)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const lost = forge.sends[0]!.key
  const paused = r.entries().find((entry) => entry.state === 'prepared')!.key
  const unsettled = (await r.pub.gaps(f.goal)).length
  await r.pub.skip(f.run, paused, 'the pull request moved on; nobody needs this now')
  assert.equal(entryOf(r, paused).state, 'skipped')
  assert.deepEqual(entryOf(r, paused).person?.action, 'skip')
  assert.equal((await r.pub.gaps(f.goal)).length, unsettled - 1, 'no longer unsettled: the wrap does not ask about it again')
  const recorded = r.pub.recordedGaps(f.goal)
  assert.equal(recorded.length, 1)
  assert.match(recorded[0]!, /was skipped\. A person skipped this: the pull request moved on/)
  // Skipping one whose answer was lost: its copy is on the pull request, so where it landed is recorded, never dropped.
  await r.pub.skip(f.run, lost, 'not needed')
  assert.equal(entryOf(r, lost).state, 'posted')
  assert.equal(forge.sends.filter((send) => send.key === lost).length, 1)
  // Journaled: a restart reads the person's actions back.
  await r.restart()
  assert.equal(entryOf(r, paused).state, 'skipped')
  assert.equal(entryOf(r, paused).person?.reason, 'the pull request moved on; nobody needs this now')
})

test('a round kept on the desk is posted later only after a person previews it, and only once', async (t) => {
  const r = await publicationRig(t, { bind: false })
  const { f, forge } = r
  await review(r)
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const none = await r.pub.needs(f.run)
  assert.equal(none.backfill, null)
  assert.match(none.backfillRefusal ?? '', /No open pull request is bound/)
  r.bindPullRequest()
  r.goal.preference = false
  assert.match((await r.pub.needs(f.run)).backfillRefusal ?? '', /Posting is off/)
  r.goal.preference = undefined
  const preview = await r.pub.needs(f.run)
  assert.deepEqual(preview.backfill?.rounds, [{ round: r.round, findings: 2, reviews: 2 }])
  assert.equal(preview.backfill?.pr, 7)
  assert.deepEqual(forge.calls, [], 'previewing sends nothing')
  await assert.rejects(r.pub.backfill(f.run, '0'.repeat(64)), /changed since you previewed/)
  await r.pub.backfill(f.run, preview.backfill!.stamp)
  await r.pub.idle()
  assert.equal(forge.sends.length, 4)
  assert.ok(r.entries().every((entry) => entry.state === 'posted'))
  const round = f.rig.executions.stored(f.run)!.publication!.rounds[String(r.round)]!
  assert.equal(round.mode, 'batch')
  assert.match(round.backfilled?.from ?? '', /No open pull request is bound/, 'the journal keeps what it was before')
  await r.pub.backfill(f.run, preview.backfill!.stamp).catch(() => {})
  await r.pub.idle()
  assert.equal(forge.sends.length, 4, 'a second press posts nothing more')
  assert.equal((await r.pub.needs(f.run)).backfill, null)
})

test('a person’s posting actions are confined to the run’s own Goal, and refused once that Goal is no longer open', async (t) => {
  const r = await publicationRig(t)
  const { f, forge } = r
  await review(r)
  forge.onSend = () => 'lose'
  await f.finishReviews('request-changes')
  await r.pub.idle()
  const view = await f.plane.publications({ goal: f.goal, run: f.run })
  assert.ok(view.items.length > 0)
  await assert.rejects(f.plane.publications({ goal: 'goal-elsewhere', run: f.run }), /does not belong to this Goal/)
  await assert.rejects(f.plane.publish({ goal: 'goal-elsewhere', run: f.run, action: { kind: 'post-again', key: view.items[0]!.key } }), /does not belong to this Goal/)
  f.goalClosed = 'This Goal is wrapped. Its findings are history here; carry them into an open Goal to decide them.'
  await assert.rejects(f.plane.publish({ goal: f.goal, run: f.run, action: { kind: 'post-again', key: view.items[0]!.key } }), /This Goal is wrapped/)
  const sends = forge.sends.length
  f.goalClosed = null
  const after = await f.plane.publish({ goal: f.goal, run: f.run, action: { kind: 'post-again', key: view.items[0]!.key } })
  assert.equal(forge.sends.length, sends, 'read back and recorded, never sent again')
  assert.equal(after.items.some((item) => item.key === view.items[0]!.key), false)
})
