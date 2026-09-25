import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Intent } from '@harnessdesk/protocol'

import { isSummaryPublication, Publications, type PublicationEntry } from '../src/findings/publication.js'
import { FakeFindingForge, type SendOutcome } from './fixtures/fake-finding-forge.js'
import { findingsRig, SHA1, SHA2, type FindingsRig } from './fixtures/findings-rig.js'

/*
 * A trigger's run posts each closed blind round as one pull request review:
 * three independent answers and the findings they raised, in a single
 * `COMMENT` review pinned to the head the round reviewed, each answer signed
 * from its own Seat's record. Never before the round closed, never twice to
 * find out whether the first landed, and never at a head the round did not
 * review.
 */

const REVIEWERS = ['code-reviewer', 'security-reviewer', 'api-reviewer'] as const

interface Rig {
  readonly f: FindingsRig
  readonly forge: FakeFindingForge
  pub: Publications
  readonly round: number
  entries(): PublicationEntry[]
  restart(): Promise<void>
}

const rig = async (t: { after(fn: () => Promise<void>): void }, options: { summary?: boolean; gate?: { value: string | null } } = {}): Promise<Rig> => {
  const f = await findingsRig(t, { reviewers: REVIEWERS })
  const forge = new FakeFindingForge(SHA1)
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
    goal: () => ({ open: true, preference: undefined }),
    projectOf: async () => '/repo',
    facts: (id) => f.port.flows.facts!(id),
    ledger: (project) => f.plane.ledgerOf(project),
    seat: (id) => f.rig.seats.get(id) ?? null,
    template: () => '**Review by {seat} · via HarnessDesk**',
    appendPost: (input) => f.plane.appendPost(input),
    forge,
    // The host answers this from the run: a trigger's run posts one review a round.
    summary: () => options.summary ?? true,
    // The intake gate by Goal, as the host answers it: a paused machine posts nothing.
    ...(options.gate ? {
      beforeDispatch: async () => options.gate!.value === null ? { ok: true as const } : { ok: false as const, reason: 'needs a person' as const, detail: options.gate!.value },
    } : {}),
    now: () => 1_000,
    log: () => {},
  })
  const out = { f, forge, pub: make(), round: 2 } as Rig
  const attach = (): void => {
    f.plane.attachPublisher(out.pub)
    f.rig.flows.onRunStopped((run) => out.pub.cancel(run, 'The run was stopped before this was posted, so it stays on the desk.'))
  }
  attach()
  f.onPlane = () => {
    out.pub = make()
    attach()
  }
  f.rig.facts.set(f.goal, [...(f.rig.facts.get(f.goal) ?? []), {
    id: 'pr-1', fact: { kind: 'pr', number: 7, head: SHA1, state: 'open', url: 'https://github.com/acme/widgets/pull/7' },
    card: { board: f.goal, id: 1 }, checkout: { cwd: '/repo', branch: 'fix' }, seat: null, round: null, observedAt: 1, posted: null,
  }])
  out.entries = () => Object.values(f.rig.executions.stored(f.run)?.publication?.ops ?? {})
  out.restart = async () => {
    await out.pub.idle()
    await f.restart()
    await out.pub.recover()
    await out.pub.idle()
  }
  return out
}

const holder = (f: FindingsRig, card: Intent): string => {
  const found = [...f.rig.seats.values()].find((seat) => seat.session.sessionId === card.claim?.sessionId)
  assert.ok(found, `somebody holds card #${card.id}`)
  return String(found.id)
}

/** One reviewer answers: raises what it is given, records its verdict, finishes its card. */
const answer = async (f: FindingsRig, card: Intent, verdict: 'approve' | 'request-changes', raises: readonly { title: string; anchor?: { path: string; line: number; side: 'LEFT' | 'RIGHT' } }[]): Promise<void> => {
  const seat = holder(f, card)
  const candidate = await f.candidate(card.id, seat)
  for (const one of raises) {
    await f.plane.raise({
      intent: card.id, candidate: candidate.id, request: `raise-${one.title}`, title: one.title, body: `What ${one.title} is.`,
      category: 'ordinary', blocking: true, ...(one.anchor ? { anchor: one.anchor } : {}),
    }, f.scope(seat))
  }
  await f.rig.review.record({ intent: card.id, candidate: candidate.id, verdict }, f.scope(seat))
  await f.rig.team.complete(card.id, { outcome: verdict }, f.scope(seat))
  await f.rig.flows.flush()
}

