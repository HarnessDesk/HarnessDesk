import assert from 'node:assert/strict'
import { test } from 'node:test'

import { seatLabel, seatSlugs, signatureFor } from './cast.mjs'
import { attribute, commentsIn } from './targets.mjs'

/**
 * The evidence check, tested — because it passed while it was wrong.
 *
 * On 2026-09-07 a run seated three Cursor reviewers on PR #77 and closed the
 * desk four minutes after handing out the brief: one review had been posted,
 * two were still being written, and the run printed `3/3 signed`,
 * `missing: none` and exited 0. `signaturesOn` filtered a list of *marks*
 * against every comment body joined into one string — three seats on one
 * agent shared a mark, so one comment matched three times — and
 * `evidence.json` faithfully recorded the same signature three times.
 *
 * A check that cannot fail is worse than no check, and this whole skill is
 * built on the idea that GitHub is asked rather than the agents believed. So
 * the rule the file now keeps is a countable one — **N seats need N distinct
 * comments** — and these hold it to that.
 *
 * The signatures are built with `signatureFor` rather than written out, so a
 * change to how a reviewer signs cannot leave these passing against strings
 * nobody posts any more.
 */

const seat = (over) => {
  const one = { product: 'Cursor', version: '2026.09.02-c22c1a3', modelLabel: 'Claude Opus 4.6', effortLabel: 'Max', ...over }
  return { ...one, ...signatureFor(one) }
}

const comment = (id, body) => ({ id, url: `https://github.com/o/r/pull/77#issuecomment-${id}`, at: '2026-09-07T00:50:08Z', by: 'iamenahs', body })

/** A whole review, the way one actually arrives: signature, then prose. */
const review = (id, member, tail = '\n\n## Summary\n\nThe change looks right.') =>
  comment(id, `${member.signature}${tail}`)

test('three seats that sign the same line are not all answered by one comment', () => {
  /* The invariant, in the shape that breaks a filter: identical product,
     version, model and effort, so every string these three could be looked
     for by is the same string. One comment is one review, whoever wrote it. */
  const members = [seat(), seat(), seat()]
  assert.equal(new Set(members.map((one) => one.mark)).size, 1, 'the fixture must actually collide')

  const found = attribute(members, [review(1, members[0])])
  assert.equal(found.filter(Boolean).length, 1)
  assert.equal(found.filter((one) => one === null).length, 2)
})

test('a seat is signed for by its own comment, not by the one beside it', () => {
  /* The cast of 2026-09-07 — three Cursor seats differing only by model — and
     the one comment GitHub actually had when the desk closed on all three.
     Two things were wrong that day and this holds both: the mark now carries
     the model and the effort, so these three are not one string; and the
     answer is a *comment* rather than a hit somewhere in all of them joined
     together, so seats that do share a line still need one review each. */
  const members = [
    seat({ modelLabel: 'Claude Opus 4.6', effortLabel: 'Max' }),
    seat({ modelLabel: 'GPT-5.3 Codex', effortLabel: 'Xhigh' }),
    seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' }),
  ]
  const found = attribute(members, [review(1, members[0])])

  assert.deepEqual(
    found.map(Boolean),
    [true, false, false],
    'only the seat that posted is signed for',
  )
  assert.equal(found[0].how, 'signature')
  assert.equal(found[0].id, 1)
})

test('every seat is signed for once every seat has posted', () => {
  const members = [
    seat({ modelLabel: 'Claude Opus 4.6', effortLabel: 'Max' }),
    seat({ modelLabel: 'GPT-5.3 Codex', effortLabel: 'Xhigh' }),
    seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' }),
  ]
  const found = attribute(members, members.map((one, index) => review(index + 1, one)))

  assert.deepEqual(found.map((one) => one.id), [1, 2, 3])
  assert.equal(new Set(found.map((one) => one.id)).size, 3, 'no comment answers for two seats')
})

test('a comment carrying two signatures answers for one of them', () => {
  /* A reviewer that quotes another's line — replying to it, or listing what
     the room found — must not sign on its behalf. */
  const claude = seat({ product: 'Claude Code', version: '2.1.259', modelLabel: 'Opus (1M context)' })
  const cursor = seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' })
  const both = comment(1, `${cursor.signature}\n\nI agree with ${claude.signature} on the first defect.`)

  const found = attribute([claude, cursor], [both])
  assert.equal(found.filter(Boolean).length, 1)
})

