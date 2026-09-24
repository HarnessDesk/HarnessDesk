import { DEFAULT_TRIGGER_BUDGET, type TriggerDefinition, type TriggerSource } from '@harnessdesk/protocol'

import type { GhApiRunner } from '../../src/findings/forge.js'
import type { ArmedTrigger } from '../../src/intake/consent.js'

/**
 * A synthetic, paged forge for intake tests, answering exactly the fixed
 * `gh api --method GET` reads the intake adapter makes, from in-memory pull
 * requests and issues. Nothing here touches a network or a real account.
 * Every call is recorded; any read can be failed, held on a gate, or answered
 * with something malformed, to stage a real poll's failures deterministically.
 */

export const REPO = 'acme/widgets'
export const iso = (ms: number): string => new Date(ms).toISOString()
export const sha = (seed: string): string => seed.repeat(40).slice(0, 40)

export interface FakePull {
  number: number
  head: string
  state: 'open' | 'closed'
  created: number
  updated: number
  title?: string
  body?: string | null
  headRepo?: string | null
  baseRepo?: string
  url?: string
  extra?: Record<string, unknown>
}

export interface FakeIssue {
  number: number
  state: 'open' | 'closed'
  created: number
  updated: number
  title?: string
  body?: string | null
  pullRequest?: boolean
  events: { id: number; event: string; created: number }[]
  comments: { id: number; body: string; created: number; updated: number }[]
}

export type Failure = { exitCode: number; stderr: string } | 'timeout' | 'overflow' | 'malformed'

