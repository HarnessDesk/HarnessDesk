import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/**
 * Codex lets exactly one process at a time *write* a thread.
 *
 * The lock is a real `flock` on `$CODEX_HOME/thread-writer-locks/<id>.lock`,
 * taken when a thread is resumed or started and released only when the
 * process holding it exits — `thread/unsubscribe` does not give it back
 * (measured on 0.149.0). It is deliberately cross-process, because two
 * app-servers appending to one rollout would corrupt it, and every Codex on
 * the machine shares `~/.codex`: the CLI, the desktop app, and every account
 * HarnessDesk runs, whose homes are that home in symlinks.
 *
 * So "already has an active writer" is not a fault to be retried. It means
 * the conversation is open somewhere else, and the only useful thing to say
 * is where — which is what this module is for.
 */

/** Codex's own words when a second process asks to write a thread. */
const REFUSAL = /already has an active writer/i

export const isBusyRefusal = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const details = (error as { details?: unknown })['details']
  return REFUSAL.test(error.message) || (typeof details === 'string' && REFUSAL.test(details))
}

/** A `CODEX_HOME` that may be null, resolved the way Codex resolves it. */
const homeOf = (codexHome: string | null): string =>
  codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')

/**
 * The identity of the conversation store this home reads and writes.
 *
 * An account slot's home is a directory of symlinks into the agent's real
 * home, so the *paths* differ while the threads are the same files. Resolving
 * `sessions` through those links is what makes two accounts of one Codex
 * answer with one string. A home whose `sessions` does not exist yet has
 * never held a thread; the literal path is a fine answer until it does.
 */
export const sessionStoreOf = (codexHome: string | null): string => {
  const home = homeOf(codexHome)
  const sessions = join(home, 'sessions')
  try {
    return realpathSync(sessions)
  } catch {
    // Not created yet — resolve as much of the path as exists, so a home that
    // is itself a link still matches the home it points at.
  }
  try {
    return join(realpathSync(home), 'sessions')
  } catch {
    return sessions
  }
}

/** Where the lock for one thread lives. */
export const lockPathOf = (codexHome: string | null, threadId: string): string =>
  join(homeOf(codexHome), 'thread-writer-locks', `${threadId}.lock`)

/**
 * The application holding a thread's lock, in words a person recognises.
 *
 * Best effort and never load-bearing: the lock file itself is empty, so the
 * holder can only be found by asking the operating system who has it open.
 * That is `lsof`, which exists on macOS and Linux and not on Windows, and
 * which is given a short leash because this runs on the path of an error the
 * user is already waiting on. Anything unexpected answers `null`, and the
 * caller says "another Codex" instead of naming one.
 */
export const holderOf = async (
  codexHome: string | null,
  threadId: string,
  run: RunCommand = execFileAsync,
): Promise<string | null> => {
  if (process.platform === 'win32') return null
  try {
    const pids = (await run('lsof', ['-t', lockPathOf(codexHome, threadId)]))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
    for (const pid of pids) {
      // `command=` is the executable path; `codex app-server` run by an app
      // bundle is the bundle's own copy, so the path is what names the app.
      const command = (await run('ps', ['-o', 'command=', '-p', pid])).trim()
      const named = appNameOf(command)
      if (named) return named
    }
  } catch {
    // No `lsof`, no permission, a lock released between the refusal and the
    // question. None of these are worth a second sentence.
  }
  return null
}

/**
 * An app name from the command line of the process holding the lock.
 *
 * Only ever a hint, so it is deliberately conservative: a wrong name sends
 * someone to the wrong window, which is worse than the honest "another Codex"
 * the caller falls back to. Every pattern here is a path shape that cannot
 * mean anything else — a macOS bundle, a Snap, a Flatpak — and everything
 * else is either our own child, which the host names from its own registry
 * rather than from here, or a plain `codex`.
 *
 * AppImage has no name worth reading — it runs from a temporary mount called
 * `/tmp/.mount_<mangled>` — so it is answered with nothing rather than with
 * the `codex` at the end of its path, which would call a desktop app "the
 * Codex CLI" and send someone looking for a terminal.
 */
export const appNameOf = (command: string): string | null => {
  const trimmed = command.trim()
  if (!trimmed) return null
  const path = trimmed.split(/\s+/)[0] ?? ''
  const bundle = /\/([^/]+)\.app\//.exec(trimmed)
  if (bundle?.[1]) return `the ${bundle[1]} app`
  // `/snap/<name>/…`, and flatpak's reverse-DNS id under its app directory —
  // whose last segment is the part a person would recognise.
  const snap = /^\/snap\/([^/]+)\//.exec(path)
  if (snap?.[1]) return `the ${snap[1]} app`
  const flatpak = /\/flatpak\/app\/([^/]+)\//.exec(path)
  if (flatpak?.[1]) return `the ${flatpak[1].split('.').pop() ?? flatpak[1]} app`
  if (/\/\.mount_[^/]+\//.test(path)) return null
  if (basename(path) === 'codex') return 'the Codex CLI'
  return null
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<string>

const execFileAsync: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { timeout: 1_500 }, (error, stdout) => {
      // `lsof` exits non-zero when nothing has the file open, which is an
      // answer and not a failure.
      if (error && !stdout) reject(error)
      else resolve(stdout)
    })
    child.on('error', reject)
  })