/** The fixer finishes, and the three blind reviewers' cards are held. */
const toReview = async (r: Rig): Promise<Intent[]> => {
  await r.f.finishFixer()
  const cards = r.f.cards('reviewer')
  assert.equal(cards.length, 3, 'three blind reviewers')
  return cards
}

test('one closed round creates one pinned PR review', async (t) => {
  const r = await rig(t)
  const { f, forge } = r
  const [one, two, three] = await toReview(r)
  const seats = [one!, two!, three!].map((card) => f.rig.seats.get(holder(f, card))!)
  await answer(f, one!, 'request-changes', [{ title: 'Unbounded read', anchor: { path: 'src/read.ts', line: 3, side: 'RIGHT' } }])
  await answer(f, two!, 'approve', [])
  await r.pub.idle()
  // Two of three answered: the round is open and blind, and nothing is decided or sent.
  assert.equal(f.rig.flows.roundClosed(f.run, r.round), false)
  assert.equal(await r.pub.prepare(f.run, r.round), null)
  assert.deepEqual(forge.calls, [], 'nothing reached the forge')
  assert.deepEqual(r.entries(), [])

  await answer(f, three!, 'request-changes', [{ title: 'Missing check' }])
  await r.pub.idle()
  assert.equal(forge.summaries.length, 1, 'one review for the closed round')
  assert.deepEqual(forge.sends, [], 'no finding or answer is posted on its own')
  const [sent] = forge.summaries
  assert.equal(sent!.head, SHA1, 'pinned to the head the round reviewed')
  assert.equal(sent!.pr, 7)
  assert.match(sent!.body, /^<!-- harnessdesk:finding-op pub-[0-9a-f]{48} -->\n\*\*Review round 2\*\* · 3 independent reviews of 111111111111 · no verdict is claimed/)
  // Each answer is signed from its own Seat's record, the zero-findings one included.
  const signatures = sent!.body.split('\n').filter((line) => line.startsWith('**Review by '))
  assert.equal(signatures.length, 3, 'three signed answers')
  for (const seat of seats) {
    assert.ok(sent!.body.includes(`**Review by ${seat.seatLabel} · via HarnessDesk**`), `${seat.seatLabel} signs its own answer`)
  }
  assert.match(sent!.body, /approve · raised no findings/)
  // The anchored finding is an inline comment of the same review; the other stays in its body.
  assert.deepEqual(sent!.comments.map((one) => [one.path, one.line, one.side]), [['src/read.ts', 3, 'RIGHT']])
  assert.match(sent!.comments[0]!.body, /\*\*Unbounded read\*\*/)
  assert.match(sent!.body, /\*\*Findings not on a changed line\*\*[\s\S]*\*\*Missing check\*\*/)
  assert.doesNotMatch(sent!.body, /Unbounded read/, 'an inline finding is not repeated in the body')
  const [entry] = r.entries()
  assert.ok(entry && isSummaryPublication(entry))
  assert.equal(entry.state, 'posted')
  assert.equal(r.entries().length, 1, 'no per-finding first send was journaled for this batch')
  // The inline comment is its finding's thread now: the ledger records where it is.
  const posts = (await f.records()).filter((record) => record.finding?.event.kind === 'post')
  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.finding?.event.kind === 'post' ? posts[0]!.finding.event.location.kind : null, 'review-comment')

  // A replayed close, a reconcile and a restart post nothing more.
  await r.pub.close(f.run, r.round)
  await r.pub.reconcile(f.run, r.round)
  await r.restart()
  assert.equal(forge.summaries.length, 1, 'never a second review for the same closed round')
})

const lossRig = async (t: { after(fn: () => Promise<void>): void }, outcome: SendOutcome): Promise<Rig> => {
  const r = await rig(t)
  const [one, two, three] = await toReview(r)
  r.forge.onSummary = () => outcome
  await answer(r.f, one!, 'request-changes', [{ title: 'Unbounded read', anchor: { path: 'src/read.ts', line: 3, side: 'RIGHT' } }])
  await answer(r.f, two!, 'approve', [])
  await answer(r.f, three!, 'approve', [])
  await r.pub.idle()
  r.forge.onSummary = null
  return r
}