test('a quoted signature does not cost the reviewer that was quoted its own comment', () => {
  /* Greedy in member order gets this wrong: Claude takes the comment that
     quotes it, and Cursor — whose signature is only in that one comment — is
     reported missing while its review sits on the pull request. Both are
     matchable, so both must be matched. */
  const claude = seat({ product: 'Claude Code', version: '2.1.259', modelLabel: 'Opus (1M context)' })
  const cursor = seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' })
  const comments = [
    comment(1, `${cursor.signature}\n\nBuilding on ${claude.signature}: the same defect, one line lower.`),
    review(2, claude),
  ]

  const found = attribute([claude, cursor], comments)
  assert.deepEqual(found.map((one) => one?.id), [2, 1])
})

test('a reviewer that reformatted the tail of its line is found by its mark', () => {
  /* What the mark is for: the model reprinted its own signature without the
     bold and without the trailing "via HarnessDesk", which identifies nobody.
     It still says which seat wrote it, so it still counts — and says how. */
  const member = seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' })
  const found = attribute([member], [comment(1, `${member.mark}\n\n## Findings\n\nNothing blocking.`)])

  assert.equal(found[0]?.id, 1)
  assert.equal(found[0].how, 'mark')
})

test('a comment nobody signed is nobody\'s review', () => {
  const member = seat()
  assert.deepEqual(attribute([member], [comment(1, 'nice work!')]), [null])
  assert.deepEqual(attribute([member], []), [null])
})

test('what is reported about a comment is where it is, not what it said', () => {
  /* The body is dropped: `evidence.json` is a record of which review landed
     where, and pasting three whole reviews into it helps nobody read it. */
  const member = seat()
  const [found] = attribute([member], [review(1, member)])

  assert.deepEqual(Object.keys(found).sort(), ['at', 'by', 'how', 'id', 'url'])
})

