import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readsAsReport } from './brief.mjs'

/**
 * The room-side wait, tested — because it ended a review that was still going.
 *
 * The GitHub side already knows that *a signature in a comment is not a
 * comment being signed*. The room side made the same mistake one layer down
 * and kept it: it decided a reviewer had reported the moment that seat said
 * anything at all. The brief is the worst possible source of a "done" signal,
 * because it instructs every reviewer to write its signature — so neither a
 * message existing nor a signature in one says the reading is over.
 *
 * On 2026-09-07 (`~/.harnessdesk/reviews/2026-09-07T04-58-35/`) the
 * `cursor · gpt-5.3-codex · xhigh` seat posted a progress note four minutes
 * into PR #90. The driver printed `3 answered — nobody left to wait for`,
 * polled GitHub through a three-minute grace, reported `2/3 signed` and
 * exited 1. That reviewer never posted a comment; it was still reading.
 *
 * The three messages of that round are the fixtures below, verbatim: the two
 * that were reports, and the one that was not.
 */

const PR90 = { number: 90, url: 'https://github.com/HarnessDesk/HarnessDesk/pull/90' }
const one = { prs: [PR90] }

/* Room messages of 2026-09-07T04-58-35, exactly as `room.json` recorded them. */
const OPUS =
  '[#90](https://github.com/HarnessDesk/HarnessDesk/pull/90) — **Verdict: approve** — [comment](https://github.com/HarnessDesk/HarnessDesk/pull/90#issuecomment-5565285179)'
const GEMINI = '#90: approve — https://github.com/HarnessDesk/HarnessDesk/pull/90#issuecomment-5565322735'
const CODEX =
  'I’m now checking downstream callers and reason-string sources to see whether the new two-line clamp or brand-matching rules can hide or misclassify real runtime states.'

test('the progress note that ended a review early is not a report', () => {
  /* The whole reason this file exists. It carries no verdict and links to no
     comment: it is a sentence about what the agent is doing next. */
  assert.equal(readsAsReport(CODEX, one), false)
})

test('the two reports of that round are reports', () => {
  /* Two vendors, two spellings of the same line — one all markdown, one all
     plain. Both name the pull request, both give a verdict, both link the
     comment they left, and nothing may be read so tightly that it misses
     either of them. */
  assert.equal(readsAsReport(OPUS, one), true)
  assert.equal(readsAsReport(GEMINI, one), true)
})

test('a signature alone is not a report', () => {
  /* The signal the wait used to be happy with, near enough: the brief hands
     this exact line to every reviewer before it has read a thing. */
  const signature = '**Review by Cursor 2026.09.02-c22c1a3 · Codex 5.3 · Extra high effort · via HarnessDesk**'
  assert.equal(readsAsReport(signature, one), false)
  assert.equal(readsAsReport(`${signature}\n\n${CODEX}`, one), false)
})

test('a verdict is enough, and so is the comment it left', () => {
  /* Either half of the closing ask answers it: the brief asks for "the
     number, your verdict, and the link to the comment you left", and a
     reviewer that gives one of the two has still said it is finished. */
  assert.equal(readsAsReport('Verdict: approve', one), true)
  assert.equal(readsAsReport('Verdict: request changes', one), true)
  assert.equal(readsAsReport('#90: approve', one), true)
  assert.equal(readsAsReport('Posted: https://github.com/o/r/pull/90#issuecomment-99', one), true)
})

test('a link to the pull request is not a link to a comment', () => {
  /* The brief hands every reviewer the pull request's own URL, so quoting it
     proves only that the agent can read its instructions back. */
  assert.equal(readsAsReport(`Reading ${PR90.url} now.`, one), false)
  assert.equal(readsAsReport(`Reviewing ${PR90.url}/files — nothing yet.`, one), false)
})

test('offering both verdicts is a plan, not a verdict', () => {
  /* The next shape of the same bug: a progress note that happens to name the
     words. A line that offers both is offering, not deciding. */
  assert.equal(readsAsReport("Reading the diff — I'll approve or request changes shortly.", one), false)
  assert.equal(readsAsReport("I'll post my verdict — approve or request changes — once I've read the callers.", one), false)
})

test('a sentence that opens on a verdict word is not a verdict', () => {
  /* Nothing may follow the word but separators and links, which is what keeps
     the driver's own vocabulary out of the count: these agents run `gh` a
     dozen times and the room hears about it. */
  assert.equal(readsAsReport('Approved the gh command and carried on reading.', one), false)
  assert.equal(readsAsReport('Changes requested by the linter are unrelated to this diff.', one), false)
})

test('a verdict that mentions the other one is still a verdict', () => {
  /* The tolerance the "both words" rule must not cost. This reviewer has
     decided; it is saying why. */
  assert.equal(
    readsAsReport("Verdict: request changes — I can't approve while the clamp hides the reason.", one),
    true,
  )
})

test('a report on the first of several pull requests is not the report', () => {
  /* The brief asks for "one line per pull request", and the same reasoning
     applies at the smaller scale: a reviewer three lines into eight is a
     reviewer still working. Missing one is cheap — the GitHub poll releases
     that seat within the minute — and cutting one off is not. */
  const three = { prs: [PR90, { number: 91 }, { number: 92 }] }
  assert.equal(readsAsReport(GEMINI, three), false)
  assert.equal(
    readsAsReport(
      [
        '- #90 approve — https://github.com/o/r/pull/90#issuecomment-1',
        '- #91 request changes — https://github.com/o/r/pull/91#issuecomment-2',
        '- #92 approve — https://github.com/o/r/pull/92#issuecomment-3',
      ].join('\n'),
      three,
    ),
    true,
  )
})

test('a branch review reports a verdict or the path it wrote', () => {
  /* No pull request, so no comment to link: `branchBrief` asks for "your
     verdict, and the path you wrote", and there is no GitHub poll behind this
     one to catch what the reading misses. */
  const branch = { report: '/Users/a/.harnessdesk/reviews/x/codex.md' }
  assert.equal(readsAsReport('Wrote /Users/a/.harnessdesk/reviews/x/codex.md', branch), true)
  assert.equal(readsAsReport('Verdict: request changes — the review is on disk.', branch), true)
  assert.equal(readsAsReport('Still reading packages/ui/src for the clamp.', branch), false)
})

test('a rehearsal is finished by the word it was asked for', () => {
  /* `rehearseBrief` asks for the word `ready` and a signature, never a
     verdict. A reading that only knows what a review looks like would leave
     `--rehearse` — the cheap way to prove this whole machine — sitting out
     its clock every time. */
  const rehearsal = { rehearsal: true }
  assert.equal(readsAsReport('ready — "Agent logos from lobe-icons, and one height"', rehearsal), true)
  assert.equal(readsAsReport(CODEX, rehearsal), false)
})

test('a report survives the ways a model decorates one', () => {
  /* Bold, headings, table rows, block quotes and bullets are how these three
     actually write. None of them changes what the line says. */
  for (const line of [
    '**Verdict: approve**',
    '## Verdict: request changes',
    '| #90 | approve | https://github.com/o/r/pull/90#issuecomment-1 |',
    '> Verdict: approve',
    '* #90 — approve',
    '`Verdict: approve`',
  ]) {
    assert.equal(readsAsReport(line, one), true, line)
  }
})

test('nothing at all is not a report', () => {
  for (const nothing of [null, undefined, '', '   \n\n  ']) {
    assert.equal(readsAsReport(nothing, one), false)
  }
})
