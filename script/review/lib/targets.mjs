/**
 * What is being reviewed, and how anyone can check afterwards that it was.
 *
 * Everything here goes through `gh` and `git` rather than through a
 * remembered repository name: the skill is called from whatever folder the
 * person is standing in, and "all the pull requests" means all of that
 * folder's, on that folder's remote.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const gh = async (args, cwd) => {
  try {
    const { stdout } = await run('gh', args, { cwd, maxBuffer: 1 << 24 })
    return stdout
  } catch (error) {
    const said = String(error.stderr ?? error.message).trim().split('\n')[0]
    throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${said}`)
  }
}

export const repoRoot = async (cwd) => {
  const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd })
  return stdout.trim()
}

export const currentBranch = async (cwd) => {
  const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  return stdout.trim()
}

/** `owner/name` for the checkout's own remote. */
export const repoSlug = async (cwd) => JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'], cwd)).nameWithOwner

/** The repository's default branch, which is what a branch review is measured against. */
export const defaultBranch = async (cwd) =>
  JSON.parse(await gh(['repo', 'view', '--json', 'defaultBranchRef'], cwd)).defaultBranchRef.name

/**
 * The name a diff can actually be taken against here.
 *
 * A worktree is often cut without the default branch ever being checked out
 * in it, so `main` names nothing and `git diff main...HEAD` fails — leaving
 * the reviewer holding an instruction that does not run. `origin/main` is the
 * fallback, and when neither resolves the caller is told rather than handed a
 * broken command to pass on.
 */
export const baseRef = async (cwd, base) => {
  for (const name of [base, `origin/${base}`]) {
    const ok = await run('git', ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd })
      .then(() => true)
      .catch(() => false)
    if (ok) return name
  }
  throw new Error(`neither ${base} nor origin/${base} resolves in ${cwd}`)
}

const asPr = (row, slug) => ({
  kind: 'pr',
  number: row.number,
  title: row.title,
  url: row.url,
  draft: Boolean(row.isDraft),
  branch: row.headRefName ?? null,
  slug: /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(row.url)?.[1] ?? slug,
})

export const openPrs = async (cwd) => {
  const slug = await repoSlug(cwd)
  const rows = JSON.parse(
    await gh(
      ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,url,isDraft,headRefName'],
      cwd,
    ),
  )
  return rows.map((row) => asPr(row, slug))
}

/** One pull request, named by URL, by `#12`, or by a bare number. */
export const onePr = async (name, cwd) => {
  const slug = await repoSlug(cwd)
  const row = JSON.parse(
    await gh(['pr', 'view', name, '--json', 'number,title,url,isDraft,headRefName'], cwd),
  )
  return asPr(row, slug)
}

/** The pull request open on this branch, or null when there is none. */
export const prForBranch = async (cwd) => {
  try {
    return await onePr(await currentBranch(cwd), cwd)
  } catch {
    return null
  }
}

/**
 * The targets named on the command line, resolved against this checkout.
 *
 * `all` is every open pull request the folder's remote has, drafts included —
 * the word means what it says, and a draft is exactly the kind of thing worth
 * three opinions before it stops being one.
 */
export const resolveTargets = async (args, cwd) => {
  const named = args.filter((arg) => !arg.startsWith('-'))
  if (named.some((arg) => arg.toLowerCase() === 'all')) {
    const all = await openPrs(cwd)
    if (all.length === 0) throw new Error('no open pull requests on this repository')
    return { mode: 'all', prs: all }
  }
  if (named.length > 0) {
    const prs = []
    for (const name of named) prs.push(await onePr(name, cwd))
    return { mode: 'named', prs }
  }
  const mine = await prForBranch(cwd)
  if (mine) return { mode: 'branch-pr', prs: [mine] }
  const branch = await currentBranch(cwd)
  const base = await baseRef(cwd, await defaultBranch(cwd).catch(() => 'main'))
  if (branch === base) {
    throw new Error(
      `nothing to review: ${cwd} is on ${branch} with no pull request. Name one, or say "all".`,
    )
  }
  return { mode: 'branch', prs: [], branch: { name: branch, base } }
}

/**
 * The comments a pull request has carried since a given moment.
 *
 * The `since` is not decoration. A pull request can be reviewed twice, and
 * "does a comment with this signature exist" is a check that cannot fail on
 * the second round — the first round's comments answer it, and the run reports
 * a success it did not have. It is asked of the API as well as of the result:
 * the wait re-reads this every minute, and `since` there filters on
 * `updated_at`, which is never earlier than `created_at` — so it drops pages
 * of history without being able to drop a comment this run is waiting for.
 */
export const commentsOn = async (pr, since, cwd) =>
  commentsIn(
    await gh(
      [
        'api',
        `repos/${pr.slug}/issues/${pr.number}/comments?since=${encodeURIComponent(since)}`,
        '--paginate',
        '--jq',
        `.[] | select(.created_at >= "${since}") | {id, url: .html_url, at: .created_at, by: .user.login, body}`,
      ],
      cwd,
    ),
    `#${pr.number}`,
  )

/**
 * What `gh --jq` printed, as comments.
 *
 * One per line: each result is compact JSON, so a body full of newlines
 * arrives with them escaped inside its string. A line that will not parse is
 * raised rather than skipped, because a dropped comment is a reviewer this
 * file goes on to call missing — and pulled out of the `gh` call so that the
 * parsing can be held to it without a network.
 */
export const commentsIn = (out, where = 'this pull request') =>
  String(out)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`could not read a comment on ${where} as JSON: ${line.slice(0, 160)}`)
      }
    })

