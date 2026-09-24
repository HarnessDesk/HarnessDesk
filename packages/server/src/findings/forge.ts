import { spawn } from 'node:child_process'

import type { FindingAnchor, FindingPost } from '@harnessdesk/protocol'

import { isSha } from '../evidence/records.js'
import {
  APPEND_JOIN, chainOf, PublicationConflict, segmentsOf, sha256, summaryCommentMarker,
  type FindingForgePort, type FindingSummaryForgePort, type ObservedTarget, type PublicationEntry,
  type SummaryReviewInput, type SummaryReviewLocation,
} from './publication.js'

/**
 * The host's own forge adapter for a closed round's batch.
 *
 * It reaches GitHub with the person's own `gh`, the way the rest of the desk
 * does, through an argument vector and never a shell: a body is JSON on
 * `gh api`'s standard input, so nothing an agent wrote is ever a word of a
 * command. Every call is bounded — thirty seconds, two megabytes of answer,
 * a hundred pages — and a read that hits a bound throws: a lookup that could
 * not finish is never "not found". Every location it answers with is the
 * forge's own comment id and address, checked to be exactly a comment on the
 * target pull request of the target repository, over HTTPS, with no user in
 * it; anything else is refused before the desk records it.
 */

/** One `gh` run: argument vector, optional standard input, bounded. */
export type GhApiRunner = (
  args: readonly string[],
  input: string | null,
  options: { readonly cwd: string; readonly timeoutMs: number; readonly maxBytes: number },
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly timedOut: boolean; readonly overflow: boolean }>

/** `gh` itself, spawned with no shell; `command` is where to find it. */
export const spawnGh = (command = 'gh'): GhApiRunner => (args, input, options) => new Promise((resolve) => {
  const child = spawn(command, [...args], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  const out: Buffer[] = []
  const err: Buffer[] = []
  let size = 0
  let errSize = 0
  let overflow = false
  let timedOut = false
  let settled = false
  const done = (exitCode: number | null, failure?: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve({
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: failure ?? Buffer.concat(err).toString('utf8'),
      exitCode, timedOut, overflow,
    })
  }
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, options.timeoutMs)
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > options.maxBytes) {
      overflow = true
      child.kill('SIGKILL')
      return
    }
    out.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    errSize += chunk.length
    if (errSize <= 64 * 1024) err.push(chunk)
  })
  child.on('error', (error) => done(null, error.message))
  child.on('close', (code) => done(code))
  child.stdin.on('error', () => {})
  child.stdin.end(input ?? '')
})

export interface GhFindingForgeOptions {
  readonly run?: GhApiRunner
  /** The forge's web host: pull request and comment addresses must be on it. */
  readonly host?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly maxPages?: number
}

const PER_PAGE = 100
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

interface GhComment {
  readonly id?: unknown
  readonly body?: unknown
  readonly html_url?: unknown
  readonly in_reply_to_id?: unknown
  readonly path?: unknown
  readonly commit_id?: unknown
}

interface GhReview {
  readonly id?: unknown
  readonly body?: unknown
  readonly html_url?: unknown
  readonly commit_id?: unknown
  readonly state?: unknown
}

export class GhFindingForge implements FindingForgePort, FindingSummaryForgePort {
  readonly #run: GhApiRunner
  readonly #host: string
  readonly #timeoutMs: number
  readonly #maxBytes: number
  readonly #maxPages: number
  /** Where each target was observed from, so every later call runs in the canonical project. */
  readonly #projects = new Map<string, string>()

  constructor(options: GhFindingForgeOptions = {}) {
    this.#run = options.run ?? spawnGh()
    this.#host = options.host ?? 'github.com'
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    this.#maxPages = options.maxPages ?? 100
  }