export class Gate {
  #open!: () => void
  readonly opened: Promise<void> = new Promise((resolve) => { this.#open = resolve })
  open(): void { this.#open() }
}

export class FakeForge {
  repo = REPO
  pulls: FakePull[] = []
  issues: FakeIssue[] = []
  /** Every path read, in order. */
  readonly calls: string[] = []
  /** Every argument vector, in order. */
  readonly argv: (readonly string[])[] = []
  fail: ((path: string) => Failure | null) | null = null
  gate: Gate | null = null
  /** How many reads are waiting at the gate now. */
  waiting = 0
  readonly #reached: { readonly count: number; readonly resolve: () => void }[] = []

  /** Resolves once `count` reads are held at the gate: a condition, never a timed wait. */
  reached(count: number): Promise<void> {
    if (this.waiting >= count) return Promise.resolve()
    return new Promise((resolve) => { this.#reached.push({ count, resolve }) })
  }
  /** Answers `gh repo view` with this; null answers as a folder with no GitHub remote. */
  view: { nameWithOwner: string; url: string } | null = { nameWithOwner: REPO, url: `https://github.com/${REPO}` }

  readonly runner: GhApiRunner = async (args) => {
    this.argv.push(args)
    if (args[0] === 'repo' && args[1] === 'view') {
      if (!this.view) return { stdout: '', stderr: 'no git remotes found', exitCode: 1, timedOut: false, overflow: false }
      return { stdout: JSON.stringify(this.view), stderr: '', exitCode: 0, timedOut: false, overflow: false }
    }
    const path = args[args.length - 1]!
    this.calls.push(path)
    if (this.gate) {
      this.waiting += 1
      for (const waiter of this.#reached.filter((one) => one.count <= this.waiting)) {
        this.#reached.splice(this.#reached.indexOf(waiter), 1)
        waiter.resolve()
      }
      await this.gate.opened
      this.waiting -= 1
    }
    const failure = this.fail?.(path) ?? null
    if (failure === 'timeout') return { stdout: '', stderr: '', exitCode: null, timedOut: true, overflow: false }
    if (failure === 'overflow') return { stdout: '', stderr: '', exitCode: null, timedOut: false, overflow: true }
    if (failure === 'malformed') return { stdout: '{"not": "a list"', stderr: '', exitCode: 0, timedOut: false, overflow: false }
    if (failure) return { stdout: '', stderr: failure.stderr, exitCode: failure.exitCode, timedOut: false, overflow: false }
    return { stdout: JSON.stringify(this.#answer(path)), stderr: '', exitCode: 0, timedOut: false, overflow: false }
  }

  #answer(path: string): unknown {
    const url = new URL(`https://api.invalid/${path}`)
    const page = Number(url.searchParams.get('page') ?? '1')
    const per = Number(url.searchParams.get('per_page') ?? '30')
    const slice = <T>(items: T[]): T[] => items.slice((page - 1) * per, page * per)
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] !== 'repos' || `${parts[1]}/${parts[2]}` !== this.repo) throw new Error(`unexpected path ${path}`)
    if (parts[3] === 'pulls' && parts.length === 4) {
      const state = url.searchParams.get('state')
      const rows = this.pulls.filter((one) => state === 'all' || one.state === state).sort((a, b) => b.updated - a.updated)
      return slice(rows).map((one) => this.pullJson(one))
    }
    if (parts[3] === 'issues' && parts.length === 4) {
      const rows = [...this.issues].sort((a, b) => b.updated - a.updated)
      return slice(rows).map((one) => ({
        number: one.number, title: one.title ?? `Issue ${one.number}`, body: one.body ?? null, state: one.state,
        created_at: iso(one.created), updated_at: iso(one.updated), html_url: `https://github.com/${this.repo}/issues/${one.number}`,
        ...(one.pullRequest ? { pull_request: { url: 'x' } } : {}),
      }))
    }
    if (parts[3] === 'issues' && parts[5] === 'events') {
      const issue = this.issues.find((one) => one.number === Number(parts[4]))
      return slice(issue?.events ?? []).map((one) => ({ id: one.id, event: one.event, created_at: iso(one.created) }))
    }
    if (parts[3] === 'issues' && parts[5] === 'comments') {
      const since = Date.parse(url.searchParams.get('since') ?? iso(0))
      const issue = this.issues.find((one) => one.number === Number(parts[4]))
      return slice((issue?.comments ?? []).filter((one) => one.updated >= since)).map((one) => ({
        id: one.id, body: one.body, created_at: iso(one.created), updated_at: iso(one.updated),
        html_url: `https://github.com/${this.repo}/issues/${parts[4]}#issuecomment-${one.id}`,
      }))
    }
    throw new Error(`unexpected path ${path}`)
  }

  pullJson(one: FakePull): Record<string, unknown> {
    return {
      number: one.number, title: one.title ?? `Change ${one.number}`, body: one.body ?? null, state: one.state,
      created_at: iso(one.created), updated_at: iso(one.updated),
      html_url: one.url ?? `https://github.com/${this.repo}/pull/${one.number}`,
      head: { sha: one.head, repo: one.headRepo === null ? null : { full_name: one.headRepo ?? this.repo } },
      base: { repo: { full_name: one.baseRepo ?? this.repo } },
      ...(one.extra ?? {}),
    }
  }
}

/** Two clocks a test moves by hand: the wall a slot is read from, and the monotonic one pacing uses. */
export class Clocks {
  wall: number
  mono = 0
  constructor(wall: number) { this.wall = wall }
  advance(ms: number): void {
    this.wall += ms
    this.mono += ms
  }
}

/** Lets every pending callback and promise run: never a sleep, only turns of the event loop. */
export const settle = async (turns = 20): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Timers a test drives: what `every` registered, and whether it was cleared. */
export class FakeTimers {
  readonly live = new Set<number>()
  #next = 1
  readonly every = (_fn: () => void, _ms: number): unknown => {
    const handle = this.#next++
    this.live.add(handle)
    return handle
  }
  readonly clear = (handle: unknown): void => { this.live.delete(handle as number) }
}

/** The instant the fixture's arms were armed. */
export const ARMED_AT = Date.UTC(2026, 8, 1, 10)

/** A verified arm, as `TriggerConsent.armed()` answers, for one trigger on one source. */
export const armOf = (id: string, options: { project?: string; source?: TriggerSource; baseline?: number; every?: number } = {}): ArmedTrigger => {
  const source = options.source ?? 'pull-request'
  const project = options.project ?? '/work/project'
  const on: TriggerDefinition['on'] = source === 'pull-request' ? { kind: 'pull-request', events: ['opened', 'pushed'] }
    : source === 'issue' ? { kind: 'issue', events: ['labelled', 'closed', 'commented'] }
      : { kind: 'schedule', events: ['tick'], everyMinutes: options.every ?? 60 }
  const field = source === 'pull-request' ? 'pr' : source === 'issue' ? 'issue' : 'slot'
  return {
    project, id, baseline: options.baseline ?? ARMED_AT, armedAt: options.baseline ?? ARMED_AT,
    definition: { id, on, opens: { flow: 'review-pr' }, goal: [field], again: null, dedupe: source === 'pull-request' ? ['pr', 'head', 'event'] : source === 'issue' ? ['issue', 'event'] : ['slot'], concurrency: 1, forks: 'never', budget: DEFAULT_TRIGGER_BUDGET },
    binding: { project, incarnation: 'clone-1', source: 's', closure: 'c', account: source === 'schedule' ? 'none' : 'a', repository: source === 'schedule' ? null : REPO },
  }
}

