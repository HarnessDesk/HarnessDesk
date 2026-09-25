import { execFile } from 'node:child_process'

import type { FindingSeries, FindingView, RepairPacket } from '@harnessdesk/protocol'

import { isSha } from '../evidence/records.js'
import { isResolved } from './model.js'

/**
 * A later review round's package: what the reviewer judges, and nothing it
 * should not see.
 *
 * It leads with the findings whose repair was claimed since the last review
 * and those still unresolved, then the exact delta between the revision that
 * review judged and the subject's committed head now, then the evidence the
 * review must still honour — requirement revisions, checks, CI. No
 * transcript, no resolved finding's body, no predecessor's prose.
 *
 * The delta is read from the subject's own checkout through git's argument
 * vector: two full object ids, never a revision expression; replacement
 * objects, external diff drivers and text conversion off; bounded in size
 * and time. What cannot be read in full is refused before any reviewer is
 * seated, never cut short.
 */

/** The largest delta a review is handed. Past it the change is split, not truncated. */
export const DELTA_LIMIT = 1024 * 1024
/** The most unresolved findings one packet carries. More stop at a person to split the work. */
export const PACKET_FINDINGS_LIMIT = 200

export const DELTA_REFUSED = 'The repair delta cannot be read in full. Split the change or restore its base revision.'
const HISTORY_CHANGED = 'History changed: the reviewed revision is not an ancestor of this head, so this is the difference between two trees, not a range of new commits.'

const GIT_TIMEOUT_MS = 20_000

/** One git command, by argument vector, in the subject's checkout: its output, or null for any refusal. */
const git = (cwd: string, args: readonly string[], limit = DELTA_LIMIT): Promise<{ readonly code: number; readonly out: string } | null> =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, '--no-replace-objects', '-c', 'core.quotePath=true', ...args], {
      timeout: GIT_TIMEOUT_MS,
      // One byte past the limit is how an oversize delta is told from one exactly at it.
      maxBuffer: limit + 1,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
    }, (error, stdout) => {
      if (error) {
        const code = (error as { code?: unknown }).code
        // A non-zero exit is an answer for `merge-base --is-ancestor`; a kill, a timeout or an overflow is not.
        resolve(typeof code === 'number' && !(error as { killed?: boolean }).killed ? { code, out: String(stdout) } : null)
        return
      }
      resolve({ code: 0, out: String(stdout) })
    })
  })

/**
 * The package for a later review of `series` at `to`. The owner supplies an
 * admitted project checkout (the series's) and the head it observed and
 * pinned; this refuses anything it cannot read in full.
 */
export async function repairPacket(input: {
  readonly run: string
  readonly round: number
  readonly series: FindingSeries
  readonly to: string
  readonly findings: readonly FindingView[]
  readonly evidence: readonly string[]
}): Promise<RepairPacket> {
  const unresolvedViews = input.findings.filter((one) => !isResolved(one))
  if (unresolvedViews.length > PACKET_FINDINGS_LIMIT) {
    throw new Error(`Split this review: ${unresolvedViews.length} findings are unresolved and one review carries at most ${PACKET_FINDINGS_LIMIT}.`)
  }
  const from = input.series.reviewedAt
  const cwd = input.series.checkout.cwd
  if (!from || !isSha(from) || !isSha(input.to)) throw new Error(DELTA_REFUSED)
  // Both tips must be commits this repository has, and the head must be what is checked out, clean.
  const [base, head, status, current] = await Promise.all([
    git(cwd, ['cat-file', '-e', `${from}^{commit}`]),
    git(cwd, ['cat-file', '-e', `${input.to}^{commit}`]),
    git(cwd, ['status', '--porcelain', '--untracked-files=no']),
    git(cwd, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']),
  ])
  if (base?.code !== 0 || head?.code !== 0 || status?.code !== 0 || current?.code !== 0) throw new Error(DELTA_REFUSED)
  if (status.out.trim() !== '' || current.out.trim() !== input.to) throw new Error(DELTA_REFUSED)
  const ancestry = await git(cwd, ['merge-base', '--is-ancestor', from, input.to])
  if (ancestry === null || (ancestry.code !== 0 && ancestry.code !== 1)) throw new Error(DELTA_REFUSED)
  const diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', from, input.to, '--'])
  if (diff?.code !== 0 || Buffer.byteLength(diff.out) > DELTA_LIMIT) throw new Error(DELTA_REFUSED)
  const claimed = unresolvedViews.filter((one) => one.lifecycle.state === 'repaired' && !one.lifecycle.confirmed)
  const rest = unresolvedViews.filter((one) => !claimed.includes(one))
  const ordered = [...claimed, ...rest]
  return {
    run: input.run,
    round: input.round,
    series: input.series.id,
    from,
    to: input.to,
    diff: diff.out,
    findings: ordered,
    claimed: claimed.map((one) => one.id),
    unresolved: ordered.map((one) => one.id),
    evidence: [...input.evidence],
    warning: ancestry.code === 1 ? HISTORY_CHANGED : null,
  }
}
