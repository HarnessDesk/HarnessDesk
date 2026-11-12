import { createHash } from 'node:crypto'

import type { TriggerAction, TriggerCheck, TriggerFact, TriggerReview, TriggerSource } from '@harnessdesk/protocol'

import { spawnGh, type GhApiRunner } from '../findings/forge.js'
import { isDeskPost, summonsOf } from '../findings/publication.js'
import { labelName } from './definition.js'
import { eventKey } from './keys.js'
import { factOf } from './store.js'

/**
 * The forge, read for intake: new pull requests and changed heads, and issue
 * activity, with the person's own `gh` sign-in — never an agent's, and never
 * a poller that spends inference.
 *
 * Everything the forge answers is untrusted. Reads are only fixed
 * `gh api --method GET` endpoints assembled from the repository the arm was
 * bound to and validated integers; a `Link` header or an address inside a
 * payload is never followed, and pagination is the desk's own page numbers.
 * Every read is bounded — 100 items a page, 10 pages a list, 4 MiB an answer,
 * 30 seconds a source's whole read — and a read that hits a bound is a gap,
 * never "nothing changed". What survives is the fixed set of fields a
 * `TriggerFact` has: ids, commit ids and times validated, the repository the
 * arm bound (never one a payload names), an address confined to that
 * repository or nothing, and titles, bodies and comments as clipped prose.
 * Raw answers are dropped once read.
 *
 * github.com is the first adapter, not a promise that any remote URL can be
 * fetched: a project on another host is refused by name.
 */

export interface SourceCursor {
  readonly version: 1
  readonly source: TriggerSource
  /** `owner/name` as bound when the source was first read; null for a schedule. */
  readonly repository: string | null
  /** When the source was first read: nothing that happened before it fires. */
  readonly baseline: number
  /** The newest forge update covered by a complete read. Only a complete read moves it. */
  readonly observedThrough: number
  /** Why the last read could not cover everything — a gap a person resumes past — or null. */
  readonly continuation: string | null
  /** Per pull request its last head; per issue its highest event and comment ids; per schedule its last slot. */
  readonly subjects: Readonly<Record<string, { readonly head: string | null; readonly event: string }>>
  /** Optional in version 1: bounded, normalized work deferred by the per-PR request budget. */
  readonly pulls?: Readonly<Record<string, PullWatchState>>
  /** The next watched PR, so a source deadline cannot starve later PRs. */
  readonly pullNext?: number
  /**
   * Optional in version 1: what the `@harnessdesk` request read has handled
   * inside its overlap window, so reading that window again never asks twice.
   */
  readonly requests?: RequestCoverage
}

/**
 * The request read's coverage. It reads by time from the source's own
 * `observedThrough` (less the overlap), so it keeps no per-pull-request mark
 * that could be forgotten: only what it handled since that window opened,
 * each by the time it was read under — `c<id>` a conversation comment by its
 * update, `r<id>` a review by its submission, `p<n>` a pull request whose
 * reviews were read at that update. Older entries fall out of the window and
 * are dropped; more than the window may hold is a gap, never a forgotten mark.
 */
export interface RequestCoverage { readonly seen: Readonly<Record<string, number>> }

/** Closed parser for the optional request coverage; older cursors omit it. */
export const requestCoverageOf = (value: unknown): RequestCoverage | null => {
  if (!isMap(value) || Object.keys(value).length !== 1 || !isMap(value['seen'])) return null
  const entries = Object.entries(value['seen'])
  if (entries.length > SEEN_LIMIT) return null
  for (const [key, at] of entries) {
    if (!/^[cpr][1-9][0-9]{0,15}$/.test(key) || !Number.isSafeInteger(at) || (at as number) < 0) return null
  }
  return { seen: Object.fromEntries(entries) as Record<string, number> }
}

/**
 * What a poll reads for `@harnessdesk` requests, present only when an arm on
 * the source names `mentioned`: `permissions` when one of those lets
 * collaborators ask, so a command comment's author is asked about once.
 */
export interface RequestReading { readonly permissions: boolean }

/** Omit number for every open PR; explicit numbers also observe closed/merged PRs. */
export interface PullWatch {
  readonly number?: number
  readonly checks: boolean
  readonly reviews: boolean
  /** The interest’s own arming/ownership baseline; defaults to the source baseline. */
  readonly since?: number
}

interface CheckCounts { readonly total: number; readonly failed: number; readonly pending: number; readonly failureAt?: number }
interface PendingReview {
  readonly id: number
  readonly account: number
  readonly login: string
  readonly at: number
  readonly state: TriggerReview['state']
}
export interface PullWatchState {
  readonly head: string
  readonly phase: 'checks' | 'statuses' | 'reviews' | 'authors' | 'body'
  readonly page: number
  readonly counts: CheckCounts
  readonly pending: readonly PendingReview[]
  readonly aggregate?: string
  readonly idle?: { readonly interval: number; readonly next: number; readonly updated: number; readonly interest: string; readonly aggregate: string }
  readonly nonWriters?: readonly number[]
  readonly more: boolean
  readonly failed: boolean
  /** Shared across arms by design: one review event per head. */
  readonly reviewed: boolean
}

/** Closed parser for optional version-1 watch metadata; older cursors omit it. */
export const pullStatesOf = (value: unknown): Record<string, PullWatchState> | null => {
  if (!isMap(value) || Object.keys(value).length > FACT_LIMIT || Buffer.byteLength(JSON.stringify(value), 'utf8') > BATCH_BYTES) return null
  const parsed: Record<string, PullWatchState> = {}
  let pendingCount = 0
  for (const [number, entry] of Object.entries(value)) {
    if (!/^[1-9][0-9]{0,15}$/.test(number) || !Number.isSafeInteger(Number(number)) || !isMap(entry) || !SHA.test(String(entry['head'])) ||
      !['checks', 'statuses', 'reviews', 'authors', 'body'].includes(String(entry['phase'])) || !Number.isSafeInteger(entry['page']) ||
      (entry['page'] as number) < 1 || (entry['page'] as number) > 10 || !isMap(entry['counts']) ||
      !Array.isArray(entry['pending']) || entry['pending'].length > PER_PAGE ||
      typeof entry['more'] !== 'boolean' || typeof entry['failed'] !== 'boolean' || typeof entry['reviewed'] !== 'boolean') return null
    if (entry['nonWriters'] !== undefined && (!Array.isArray(entry['nonWriters']) || entry['nonWriters'].length > NON_WRITER_LIMIT ||
      entry['nonWriters'].some((id: unknown) => !Number.isSafeInteger(id) || (id as number) < 1) || new Set(entry['nonWriters']).size !== entry['nonWriters'].length)) return null
    if (entry['aggregate'] !== undefined && (typeof entry['aggregate'] !== 'string' || entry['aggregate'].length > 120)) return null
    const idle = entry['idle']
    if (idle !== undefined && (!isMap(idle) || !Number.isSafeInteger(idle['interval']) || (idle['interval'] as number) < WATCH_INTERVAL || (idle['interval'] as number) > WATCH_MAX_INTERVAL ||
      !Number.isSafeInteger(idle['next']) || (idle['next'] as number) < 0 || !Number.isSafeInteger(idle['updated']) || (idle['updated'] as number) < 0 ||
      typeof idle['interest'] !== 'string' || idle['interest'].length > 120 || typeof idle['aggregate'] !== 'string' || idle['aggregate'].length > 120)) return null
    const counts = entry['counts']
    for (const field of ['total', 'failed', 'pending']) {
      if (!Number.isSafeInteger(counts[field]) || (counts[field] as number) < 0 || (counts[field] as number) > 2000) return null
    }
    if (counts['failureAt'] !== undefined && (!Number.isSafeInteger(counts['failureAt']) || (counts['failureAt'] as number) < 0)) return null
    if ((counts['failed'] as number) + (counts['pending'] as number) > (counts['total'] as number)) return null
    const pending: PendingReview[] = []
    for (const raw of entry['pending']) {
      if (!isMap(raw) || typeof raw['login'] !== 'string' || !LOGIN.test(raw['login'])) return null
      // Read old version-1 cursors, but discard their unverified prose immediately.
      const old = raw['fact'] === undefined ? null : factOf(raw['fact'])
      if (raw['fact'] !== undefined && (!old || old.action !== 'review-commented' || old.subject !== number || old.head !== entry['head'] || old.author !== accountDigest(raw['id'] as number))) return null
      const candidate = { id: old?.review?.id ?? raw['id'], account: old ? raw['id'] : raw['account'], login: raw['login'], at: old?.at ?? raw['at'], state: old?.review?.state ?? raw['state'] }
      if (!Number.isSafeInteger(candidate.id) || (candidate.id as number) < 1 || !Number.isSafeInteger(candidate.account) || (candidate.account as number) < 1 ||
        !Number.isSafeInteger(candidate.at) || (candidate.at as number) < 0 || !['commented', 'changes-requested', 'approved'].includes(String(candidate.state))) return null
      pending.push(candidate as PendingReview)
    }
    pendingCount += pending.length
    if (pendingCount > PENDING_LIMIT) return null
    parsed[number] = { ...entry, pending } as unknown as PullWatchState
  }
  return parsed
}