test('uncertain send and moved head never publish twice', async (t) => {
  await t.test('a lost answer is read back after a restart and recorded once', async (t) => {
    const r = await lossRig(t, 'lose')
    assert.equal(r.entries()[0]!.state, 'uncertain', 'the send may have landed')
    assert.equal(r.forge.reviews.length, 1)
    await r.restart()
    assert.equal(r.forge.summaries.length, 1, 'never sent again to find out')
    const [entry] = r.entries()
    assert.equal(entry!.state, 'posted', 'the one exact copy is recorded where it is')
    assert.ok(isSummaryPublication(entry!) && entry.posted?.id === String(r.forge.reviews[0]!.id))
  })

  await t.test('two copies on the forge need the person, and nothing is resent', async (t) => {
    const r = await lossRig(t, 'duplicate')
    await r.restart()
    await r.restart()
    assert.equal(r.forge.summaries.length, 1)
    const [entry] = r.entries()
    assert.equal(entry!.state, 'uncertain')
    assert.match(entry!.reason ?? '', /shows 2 copies of this round’s review/)
  })

  await t.test('a read back that cannot finish is never read as "not there"', async (t) => {
    const r = await lossRig(t, 'lose')
    r.forge.findFails = 'HTTP 502'
    await r.restart()
    assert.equal(r.forge.summaries.length, 1)
    assert.equal(r.entries()[0]!.state, 'uncertain')
    assert.match(r.entries()[0]!.reason ?? '', /could not read the pull request back/)
  })

  await t.test('a head that moved keeps the review on the desk for the person', async (t) => {
    const r = await rig(t)
    const [one, two, three] = await toReview(r)
    r.forge.head = SHA2
    await answer(r.f, one!, 'request-changes', [{ title: 'Unbounded read' }])
    await answer(r.f, two!, 'approve', [])
    await answer(r.f, three!, 'approve', [])
    await r.pub.idle()
    assert.equal(r.forge.summaries.length, 0, 'nothing is posted at a head the round did not review')
    const [entry] = r.entries()
    assert.equal(entry!.state, 'prepared')
    assert.match(entry!.reason ?? '', /moved from 111111111111 to 222222222222/)
    await r.restart()
    assert.equal(r.forge.summaries.length, 0, 'a restart does not resume a paused review on its own')
  })
})

test('a run that is not a trigger’s still posts comment by comment', async (t) => {
  const r = await rig(t, { summary: false })
  const [one, two, three] = await toReview(r)
  await answer(r.f, one!, 'request-changes', [{ title: 'Unbounded read' }])
  await answer(r.f, two!, 'approve', [])
  await answer(r.f, three!, 'approve', [])
  await r.pub.idle()
  assert.equal(r.forge.summaries.length, 0)
  assert.equal(r.forge.sends.length, 4, 'one finding and three answers, as phase 7 posts them')
})

test('a paused machine posts no closed round’s review, and posts it once when it resumes', async (t) => {
  const gate = { value: 'Every trigger is paused. Resume triggers to continue.' as string | null }
  const r = await rig(t, { gate })
  const [one, two, three] = await toReview(r)
  await answer(r.f, one!, 'request-changes', [{ title: 'Unbounded read' }])
  await answer(r.f, two!, 'approve', [])
  await answer(r.f, three!, 'approve', [])
  await r.pub.idle()
  assert.equal(r.forge.summaries.length, 0, 'nothing reaches the forge while paused')
  assert.deepEqual(r.forge.calls, [], 'not even a read')
  const [waiting] = r.entries()
  assert.equal(waiting!.state, 'prepared')
  assert.equal(waiting!.reason, null, 'held, not paused for a person: the resume posts it on its own')

  gate.value = null
  await r.pub.settleForWrap(r.f.goal)
  await r.pub.idle()
  assert.equal(r.forge.summaries.length, 1, 'posted once the machine resumes')
  assert.equal(r.entries()[0]!.state, 'posted')
  await r.pub.settleForWrap(r.f.goal)
  assert.equal(r.forge.summaries.length, 1, 'and never twice')
})
