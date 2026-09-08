/**
 * The words the reviewers actually get — and the reading of what comes back.
 *
 * One template, handed out once, with each reviewer's own signature filled in
 * for it — `{{signature}}` and `{{report}}` are the host's own hand-out slots,
 * filled per recipient at delivery.
 *
 * `evidenceOf` and `readsAsReport` live here rather than beside the run for
 * the same reason: which brief goes out, what the run is graded on and what
 * the wait is listening for are one decision seen from three sides, and a
 * brief whose closing ask changes without them is a wait that stops on the
 * wrong sentence — or a flag that means three different things (see
 * `evidenceOf`).
 *
 * Three things in here are load-bearing and were learned the hard way:
 * independence (agreement between three reviewers is only evidence if none of
 * them read the others first), the signature as a finished line to copy
 * (a model asked to "sign with your name and version" invents a version), and
 * the instruction to say what was checked and found *sound* — the reviews
 * that have caught real defects here are the ones that also cleared areas
 * explicitly, because a list with nothing in it is not the same as silence.
 */

const list = (prs) => prs.map((pr) => `- #${pr.number} ${pr.url} — ${pr.title}${pr.draft ? ' (draft)' : ''}`).join('\n')

/**
 * The independence sentence, counting the room it is actually in.
 *
 * It said "two other agents from other vendors … three opinions" whatever the
 * cast was. Run four seats and the brief is wrong in front of every one of
 * them; run two and it invents a third. A reviewer told there are two others
 * has been told something checkable about the room, and getting it wrong is
 * the cheapest possible way to spend its trust.
 */
const WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n) => WORD[n] ?? String(n)

const alone = (others) => {
  if (others <= 0) {
    return 'Deep code review, please — yours alone. Nobody else is reviewing this with you, so nothing here is a second opinion but yours.'
  }
  const many = others === 1 ? 'one other agent is' : `${count(others)} other agents are`
  const opinions = `${count(others + 1)} opinions`
  return `Deep code review, please — yours alone. ${many[0].toUpperCase()}${many.slice(1)} reviewing the same code in this room, independently: do not wait for them, do not ask them, and do not read their answers before writing your own. The value of this is ${opinions} that were formed separately.`
}

const HOW = (where) => `In the ${where}, in your own words:
- the defects you can point at, each with a \`file:line\` and what actually goes wrong;
- the risks and the missing tests;
- what you checked and found sound — say so explicitly, by name. An area cleared is worth as much as a defect found, and only you can say which areas you actually read.
End with a verdict on its own line: \`Verdict: approve\` or \`Verdict: request changes\`.

Rules:
- Report only what the code supports. Where you are unsure, say you are unsure and say what you would have to run to know. A confident wrong finding costs more than a missing one.
- Read-only: do not edit files, do not build, do not commit, push, approve or merge anything. Other agents are working in this checkout.`

/** The brief for a set of pull requests. */
export const prBrief = ({ prs, note, others = 2 }) => `${alone(others)}

Pull request${prs.length === 1 ? '' : 's'} to review:
${list(prs)}

For each one:
1. Read the whole diff — \`gh pr diff <url>\` — and then the files it touches in this checkout. The question is what the change does to *this* codebase, not whether the patch is internally tidy.
2. Post exactly one comment on that pull request: \`gh pr comment <url> --body-file <file>\`. The comment's first line must be exactly this, on its own line, unchanged:

{{signature}}

3. ${HOW('comment')}

When you have finished, reply here with one line per pull request: the number, your verdict, and the link to the comment you left.${note ? `\n\n${note}` : ''}`

/**
 * The same pull requests, reviewed but not commented on — `--no-post`.
 *
 * The subject does not change when nothing is published; only where the
 * review goes. Until 2026-09-07 `--no-post` handed out `prBrief` anyway, so a
 * run that printed "publishing nothing" over its own banner told all three
 * reviewers to comment on GitHub — and then graded them against report files
 * nobody had been asked to write, so every seat came back "no report written"
 * and the run exited 1 having published under the user's account. One flag,
 * one meaning: the diff is still the pull request's, and the review is a file.
 */