/** A current lifecycle read, kept separate from the two opt-in trigger events. */
export interface PullObservation {
  readonly repository: string
  readonly number: number
  readonly head: string
  readonly state: 'open' | 'merged' | 'closed'
  readonly check: TriggerCheck | null
  readonly at: number
}

export interface PollBatch {
  readonly facts: readonly TriggerFact[]
  readonly observations?: readonly PullObservation[]
  readonly next: SourceCursor
  readonly complete: boolean
  readonly problem: string | null
  /** What was seen and deliberately not offered, with why: a stranger's head, a missed slot. */
  readonly skipped: readonly { readonly trigger: string | null; readonly subject: string; readonly reason: string; readonly count: number }[]
}

export type ForgeFailure = 'offline' | 'rate-limited' | 'signed-out' | 'unreadable'

/** A read that failed, by kind only: no command, environment, token or raw answer is carried. */
export class ForgeReadError extends Error {
  readonly kind: ForgeFailure
  /** The forge answered that the thing asked about is not there (HTTP 404): an answer, not a failed read. */
  readonly notFound: boolean
  /** The read ran out of its own time budget: the forge was slow, not necessarily down. */
  readonly budget: boolean
  constructor(kind: ForgeFailure, message: string, notFound = false, budget = false) {
    super(message)
    this.kind = kind
    this.notFound = notFound
    this.budget = budget
    this.name = 'ForgeReadError'
  }
}

const outOfTime = (): ForgeReadError => new ForgeReadError('offline', 'The forge did not answer in time.', false, true)

export const UNREADABLE = 'The forge answered with something the desk cannot read.'
const unreadable = (): ForgeReadError => new ForgeReadError('unreadable', UNREADABLE)

const PER_PAGE = 100
const OVERLAP_MS = 5 * 60_000
const TITLE_LIMIT = 4096
const BODY_LIMIT = 16384
const FACT_LIMIT = 1000
const WATCH_INTERVAL = 30_000
const WATCH_MAX_INTERVAL = 10 * 60_000
const NON_WRITER_LIMIT = 100
const PENDING_LIMIT = 1000
class PullWatchOverflow extends ForgeReadError {
  constructor(message: string) { super('unreadable', message) }
}

/** More pull requests named by request comments than one read may look up. */
class RequestBurst extends Error {}

const BATCH_BYTES = 2 * 1024 * 1024
const ISSUE_LIMIT = 100
const SUBJECT_LIMIT = 5000
/** What the request read may hold as handled inside one overlap window; more is a gap. */
const SEEN_LIMIT = 2000
const CLIPPED = '\n[clipped by HarnessDesk]'
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** A forge login as the permission read may spell it into a path: letters, digits and single dashes, or an app's `name[bot]`. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/
const WRITES = new Set(['admin', 'maintain', 'write'])

/**
 * An opaque digest of the forge and a numeric account id: what an arm binds
 * for the signed-in account, and what a comment's author is compared by —
 * never a login, an address or a display name.
 */
export const accountDigest = (id: number): string => createHash('sha256').update(JSON.stringify(['github.com', id])).digest('hex')
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validRepo = (name: unknown): name is string =>
  typeof name === 'string' && name.length <= 200 && REPO.test(name) && !name.split('/').some((part) => part === '.' || part === '..')

/**
 * The fixed-field reader of one pull request. The adapter separately checks
 * `baseRepo` against the arm, and validates the optional body and address; no
 * external property survives it.
 */
export function readPullFact(raw: unknown): {
  number: number; head: string; baseRepo: string; headRepo: string; title: string
} {
  const object = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The forge returned an invalid pull request.')
    return value as Record<string, unknown>
  }
  const repo = (value: unknown): string => {
    const name = object(value).full_name
    if (!validRepo(name)) throw new Error('The forge returned an invalid repository.')
    return name
  }
  const row = object(raw)
  const head = object(row.head)
  const base = object(row.base)
  if (typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number < 1 ||
      typeof head.sha !== 'string' || !SHA.test(head.sha) ||
      typeof row.title !== 'string' || Buffer.byteLength(row.title, 'utf8') > TITLE_LIMIT) {
    throw new Error('The forge returned an invalid pull request.')
  }
  return {
    number: row.number, head: head.sha, baseRepo: repo(base.repo),
    headRepo: repo(head.repo), title: row.title.replace(/[\u0000-\u001f\u007f]/g, ' '),
  }
}

/** Prose, clipped to a byte bound at a character boundary, with a marker that says so. */
const prose = (value: unknown, limit = BODY_LIMIT): string => {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') throw unreadable()
  const text = value.replace(/\u0000/g, '')
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let used = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > limit) break
    used += size
    end += char.length
  }
  return `${text.slice(0, end)}${CLIPPED}`
}

const time = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0) throw unreadable()
  return parsed
}

const positive = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw unreadable()
  return value
}

/** An address the forge gave, only when it is exactly the expected page of the bound repository. */
const confined = (value: unknown, path: string, hash = ''): string | null => {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.search !== '' || url.pathname !== path || url.hash !== hash) return null
  return url.href
}

/** What `gh` said went wrong, by kind only. */
const failureOf = (stderr: string): ForgeReadError => {
  if (/HTTP 401|gh auth login|not logged in|authentication|bad credentials/i.test(stderr)) {
    return new ForgeReadError('signed-out', 'The forge is not signed in.')
  }
  if (/rate limit|HTTP 429|abuse detection/i.test(stderr)) return new ForgeReadError('rate-limited', 'The forge’s rate limit was reached.')
  if (/HTTP 5\d\d|could not resolve|error connecting|connection|timed? ?out|network|ENOTFOUND|ECONN|EAI_AGAIN|ENOENT|spawn/i.test(stderr)) {
    return new ForgeReadError('offline', 'The forge could not be reached.')
  }
  if (/HTTP 404|Not Found/i.test(stderr)) return new ForgeReadError('unreadable', 'The forge has no such thing.', true)
  return unreadable()
}

interface PullRow {
  readonly number: number
  readonly head: string
  readonly headRepo: string | null
  readonly baseRepo: string
  readonly state: 'open' | 'closed'
  readonly merged: boolean
  readonly title: string
  readonly body: string
  readonly url: string | null
  readonly created: number
  readonly updated: number
}

interface IssueRow {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string | null
  readonly created: number
  readonly updated: number
}

export interface ForgeSourceOptions {
  readonly run?: GhApiRunner
  /** The wall clock a baseline is read from. */
  readonly now: () => number
  /** A whole source read's budget. */
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly maxPages?: number
  /** Local remembered publication ids, never a forge read. */
  readonly posted?: (fact: TriggerFact) => Promise<boolean>
}

export class ForgeSource {
  readonly #run: GhApiRunner
  readonly #now: () => number
  readonly #timeoutMs: number
  readonly #maxBytes: number
  readonly #maxPages: number
  readonly #posted: (fact: TriggerFact) => Promise<boolean>

  constructor(options: ForgeSourceOptions) {
    this.#run = options.run ?? spawnGh()
    this.#now = options.now
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    this.#maxPages = options.maxPages ?? 10
    this.#posted = options.posted ?? (async () => false)
  }

  /**
   * The forge repository a main checkout is observed on: what the signed-in
   * `gh` resolves for it, confirmed to be `owner/name` on github.com.
   */
  async repository(project: string): Promise<{ readonly repository: string } | { readonly refused: string; readonly fix: string }> {
    const none = { refused: 'This project has no GitHub repository the signed-in forge can read.', fix: 'Add a GitHub remote, and sign in with gh auth login.' }
    const result = await this.#run(['repo', 'view', '--json', 'nameWithOwner,url'], null, { cwd: project, timeoutMs: 15_000, maxBytes: 64 * 1024 })
    if (result.exitCode !== 0 || result.timedOut || result.overflow) return none
    let answer: unknown
    try {
      answer = JSON.parse(result.stdout)
    } catch {
      return none
    }
    if (!isMap(answer) || typeof answer['url'] !== 'string') return none
    let url: URL
    try {
      url = new URL(answer['url'])
    } catch {
      return none
    }
    if (url.host !== 'github.com') return { refused: 'This forge is not supported for triggers yet.', fix: 'Use a project whose remote is on github.com.' }
    const name = answer['nameWithOwner']
    if (!validRepo(name) || confined(answer['url'], `/${name}`) === null) return none
    return { repository: name }
  }

