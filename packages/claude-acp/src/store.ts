import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

/**
 * Claude Code's own conversation store, and the one thing this bridge writes
 * to it: removing a conversation the user asked to delete.
 *
 * The layout, as the base bridge spells it:
 *
 * ```
 * ~/.claude/projects/<cwd with every non-alphanumeric turned into ->/
 *   <session id>.jsonl     the transcript
 *   <session id>/          sidecar files, when the session has any
 * ```
 *
 * Two rules, and they are the whole module. **Nothing is edited** — a bridge
 * that rewrote another application's records would break the moment that
 * application changed them; a whole conversation moved out of the way breaks
 * nothing, because the only thing that reads it is the entry it was named by.
 * And **nothing is erased**: what is removed goes to the user's Trash, so a
 * confirmation misread at midnight costs a drag back out rather than the
 * work. That is also the honest reading of "delete" on a desktop — the
 * Finder's delete has meant this since 1984.
 *
 * The session id alone is enough to find it. Claude Code keys transcripts by
 * project directory, and a delete request carries no cwd, so the projects
 * tree is scanned; the ids are UUIDs and every match is the same conversation.
 */

/**
 * Where Claude Code keeps everything, read at call time rather than at import
 * — the bridge is started with `CLAUDE_CONFIG_DIR` set by whoever ran it.
 */
export const claudeConfigDir = (): string =>
  process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')

/** A session id shaped like the ones Claude Code mints, and nothing else. */
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * Everything Claude Code holds for one session: the transcript, and the
 * sidecar directory beside it when the session has one. Empty when the agent
 * never wrote anything for that id, which is the ordinary case for a session
 * opened and closed without a turn.
 */
export const sessionFiles = (
  sessionId: string,
  configDir = claudeConfigDir(),
): readonly string[] => {
  // A traversal dressed as a session id must not reach outside the tree.
  if (!SESSION_ID.test(sessionId)) return []
  const root = join(configDir, 'projects')
  let projects: readonly string[]
  try {
    projects = readdirSync(root)
  } catch {
    return []
  }
  const found: string[] = []
  for (const project of projects) {
    for (const candidate of [join(root, project, `${sessionId}.jsonl`), join(root, project, sessionId)]) {
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Moves paths into the user's Trash and answers with the ones that moved.
 *
 * A rename within the same volume, which is what the Trash is for anything
 * under the home directory. A name already taken there gets a numbered
 * suffix rather than overwriting whatever is sitting in the Trash — the whole
 * point of this function is that nothing is destroyed.
 */
export const trash = (paths: readonly string[], home = homedir()): readonly string[] => {
  if (paths.length === 0) return []
  const dir = join(home, '.Trash')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return []
  }
  const moved: string[] = []
  for (const path of paths) {
    try {
      renameSync(path, freeName(dir, basename(path)))
      moved.push(path)
    } catch {
      // A file already gone, or one the process cannot move, is reported by
      // its absence from the answer rather than by taking the delete down.
    }
  }
  return moved
}

const freeName = (dir: string, name: string): string => {
  let candidate = join(dir, name)
  if (!taken(candidate)) return candidate
  const extension = extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  for (let n = 2; n < 1000; n += 1) {
    candidate = join(dir, `${stem} ${n}${extension}`)
    if (!taken(candidate)) return candidate
  }
  return join(dir, `${stem} ${Date.now()}${extension}`)
}

const taken = (path: string): boolean => {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
