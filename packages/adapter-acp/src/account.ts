import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { AccountStatus, AgentEvent, LoginStart, RuntimeId } from '@harnessdesk/protocol'

/**
 * Identity for ACP agents, from the agent's own CLI.
 *
 * ACP declares how to *authenticate* but never whether you already are — the
 * protocol has no account query. The CLIs behind the agents do: `claude auth
 * status` answers in JSON, `cursor-agent status` in a sentence, and both ship
 * `login`/`logout`. The registry entry names those commands and this class
 * turns them into the same account surface Codex uses, so the renderer keeps
 * zero vendor knowledge.
 *
 * Trust: `agents.json` already names the agent executable the host runs, so
 * these commands are not an escalation of what the registry can do. They are
 * executed with `execFile`/`spawn` — never a shell.
 *
 * A login command is expected to print a URL (its browser flow) and exit 0
 * once the flow completes; that maps exactly onto the `browser` LoginStart.
 * The exit settles the flow as an `account/loginCompleted` event, which is
 * how the shell hears about it — possibly long after the dialog closed.
 */

export interface AcpCommandSpec {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export interface AcpAccountCommands {
  /** Prints who is signed in: JSON (`loggedIn`, `email`) or `Logged in as …`. */
  readonly status: AcpCommandSpec
  /** Starts the browser sign-in; prints its URL; exits 0 when signed in. */
  readonly login?: AcpCommandSpec
  readonly logout?: AcpCommandSpec
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/
/** How long the login command gets to print its URL before that is an answer. */
const URL_TIMEOUT_MS = 30_000

export class CliAccount {
  readonly #logins = new Map<string, ChildProcess>()
  /** How each flow still in flight is ended by `cancel()`, before its child is killed. */
  readonly #cancels = new Map<string, () => void>()

  constructor(
    private readonly commands: AcpAccountCommands,
    private readonly runtime: RuntimeId,
    private readonly emit: (event: AgentEvent) => void,
    private readonly log?: (message: string, details?: unknown) => void,
    /**
     * @internal Seams for tests only. The ways a flow can end that a real CLI
     * cannot stage on demand — an `'error'` after its URL, two events in one
     * tick, a URL that never comes — are driven through a child the test
     * controls, with a timeout the test does not wait thirty seconds for.
     */
    private readonly seams: { readonly spawn?: typeof spawn; readonly urlTimeoutMs?: number } = {},
  ) {}

  async status(): Promise<AccountStatus> {
    const methods = this.commands.login
      ? [{ id: 'cli-browser', label: 'Sign in in your browser', flow: 'browser' as const }]
      : []
    try {
      const stdout = await this.#run(this.commands.status)
      const parsed = parseStatus(stdout)
      return { accounts: parsed ? [parsed] : [], signInMethods: methods }
    } catch (error) {
      // A status probe that fails is "signed out" with the reason logged, not
      // a broken settings page: `cursor-agent status` exits non-zero when
      // nobody is signed in.
      this.log?.('account status probe failed', { error: String(error) })
      return { accounts: [], signInMethods: methods }
    }
  }

  async login(): Promise<LoginStart> {
    const spec = this.commands.login
    if (!spec) throw new Error('This agent declares no sign-in command.')
    const loginId = randomUUID()
    const child = (this.seams.spawn ?? spawn)(spec.command, [...(spec.args ?? [])], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env },
    })
    this.#logins.set(loginId, child)