  /**
   * Who the forge is signed in as, as an opaque digest of the forge and its
   * numeric account id — never a login, an address or a token. An arm binds
   * it, so signing in as someone else lists the trigger as changed.
   */
  async account(project: string): Promise<{ readonly account: string } | { readonly refused: string; readonly fix: string }> {
    const refused = { refused: 'The forge is not signed in, so no trigger can read it.', fix: 'Sign in with gh auth login, then preview again.' }
    let answer: unknown
    try {
      answer = await this.#get(project, 'user', Date.now() + this.#timeoutMs, new AbortController().signal)
    } catch (error) {
      return error instanceof ForgeReadError && error.kind !== 'signed-out'
        ? { refused: 'The forge could not be asked who is signed in.', fix: 'Check the connection, then preview again.' }
        : refused
    }
    const id = isMap(answer) ? answer['id'] : null
    if (!Number.isSafeInteger(id) || (id as number) < 1) return refused
    return { account: accountDigest(id as number) }
  }

  /** One read, bounded in time and bytes; a failure by kind. */
  async #get(project: string, path: string, deadline: number, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new ForgeReadError('offline', 'The read was stopped.')
    const left = deadline - Date.now()
    if (left <= 0) throw outOfTime()
    const result = await this.#run(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path], null, {
      cwd: project, timeoutMs: left, maxBytes: this.#maxBytes,
    })
    if (signal.aborted) throw new ForgeReadError('offline', 'The read was stopped.')
    if (result.timedOut || Date.now() > deadline) throw outOfTime()
    if (result.overflow) throw new PullWatchOverflow('The forge response exceeded the read limit.')
    if (result.exitCode !== 0) throw failureOf(result.stderr)
    try {
      return JSON.parse(result.stdout) as unknown
    } catch {
      throw unreadable()
    }
  }

  /** One page of a list: an array of at most 100 items, or unreadable. */
  async #page(project: string, path: string, deadline: number, signal: AbortSignal): Promise<readonly unknown[]> {
    const answer = await this.#get(project, path, deadline, signal)
    if (!Array.isArray(answer) || answer.length > PER_PAGE) throw unreadable()
    return answer
  }

  #pull(raw: unknown): PullRow {
    if (!isMap(raw) || !isMap(raw['head'])) throw unreadable()
    // A deleted fork answers with no head repository: known unknown, refused per pull request, not a broken read.
    const lost = raw['head']['repo'] === null
    let read
    try {
      read = readPullFact(lost ? { ...raw, head: { ...raw['head'], repo: isMap(raw['base']) ? raw['base']['repo'] : null } } : raw)
    } catch {
      throw unreadable()
    }
    const state = raw['state']
    if (state !== 'open' && state !== 'closed') throw unreadable()
    if (raw['merged'] !== undefined && typeof raw['merged'] !== 'boolean') throw unreadable()
    if (raw['merged_at'] !== undefined && raw['merged_at'] !== null) time(raw['merged_at'])
    const merged = raw['merged'] === true || typeof raw['merged_at'] === 'string'
    if (merged && state !== 'closed') throw unreadable()
    return {
      number: read.number, head: read.head, headRepo: lost ? null : read.headRepo, baseRepo: read.baseRepo, state,
      merged,
      title: read.title, body: prose(raw['body']), url: null, created: time(raw['created_at']), updated: time(raw['updated_at']),
    }
  }

  #issue(raw: Record<string, unknown>, repository: string): IssueRow {
    const number = positive(raw['number'])
    const title = raw['title']
    if (typeof title !== 'string' || Buffer.byteLength(title, 'utf8') > TITLE_LIMIT) throw unreadable()
    return {
      number, title: title.replace(/[\u0000-\u001f\u007f]/g, ' '), body: prose(raw['body']),
      url: confined(raw['html_url'], `/${repository}/issues/${number}`),
      created: time(raw['created_at']), updated: time(raw['updated_at']),
    }
  }

  /** The repository a cursor was bound to, checked again before it is spelled into a path. */
  #repo(cursor: SourceCursor): string {
    if (!validRepo(cursor.repository)) throw unreadable()
    return cursor.repository
  }

  /**
   * The first read of a source after it is armed: open pull requests' heads,
   * or nothing for issues, and the instant it was taken. Nothing is offered.
   * More than ten pages of open pull requests refuses the arm with a reason.
   */
  async inventory(project: string, source: 'pull-request' | 'issue' | 'mention', repository: string, signal: AbortSignal): Promise<SourceCursor> {
    if (!validRepo(repository)) throw unreadable()
    const now = this.#now()
    const deadline = Date.now() + this.#timeoutMs
    const subjects: Record<string, { head: string | null; event: string }> = {}
    if (source === 'mention') {
      await this.#page(project, `repos/${repository}/issues/comments?sort=updated&direction=desc&per_page=${PER_PAGE}&page=1`, deadline, signal)
    } else if (source === 'issue') {
      await this.#page(project, `repos/${repository}/issues?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=1`, deadline, signal)
    } else {
      for (let page = 1; ; page += 1) {
        if (page > this.#maxPages) {
          throw new ForgeReadError('unreadable', 'This repository has more open pull requests than a trigger can watch (1,000).')
        }
        const rows = await this.#page(project, `repos/${repository}/pulls?state=open&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`, deadline, signal)
        for (const raw of rows) {
          const row = this.#pull(raw)
          if (row.state === 'open' && row.baseRepo === repository) subjects[String(row.number)] = { head: row.head, event: '' }
        }
        if (rows.length < PER_PAGE) break
      }
    }
    return { version: 1, source, repository, baseline: now, observedThrough: now, continuation: null, subjects }
  }

  /** Proves a watched source still reads, for a second arm on it: one page, nothing kept. */
  async probe(project: string, cursor: SourceCursor, signal: AbortSignal): Promise<void> {
    const repository = this.#repo(cursor)
    const list = cursor.source === 'mention' ? 'issues/comments?sort=updated' : cursor.source === 'issue' ? 'issues?state=all' : 'pulls?state=open'
    await this.#page(project, `repos/${repository}/${list}${cursor.source === 'mention' ? '' : '&sort=updated'}&direction=desc&per_page=${PER_PAGE}&page=1`, Date.now() + this.#timeoutMs, signal)
  }

  /**
   * `permissions`: a trigger on this source lets collaborators' comments
   * fire it, so each new comment's author is asked about once — one bounded
   * read per comment, never for a desk post or an unreadable author. PR
   * `watches` opt into supplemental reads and always verify review authors.
   */
  async poll(project: string, cursor: SourceCursor, signal: AbortSignal, options: {
    readonly permissions?: boolean; readonly watches?: readonly PullWatch[]; readonly requests?: RequestReading
  } = {}): Promise<PollBatch> {
    if (cursor.source === 'pull-request') return this.#pulls(project, cursor, signal, options.watches ?? [], options.requests ?? null)
    if (cursor.source === 'issue') return this.#issues(project, cursor, signal, options.permissions === true, options.requests ?? null)
    if (cursor.source === 'mention') return this.#mentions(project, cursor, signal)
    throw unreadable()
  }

  /**
   * Whether an account can write to a repository, for a mention's gate: the
   * same bounded read as a comment trigger's, its answer's account compared
   * with the author's by digest. A read that fails throws, so the comment is
   * kept and judged again later.
   */
  async writes(project: string, repository: string, login: string, author: string, signal: AbortSignal): Promise<boolean> {
    if (!validRepo(repository) || !LOGIN.test(login)) return false
    let answer: unknown
    try {
      answer = await this.#get(project, `repos/${repository}/collaborators/${login}/permission`, Date.now() + this.#timeoutMs, signal)
    } catch (error) {
      if (!signal.aborted && error instanceof ForgeReadError && error.notFound) return false
      throw error
    }
    if (!isMap(answer) || !isMap(answer['user']) || !Number.isSafeInteger(answer['user']['id']) || typeof answer['permission'] !== 'string') return false
    if (accountDigest(answer['user']['id'] as number) !== author) return false
    return WRITES.has(answer['permission']) || (typeof answer['role_name'] === 'string' && WRITES.has(answer['role_name']))
  }

  /**
   * One issue or pull request as a mention's gate reads it: whether it is a
   * pull request, its state, its labels as validated names and its title as
   * clipped prose. Nothing else of the answer survives.
   */
  async thread(project: string, repository: string, number: number, signal: AbortSignal): Promise<MentionThread> {
    if (!validRepo(repository) || !Number.isSafeInteger(number) || number < 1) throw unreadable()
    const raw = await this.#get(project, `repos/${repository}/issues/${number}`, Date.now() + this.#timeoutMs, signal)
    if (!isMap(raw) || raw['number'] !== number || (raw['state'] !== 'open' && raw['state'] !== 'closed')) throw unreadable()
    const title = raw['title']
    if (typeof title !== 'string' || Buffer.byteLength(title, 'utf8') > TITLE_LIMIT) throw unreadable()
    const labels = Array.isArray(raw['labels'])
      ? raw['labels'].slice(0, 100).flatMap((one) => {
        const name = labelName(isMap(one) ? one['name'] : one)
        return name === null ? [] : [name]
      })
      : []
    return { number, pull: 'pull_request' in raw, state: raw['state'], labels, title: title.replace(/[\u0000-\u001f\u007f]/g, ' ') }
  }

  /**
   * Whether a login a trigger names is the account that wrote a comment: the
   * forge's account for that login, read by name, compared by stable id —
   * and, for a bot, the forge's own word that it is one. False when the forge
   * has no such account; any other failure throws, so the comment is judged
   * again later.
   */
  async isAccount(project: string, login: string, bot: boolean, author: string, signal: AbortSignal): Promise<boolean> {
    const name = bot ? `${login}[bot]` : login
    if (!LOGIN.test(name)) return false
    let answer: unknown
    try {
      answer = await this.#get(project, `users/${encodeURIComponent(name)}`, Date.now() + this.#timeoutMs, signal)
    } catch (error) {
      if (!signal.aborted && error instanceof ForgeReadError && error.notFound) return false
      throw error
    }
    if (!isMap(answer) || !Number.isSafeInteger(answer['id']) || (answer['id'] as number) < 1) throw unreadable()
    if (bot && answer['type'] !== 'Bot') return false
    return accountDigest(answer['id'] as number) === author
  }

  /** One comment as the forge holds it now, read again by id: what Re-evaluate judges. */
  async comment(project: string, repository: string, id: number, signal: AbortSignal): Promise<TriggerFact> {
    if (!validRepo(repository) || !Number.isSafeInteger(id) || id < 1) throw unreadable()
    const raw = await this.#get(project, `repos/${repository}/issues/comments/${id}`, Date.now() + this.#timeoutMs, signal)
    if (!isMap(raw) || raw['id'] !== id) throw unreadable()
    return mentionFact(project, repository, raw, id, time(raw['created_at']))
  }

  /** A pull request's lifecycle, for a thread of work that follows it: open, merged or closed. */
  async pullState(project: string, repository: string, number: number, signal: AbortSignal): Promise<'open' | 'merged' | 'closed'> {
    if (!validRepo(repository) || !Number.isSafeInteger(number) || number < 1) throw unreadable()
    const row = this.#pull(await this.#get(project, `repos/${repository}/pulls/${number}`, Date.now() + this.#timeoutMs, signal))
    if (row.number !== number) throw unreadable()
    return row.state === 'open' ? 'open' : row.merged ? 'merged' : 'closed'
  }

  /**
   * Whether the forge says an account can write to a repository: its
   * permission there read by login, and the answer's own account id checked
   * against the author's. False when the forge says it has no such
   * collaborator (HTTP 404); null when its answer names another account —
   * which never fires anything. Any other failure — offline, rate limited,
   * signed out, forbidden, garbled — throws: no answer, so the read keeps
   * its cursor and the fact is offered again, never consumed as a skip.
   */
  async #writes(project: string, repository: string, login: string, id: number, deadline: number, signal: AbortSignal): Promise<boolean | null> {
    if (!LOGIN.test(login)) return null
    let answer: unknown
    try {
      answer = await this.#get(project, `repos/${repository}/collaborators/${login}/permission`, deadline, signal)
    } catch (error) {
      // Only the forge saying there is no such collaborator is an answer; a 403, a garbled or a failed read is none.
      if (!signal.aborted && error instanceof ForgeReadError && error.notFound) return false
      throw error
    }
    if (!isMap(answer) || !isMap(answer['user']) || answer['user']['id'] !== id || typeof answer['permission'] !== 'string') return null
    return WRITES.has(answer['permission']) || (typeof answer['role_name'] === 'string' && WRITES.has(answer['role_name']))
  }

  /** A read that could not cover the whole window: nothing offered, the watermark kept, the reason said. */
  #gap(cursor: SourceCursor, problem: string): PollBatch {
    return { facts: [], next: cursor, complete: false, problem, skipped: [] }
  }

  #bounded(cursor: SourceCursor, facts: TriggerFact[], next: SourceCursor, skipped: PollBatch['skipped']): PollBatch {
    facts.sort((a, b) => a.at - b.at || Number(a.subject) - Number(b.subject) || a.event.localeCompare(b.event))
    if (facts.length > FACT_LIMIT || Buffer.byteLength(JSON.stringify(facts), 'utf8') > BATCH_BYTES) {
      return this.#gap(cursor, 'More changed than one read can hold.')
    }
    return { facts, next, complete: true, problem: null, skipped }
  }

  async #pulls(project: string, cursor: SourceCursor, signal: AbortSignal, watches: readonly PullWatch[], requests: RequestReading | null): Promise<PollBatch> {
    const repository = this.#repo(cursor)
    const deadline = Date.now() + this.#timeoutMs
    const floor = cursor.observedThrough - OVERLAP_MS
    const rows: PullRow[] = []
    let complete = false
    for (let page = 1; page <= this.#maxPages && !complete; page += 1) {
      const answer = await this.#page(project, `repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`, deadline, signal)
      for (const raw of answer) {
        const row = this.#pull(raw)
        if (row.updated < floor) {
          complete = true
          break
        }
        rows.push({ ...row, url: confined(isMap(raw) ? raw['html_url'] : null, `/${repository}/pull/${row.number}`) })
      }
      if (answer.length < PER_PAGE) complete = true
    }
    if (!complete) return this.#gap(cursor, 'More pull requests changed than one read can cover.')
    const subjects: Record<string, { head: string | null; event: string }> = { ...cursor.subjects }
    const facts: TriggerFact[] = []
    const skipped: PollBatch['skipped'][number][] = []
    let through = cursor.observedThrough
    for (const row of [...rows].sort((a, b) => a.updated - b.updated || a.number - b.number)) {
      through = Math.max(through, row.updated)
      const subject = String(row.number)
      if (row.state !== 'open') {
        delete subjects[subject]
        continue
      }
      if (row.baseRepo !== repository) {
        skipped.push({ trigger: null, subject, reason: 'The forge named another repository as this pull request’s target, so it was not read.', count: 1 })
        continue
      }
      if (row.headRepo === null) {
        skipped.push({ trigger: null, subject, reason: 'This pull request’s head repository is unknown, so it was not read.', count: 1 })
        continue
      }
      const known = subjects[subject]
      let action: TriggerAction | null = null
      if (!known) action = row.created > cursor.baseline ? 'opened' : null
      else if (known.head !== row.head) action = 'pushed'
      if (action === null) {
        if (!known) subjects[subject] = { head: row.head, event: '' }
        continue
      }
      const event = eventKey([repository, row.number, action, row.head])
      subjects[subject] = { head: row.head, event }
      facts.push({
        source: 'pull-request', project, repository, subject, event, action,
        at: action === 'opened' ? row.created : row.updated, head: row.head, fork: row.headRepo !== repository,
        title: row.title, body: row.body, url: row.url, trigger: null,
      })
    }
    const watched = await this.#watch(project, repository, cursor, rows, watches, deadline, signal, facts, skipped)
    if (watched === null) return this.#gap(cursor, 'More watched pull request state than one read can cover.')
    for (const observation of watched.observations) {
      if (observation.state !== 'open') delete subjects[String(observation.number)]
    }
    let coverage = cursor.requests
    if (requests !== null) {
      const asked = await this.#requests(project, repository, cursor, rows, requests, deadline, signal)
      if (typeof asked === 'string') return this.#gap(cursor, asked)
      if (asked === null) {
        // Out of time before the requests were read: this window is read again, and no request in it is lost.
        through = cursor.observedThrough
      } else {
        facts.push(...asked.facts)
        // Only what the next window can return again is kept; a window that holds more than that is a gap.
        const floor = Math.max(cursor.baseline, through - OVERLAP_MS)
        const seen = Object.fromEntries(Object.entries(asked.seen).filter(([, at]) => at >= floor))
        if (Object.keys(seen).length > SEEN_LIMIT) return this.#gap(cursor, 'More pull request comments changed than one read can cover.')
        coverage = { seen }
      }
    }
    const next = { ...cursor, observedThrough: through, continuation: null, subjects, pulls: watched.pulls, pullNext: watched.next, ...(coverage === undefined ? {} : { requests: coverage }) }
    if (Buffer.byteLength(JSON.stringify([facts, watched.observations, watched.pulls]), 'utf8') > BATCH_BYTES) return this.#gap(cursor, 'More changed than one read can hold.')
    const batch = this.#bounded(cursor, facts, next, skipped)
    return batch.complete ? { ...batch, observations: watched.observations } : batch
  }

  /** Two supplemental requests per PR, including direct lifecycle and permission reads. */
  async #watch(
    project: string, repository: string, cursor: SourceCursor, rows: readonly PullRow[], watches: readonly PullWatch[],
    deadline: number, signal: AbortSignal, facts: TriggerFact[], skipped: PollBatch['skipped'][number][],
  ): Promise<{ pulls: Record<string, PullWatchState>; observations: PullObservation[]; next: number } | null> {
    for (const watch of watches) {
      if (watch.number !== undefined) positive(watch.number)
      if (watch.since !== undefined && (!Number.isSafeInteger(watch.since) || watch.since < 0)) throw unreadable()
      if (typeof watch.checks !== 'boolean' || typeof watch.reviews !== 'boolean') throw unreadable()
    }
    const all = watches.some((watch) => watch.number === undefined)
    const numbers = [...new Set([
      ...watches.flatMap((watch) => watch.number === undefined ? [] : [watch.number]),
      ...(all ? Object.keys(cursor.subjects).map(Number) : []),
      ...(all ? rows.filter((row) => row.state === 'open').map((row) => row.number) : []),
    ])].sort((a, b) => a - b)
    for (const number of numbers) positive(number)
    if (numbers.length > FACT_LIMIT) return null
    const ordered = [...numbers.filter((n) => n >= (cursor.pullNext ?? 0)), ...numbers.filter((n) => n < (cursor.pullNext ?? 0))]
    const pulls: Record<string, PullWatchState> = {}
    for (const number of numbers) if (cursor.pulls?.[number]) pulls[number] = cursor.pulls[number]!
    const observations: PullObservation[] = []
    let next = 0
    let progressed = false
    for (const number of ordered) {
      const interested = watches.filter((watch) => watch.number === undefined || watch.number === number)
      const checks = interested.some((watch) => watch.checks)
      const reviews = interested.some((watch) => watch.reviews)
      const checkFloor = Math.max(cursor.baseline, Math.min(...interested.filter((watch) => watch.checks).map((watch) => watch.since ?? cursor.baseline)))
      const reviewFloor = Math.max(cursor.baseline, Math.min(...interested.filter((watch) => watch.reviews).map((watch) => watch.since ?? cursor.baseline)))
      const interest = `${checks}:${reviews}:${checks ? checkFloor : 0}:${reviews ? reviewFloor : 0}`
      const listed = rows.find((one) => one.number === number)
      const previous = pulls[number]
      if (previous?.idle && previous.idle.next > this.#now() && previous.idle.interest === interest &&
        (!listed || (listed.head === previous.head && listed.state === 'open' && !listed.merged && listed.updated === previous.idle.updated))) continue
      let slots = 2
      let cycleComplete = false
      const factStart = facts.length
      const observationStart = observations.length
      try {
        let row = listed
        if (!row) {
          slots -= 1
          row = this.#pull(await this.#get(project, `repos/${repository}/pulls/${number}`, deadline, signal))
          if (row.number !== number) throw unreadable()
        }
        if (row.baseRepo !== repository || row.headRepo === null) {
          delete pulls[number]
          continue
        }
        if (row.state === 'closed') {
          delete pulls[number]
          observations.push({ repository, number, head: row.head, state: row.merged ? 'merged' : 'closed', check: null, at: this.#now() })
          progressed = true
          next = numbers[(numbers.indexOf(number) + 1) % numbers.length] ?? 0
          continue
        }
        let state: PullWatchState = pulls[number]?.head === row.head ? pulls[number]! : {
          head: row.head, phase: checks ? 'checks' : 'reviews', page: 1,
          counts: { total: 0, failed: 0, pending: 0 }, pending: [], more: false, failed: false, reviewed: false,
        }
        if (state.idle && (state.idle.updated !== row.updated || state.idle.interest !== interest)) state = { ...state, idle: undefined }
        if (!reviews && (state.phase === 'authors' || state.phase === 'body')) state = { ...state, phase: 'checks', pending: [], page: 1, more: false, counts: { total: 0, failed: 0, pending: 0 } }
        let check: TriggerCheck | null = null
        const writers = new Map<string, boolean | null>()
        const fact = (action: 'checks-failed' | 'review-commented', at: number): TriggerFact => ({
          source: 'pull-request', project, repository, subject: String(number),
          event: eventKey([repository, number, action, row.head]), action, at, head: row.head,
          fork: row.headRepo !== repository, title: row.title, body: '',
          url: `https://github.com/${repository}/pull/${number}`, trigger: null,
        })
        // Each successful step is retained only with the batch's eventual delivery acknowledgement.
        while (slots > 0) {
          if (state.phase === 'checks' || state.phase === 'statuses') {
            if (!checks) { state = { ...state, phase: 'reviews', page: 1 }; continue }
            const runs = state.phase === 'checks'
            slots -= 1
            const answer = await this.#get(project, `repos/${repository}/commits/${row.head}/${runs ? 'check-runs' : 'status'}?per_page=${PER_PAGE}&page=${state.page}`, deadline, signal)
            const list = isMap(answer) ? answer[runs ? 'check_runs' : 'statuses'] : null
            const total = isMap(answer) ? answer['total_count'] : null
            if (!Array.isArray(list) || list.length > PER_PAGE || !Number.isSafeInteger(total) || (total as number) < 0) throw unreadable()
            if ((total as number) > this.#maxPages * PER_PAGE) throw new PullWatchOverflow('Too many checks on this pull request; supplemental state was not read.')
            const expected = Math.min(PER_PAGE, Math.max(0, (total as number) - (state.page - 1) * PER_PAGE))
            if (list.length !== expected) throw unreadable()
            if (!runs && (!isMap(answer) || answer['sha'] !== row.head)) throw unreadable()
            const counts = { ...state.counts }
            for (const raw of list) {
              if (!isMap(raw)) throw unreadable()
              positive(raw['id'])
              if (runs && raw['head_sha'] !== row.head) throw unreadable()
              const name = runs ? raw['name'] : raw['context']
              if (typeof name !== 'string' || Buffer.byteLength(name, 'utf8') > TITLE_LIMIT) throw unreadable()
              const status = runs ? raw['status'] : raw['state']
              if (typeof status !== 'string' || (runs && !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(status)) ||
                (!runs && !['pending', 'success', 'failure', 'error'].includes(status))) throw unreadable()
              const conclusion = runs ? raw['conclusion'] : null
              if (runs && conclusion !== null && !['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(String(conclusion))) throw unreadable()
              counts.total += 1
              if (runs ? status !== 'completed' || conclusion === null : status === 'pending') counts.pending += 1
              else if (runs ? !['success', 'neutral', 'skipped'].includes(String(conclusion)) : status !== 'success') {
                counts.failed += 1
                const stamp = raw[runs ? 'completed_at' : 'updated_at']
                // Missing failure time cannot establish an event after arming.
                counts.failureAt = Math.max(counts.failureAt ?? 0, stamp == null ? 0 : time(stamp))
              }
            }
            const more = state.page * PER_PAGE < (total as number)
            if (more && (list.length !== PER_PAGE || state.page >= this.#maxPages)) throw new PullWatchOverflow('Too many checks on this pull request; supplemental state was not read.')
            state = { ...state, counts, page: more ? state.page + 1 : 1, phase: more ? state.phase : runs ? 'statuses' : 'reviews' }
            if (!runs && !more) {
              state = { ...state, aggregate: `${counts.total}:${counts.failed}:${counts.pending}:${counts.failureAt ?? 0}` }
              check = { head: row.head, state: counts.failed > 0 ? 'failed' : counts.pending > 0 ? 'pending' : counts.total > 0 ? 'passed' : 'absent', total: counts.total }
              if (check.state === 'failed' && !state.failed) {
                if ((counts.failureAt ?? 0) > checkFloor) facts.push({ ...fact('checks-failed', counts.failureAt!), body: row.body, check })
                state = { ...state, failed: true }
              }
            }
          } else if (state.phase === 'reviews') {
            if (!reviews || (state.reviewed && state.page === 1)) {
              state = { ...state, phase: 'checks', page: 1, counts: { total: 0, failed: 0, pending: 0 } }
              cycleComplete = true
              break
            }
            slots -= 1
            const answer = await this.#page(project, `repos/${repository}/pulls/${number}/reviews?per_page=${PER_PAGE}&page=${state.page}`, deadline, signal)
            if (answer.length === PER_PAGE && state.page >= this.#maxPages) throw new PullWatchOverflow('Too many reviews on this pull request; supplemental state was not read.')
            const pending: PendingReview[] = []
            for (const raw of answer) {
              if (!isMap(raw)) throw unreadable()
              const id = positive(raw['id'])
              if (raw['state'] === 'PENDING' || raw['state'] === 'DISMISSED') continue
              const states: Record<string, TriggerReview['state']> = { COMMENTED: 'commented', CHANGES_REQUESTED: 'changes-requested', APPROVED: 'approved' }
              const kind = states[String(raw['state'])]
              if (!kind || !SHA.test(String(raw['commit_id']))) throw unreadable()
              const at = time(raw['submitted_at'])
              if (raw['commit_id'] !== row.head || at <= reviewFloor) continue
              const body = prose(raw['body'])
              if (kind === 'approved' && !body.trim()) continue
              const user = raw['user']
              if (!isMap(user) || !Number.isSafeInteger(user['id']) || (user['id'] as number) < 1 || typeof user['login'] !== 'string' || !LOGIN.test(user['login'])) continue
              if (isDeskPost(body) || state.reviewed || state.nonWriters?.includes(user['id'] as number)) continue
              // Remembered desk publications need no permission or body reread.
              if (await this.#posted({ ...fact('review-commented', at), review: { id, head: row.head, state: kind }, author: accountDigest(user['id'] as number),
                url: `https://github.com/${repository}/pull/${number}#pullrequestreview-${id}` })) continue
              pending.push({ id, account: user['id'] as number, login: user['login'], at, state: kind })
            }
            const otherPending = Object.entries(pulls).reduce((count, [key, value]) => count + (key === String(number) ? 0 : value.pending.length), 0)
            if (otherPending + pending.length > PENDING_LIMIT) throw new PullWatchOverflow('Too many pending reviews; this pull request’s supplemental state was not read.')
            state = { ...state, pending, phase: 'authors', more: answer.length === PER_PAGE }
          } else {
            if (state.reviewed) state = { ...state, pending: [], phase: 'authors' }
            if (state.pending.length === 0) {
              state = state.more ? { ...state, phase: 'reviews', page: state.page + 1 } :
                { ...state, phase: 'checks', page: 1, counts: { total: 0, failed: 0, pending: 0 } }
              if (!state.more) { cycleComplete = true; break }
              continue
            }
            const candidate = state.pending[0]!
            if (candidate.at <= reviewFloor || state.nonWriters?.includes(candidate.account)) {
              state = { ...state, pending: state.pending.slice(1), phase: 'authors' }
              continue
            }
            if (state.phase === 'body') {
              // Permission was verified before retaining or rereading any body.
              slots -= 1
              const raw = await this.#get(project, `repos/${repository}/pulls/${number}/reviews/${candidate.id}`, deadline, signal)
              if (!isMap(raw) || raw['id'] !== candidate.id || raw['commit_id'] !== row.head || !isMap(raw['user']) || raw['user']['id'] !== candidate.account ||
                raw['user']['login'] !== candidate.login || time(raw['submitted_at']) !== candidate.at) throw unreadable()
              const kinds: Record<string, TriggerReview['state']> = { COMMENTED: 'commented', CHANGES_REQUESTED: 'changes-requested', APPROVED: 'approved' }
              const kind = kinds[String(raw['state'])]
              const body = prose(raw['body'])
              const reviewed = { ...fact('review-commented', candidate.at), body, review: { id: candidate.id, head: row.head, state: candidate.state },
                author: accountDigest(candidate.account), authorWrites: true, desk: isDeskPost(body), url: `https://github.com/${repository}/pull/${number}#pullrequestreview-${candidate.id}` }
              if (kind === candidate.state && (kind !== 'approved' || body.trim()) && !reviewed.desk && !await this.#posted(reviewed)) {
                facts.push(reviewed)
                state = { ...state, reviewed: true }
              }
              state = { ...state, pending: state.pending.slice(1), phase: 'authors' }
            } else {
              const key = `${candidate.login}\u0000${candidate.account}`
              if (!writers.has(key)) {
                slots -= 1
                writers.set(key, await this.#writes(project, repository, candidate.login, candidate.account, deadline, signal))
              }
              if (writers.get(key) === true) state = { ...state, phase: 'body' }
              else {
                if (writers.get(key) === false) state = { ...state, nonWriters: [...(state.nonWriters ?? []), candidate.account].slice(-NON_WRITER_LIMIT) }
                skipped.push({ trigger: null, subject: String(number), reason: 'This review’s author does not have verified write access.', count: 1 })
                state = { ...state, pending: state.pending.slice(1) }
              }
            }
          }
          pulls[number] = state
          if (facts.length > FACT_LIMIT || Buffer.byteLength(JSON.stringify([facts, pulls, observations]), 'utf8') > BATCH_BYTES) throw new PullWatchOverflow('Too much supplemental state on this pull request; it was not read.')
          progressed = true
        }
        if (cycleComplete) {
          const aggregate = state.aggregate ?? ''
          const unchanged = state.idle?.aggregate === aggregate && state.idle.updated === row.updated && state.idle.interest === interest
          const interval = unchanged ? Math.min(WATCH_MAX_INTERVAL, state.idle!.interval * 2) : WATCH_INTERVAL
          state = { ...state, idle: { interval, next: this.#now() + (unchanged ? interval : 0), updated: row.updated, interest, aggregate } }
        }
        pulls[number] = state
        observations.push({ repository, number, head: row.head, state: row.merged ? 'merged' : row.state, check, at: this.#now() })
        if (Buffer.byteLength(JSON.stringify([facts, pulls, observations]), 'utf8') > BATCH_BYTES) throw new PullWatchOverflow('Too much supplemental state on this pull request; it was not read.')
        progressed = true
        next = numbers[(numbers.indexOf(number) + 1) % numbers.length] ?? 0
      } catch (error) {
        if (error instanceof PullWatchOverflow) {
          facts.splice(factStart)
          observations.splice(observationStart)
          delete pulls[number]
          skipped.push({ trigger: null, subject: String(number), reason: error.message, count: 1 })
          continue
        }
        if (!(error instanceof ForgeReadError) || !error.budget || signal.aborted) throw error
        if (!progressed) return null
        next = number
        break
      }
    }
    return { pulls, observations, next }
  }

  /**
   * `@harnessdesk` requests on pull requests, read by time from the source's
   * own window — never a mark per pull request, so nothing can be forgotten
   * into looking new.
   *
   * Conversation comments come from one repository-wide list, by update, from
   * the window's start: one paged read however many pull requests moved, each
   * comment routed to its pull request by `issue_url` (an issue's comments are
   * the issue source's). A comment asks only as written: one whose update
   * differs from its creation was edited, by its author or by anyone with
   * write access, so it never asks — whoever's name it carries.
   *
   * Reviews are read per pull request, only for those the existing list read
   * shows as updated, and a review is new by its submission time and its id,
   * never by the highest id read: a review left pending and submitted later is
   * still new. Its summary never asks, because the forge says nothing of
   * whether it was edited; its inline comments are read once it is submitted,
   * from that review alone — they carry the time they were drafted, so a read
   * by time would miss a review drafted before the window — and every inline
   * comment that starts with the word, unedited since the submission, makes
   * one request for the review.
   *
   * A list longer than one read may cover is a gap; running out of time
   * returns null, so the caller reads the same window again.
   */
  async #requests(
    project: string, repository: string, cursor: SourceCursor, rows: readonly PullRow[], requests: RequestReading,
    deadline: number, signal: AbortSignal,
  ): Promise<{ facts: TriggerFact[]; seen: Record<string, number> } | string | null> {
    const burst = 'More pull request comments changed than one read can cover.'
    const since = Math.max(cursor.baseline, cursor.observedThrough - OVERLAP_MS)
    const seen: Record<string, number> = { ...cursor.requests?.seen }
    const facts: TriggerFact[] = []
    const listed = new Map(rows.map((row) => [row.number, row]))
    const extra = new Map<number, PullRow>()
    // One permission answer per author within one read.
    const writers = new Map<string, boolean | null>()
    const repo = repository.replace(/[.]/g, '\\.')
    const issueUrl = new RegExp(`^https://api\\.github\\.com/repos/${repo}/issues/([1-9][0-9]{0,15})$`)
    const author = (user: Record<string, unknown> | null): { id: number | null; login: string | null } => ({
      id: user && Number.isSafeInteger(user['id']) && (user['id'] as number) >= 1 ? user['id'] as number : null,
      login: user && typeof user['login'] === 'string' ? user['login'] : null,
    })
    const writes = async (who: { id: number | null; login: string | null }): Promise<boolean | null> => {
      if (!requests.permissions || who.id === null || who.login === null) return null
      const cached = `${who.login}\u0000${who.id}`
      if (!writers.has(cached)) writers.set(cached, await this.#writes(project, repository, who.login, who.id, deadline, signal))
      return writers.get(cached) ?? null
    }
    // A pull request the list did not show (it moved before the window, its comment inside it): read once by number.
    const pull = async (number: number): Promise<PullRow> => {
      const known = listed.get(number) ?? extra.get(number)
      if (known) return known
      if (extra.size >= ISSUE_LIMIT) throw new RequestBurst(burst)
      const raw = await this.#get(project, `repos/${repository}/pulls/${number}`, deadline, signal)
      const row = { ...this.#pull(raw), url: confined(isMap(raw) ? raw['html_url'] : null, `/${repository}/pull/${number}`) }
      if (row.number !== number) throw unreadable()
      extra.set(number, row)
      return row
    }
    const request = (row: PullRow, key: readonly (string | number)[], at: number, words: string, url: string | null,
      who: { id: number | null }, authorWrites: boolean | null): TriggerFact => ({
      source: 'pull-request', project, repository, subject: String(row.number), event: eventKey([repository, row.number, 'mentioned', ...key]),
      action: 'mentioned', at, head: row.head, fork: row.headRepo !== repository, title: row.title, body: prose(words), url, trigger: null,
      author: who.id === null ? null : accountDigest(who.id), authorWrites, desk: false,
    })
    try {
      const comments = await this.#all(project, `repos/${repository}/issues/comments?sort=updated&direction=asc&since=${new Date(since).toISOString()}`, deadline, signal)
      if (comments === null) return burst
      for (const raw of comments) {
        if (!isMap(raw)) throw unreadable()
        const id = positive(raw['id'])
        const created = time(raw['created_at'])
        const updated = time(raw['updated_at'])
        const key = `c${id}`
        if (seen[key] !== undefined) continue
        const routed = typeof raw['issue_url'] === 'string' ? issueUrl.exec(raw['issue_url']) : null
        if (!routed) throw unreadable()
        const number = Number(routed[1])
        const url = confined(raw['html_url'], `/${repository}/pull/${number}`, `#issuecomment-${id}`)
        // An issue's comment, which the issue source reads.
        if (url === null) continue
        seen[key] = updated
        // From before the source began watching, or edited — by its author or by anyone who may write: never a request.
        if (created <= cursor.baseline || updated !== created) continue
        const user = isMap(raw['user']) ? raw['user'] : null
        const words = typeof raw['body'] === 'string' && !isBot(user) ? summonsOf(raw['body']) : null
        if (words === null) continue
        const row = await pull(number)
        if (row.baseRepo !== repository) continue
        const who = author(user)
        facts.push(request(row, [id], created, words, url, who, await writes(who)))
      }
      const changed = rows.filter((row) => row.baseRepo === repository && row.updated > cursor.baseline && seen[`p${row.number}`] !== row.updated)
      if (changed.length > ISSUE_LIMIT) return burst
      let opened = 0
      for (const row of [...changed].sort((a, b) => a.updated - b.updated || a.number - b.number)) {
        const reviews = await this.#all(project, `repos/${repository}/pulls/${row.number}/reviews`, deadline, signal)
        if (reviews === null) return 'A pull request has more reviews than one read can cover.'
        for (const raw of reviews) {
          if (!isMap(raw)) throw unreadable()
          const id = positive(raw['id'])
          // A pending review has not been submitted: nobody has said it yet, and it stays new until it is.
          if (raw['submitted_at'] === null || raw['submitted_at'] === undefined || raw['state'] === 'PENDING') continue
          const submitted = time(raw['submitted_at'])
          const key = `r${id}`
          if (seen[key] !== undefined || submitted < since || submitted <= cursor.baseline) continue
          seen[key] = submitted
          const user = isMap(raw['user']) ? raw['user'] : null
          if (isBot(user)) continue
          const who = author(user)
          if (who.id === null) continue
          opened += 1
          if (opened > ISSUE_LIMIT) return burst
          const inline = await this.#all(project, `repos/${repository}/pulls/${row.number}/reviews/${id}/comments`, deadline, signal)
          if (inline === null) return 'A review has more comments than one read can cover.'
          const words: string[] = []
          for (const one of inline) {
            if (!isMap(one)) throw unreadable()
            positive(one['id'])
            time(one['created_at'])
            const written = isMap(one['user']) ? one['user'] : null
            // Only the review's own words, unedited since it was submitted: a later edit may be anyone's who can write.
            if (one['pull_request_review_id'] !== id || written?.['id'] !== who.id || time(one['updated_at']) > submitted) continue
            const asked = typeof one['body'] === 'string' ? summonsOf(one['body']) : null
            if (asked !== null) words.push(asked)
          }
          if (words.length === 0) continue
          const url = confined(raw['html_url'], `/${repository}/pull/${row.number}`, `#pullrequestreview-${id}`)
          facts.push(request(row, ['review', id], submitted, words.join('\n\n'), url, who, await writes(who)))
        }
        seen[`p${row.number}`] = row.updated
      }
    } catch (error) {
      if (error instanceof RequestBurst) return error.message
      if (!(error instanceof ForgeReadError) || !error.budget || signal.aborted) throw error
      return null
    }
    return { facts, seen }
  }

  /** Every page of one issue's list, or a gap: never a short list read as the whole. */
  async #all(project: string, path: string, deadline: number, signal: AbortSignal): Promise<readonly unknown[] | null> {
    const all: unknown[] = []
    for (let page = 1; page <= this.#maxPages; page += 1) {
      const rows = await this.#page(project, `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`, deadline, signal)
      all.push(...rows)
      if (rows.length < PER_PAGE) return all
    }
    return null
  }

  /**
   * One read of a source's issues. Always makes progress: the list is read,
   * then each changed issue in `updated` order, and an issue already read at
   * this same update is not read again. A read that runs out of its time
   * budget part-way keeps what it covered — its facts offered, its cursor
   * moved to the first issue it did not finish — and the next read goes on
   * from there. Only a read that could cover nothing at all, or a burst
   * past what one read may ever hold, is a gap a person resumes from now.
   */
  async #issues(project: string, cursor: SourceCursor, signal: AbortSignal, permissions: boolean, requests: RequestReading | null): Promise<PollBatch> {
    const repository = this.#repo(cursor)
    const deadline = Date.now() + this.#timeoutMs
    const floor = cursor.observedThrough - OVERLAP_MS
    const burst = 'More issues changed than one read can cover.'
    const changed: IssueRow[] = []
    let complete = false
    let through = cursor.observedThrough
    try {
      for (let page = 1; page <= this.#maxPages && !complete; page += 1) {
        const answer = await this.#page(project, `repos/${repository}/issues?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`, deadline, signal)
        for (const raw of answer) {
          if (!isMap(raw)) throw unreadable()
          const updated = time(raw['updated_at'])
          if (updated < floor) {
            complete = true
            break
          }
          through = Math.max(through, updated)
          // The issue list also lists pull requests; they are the other source's, never read as issues.
          if ('pull_request' in raw) continue
          // Not touched since this source began watching: it can carry no fact, so it neither counts nor is read (a
          // source resumed after a gap is not stopped again by the very burst it skipped).
          if (updated <= cursor.baseline) continue
          changed.push(this.#issue(raw, repository))
        }
        if (answer.length < PER_PAGE) complete = true
      }
    } catch (error) {
      // Not even the list fits in one read: nothing can be covered, so the source stops at a gap, honestly.
      if (error instanceof ForgeReadError && error.budget && !signal.aborted) return this.#gap(cursor, burst)
      throw error
    }
    if (!complete || changed.length > ISSUE_LIMIT) return this.#gap(cursor, burst)
    const subjects: Record<string, { head: string | null; event: string }> = { ...cursor.subjects }
    const facts: TriggerFact[] = []
    // One permission answer per author within one read.
    const writers = new Map<string, boolean | null>()
    const ordered = [...changed].sort((a, b) => a.updated - b.updated || a.number - b.number)
    for (const [index, issue] of ordered.entries()) {
      const subject = String(issue.number)
      const known = marksOf(subjects[subject]?.event)
      // Read already at this very update: nothing new on it since.
      if (known !== null && known.u === issue.updated) continue
      const found: TriggerFact[] = []
      let events = known?.e ?? 0
      let comments = known?.c ?? 0
      const fresh = (id: number, created: number, mark: number): boolean => created > cursor.baseline && (known === null || id > mark)
      try {
        const listed = await this.#all(project, `repos/${repository}/issues/${issue.number}/events`, deadline, signal)
        if (listed === null) return this.#gap(cursor, 'An issue has more events than one read can cover.')
        for (const raw of listed) {
          if (!isMap(raw)) throw unreadable()
          const id = positive(raw['id'])
          const created = time(raw['created_at'])
          const kind = raw['event'] === 'labeled' ? 'labelled' : raw['event'] === 'closed' ? 'closed' : null
          if (kind && fresh(id, created, known?.e ?? 0)) {
            // The label a labelled event added, only as a validated name; its immutable event id already makes the fact one.
            const label = kind === 'labelled' && isMap(raw['label']) ? labelName(raw['label']['name']) : null
            found.push({
              source: 'issue', project, repository, subject, event: eventKey([repository, issue.number, kind, id]), action: kind,
              at: created, head: null, fork: false, title: issue.title, body: issue.body, url: issue.url, trigger: null,
              ...(label !== null ? { label } : {}),
            })
          }
          events = Math.max(events, id)
        }
        /* Comments since this issue's own last read (less the overlap), or since
           the source began watching for one never read — never the window's
           floor, which a read that ran short moved past comments on issues it
           did not reach (review #898). */
        const since = new Date(Math.max(0, known !== null ? known.u - OVERLAP_MS : cursor.baseline)).toISOString()
        const replies = await this.#all(project, `repos/${repository}/issues/${issue.number}/comments?since=${since}`, deadline, signal)
        if (replies === null) return this.#gap(cursor, 'An issue has more comments than one read can cover.')
        for (const raw of replies) {
          if (!isMap(raw)) throw unreadable()
          const id = positive(raw['id'])
          const created = time(raw['created_at'])
          if (fresh(id, created, known?.c ?? 0)) {
            // Who wrote it, by stable id only; whether the desk itself posted it, by its exact marker.
            const user = isMap(raw['user']) ? raw['user'] : null
            const authorId = user && Number.isSafeInteger(user['id']) && (user['id'] as number) >= 1 ? user['id'] as number : null
            const desk = typeof raw['body'] === 'string' && isDeskPost(raw['body'])
            const login = user && typeof user['login'] === 'string' ? user['login'] : null
            // A request is a comment that starts with the command word, from a person, as written: a bot never asks,
            // and neither does an edited comment — anyone with write access may edit it, so its words are not surely its author's.
            const words = requests !== null && typeof raw['body'] === 'string' && !isBot(user) && time(raw['updated_at']) === created ? summonsOf(raw['body']) : null
            let writes: boolean | null = null
            if ((permissions || (words !== null && requests?.permissions === true)) && !desk && authorId !== null && login !== null) {
              const cached = `${login}\u0000${authorId}`
              if (!writers.has(cached)) writers.set(cached, await this.#writes(project, repository, login, authorId, deadline, signal))
              writes = writers.get(cached) ?? null
            }
            found.push({
              source: 'issue', project, repository, subject, event: eventKey([repository, issue.number, 'commented', id]), action: 'commented',
              at: created, head: null, fork: false, title: issue.title, body: prose(raw['body']),
              url: confined(raw['html_url'], `/${repository}/issues/${issue.number}`, `#issuecomment-${id}`), trigger: null,
              author: authorId === null ? null : accountDigest(authorId), authorWrites: writes, desk,
            })
            // The same comment as a request, under its own key: the two dedupe apart.
            if (words !== null) {
              found.push({
                source: 'issue', project, repository, subject, event: eventKey([repository, issue.number, 'mentioned', id]), action: 'mentioned',
                at: created, head: null, fork: false, title: issue.title, body: prose(words),
                url: confined(raw['html_url'], `/${repository}/issues/${issue.number}`, `#issuecomment-${id}`), trigger: null,
                author: authorId === null ? null : accountDigest(authorId), authorWrites: writes, desk,
              })
            }
          }
          comments = Math.max(comments, id)
        }
      } catch (error) {
        if (!(error instanceof ForgeReadError) || !error.budget || signal.aborted) throw error
        // Out of time part-way: nothing covered at all is a gap; otherwise keep what was covered, up to this issue.
        if (index === 0) return this.#gap(cursor, burst)
        const covered = Math.max(cursor.observedThrough, issue.updated - 1)
        return this.#bounded(cursor, facts, { ...cursor, observedThrough: covered, continuation: null, subjects: prune(subjects) }, [])
      }
      facts.push(...found)
      subjects[subject] = { head: null, event: JSON.stringify({ e: events, c: comments, u: issue.updated }) }
    }
    return this.#bounded(cursor, facts, { ...cursor, observedThrough: through, continuation: null, subjects: prune(subjects) }, [])
  }

  /**
   * Every new comment on the repository's issues and pull request
   * conversations, oldest first, from one bounded repository-wide list: each
   * an untrusted fact with its author by stable id, its login as validated,
   * whether the forge says it is a bot, and whether the desk posted it. A
   * comment is new once: its id above the highest one read. Whether it
   * addresses anyone is the gate's question, never this reader's.
   */
  async #mentions(project: string, cursor: SourceCursor, signal: AbortSignal): Promise<PollBatch> {
    const repository = this.#repo(cursor)
    const deadline = Date.now() + this.#timeoutMs
    const mark = Number(cursor.subjects[MENTION_MARK]?.event ?? '0')
    const seen = Number.isSafeInteger(mark) && mark >= 0 ? mark : 0
    const since = new Date(Math.max(cursor.baseline, cursor.observedThrough - OVERLAP_MS)).toISOString()
    const burst = 'More comments changed than one read can cover.'
    const facts: TriggerFact[] = []
    let through = cursor.observedThrough
    let highest = seen
    let complete = false
    try {
      for (let page = 1; page <= this.#maxPages && !complete; page += 1) {
        const answer = await this.#page(project, `repos/${repository}/issues/comments?sort=updated&direction=asc&since=${since}&per_page=${PER_PAGE}&page=${page}`, deadline, signal)
        for (const raw of answer) {
          if (!isMap(raw)) throw unreadable()
          const id = positive(raw['id'])
          const created = time(raw['created_at'])
          through = Math.max(through, time(raw['updated_at']))
          highest = Math.max(highest, id)
          // Edited, or from before this source began watching: read once already, or never this source's.
          if (id <= seen || created <= cursor.baseline) continue
          facts.push(mentionFact(project, repository, raw, id, created))
        }
        if (answer.length < PER_PAGE) complete = true
      }
    } catch (error) {
      if (error instanceof ForgeReadError && error.budget && !signal.aborted) return this.#gap(cursor, burst)
      throw error
    }
    if (!complete) return this.#gap(cursor, burst)
    return this.#bounded(cursor, facts, {
      ...cursor, observedThrough: through, continuation: null, subjects: { [MENTION_MARK]: { head: null, event: String(highest) } },
    }, [])
  }
}

/** One comment, as a mention fact: untrusted prose, its author by stable id and validated login, and where it was made. */
const mentionFact = (project: string, repository: string, raw: Record<string, unknown>, id: number, created: number): TriggerFact => {
  const where = typeof raw['html_url'] === 'string'
    ? new RegExp(`^https://github\\.com/${repository.replace(/[.]/g, '\\.')}/(issues|pull)/([1-9][0-9]{0,15})#issuecomment-${id}$`).exec(raw['html_url'])
    : null
  if (!where) throw unreadable()
  const number = Number(where[2])
  const thread = where[1] === 'pull' ? 'pull-request' as const : 'issue' as const
  const user = isMap(raw['user']) ? raw['user'] : null
  const authorId = user && Number.isSafeInteger(user['id']) && (user['id'] as number) >= 1 ? user['id'] as number : null
  const rawLogin = user && typeof user['login'] === 'string' && LOGIN.test(user['login']) ? user['login'] : null
  const bot = user?.['type'] === 'Bot' || (rawLogin?.endsWith('[bot]') ?? false)
  return {
    source: 'mention', project, repository, subject: String(number), event: eventKey([repository, number, 'mention', id]), action: 'commented',
    at: created, head: null, fork: false, title: '', body: prose(raw['body']),
    url: confined(raw['html_url'], `/${repository}/${where[1]}/${number}`, `#issuecomment-${id}`), trigger: null,
    author: authorId === null ? null : accountDigest(authorId),
    authorWrites: null, desk: typeof raw['body'] === 'string' && isDeskPost(raw['body']),
    thread, login: rawLogin === null ? null : rawLogin.replace(/\[bot\]$/, '').toLowerCase(), bot,
  }
}

/** One issue or pull request as a mention's gate reads it. */
export interface MentionThread {
  readonly number: number
  readonly pull: boolean
  readonly state: 'open' | 'closed'
  readonly labels: readonly string[]
  readonly title: string
}

/** The cursor entry a mention source keeps its highest comment id under. */
const MENTION_MARK = '_comments'

/** An issue's watermarks, as its cursor entry keeps them; null when the issue has not been read. */
const marksOf = (event: string | undefined): { readonly e: number; readonly c: number; readonly u: number } | null => {
  if (!event) return null
  try {
    const value = JSON.parse(event) as { e?: unknown; c?: unknown; u?: unknown }
    const number = (one: unknown): number => (Number.isSafeInteger(one) && (one as number) >= 0 ? one as number : 0)
    return { e: number(value.e), c: number(value.c), u: number(value.u) }
  } catch {
    return null
  }
}

/** The forge says an account is a bot: by its type, or an app's `name[bot]` login. */
const isBot = (user: Record<string, unknown> | null): boolean =>
  user?.['type'] === 'Bot' || (typeof user?.['login'] === 'string' && user['login'].endsWith('[bot]'))

/** At most 5,000 issues are remembered: the least recently updated are forgotten, and read by time if they return. */
const prune = (subjects: Record<string, { head: string | null; event: string }>): Record<string, { head: string | null; event: string }> => {
  const entries = Object.entries(subjects)
  if (entries.length <= SUBJECT_LIMIT) return subjects
  entries.sort((a, b) => (marksOf(b[1].event)?.u ?? 0) - (marksOf(a[1].event)?.u ?? 0))
  return Object.fromEntries(entries.slice(0, SUBJECT_LIMIT))
}