  async #gh(cwd: string, args: readonly string[], input: string | null = null): Promise<unknown> {
    const result = await this.#run(args, input, { cwd, timeoutMs: this.#timeoutMs, maxBytes: this.#maxBytes })
    if (result.timedOut) throw new Error(`the forge did not answer within ${Math.round(this.#timeoutMs / 1000)} seconds`)
    if (result.overflow) throw new Error(`the forge answered with more than ${Math.round(this.#maxBytes / 1024 / 1024)} MiB`)
    if (result.exitCode !== 0) throw new Error((`${result.stderr}\n${result.stdout}`.trim().split('\n').find((line) => line.trim() !== '') ?? 'gh could not answer').slice(0, 500))
    try {
      return JSON.parse(result.stdout) as unknown
    } catch {
      throw new Error('the forge answered with something that is not JSON')
    }
  }

  #api(operation: PublicationEntry, method: 'GET' | 'POST' | 'PATCH', path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!REPO.test(operation.repo)) throw new Error('This repository name cannot be used in a forge address.')
    const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path, ...(body ? ['--input', '-'] : [])]
    return this.#gh(this.#projects.get(`${operation.repo}#${operation.pr}`) ?? operation.project, args, body ? JSON.stringify(body) : null)
  }

  /** Every page of a list, or a throw: never a short list read as the whole. */
  async #pages(operation: PublicationEntry, path: string): Promise<readonly GhComment[]> {
    const all: GhComment[] = []
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const answer = await this.#api(operation, 'GET', `${path}?per_page=${PER_PAGE}&page=${page}`)
      if (!Array.isArray(answer)) throw new Error('the forge answered a list with something else')
      all.push(...(answer as GhComment[]))
      if (answer.length < PER_PAGE) return all
    }
    throw new Error(`the pull request has more than ${this.#maxPages} pages of comments, so the desk could not read them all`)
  }

  /** A call about one pull request that no single publication operation names: a round's review. */
  #target(input: Pick<SummaryReviewInput, 'repo' | 'pr' | 'project'>, method: 'GET' | 'POST', path: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!REPO.test(input.repo) || !Number.isSafeInteger(input.pr) || input.pr < 1) throw new Error('This pull request cannot be used in a forge address.')
    const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', path, ...(body ? ['--input', '-'] : [])]
    return this.#gh(this.#projects.get(`${input.repo}#${input.pr}`) ?? input.project, args, body ? JSON.stringify(body) : null)
  }

  async #targetPages<T>(input: SummaryReviewInput, path: string): Promise<readonly T[]> {
    const all: T[] = []
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const answer = await this.#target(input, 'GET', `${path}?per_page=${PER_PAGE}&page=${page}`)
      if (!Array.isArray(answer)) throw new Error('the forge answered a list with something else')
      all.push(...(answer as T[]))
      if (answer.length < PER_PAGE) return all
    }
    throw new Error(`the pull request has more than ${this.#maxPages} pages, so the desk could not read them all`)
  }

  /** A review's address and its inline comments', confined to the target and matched to the findings they carry. */
  async #reviewLocation(input: SummaryReviewInput, review: GhReview): Promise<SummaryReviewLocation> {
    const id = review.id
    if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof review.html_url !== 'string') throw new Error('the forge answered without the review’s id or address')
    let url: URL
    try {
      url = new URL(review.html_url)
    } catch {
      throw new Error('the forge answered with a review address it cannot read')
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.host !== this.#host || url.port !== '' ||
      url.search !== '' || url.pathname !== `/${input.repo}/pull/${input.pr}` || url.hash !== `#pullrequestreview-${id as number}`) {
      throw new Error('The forge answered with a review address outside this pull request, so it was not recorded.')
    }
    const comments = await this.#targetPages<GhComment>(input, `repos/${input.repo}/pulls/${input.pr}/reviews/${id as number}/comments`)
    const out: { finding: string; id: string; url: string }[] = []
    for (const wanted of input.comments) {
      const marker = summaryCommentMarker(input.key, wanted.finding)
      const matches = comments.filter((one) => typeof one.body === 'string' && one.body.split('\n')[0] === marker && one.body === wanted.body)
      if (matches.length !== 1) throw new Error('The review’s inline comments do not match what was sent, so it was not recorded.')
      const location = this.#location({ key: input.key, repo: input.repo, pr: input.pr } as PublicationEntry, matches[0]!, 'review-comment')
      if (!location) throw new Error('The forge answered with a comment address outside this pull request, so it was not recorded.')
      out.push({ finding: wanted.finding, id: String(location.comment), url: location.url })
    }
    return { id: String(id), url: url.href, comments: out }
  }

  /**
   * Posts a closed round as one `COMMENT` review pinned to the head it
   * reviewed, its inline comments in the same review: never an approval, and
   * never two requests for one round.
   */
  async publishSummary(input: SummaryReviewInput): Promise<SummaryReviewLocation> {
    if (!isSha(input.head)) throw new Error('A review is pinned to a full commit id.')
    const answer = await this.#target(input, 'POST', `repos/${input.repo}/pulls/${input.pr}/reviews`, {
      commit_id: input.head, event: 'COMMENT', body: input.body,
      comments: input.comments.map((one) => ({ path: one.path, line: one.line, side: one.side, body: one.body })),
    }) as GhReview
    return this.#reviewLocation(input, answer)
  }

  /** Every exact copy of a round's review the pull request holds: its marker, its body and its head. */
  async reconcileSummary(input: SummaryReviewInput): Promise<readonly SummaryReviewLocation[]> {
    const marker = `<!-- harnessdesk:finding-op ${input.key} -->`
    const reviews = await this.#targetPages<GhReview>(input, `repos/${input.repo}/pulls/${input.pr}/reviews`)
    const exact = reviews.filter((one) => typeof one.body === 'string' && one.body.split('\n')[0] === marker &&
      sha256(one.body) === sha256(input.body) && one.commit_id === input.head)
    const out: SummaryReviewLocation[] = []
    for (const review of exact) out.push(await this.#reviewLocation(input, review))
    return out
  }

  /** The forge's own location for a comment, confined to the target; null when it is anything else. */
  #location(operation: PublicationEntry, comment: GhComment, kind: FindingPost['kind']): FindingPost | null {
    const id = comment.id
    if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof comment.html_url !== 'string') return null
    let url: URL
    try {
      url = new URL(comment.html_url)
    } catch {
      return null
    }
    const fragment = kind === 'issue-comment' ? `#issuecomment-${id as number}` : `#discussion_r${id as number}`
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.host !== this.#host || url.port !== '' ||
      url.search !== '' || url.pathname !== `/${operation.repo}/pull/${operation.pr}` || url.hash !== fragment) return null
    return { repo: operation.repo, pr: operation.pr, comment: id as number, kind, url: url.href, operation: operation.key }
  }

  #confined(operation: PublicationEntry, comment: GhComment, kind: FindingPost['kind']): FindingPost {
    const location = this.#location(operation, comment, kind)
    if (!location) throw new Error('The forge answered with a comment address outside this pull request, so it was not recorded.')
    return location
  }

  async observeTarget(project: string, pr: number): Promise<ObservedTarget> {
    const answer = await this.#gh(project, ['pr', 'view', String(pr), '--json', 'number,state,headRefOid,url']) as {
      number?: unknown; state?: unknown; headRefOid?: unknown; url?: unknown
    }
    const state = typeof answer?.state === 'string' ? ({ OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const)[answer.state.toUpperCase() as 'OPEN'] : undefined
    const head = typeof answer?.headRefOid === 'string' ? answer.headRefOid.toLowerCase() : ''
    if (answer?.number !== pr || !state || !isSha(head) || typeof answer.url !== 'string') {
      throw new Error('the forge answered without this pull request’s number, state or head')
    }
    let url: URL
    try {
      url = new URL(answer.url)
    } catch {
      throw new Error('the forge answered with a pull request address it cannot read')
    }
    const path = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(url.pathname)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.host !== this.#host || url.port !== '' ||
      url.search !== '' || url.hash !== '' || !path || Number(path[2]) !== pr) {
      throw new Error('the forge answered with a pull request address outside this repository')
    }
    this.#projects.set(`${path[1]!}#${pr}`, project)
    return { repo: path[1]!, number: pr, head, state }
  }

  async anchorable(operation: PublicationEntry, anchor: FindingAnchor): Promise<boolean> {
    const files = await this.#pages(operation, `repos/${operation.repo}/pulls/${operation.pr}/files`) as readonly { filename?: unknown; patch?: unknown }[]
    const file = files.find((one) => one.filename === anchor.path)
    if (!file || typeof file.patch !== 'string') return false
    return linesOf(file.patch, anchor.side).has(anchor.line)
  }

  async find(operation: PublicationEntry): Promise<readonly FindingPost[]> {
    switch (operation.placement) {
      case 'general': {
        const comments = await this.#pages(operation, `repos/${operation.repo}/issues/${operation.pr}/comments`)
        return comments
          .filter((one) => typeof one.body === 'string' && one.body.split('\n')[0] === operation.marker && sha256(one.body) === operation.digest)
          .map((one) => this.#confined(operation, one, 'issue-comment'))
      }
      case 'inline':
      case 'reply': {
        const parent = 'parent' in operation ? operation.parent : null
        const comments = await this.#pages(operation, `repos/${operation.repo}/pulls/${operation.pr}/comments`)
        return comments
          .filter((one) => typeof one.body === 'string' && one.body.split('\n')[0] === operation.marker && sha256(one.body) === operation.digest &&
            (operation.placement === 'inline' || one.in_reply_to_id === parent?.comment))
          .map((one) => this.#confined(operation, one, 'review-comment'))
      }
      case 'append': {
        const parent = 'parent' in operation ? operation.parent : null
        if (!parent || !operation.wrote) throw new Error('This appended section has no comment to read back.')
        const comment = await this.#api(operation, 'GET', `repos/${operation.repo}/issues/comments/${parent.comment}`) as GhComment
        if (typeof comment?.body !== 'string') throw new Error('the forge answered without the comment’s text')
        const segments = segmentsOf(comment.body)
        const last = segments.at(-1) ?? ''
        const here = last.split('\n')[0] === operation.marker && sha256(last) === operation.digest && chainOf(segments) === operation.wrote
        return here ? [this.#confined(operation, comment, 'issue-comment')] : []
      }
      default:
        throw new Error('This publication was never placed, so there is nothing to read back.')
    }
  }

  async send(operation: PublicationEntry, body: string, anchor: FindingAnchor | null): Promise<FindingPost> {
    if (sha256(body) !== operation.digest) throw new Error('This body is not the one its operation fixed.')
    const parent = 'parent' in operation ? operation.parent : null
    switch (operation.placement) {
      case 'general': {
        const answer = await this.#api(operation, 'POST', `repos/${operation.repo}/issues/${operation.pr}/comments`, { body }) as GhComment
        return this.#confined(operation, answer, 'issue-comment')
      }
      case 'inline': {
        if (!anchor) throw new Error('An inline comment needs its validated anchor.')
        const answer = await this.#api(operation, 'POST', `repos/${operation.repo}/pulls/${operation.pr}/comments`, {
          body, commit_id: operation.at, path: anchor.path, line: anchor.line, side: anchor.side,
        }) as GhComment
        return this.#confined(operation, answer, 'review-comment')
      }
      case 'reply': {
        if (!parent || parent.kind !== 'review-comment') throw new Error('A reply needs the review comment it answers.')
        const answer = await this.#api(operation, 'POST', `repos/${operation.repo}/pulls/${operation.pr}/comments/${parent.comment}/replies`, { body }) as GhComment
        return this.#confined(operation, answer, 'review-comment')
      }
      case 'append': {
        if (!parent || parent.kind !== 'issue-comment' || !operation.expected) throw new Error('An appended section needs the comment it extends and what the desk last wrote there.')
        const current = await this.#api(operation, 'GET', `repos/${operation.repo}/issues/comments/${parent.comment}`) as GhComment
        if (typeof current?.body !== 'string') throw new Error('the forge answered without the comment’s text')
        if (chainOf(segmentsOf(current.body)) !== operation.expected) {
          throw new PublicationConflict('Someone changed this finding’s comment on the pull request since the desk last wrote it, so it was left as it is. A person has to look at it.')
        }
        this.#confined(operation, current, 'issue-comment')
        const answer = await this.#api(operation, 'PATCH', `repos/${operation.repo}/issues/comments/${parent.comment}`, { body: `${current.body}${APPEND_JOIN}${body}` }) as GhComment
        return this.#confined(operation, answer, 'issue-comment')
      }
      default:
        throw new Error('This publication was never placed, so it was not sent.')
    }
  }
}

/** The lines a unified diff's hunks show on one side: a comment may sit on any of them. */
export const linesOf = (patch: string, side: FindingAnchor['side']): ReadonlySet<number> => {
  const lines = new Set<number>()
  let left = 0
  let right = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      left = Number(hunk[1])
      right = Number(hunk[2])
      continue
    }
    if (left === 0 && right === 0) continue
    if (line.startsWith('+')) {
      if (side === 'RIGHT') lines.add(right)
      right += 1
    } else if (line.startsWith('-')) {
      if (side === 'LEFT') lines.add(left)
      left += 1
    } else if (line.startsWith(' ')) {
      lines.add(side === 'RIGHT' ? right : left)
      left += 1
      right += 1
    }
  }
  return lines
}
