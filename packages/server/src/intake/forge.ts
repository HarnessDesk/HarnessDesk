import { createHash } from 'node:crypto'

import type { TriggerAction, TriggerFact, TriggerSource } from '@harnessdesk/protocol'

import { spawnGh, type GhApiRunner } from '../findings/forge.js'
import { isDeskPost } from '../findings/publication.js'
import { labelName } from './definition.js'
import { eventKey } from './keys.js'

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
}

export interface PollBatch {
  readonly facts: readonly TriggerFact[]
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
const BATCH_BYTES = 2 * 1024 * 1024
const ISSUE_LIMIT = 100
const SUBJECT_LIMIT = 5000
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
}

export class ForgeSource {
  readonly #run: GhApiRunner
  readonly #now: () => number
  readonly #timeoutMs: number
  readonly #maxBytes: number
  readonly #maxPages: number

  constructor(options: ForgeSourceOptions) {
    this.#run = options.run ?? spawnGh()
    this.#now = options.now
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#maxBytes = options.maxBytes ?? 4 * 1024 * 1024
    this.#maxPages = options.maxPages ?? 10
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
    if (result.overflow) throw unreadable()
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
    return {
      number: read.number, head: read.head, headRepo: lost ? null : read.headRepo, baseRepo: read.baseRepo, state,
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
  async inventory(project: string, source: 'pull-request' | 'issue', repository: string, signal: AbortSignal): Promise<SourceCursor> {
    if (!validRepo(repository)) throw unreadable()
    const now = this.#now()
    const deadline = Date.now() + this.#timeoutMs
    const subjects: Record<string, { head: string | null; event: string }> = {}
    if (source === 'issue') {
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
    const list = cursor.source === 'issue' ? 'issues?state=all' : 'pulls?state=open'
    await this.#page(project, `repos/${repository}/${list}&sort=updated&direction=desc&per_page=${PER_PAGE}&page=1`, Date.now() + this.#timeoutMs, signal)
  }

  /**
   * `permissions`: a trigger on this source lets collaborators' comments
   * fire it, so each new comment's author is asked about once — one bounded
   * read per comment, never for a desk post or an unreadable author.
   */
  async poll(project: string, cursor: SourceCursor, signal: AbortSignal, options: { readonly permissions?: boolean } = {}): Promise<PollBatch> {
    if (cursor.source === 'pull-request') return this.#pulls(project, cursor, signal)
    if (cursor.source === 'issue') return this.#issues(project, cursor, signal, options.permissions === true)
    throw unreadable()
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

  async #pulls(project: string, cursor: SourceCursor, signal: AbortSignal): Promise<PollBatch> {
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
    return this.#bounded(cursor, facts, { ...cursor, observedThrough: through, continuation: null, subjects }, skipped)
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
  async #issues(project: string, cursor: SourceCursor, signal: AbortSignal, permissions: boolean): Promise<PollBatch> {
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
            let writes: boolean | null = null
            if (permissions && !desk && authorId !== null && login !== null) {
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
}

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

/** At most 5,000 issues are remembered: the least recently updated are forgotten, and read by time if they return. */
const prune = (subjects: Record<string, { head: string | null; event: string }>): Record<string, { head: string | null; event: string }> => {
  const entries = Object.entries(subjects)
  if (entries.length <= SUBJECT_LIMIT) return subjects
  entries.sort((a, b) => (marksOf(b[1].event)?.u ?? 0) - (marksOf(a[1].event)?.u ?? 0))
  return Object.fromEntries(entries.slice(0, SUBJECT_LIMIT))
}
