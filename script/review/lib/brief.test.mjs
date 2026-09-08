import assert from 'node:assert/strict'
import { test } from 'node:test'

import { branchBrief, briefFor, evidenceOf, prBrief, prReportBrief, readsAsReport } from './brief.mjs'

/**
 * One flag, read the same way in every place that reads it.
 *
 * `--no-post` was three different decisions. `briefFor` chose the *posting*
 * brief whenever there was a pull request, so every reviewer was told to
 * `gh pr comment` — under the user's account, from a run whose own banner
 * said `publishing nothing — reports are written to disk`. The closing check
 * then graded those seats against `<out>/<seat>.md`, a path only the branch
 * brief has ever mentioned, so every seat came back "no report written",
 * `missing` equalled the seat count and `node review.mjs 93 --no-post`
 * published comments and then reported total failure.
 *
 * Each of the three was defensible on its own; the bug was that no two of
 * them agreed. So there is one answer now — `evidenceOf` — and these hold the
 * brief to it: a reviewer is asked for the artefact the run will be graded
 * on, and for no other.
 *
 * The controls matter here more than the assertions. "The `--no-post` brief
 * does not say `gh pr comment`" is a check that passes on an empty string; it
 * is only evidence beside the posting brief, where the same look must find
 * it.
 */

const PR = { number: 93, url: 'https://github.com/HarnessDesk/HarnessDesk/pull/93', title: 'Rebuild the four derived stylesheets' }
const OTHER = { number: 92, url: 'https://github.com/HarnessDesk/HarnessDesk/pull/92', title: 'Tune the neutrals' }
const BRANCH = { name: 'claude/no-post', base: 'main' }

/** The four runs this skill has, and what each one is evidenced by. */
const RUNS = [
  { what: 'a pull request', ask: { post: true, prs: [PR] }, evidence: 'comments' },
  { what: 'a pull request with --no-post', ask: { post: false, prs: [PR] }, evidence: 'files' },
  { what: 'a branch', ask: { post: true, prs: [], branch: BRANCH }, evidence: 'files' },
  { what: 'a rehearsal', ask: { rehearse: true, post: false, prs: [PR] }, evidence: 'rehearsal' },
]

test('every run is evidenced by exactly one thing, and --no-post moves it to disk', () => {
  for (const run of RUNS) assert.equal(evidenceOf(run.ask), run.evidence, run.what)
})

test('a brief asks for the artefact its run will be graded on, and for no other', () => {
  /* The invariant the three-way disagreement broke, in one place. `{{report}}`
     is the slot the hand-out fills with the very path the closing check reads
     back, so a brief carrying it is a brief asking for the file that gets
     graded — and a brief telling anyone to comment is publishing, whatever
     the banner above it says. */
  for (const run of RUNS) {
    const words = briefFor(run.ask)
    const comments = run.evidence === 'comments'
    assert.equal(/gh pr comment/.test(words), comments, `${run.what}: gh pr comment`)
    assert.equal(words.includes('{{report}}'), run.evidence === 'files', `${run.what}: {{report}}`)
    assert.ok(words.includes('{{signature}}'), `${run.what}: every reviewer signs`)
  }
})

test('--no-post reviews the same pull request, and writes the review instead of posting it', () => {
  /* The subject does not change when nothing is published: the diff is still
     the pull request's, read the same way, and every pull request under
     review is still named. Only the destination has moved. */
  const words = prReportBrief({ prs: [PR, OTHER] })
  assert.match(words, /gh pr diff/)
  for (const pr of [PR, OTHER]) assert.ok(words.includes(pr.url), `#${pr.number} is named`)
  assert.match(words, /Write your review to this file, and nowhere else: \{\{report\}\}/)
  assert.match(words, /Nothing goes to GitHub/)
})

test('the posting brief is the control: the same look finds what it asks for', () => {
  /* Without this, the assertions above pass against a brief that says
     nothing at all. */
  const words = prBrief({ prs: [PR] })
  assert.match(words, /gh pr comment/)
  assert.ok(!words.includes('{{report}}'))
})

test('a branch keeps the brief it had; --no-post did not become a second one', () => {
  /* `--no-post` on a branch was never broken — there is no pull request to
     publish to — and the picker must not have quietly rerouted it through the
     pull-request wording. */
  const asked = { branch: BRANCH.name, base: BRANCH.base, note: null, others: 2 }
  assert.equal(briefFor({ post: false, prs: [], branch: BRANCH }), branchBrief(asked))
  assert.equal(briefFor({ post: true, prs: [], branch: BRANCH }), branchBrief(asked))
})

test('the closing line a --no-post review is asked for reads as its report', () => {
  /* The other half of the agreement: the wait reads what comes back with the
     report path in hand, because this brief closes by asking for "the number
     and your verdict — and then the path you wrote". Graded against the
     posting brief's reading — `report: null` — the same answer is still a
     report, and that is the point: nothing here narrows what a finished
     reviewer may say. */
  const report = '/Users/a/.harnessdesk/reviews/x/codex.md'
  const asked = { prs: [PR], report }
  assert.equal(readsAsReport(`#93 approve — wrote ${report}`, asked), true)
  assert.equal(readsAsReport(`Wrote ${report}`, asked), true)
  assert.equal(readsAsReport('Verdict: request changes — the review is on disk.', asked), true)
  assert.equal(readsAsReport('Reading the diff of #93 now.', asked), false)
})

test('a path on its own does not answer for pull requests still being read', () => {
  /* One file holds every pull request under `--no-post`, so a reviewer that
     names it after the first of three has said nothing about the other two.
     Strict is cheap here for the same reason it is everywhere else in this
     file: the file poll releases that seat within the minute, while a seat
     let through early is abandoned mid-review. */
  const report = '/Users/a/.harnessdesk/reviews/x/codex.md'
  const three = { prs: [PR, OTHER, { number: 91 }], report }
  assert.equal(readsAsReport(`Wrote ${report}`, three), false)
  assert.equal(
    readsAsReport([`#93 approve`, `#92 approve`, `#91 request changes`, `Wrote ${report}`].join('\n'), three),
    true,
  )
})