export const prReportBrief = ({ prs, note, others = 2 }) => `${alone(others)}

Pull request${prs.length === 1 ? '' : 's'} to review:
${list(prs)}

Read the whole diff${prs.length === 1 ? '' : ' of each'} — \`gh pr diff <url>\` — and then the files it touches in this checkout. The question is what the change does to *this* codebase, not whether the patch is internally tidy.

Nothing here is published. Write your review to this file, and nowhere else: {{report}}
Its first line must be exactly this, unchanged:

{{signature}}
${prs.length === 1 ? '' : '\nGive each pull request a section of its own, headed by its number and ending in its own verdict line.\n'}
${HOW('review')}
- Nothing goes to GitHub: do not comment on ${prs.length === 1 ? 'the pull request' : 'any of the pull requests'}, do not submit a review, do not reply there. The file is the review.

When you have finished, reply here with one line per pull request — the number and your verdict — and then the path you wrote.${note ? `\n\n${note}` : ''}`

/** The brief for a branch that has no pull request yet. */
export const branchBrief = ({ branch, base, note, others = 2 }) => `${alone(others)}

There is no pull request yet. Review this checkout's branch \`${branch}\` against \`${base}\`:
- \`git diff ${base}...HEAD\` for the change, and \`git log ${base}..HEAD\` for what it says about itself;
- then the files it touches, in full.

Write your review to this file, and nowhere else: {{report}}
Its first line must be exactly this, unchanged:

{{signature}}

${HOW('review')}

When you have finished, reply here with one line: your verdict, and the path you wrote.${note ? `\n\n${note}` : ''}`

/**
 * A rehearsal: the room, the picks, the hand-out, the approval loop and the
 * signatures, proven for the price of one short turn each.
 *
 * Everything expensive about a review is in the reading, and everything
 * fragile about it is in the plumbing. This exercises the plumbing — `gh`
 * really runs, so Claude Code really asks for approval — and publishes
 * nothing.
 */
export const rehearseBrief = ({ prs, branch }) => `Rehearsal, please — nothing you write here is published, and it should take you under a minute.

${
  prs.length > 0
    ? `Run this once: \`gh pr view ${prs[0].url} --json title --jq .title\``
    : `Run this once: \`git log -1 --format=%s\``
}

Then reply in this room with one line: the word ready, what that printed, and this signature, unchanged:

{{signature}}

Do not post anything to GitHub. Do not edit, build or commit anything.${branch ? '' : ''}`

// --------------------------------------------------------- which of them, and why

/**
 * What a run's evidence is — the one decision the brief, the wait and the
 * closing table all have to be making the same way.
 *
 * They were not. `--no-post` on a pull request handed out the *posting*
 * brief, printed "publishing nothing" above it, and then graded every seat
 * against a report file no brief had asked for: the reviews were published
 * and the run still reported total failure and exited 1. Three readings of
 * one flag in three places, none of them talking to the others — so there is
 * one reading now, and the three places ask it.
 *
 * - `comments`  — one signed comment per reviewer per pull request, counted
 *                 on GitHub;
 * - `files`     — one signed report per reviewer, counted on disk. A branch
 *                 has no pull request to comment on; `--no-post` chooses not
 *                 to;
 * - `rehearsal` — a signed line in the room, and nothing anywhere else.
 */
export const evidenceOf = ({ rehearse = false, post = true, prs = [] } = {}) =>
  rehearse ? 'rehearsal' : post && prs.length > 0 ? 'comments' : 'files'

/**
 * The words that go out, for the run this actually is.
 *
 * One brief per evidence, chosen here rather than at the call site, so that a
 * reviewer is never asked for an artefact nothing afterwards will look at —
 * and so that the reading of what comes back (`readsAsReport`, below) is
 * split on the same question as the asking.
 */
export const briefFor = ({ rehearse = false, post = true, prs = [], branch = null, note = null, others = 2 } = {}) => {
  switch (evidenceOf({ rehearse, post, prs })) {
    case 'rehearsal':
      return rehearseBrief({ prs, branch })
    case 'comments':
      return prBrief({ prs, note, others })
    default:
      return prs.length > 0
        ? prReportBrief({ prs, note, others })
        : branchBrief({ branch: branch.name, base: branch.base, note, others })
  }
}

// ------------------------------------------------------- and what comes back

/**
 * Whether a message in the room is the **report** the brief asked for.
 *
 * The wait used to end on any message from a seat, and the skill's own note
 * for the GitHub side says why that is wrong one layer down: *a signature in
 * a comment is not a comment being signed*. Here it is a message being spoken
 * mistaken for a review being finished. The brief is the worst possible
 * source of a "done" signal, because it instructs every reviewer to write its
 * signature — so the signature is the one string that says nothing at all
 * about being done.
 *
 * On 2026-09-07 the Cursor/Codex 5.3 seat said, four minutes in, "I'm now
 * checking downstream callers and reason-string sources to see whether the new
 * two-line clamp or brand-matching rules can hide or misclassify real runtime
 * states." The driver printed `3 answered — nobody left to wait for`, gave
 * GitHub three minutes, reported `2/3 signed` and exited 1 with that reviewer
 * still reading.
 *
 * So the reading is the closing ask, back:
 *
 * - a pull-request brief asks for "one line per pull request: the number,
 *   your verdict, and the link to the comment you left" — so a verdict, or a
 *   link to a *comment* (never merely to the pull request, which the brief
 *   itself hands over), and that many lines of it. A report on the first of
 *   eight is not a report;
 * - a branch brief asks for "your verdict, and the path you wrote" — so a
 *   verdict, or that path;
 * - a rehearsal asks for the word `ready`, and nothing here may make
 *   `--rehearse` sit out its clock.
 *
 * Strict is cheap and loose is not: a seat this misses is released the moment
 * its comment is seen on GitHub, a minute later at worst, while a seat this
 * lets through early is abandoned mid-review. That asymmetry is why a message
 * is read on its own rather than accumulated across several — an agent that
 * reports eight pull requests in eight messages waits for the evidence, which
 * is the answer this skill trusts anyway.
 */

/** The two words the brief actually asks for, and the ways they get written. */
const VERDICT = '(?:approved?|request(?:s|ed|ing)?\\s+changes|changes\\s+requested)'

/**
 * `Verdict: approve`, as a declaration.
 *
 * Adjacent, so "I'll post my verdict once I know whether to approve" is not
 * one: what makes this a verdict is the word sitting where the decision goes.
 */
const DECLARED = new RegExp(`\\bverdicts?\\b\\s*(?:is|was)?\\s*[-–—:=]*\\s*${VERDICT}\\b`, 'i')

/**
 * A line that *is* a verdict: `#90: approve — <link>`, `approve`, a table row.
 *
 * Nothing may follow the word but separators and links, which is what keeps
 * "Approved the gh command and carried on reading" — a sentence that opens on
 * a verdict word and is plainly not one — out of the count.
 */