test('the mark is a substring of the signature it falls back from', () => {
  /* `attribute` takes the union of the two edge sets rather than assuming
     this, but a signature that stopped containing its own mark would mean a
     reviewer signing one line and being looked for under another. */
  for (const over of [{}, { effortLabel: null }, { version: null }]) {
    const { signature, mark } = signatureFor({ product: 'Cursor', version: '1.2.3', modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High', ...over })
    assert.ok(signature.includes(mark), `${signature} does not carry ${mark}`)
  }
})

test('each seat gets a file of its own, and a lone runtime keeps its plain name', () => {
  /* `cursor.channel.md` was written once per Cursor seat and survived once:
     the 2026-09-07 record has one three-line file where three reviews belong. */
  const slugs = seatSlugs([
    { runtime: 'claude-code', model: 'opus[1m]', effort: 'max' },
    { runtime: 'cursor', model: 'claude-4.6-opus', effort: 'max' },
    { runtime: 'cursor', model: 'gpt-5.3-codex', effort: 'xhigh' },
    { runtime: 'cursor', model: 'gemini-3.8-flash', effort: 'high' },
  ])

  assert.equal(new Set(slugs).size, 4)
  assert.equal(slugs[0], 'claude-code', 'the only seat on its agent keeps the name a person looks for')
  assert.deepEqual(slugs.slice(1), ['cursor-claude-4-6-opus-max', 'cursor-gpt-5-3-codex-xhigh', 'cursor-gemini-3-8-flash-high'])
  for (const slug of slugs) assert.match(slug, /^[a-z0-9-]+$/, 'a slug is a filename')
})

test('a cast that repeats itself exactly is numbered rather than overwritten', () => {
  const slugs = seatSlugs([
    { runtime: 'cursor', model: 'gemini-3.8-flash', effort: 'high' },
    { runtime: 'cursor', model: 'gemini-3.8-flash', effort: 'high' },
  ])
  assert.equal(new Set(slugs).size, 2)
  assert.deepEqual(slugs, ['cursor-gemini-3-8-flash-high-1', 'cursor-gemini-3-8-flash-high-2'])
})

/**
 * The second round, found by the review of the first fix.
 *
 * Matching reviewers to comments made the *count* honest and left the other
 * half standing: a signature appearing in a comment is not the same as that
 * comment being signed. Cursor/Codex 5.3 reproduced it — one reviewer posting
 * twice, quoting another's line, and the reviewer that posted nothing matched
 * the quote. So a comment now belongs to whoever signed its first line, which
 * is what the brief asks for and what a quotation is never on.
 */

test('a reviewer who posted nothing is not signed for by somebody quoting it', () => {
  /* Cursor/Codex 5.3's reproduction, verbatim: A posts twice and quotes B; B
     never posted. A maximum matching was delighted to hand A's second comment
     to A and the quoting one to B, and the run went green with B missing. */
  const a = seat({ modelLabel: 'Claude Opus 4.6', effortLabel: 'Max' })
  const b = seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' })
  const found = attribute(
    [a, b],
    [
      comment(1, `${a.signature}\n\nAgreeing with ${b.signature} on the first defect.`),
      comment(2, `${a.signature}\n\nFollow-up: one more thing.`),
    ],
  )

  assert.equal(found[1], null, 'the reviewer that posted nothing is missing')
  assert.ok(found[0], 'the reviewer that posted twice is signed for once')
  assert.equal(found.filter(Boolean).length, 1)
})

test('a signature quoted mid-comment claims nothing at all', () => {
  /* The general rule under the specific case: the only comment on the pull
     request carries B's whole signature, and it is A's comment. */
  const a = seat({ modelLabel: 'Claude Opus 4.6', effortLabel: 'Max' })
  const b = seat({ modelLabel: 'Gemini 3.8 Flash', effortLabel: 'High' })
  const found = attribute([a, b], [comment(1, `${a.signature}\n\n> ${b.signature}\n\nI disagree.`)])

  assert.deepEqual(found.map((one) => one?.id ?? null), [1, null])
})

test('a reviewer that wrote a sentence before signing is still counted', () => {
  /* The tolerance the first-line rule must not cost. Nobody signed this
     comment's opening, so it is open to a signature found deeper in it — and
     `how` says which line answered, so the record does not overstate it. */
  const member = seat()
  const found = attribute([member], [comment(1, `Here is my review.\n\n${member.signature}\n\nLGTM.`)])

  assert.equal(found[0]?.id, 1)
  assert.equal(found[0].how, 'body')
})

test('numbering a repeated seat cannot land on a name another seat has', () => {
  /* Cursor/Gemini 3.8 Flash's defect: two `gemini` seats are numbered `-1`
     and `-2`, and a third seat on a model *called* `gemini-1` already owns the
     first of those. Both would have written one file. */
  const slugs = seatSlugs([
    { runtime: 'cursor', model: 'gemini', effort: null },
    { runtime: 'cursor', model: 'gemini', effort: null },
    { runtime: 'cursor', model: 'gemini-1', effort: null },
  ])

  assert.equal(new Set(slugs).size, 3, slugs.join(' '))
  for (const slug of slugs) assert.match(slug, /^[a-z0-9-]+$/)
})

test('comments are read a line at a time, and a body full of newlines is one of them', () => {
  /* `gh --jq` prints each result as compact JSON. The escaping is the whole
     reason this works, so it is what the fixture is made of. */
  const rows = [
    { id: 1, url: 'u1', at: 't1', by: 'iamenahs', body: 'first\n\n## Heading\n\n- a\n- b' },
    { id: 2, url: 'u2', at: 't2', by: 'iamenahs', body: 'second' },
  ]
  const printed = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n\n`

  assert.deepEqual(commentsIn(printed), rows, 'blank lines are not comments')
})

test('a line that will not parse is raised, not skipped', () => {
  /* A dropped comment is a reviewer this file goes on to call missing, which
     is the failure mode the whole file exists to avoid. */
  assert.throws(() => commentsIn('{"id":1}\nnot json at all\n', '#78'), /could not read a comment on #78/)
})

test('a seat is labelled by what tells it apart from the seat beside it', () => {
  assert.equal(
    seatLabel({ product: 'Cursor', version: '2026.09.02', modelLabel: 'Codex 5.3', effortLabel: 'Extra high' }),
    'Cursor 2026.09.02 · Codex 5.3 · Extra high effort',
  )
  assert.equal(
    seatLabel({ product: 'Codex', version: null, modelLabel: 'GPT-5.6 Sol', effortLabel: null }),
    'Codex · GPT-5.6 Sol',
  )
})

test('prose that merely names a reviewer is not that reviewer posting', () => {
  /* The last way in, found by re-reading Cursor/Gemini 3.8 Flash's note about
     substring matching once the first-line rule was in. A round's own write-up
     — the kind sitting on PR #77 — signs nobody at its top and names every
     seat in its body, so against the loose mark it counted as all of them. The
     body fallback takes the whole signature now, which is a line the desk
     hands over rather than one anybody writes in passing. */
  const member = seat({ modelLabel: 'Claude Opus 4.6', effortLabel: 'Max' })
  const roundup = comment(
    9,
    `## The review round, and what it changed\n\nThree seats read this. ${member.mark} approved with two findings.`,
  )

  assert.deepEqual(attribute([member], [roundup]), [null])
})

test('two seats on one agent with nothing to tell them apart still get two files', () => {
  /* Cursor/Claude Opus 4.6 read this path and called it sound. It is, but only
     because of the pass that makes the names unique — `clean(null)` is '' and
     drops out, so both wide names collapse to the runtime alone. */
  const slugs = seatSlugs([
    { runtime: 'cursor', model: null, effort: null },
    { runtime: 'cursor', model: null, effort: null },
  ])

  assert.equal(new Set(slugs).size, 2, slugs.join(' '))
})