    /* A command that cannot be started — not installed, not on PATH, not
       executable — is reported by `spawn` as an `'error'` event, not as an
       exit. With no listener Node throws it, and an unhandled `'error'` takes
       the whole host process down, and every conversation on the desk with
       it. A missing sign-in binary is the ordinary state of an agent that is
       not installed yet, so it has to be a sentence rather than a crash.
       Node may or may not emit `'exit'` after an error, so the race below
       learns about it from here rather than waiting out its timeout. */
    /* One ending per flow, whichever way it ends: an error, an exit, or no
       URL in time. Before the URL is handed out nobody holds the flow's id, so
       the ending is `login()`'s to report, by rejecting, and `ending` keeps it
       for the one case the race below cannot see. After, it is the completion
       event the caller is waiting for. Every handler claims `settled` *first*:
       an `'exit'` can be queued in the same tick behind an error, and its
       handler runs before `login()`'s race hands back control. */
    let handedOut = false
    let settled = false
    let ending: string | null = null
    /* `on`, not `once`: an error that comes after the first — a kill that
       fails, a pipe that breaks in teardown — finding no listener left is
       thrown, and takes the host down with it (review, round five). The
       promise settles on the first; the listener stays for the rest. */
    /* A cancel ends the flow itself, at once, rather than leaving it to the
       exit: a child that ignores SIGTERM would never report it (review,
       round seven). Before the hand-out nobody holds the id to cancel with. */
    this.#cancels.set(loginId, () => {
      if (settled) return
      settled = true
      this.#logins.delete(loginId)
      this.#cancels.delete(loginId)
      if (handedOut) {
        this.emit({ type: 'account/loginCompleted', runtime: this.runtime, loginId, success: false, error: 'Sign-in was cancelled.' })
      }
    })
    const failed = new Promise<Error>((resolve) => child.on('error', resolve))
    void failed.then((error) => {
      if (settled) return
      settled = true
      this.#logins.delete(loginId)
      this.#cancels.delete(loginId)
      const said = `The sign-in command stopped: ${error.message}`
      if (!handedOut) {
        ending = said
        return
      }
      this.emit({ type: 'account/loginCompleted', runtime: this.runtime, loginId, success: false, error: said })
    })

    let url: string | null = null
    let resolveUrl: ((url: string) => void) | null = null
    const sawUrl = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })
    const tail: string[] = []
    const scan = (chunk: Buffer): void => {
      const text = chunk.toString()
      tail.push(text)
      if (tail.length > 40) tail.shift()
      if (url === null) {
        const match = URL_PATTERN.exec(text)
        if (match) {
          url = match[0]
          resolveUrl?.(url)
        }
      }
    }
    child.stdout!.on('data', scan)
    child.stderr!.on('data', scan)

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    )
    void exited.then(({ code, signal }) => {
      if (settled) return
      settled = true
      this.#logins.delete(loginId)
      this.#cancels.delete(loginId)
      /* Its last words, but not the prompt it printed its URL in: after the
         hand-out the tail always holds that line, and a flow killed by a
         signal reported "Open https://… to sign in" as its error (review,
         round seven). */
      const said = code === 0 ? null : lastWords(tail, url) || stoppedBy(code, signal)
      if (handedOut) {
        this.emit({
          type: 'account/loginCompleted',
          runtime: this.runtime,
          loginId,
          success: code === 0,
          ...(said ? { error: said } : {}),
        })
      } else {
        /* An exit before the URL was handed out — "already signed in", or no
           URL printed — is `login()`'s to report. It used to be reported here
           as well, as a completion for an id nobody held: two endings for one
           flow. */
        ending = said ?? (lastWords(tail) || 'The sign-in command finished before its URL could be opened.')
      }
      // Signed in or not, the account may have changed under the desk.
      if (code === 0) this.emit({ type: 'account/changed', runtime: this.runtime })
    })

    let urlTimer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      sawUrl.then((found) => ({ kind: 'url' as const, found })),
      exited.then(({ code }) => ({ kind: 'exit' as const, code })),
      failed.then((error) => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        urlTimer = setTimeout(() => resolve({ kind: 'timeout' }), this.seams.urlTimeoutMs ?? URL_TIMEOUT_MS)
        urlTimer.unref()
      }),
    ])
    // Over, whichever way it went: a flow that has ended keeps no timer (review, round six).
    clearTimeout(urlTimer)
    if (outcome.kind === 'url') {
      /* The URL won the race, but the flow can have ended in the same tick:
         an error or an exit emitted with it, whose handler ran before this
         line. Handing out its id would name a finished flow whose ending
         nobody will report, so the ending is reported here instead. A real
         child's events arrive in separate turns and cannot do this; a flow's
         state should not rest on that. Review asked. */
      if (settled) throw new Error(ending ?? 'The sign-in command stopped before its URL could be opened.')
      handedOut = true
      return { type: 'browser', loginId, url: outcome.found }
    }
    this.#logins.delete(loginId)
    this.#cancels.delete(loginId)
    if (outcome.kind === 'error') {
      throw new Error(`The sign-in command could not start (${spec.command}): ${outcome.error.message}`)
    }
    // The exit this causes finds the flow never handed out, and reports nothing.
    if (outcome.kind === 'timeout') child.kill('SIGTERM')
    throw new Error(
      outcome.kind === 'exit' && outcome.code === 0
        ? lastWords(tail) || 'Already signed in.'
        : lastWords(tail) || 'The sign-in command printed no URL to open.',
    )
  }

  async cancel(loginId: string): Promise<void> {
    // Unknown ids are not an error — the flow may have settled already.
    const child = this.#logins.get(loginId)
    this.#cancels.get(loginId)?.()
    child?.kill('SIGTERM')
    this.#logins.delete(loginId)
  }

  async logout(): Promise<void> {
    const spec = this.commands.logout
    if (!spec) throw new Error('This agent declares no sign-out command.')
    await this.#run(spec)
    this.emit({ type: 'account/changed', runtime: this.runtime })
  }

  #run(spec: AcpCommandSpec): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        spec.command,
        [...(spec.args ?? [])],
        { timeout: 20_000, env: { ...process.env, ...spec.env } },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim().split('\n').slice(-2).join(' · ') || error.message))
          else resolve(stdout)
        },
      )
    })
  }
}