const LEADS = new RegExp(
  `^(?:(?:pr|pull\\s+request)\\s*)?(?:#?\\s*\\d+)?\\s*[-–—:=.,)\\]]*\\s*${VERDICT}\\s*(?:[-–—:=.,)\\]]|\\s|https?:\\/\\/\\S+)*$`,
  'i',
)

/** Both verdicts joined by "or" is a menu, not a decision. */
const EITHER_OR = new RegExp(`${VERDICT}\\s*,?\\s*(?:or|\\/)\\s*${VERDICT}`, 'i')

/**
 * A link to a comment somebody left — the artefact, not the pull request.
 *
 * The brief hands every reviewer the pull request's own URL, so a link to it
 * proves only that the agent can quote its instructions back.
 */
const COMMENT_LINK = /https?:\/\/[^\s)>\]]*#(?:issuecomment-|discussion_r|pullrequestreview-)\d+/i

/** Markdown taken off a line, so a bold verdict and a linked one read alike. */
const plain = (line) =>
  String(line)
    /* `[text](url)` reads as both: the number is in one and the comment in
       the other, and a report often puts a verdict between them. */
    .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '$1 $2')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/[*_`|]/g, ' ')
    .replace(/^\s*[>\-+•]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * @param {string} text                what the seat said in the room
 * @param {object} [asked]             what its brief closed by asking for
 * @param {boolean} [asked.rehearsal]  the one-line rehearsal, not a review
 * @param {Array}  [asked.prs]         the pull requests it was given
 * @param {string} [asked.report]      the file a branch review was told to write
 */
export const readsAsReport = (text, { rehearsal = false, prs = [], report = null } = {}) => {
  const lines = String(text ?? '').split('\n')
  if (rehearsal) return lines.some((line) => /\bready\b/i.test(plain(line)))

  const reports = (line) => {
    if (COMMENT_LINK.test(line)) return true
    if (report && line.includes(report)) return true
    const flat = plain(line)
    if (EITHER_OR.test(flat)) return false
    return DECLARED.test(flat) || LEADS.test(flat)
  }

  return lines.filter(reports).length >= Math.max(1, prs.length)
}
