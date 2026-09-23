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
