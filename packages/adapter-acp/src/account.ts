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

  constructor(
    private readonly commands: AcpAccountCommands,
    private readonly runtime: RuntimeId,
    private readonly emit: (event: AgentEvent) => void,
    private readonly log?: (message: string, details?: unknown) => void,
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
    const child = spawn(spec.command, [...(spec.args ?? [])], {
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
    let handedOut = false
    let settled = false
    const failed = new Promise<Error>((resolve) => child.once('error', resolve))
    void failed.then((error) => {
      // Before the URL is handed out, `login()` reports it itself, below.
      // After, the flow it started must be told it is over, or the sign-in
      // page waits for an exit that may never come.
      if (!handedOut || settled) return
      settled = true
      this.#logins.delete(loginId)
      this.emit({
        type: 'account/loginCompleted',
        runtime: this.runtime,
        loginId,
        success: false,
        error: `The sign-in command stopped: ${error.message}`,
      })
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

    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    void exited.then((code) => {
      // An error may already have closed this flow; one ending is enough.
      if (settled) return
      settled = true
      this.#logins.delete(loginId)
      this.emit({
        type: 'account/loginCompleted',
        runtime: this.runtime,
        loginId,
        success: code === 0,
        ...(code === 0 ? {} : { error: lastWords(tail) || `The sign-in command exited with code ${String(code)}.` }),
      })
      if (code === 0) this.emit({ type: 'account/changed', runtime: this.runtime })
    })

    const outcome = await Promise.race([
      sawUrl.then((found) => ({ kind: 'url' as const, found })),
      exited.then((code) => ({ kind: 'exit' as const, code })),
      failed.then((error) => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), URL_TIMEOUT_MS).unref(),
      ),
    ])
    if (outcome.kind === 'url') {
      handedOut = true
      return { type: 'browser', loginId, url: outcome.found }
    }
    this.#logins.delete(loginId)
    if (outcome.kind === 'error') {
      throw new Error(`The sign-in command could not start (${spec.command}): ${outcome.error.message}`)
    }
    if (outcome.kind === 'timeout') child.kill('SIGTERM')
    throw new Error(
      outcome.kind === 'exit' && outcome.code === 0
        ? lastWords(tail) || 'Already signed in.'
        : lastWords(tail) || 'The sign-in command printed no URL to open.',
    )
  }

  async cancel(loginId: string): Promise<void> {
    // Unknown ids are not an error — the flow may have settled already.
    this.#logins.get(loginId)?.kill('SIGTERM')
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

/** One account from whatever the status command printed, or null for signed out. */
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

export const parseStatus = (
  stdout: string,
): { kind: string; label: string; email?: string; planType?: string } | null => {
  const text = stdout.trim()
  const jsonStart = text.indexOf('{')
  const json = jsonStart === -1 ? null : firstObject(text, jsonStart)
  if (json !== null) {
    try {
      const record = JSON.parse(json) as Record<string, unknown>
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
    } catch {
      // Not JSON after all; fall through to the sentence form.
    }
  }
  const sentence = /logged in(?: as[: ]+)(\S+)/i.exec(text)
  if (sentence) {
    const identity = sentence[1]!.replace(/[.,]$/, '')
    return { kind: 'cli', label: identity, ...(identity.includes('@') ? { email: identity } : {}) }
  }
  return null
}

const lastWords = (tail: readonly string[]): string =>
  tail
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' · ')
