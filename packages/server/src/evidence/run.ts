import { spawn, type ChildProcess } from 'node:child_process'

import { TAIL_LIMIT } from './records.js'

export { TAIL_LIMIT }

/**
 * Runs one command the way a person would type it, and keeps the end of what
 * it printed.
 *
 * Through a shell, because a check is written as it is typed — `pnpm verify`,
 * `cargo test && cargo clippy`. Only ever called with a command a person has
 * seen, verbatim, on this machine, and approved (`check-runs.ts`).
 *
 * **What it runs with.** The person's own authority — their files, their
 * network, their tools — as it would in their terminal; the question that
 * approves a command says so. What it does not get is the desk's: it starts in
 * a small environment built from `ENVIRONMENT`, a list of names, so none of the
 * desk's own variables — its state paths, its port, its tokens, anything a
 * runtime or the shell app put into the desk's environment — reaches it.
 *
 * **What stopping it means.** It runs in its own process group, and a timeout
 * or a quit stops that group: the shell and every process that stays in it. A
 * process that leaves the group — a daemon, anything started in a session of
 * its own — is not stopped, and a desk that ends abruptly stops nothing. The
 * guarantee is the group, and nothing wider.
 *
 * The flow engine's `runCheck` (`flows.ts`) keeps nothing of what a command
 * prints; a check a person runs from a card has to be able to say why it
 * failed. Phase 6 moves flows onto this one.
 */

/**
 * The only variables a check's environment is built from, taken from the
 * desk's own when it has them: where tools are found, whose account it is, the
 * locale and time zone, where temporary files go, and the person's own proxy.
 * Nothing else passes — not the desk's `HARNESSDESK_*`, not a token or key,
 * not an agent's variables. `TERM` is always `dumb`: nobody is watching a
 * terminal.
 */
export const ENVIRONMENT = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

/** A check's environment, from the desk's: only the names in `ENVIRONMENT`. */
export const checkEnvironment = (from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { TERM: 'dumb' }
  for (const name of ENVIRONMENT) {
    const value = from[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** How long a check's own output may stay open after its shell has exited — a child holding the pipe. */
const AFTER_EXIT_MS = 1_000

export interface CommandRun {
  /** Its exit status; null when it did not exit by itself — it ran over its time, was stopped, or never started. */
  readonly exit: number | null
  readonly timedOut: boolean
  /** The last of what it printed, both streams in the order they arrived, or why it never started. */
  readonly tail: string
}

/** Colour and cursor codes, and every other control character but line feeds and tabs. */
const plain = (text: string): string =>
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const stopGroup = (child: ChildProcess): void => {
  try {
    // A negative pid is the group: the shell and every process still in it.
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

export const runCommand = (
  command: string,
  where: {
    readonly cwd: string
    readonly timeoutSec: number
    /** Stops it now, with its process group — the desk is closing. Already aborted, it never starts. */
    readonly signal?: AbortSignal
  },
): Promise<CommandRun> =>
  new Promise((resolve) => {
    if (where.signal?.aborted) {
      resolve({ exit: null, timedOut: false, tail: 'It was stopped: the desk closed.' })
      return
    }
    let printed = ''
    let settled = false
    let timedOut = false
    let afterExit: ReturnType<typeof setTimeout> | null = null
    const child = spawn(command, {
      cwd: where.cwd,
      shell: true,
      detached: true,
      env: checkEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (exit: number | null, said?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (afterExit) clearTimeout(afterExit)
      const text = plain(printed)
      const joined = said ? `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${said}` : text
      resolve({ exit, timedOut, tail: joined.slice(-TAIL_LIMIT) })
    }
    const keep = (chunk: Buffer): void => {
      printed = (printed + chunk.toString('utf8')).slice(-TAIL_LIMIT * 4)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopGroup(child)
      finish(null, `It ran past ${where.timeoutSec}s and was stopped.`)
    }, where.timeoutSec * 1000)
    // A check left running cannot hold a quit open; the kill above is what ends it.
    timer.unref?.()
    const stop = (): void => {
      stopGroup(child)
      finish(null, 'It was stopped: the desk closed.')
    }
    where.signal?.addEventListener('abort', stop, { once: true })
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => finish(null, `It did not start: ${error.message}`))
    child.on('exit', (code, killedBy) => {
      const exit = killedBy ? null : code
      // The streams close after the shell exits; a child still holding them is ended, not waited for.
      afterExit = setTimeout(() => {
        stopGroup(child)
        finish(exit)
      }, AFTER_EXIT_MS)
      afterExit.unref?.()
      child.on('close', () => finish(exit))
    })
  })