/**
 * The first whole JSON object in `text`, from `from` — braces counted, and
 * ignored inside strings — or null when it never closes.
 *
 * `JSON.parse(text.slice(start))` needed the object to be the last thing a
 * CLI printed. One that answered `{"loggedIn":true,…}` and then `Session
 * active.` made the parse throw; the catch fell through to the sentence form,
 * the sentence form found nothing, and a signed-in account was reported as
 * signed out. Strings are tracked because an email or a plan name may contain
 * a brace, and counting that one would end the object in the wrong place.
 */
const firstObject = (text: string, from: number): string | null => {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

/**
 * The first object in `text` that parses as JSON **and says something about
 * sign-in** — `loggedIn`, `logged_in` or `email`.
 *
 * Not simply the first brace. A CLI can print `info {cache}` before its
 * status, or log in NDJSON, and anchoring on the first `{` read that preface:
 * it failed to parse, or parsed and said nothing, and a signed-in account was
 * reported as signed out — the very outcome #39 was about, one line earlier
 * in the output. Found in review. Each opening brace is tried in turn; a run
 * that closes but is not JSON, or is JSON about something else, is passed
 * over rather than ending the search.
 */
/** A brace that opens a JSON record: the brace, then its first key. */
const RECORD_OPENING = /\{\s*"/y

const statusRecords = (
  text: string,
): { status: Record<string, unknown> | null; emailOnly: Record<string, unknown> | null; prose: string } => {
  let emailOnly: Record<string, unknown> | null = null
  // Where each object was, so that what is left is the prose a sentence is read from.
  const objects: (readonly [number, number])[] = []
  let end = text.length
  /* Objects at the top level only: after a whole object the search goes on
     from its end, not from the brace after its start, so no object nested in
     another is ever a candidate (round two). */
  for (let at = text.indexOf('{'); at !== -1; ) {
    const candidate = firstObject(text, at)
    if (candidate === null) {
      /* An object that never closes holds everything after it, so nothing
         after it is at the top level, and the scan stops. Resuming at the next
         brace walked into it: truncated output such as
         `{"wrap":{"loggedIn":true,…}` read as signed in (review, round four).
         That holds for a record's opening, a brace and then a key. A brace in
         a line of prose is only a character: `[INFO] {cache-init` ahead of the
         status took the status down with it (review, round six). */
      RECORD_OPENING.lastIndex = at
      if (RECORD_OPENING.test(text)) {
        end = at
        break
      }
      at = text.indexOf('{', at + 1)
      continue
    }
    objects.push([at, at + candidate.length])
    at = text.indexOf('{', at + candidate.length)
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    /* A record that says, in a boolean, whether the account is signed in is
       the status. A log line's field that is there with nothing in it
       (`"loggedIn": null`) is not, and must not stand in for the status after
       it (review, round six). One that only names an email may be the status
       of a CLI that answers that way, or a log line that happens to carry one
       (round three), so it is kept as the answer of last resort. */
    if (typeof record['loggedIn'] === 'boolean' || typeof record['logged_in'] === 'boolean') {
      return { status: record, emailOnly, prose: '' }
    }
    if (emailOnly === null && typeof record['email'] === 'string' && record['email'] !== '') emailOnly = record
  }
  /* The text around the objects, and nothing after a record cut short. An
     object is cut out of the sentence it sits in, not made a break in it: a
     break ends a clause, and `Not {cache} logged in as …` read as signed in
     (review, round nine). */
  let prose = ''
  let from = 0
  for (const [start, stop] of objects) {
    prose += `${text.slice(from, start)} `
    from = stop
  }
  return { status: null, emailOnly, prose: prose + text.slice(from, end) }
}

/**
 * A sentence saying nobody is signed in: a negation anywhere in the clause
 * before the verb, or signed out. A negation is `not`, `no longer`, `never`,
 * or a contraction of one, `aren't` or `isn't`, in either apostrophe
 * (review, round eight). A clause ends at `!`, `?` and `;` as it does at a
 * full stop, and a sign-out said to be in the past ("last logged out") is
 * not the state now, where "you were logged out" still is (review, round
 * nine).
 */
const SIGNED_OUT = /(?:\b(?:not|no longer|never)\b|n['’]t\b)[^.!?;\n]*?\b(?:logged|signed) in\b|(?<!\b(?:last|previously|formerly)\s+)\b(?:logged|signed) out\b/i

/** A sentence saying who is signed in now: not "last", "previously" or "was" signed in. */
const SIGNED_IN = /(?<!\b(?:last|previously|formerly|was|were)\s+)\b(?:logged|signed) in as[: ]+(\S+)/i

/** One account from whatever the status command printed, or null for signed out. */
export const parseStatus = (
  stdout: string,
): { kind: string; label: string; email?: string; planType?: string } | null => {
  const text = stdout.trim()
  const { status, emailOnly, prose } = statusRecords(text)
  if (status !== null) return fromRecord(status)
  /* Sentences are read from the prose alone: a JSON log line's text is not the
     CLI saying who is signed in, and `{"msg":"logged in as warmup"}` read as
     the account `warmup"}` (review, round six). A sentence that says who is
     signed in outranks a record that only names an email, which may be a log
     line's (review, round four); and "Not logged in as …" names someone to say
     the opposite (review, round six). */
  /* A sentence saying nobody is signed in is read first, and it wins, over a
     record that only names an email (review, round five) and over a sentence
     naming someone. A negation can sit anywhere before the verb ("not
     currently logged in"), and one line can hold both ("Not signed in. Last
     logged in as …"); guarded word by word, each read as signed in (review,
     round seven). Signed out is the safer mistake: it asks for a sign-in,
     where a wrong signed-in fails every request after it. */
  if (SIGNED_OUT.test(prose)) return null
  const identity = SIGNED_IN.exec(prose)?.[1]?.replace(/^["'`]+|["'`.,]+$/g, '') ?? ''
  // One that names nobody is no answer: `Logged in as ""` was an account with no name (review, round seven).
  if (identity !== '') return { kind: 'cli', label: identity, ...(identity.includes('@') ? { email: identity } : {}) }
  return emailOnly !== null ? fromRecord(emailOnly) : null
}

/** An account from a status record, or null when it says signed out or says nothing. */
const fromRecord = (record: Record<string, unknown>): { kind: string; label: string; email?: string; planType?: string } | null => {
  const loggedIn = record['loggedIn'] ?? record['logged_in']
  if (loggedIn === false) return null
  const email = typeof record['email'] === 'string' ? record['email'] : undefined
  const plan = record['planType'] ?? record['plan'] ?? record['subscriptionType']
  if (loggedIn === true || email) {
    return {
      kind: 'cli',
      label: email ?? 'Signed in',
      ...(email ? { email } : {}),
      ...(typeof plan === 'string' ? { planType: plan } : {}),
    }
  }
  return null
}

/** How a sign-in command ended, when it said nothing else: a signal is not a code. */
const stoppedBy = (code: number | null, signal: NodeJS.Signals | null): string =>
  code !== null ? `The sign-in command exited with code ${code}.` : `The sign-in command was stopped${signal ? ` (${signal})` : ''}.`

const lastWords = (tail: readonly string[], skip: string | null = null): string =>
  tail
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && (skip === null || !line.includes(skip)))
    .slice(-2)
    .join(' · ')