/** The first line a comment actually has, blank lines and indenting aside. */
const opening = (comment) =>
  String(comment.body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''

/**
 * Which comment each reviewer wrote — at most one each, and never one comment
 * answering for two.
 *
 * This is what the file is for, and it has been wrong twice.
 *
 * It used to filter a list of *marks* against every comment body joined into
 * one string. A mark is per reviewer and `filter` is per mark, so three Cursor
 * seats sharing a mark all matched one Cursor comment: on 2026-09-07 that
 * ended the wait on PR #77 four minutes after the hand-out with one review
 * posted and two still being written, printed `3/3 signed` and `missing:
 * none`, and exited 0.
 *
 * Matching reviewers to comments fixed the counting and left a second way to
 * be answered for by somebody else's writing, which the review of that fix
 * found: **a signature in a comment is not the same as a comment being
 * signed.** Where one reviewer posts twice and quotes another's line, a
 * maximum matching is delighted to give the quoting comment to the reviewer
 * being quoted — who posted nothing — and the run goes green with a reviewer
 * missing all over again.
 *
 * So a comment belongs to whoever signed **its first line**, which is what the
 * brief asks each reviewer for and what a quote is never on. Signatures first,
 * because those tell seats on one agent apart; then marks, which still catch a
 * reviewer that reformatted the tail of its own line; and only a comment whose
 * opening names nobody is open to a *signature* found deeper in it, so a model
 * that wrote a sentence before signing is still counted while prose that merely
 * names a reviewer is not. **N seats need N distinct comments**, and each of
 * them must be signed at the top.
 *
 * One narrowing this does not reach: a comment that signs nobody at its own top
 * and quotes a whole signature can still answer for the reviewer it quotes, if
 * that reviewer posted nothing. It takes a quotation of the exact bold line
 * inside a comment that did not sign itself, which no reviewer here has
 * written — so it is recorded rather than guarded, and `how: "body"` is what
 * marks such a match for anyone reading the evidence.
 *
 * Pure, and separate from the `gh` call above, so it can be held to that.
 */
export const attribute = (members, comments) => {
  const carries = (text, needle) => Boolean(needle) && text.includes(needle)
  const heads = comments.map(opening)
  const bodies = comments.map((comment) => String(comment.body ?? ''))
  const edgesBy = (from, needle) =>
    members.map((member) => from.flatMap((text, at) => (carries(text, needle(member)) ? [at] : [])))

  const signed = edgesBy(heads, (member) => member.signature)
  /* The mark is a substring of the signature, so this is normally a superset
     already — unioned anyway, because "normally" is not a property, and a
     member that lost an edge here would be reported missing. */
  const marked = edgesBy(heads, (member) => member.mark)
  /* A comment nobody signed at the top: a model that wrote a sentence before
     signing. Open to a match found deeper in it — and only these are, which is
     what keeps a quotation from answering for the reviewer it quotes.

     The *signature* here, never the mark. A mark is ordinary prose: a round's
     own write-up of who reviewed and what changed says "Review by Cursor
     2026.09.02 · Claude Opus 4.6 · Max effort approved with two findings", and
     against the mark that sentence counted as that reviewer's review — one is
     sitting on PR #77 right now. The signature is the finished line the desk
     hands over, bold and tailed, and nobody writes it in passing. */
  const anonymous = new Set(
    comments.map((_, at) => at).filter((at) => !members.some((member) => carries(heads[at], member.mark))),
  )
  const deep = edgesBy(bodies, (member) => member.signature).map((edges) =>
    edges.filter((at) => anonymous.has(at)),
  )

  const union = (...lists) => members.map((_, index) => [...new Set(lists.flatMap((list) => list[index]))])
  const rounds = [signed, union(signed, marked), union(signed, marked, deep)]

  const owner = new Array(comments.length).fill(-1)
  const took = new Array(members.length).fill(-1)
  /* Kuhn's augmenting path, free comments first. Taking an unclaimed comment
     before trying to move somebody along is not just tidier: displacing a
     member that matched its own signature, when a comment nobody wanted was
     sitting right there, demotes a true attribution to a looser one for no
     gain in the count. */
  const walk = (member, edges, seen) => {
    for (const at of edges[member]) {
      if (seen.has(at) || owner[at] !== -1) continue
      seen.add(at)
      owner[at] = member
      took[member] = at
      return true
    }
    for (const at of edges[member]) {
      if (seen.has(at)) continue
      seen.add(at)
      if (walk(owner[at], edges, seen)) {
        owner[at] = member
        took[member] = at
        return true
      }
    }
    return false
  }
  for (const round of rounds) {
    for (let member = 0; member < members.length; member += 1) {
      if (took[member] === -1) walk(member, round, new Set())
    }
  }

  return members.map((member, index) => {
    const at = took[index]
    if (at === -1) return null
    /* `how` is read back off the pair that was actually made rather than
       carried through the matching: an augmenting path can move a member from
       one comment to another, and a note about which line it signed with has
       to be true of the comment it ended up with. */
    const { body: _body, ...where } = comments[at]
    const how = carries(heads[at], member.signature)
      ? 'signature'
      : carries(heads[at], member.mark)
        ? 'mark'
        : 'body'
    return { ...where, how }
  })
}

/** Who signed what on one pull request, aligned with `members`. */
export const attributionOn = async (pr, since, members, cwd) =>
  attribute(members, await commentsOn(pr, since, cwd))

/** The diff a branch review reads, for the plan's own record. */
export const branchStat = async (cwd, base) => {
  const { stdout } = await run('git', ['diff', '--stat', `${base}...HEAD`], { cwd, maxBuffer: 1 << 24 })
  return stdout.trim().split('\n').slice(-1)[0] ?? ''
}

export const hasGh = async () => run('gh', ['--version']).then(() => true).catch(() => false)
