import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'
import { runtimeId, type RuntimeId } from '@harnessdesk/protocol'

import { AgentRegistryStore } from './agent-registry.js'
import { knownAgent } from './installs/known-agents.js'

/**
 * More than one Antigravity account.
 *
 * Antigravity's ACP server holds one Google session, and on macOS that
 * session is in the keychain, not under `GEMINI_HOME` — so a second home was
 * not a second account (#749, measured 2026-09-17), and this file could not
 * exist until that was answered.
 *
 * It was, on 2026-10-17, with two Google accounts: `AGY_ACP_FORCE_FILE_STORAGE=1`
 * makes the server keep its token in `<GEMINI_HOME>/antigravity-acp/acp_token.json`
 * instead of the keychain, and a `GEMINI_HOME` of its own then really is an
 * account of its own. Each row's token stayed in its own folder, both survived
 * a restart, signing one out left the other signed in, and the keychain was
 * never touched.
 *
 * So an extra Antigravity account is not a slot under `accounts.ts` — it is a
 * second **agent row** running the same server over its own folder. That costs
 * it the shared conversation store a Codex slot keeps (Antigravity's
 * conversations live under `GEMINI_HOME/antigravity-acp/conversations`, so each
 * account's are its own), and it buys the isolation the keychain denied.
 *
 * The row with the agent's own id is left exactly as it is: the keychain, the
 * default home, nothing changed here.
 */

/** Antigravity's known-agent id, which its rows carry. */
const ANTIGRAVITY = 'antigravity-acp'

/** The variable that moves Antigravity's whole home. See `installs/known-agents.ts`. */
const HOME_ENV = knownAgent(ANTIGRAVITY)?.home.env ?? 'GEMINI_HOME'

/**
 * The one that moves the token, not just the settings.
 *
 * Measured, not documented: with it unset the server refreshes the last
 * account's keychain token however the home is pointed, which is the whole
 * reason a second `GEMINI_HOME` used to be one account twice.
 */
const FORCE_FILE_STORAGE_ENV = 'AGY_ACP_FORCE_FILE_STORAGE'

/** The home the agent itself would use, when a row names none. */
const defaultHome = (): string => join(homedir(), '.gemini')

/** Whether a directory path is strictly a descendant of `parentDir`. */
const isUnder = (candidate: string, parentDir: string): boolean => {
  let resolvedParent = resolve(parentDir)
  let resolvedCandidate = resolve(candidate)
  try {
    resolvedParent = realpathSync.native(resolvedParent)
  } catch {}
  try {
    resolvedCandidate = realpathSync.native(resolvedCandidate)
  } catch {}
  const rel = relative(resolvedParent, resolvedCandidate)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** One Antigravity account: the row, its credential home, and whether it may go. */
export interface AcpAccountSlot {
  /** The runtime whose account this is — the original row's id. */
  readonly agent: RuntimeId
  /** Where this account's `GEMINI_HOME` is. */
  readonly home: string
  /** False for the agent's original row, which owns the keychain and the default home. */
  readonly removable: boolean
}

const envOf = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/**
 * The rows of an agent that holds more than one account.
 *
 * Small on purpose: the host's `AccountFactory` is where a slot becomes a
 * runtime, and everything this does is the part only the registry knows —
 * which rows are Antigravity rows, where an account's home is, and how one is
 * made or taken away. No host, no runtime, no process: it is testable with a
 * temp `agents.json` and nothing else.
 */
export class AcpAccounts {
  constructor(
    private readonly options: {
      readonly store: AgentRegistryStore
      /** Where `accounts/<id>` folders live; the same state directory as `agents.json`. */
      readonly stateDir: string
      /**
       * How a folder is taken away. Absent leaves it exactly where it is,
       * which is the honest answer for a caller that holds no Trash — better
       * than a `rm -rf` of a folder holding a live sign-in.
       */
      readonly trash?: (path: string) => Promise<void>
      readonly log?: (message: string, details?: Record<string, unknown>) => void
    },
  ) {}

  #entry(id: string): Readonly<Record<string, unknown>> | null {
    return this.options.store.entry(id)
  }

  /** Whether `entry` is Antigravity's own row, or an account of one. */
  #isAntigravity(entry: Readonly<Record<string, unknown>>): boolean {
    if (entry['id'] === ANTIGRAVITY || entry['agent'] === ANTIGRAVITY) return true
    const parent = entry['accountOf']
    if (typeof parent !== 'string') return false
    const original = this.#entry(parent)
    return original !== null && this.#isAntigravity(original)
  }

  /** The row this one is an account of — itself, when it is the original. */
  #originalId(entry: Readonly<Record<string, unknown>>): string {
    const parent = entry['accountOf']
    return typeof parent === 'string' ? parent : String(entry['id'])
  }

  /** The home the row's own environment names, or null when it names none. */
  #homeOf(entry: Readonly<Record<string, unknown>>): string | null {
    const home = envOf(entry['env'])[HOME_ENV]
    return typeof home === 'string' && home !== '' ? home : null
  }

  canAdd(id: string): boolean {
    const entry = this.#entry(id)
    return entry !== null && this.#isAntigravity(entry)
  }

  slotOf(id: string): AcpAccountSlot | null {
    const entry = this.#entry(id)
    if (!entry || !this.#isAntigravity(entry)) return null
    const originalId = this.#originalId(entry)
    if (originalId === String(entry['id'])) {
      return { agent: runtimeId(originalId), home: this.#homeOf(entry) ?? defaultHome(), removable: false }
    }
    // An extra row with no home of its own is not one this desk made and not
    // one it will touch: whatever it is, it is not an account of its own.
    const home = this.#homeOf(entry)
    if (home === null) return null
    return { agent: runtimeId(originalId), home, removable: true }
  }

  /**
   * Makes one more account: a row of its own over a folder of its own.
   *
   * The folder is created before the row is written, so a row that exists is
   * a row whose home exists — the agent starts against it and writes its
   * token there. `0o700` because a credential lands inside it.
   */
  add(id: string, name?: string): AcpAgentConfig {
    const entry = this.#entry(id)
    if (!entry || !this.#isAntigravity(entry)) {
      throw new Error('This agent cannot hold another account.')
    }
    const originalId = this.#originalId(entry)
    const original = this.#entry(originalId)
    if (!original || typeof original['command'] !== 'string') {
      throw new Error(`The account ${JSON.stringify(originalId)} is not an agent this desk can run.`)
    }
    const newId = `${originalId}-${randomBytes(3).toString('hex')}`
    const folder = join(this.options.stateDir, 'accounts', newId)
    mkdirSync(folder, { recursive: true, mode: 0o700 })

    const given = name?.trim()
    const originalName = typeof original['name'] === 'string' ? original['name'] : originalId
    // Deliberately no `registry`: that provenance names a download the desk
    // made, and `AgentDirectory.remove` uninstalls it. The download is the
    // original's, and carrying it here would let removing this account take
    // the agent away from the account that is still there.
    const row: Record<string, unknown> & { id: string } = {
      id: newId,
      name: given && given !== '' ? given : this.#nextName(originalId, originalName),
      command: original['command'],
      ...(original['args'] !== undefined ? { args: original['args'] } : {}),
      ...(original['brand'] !== undefined ? { brand: original['brand'] } : {}),
      ...(original['tagline'] !== undefined ? { tagline: original['tagline'] } : {}),
      // The variable the agent's own row carries this under, if it carries
      // one; the known-agent table's id otherwise.
      agent: typeof original['agent'] === 'string' ? original['agent'] : ANTIGRAVITY,
      env: {
        ...envOf(original['env']),
        [HOME_ENV]: folder,
        [FORCE_FILE_STORAGE_ENV]: '1',
      },
      accountOf: originalId,
    }
    this.options.store.add(row)

    const config = this.options.store.configs().find((candidate) => candidate.id === newId)
    if (!config) {
      throw new Error(`The account ${JSON.stringify(newId)} could not be read back from the registry.`)
    }
    this.options.log?.('account added', { agent: originalId, runtime: newId, home: folder })
    return config
  }

  /**
   * Takes an extra account away.
   *
   * The row goes first, so a folder is never left orphaned by a row that
   * survived: what is left behind, if the Trash fails, is a folder nothing
   * points at rather than a row pointing at nothing.
   *
   * The folder is **moved**, never deleted. It holds a live Google token, and
   * a person who removes the wrong account wants it back.
   */
  async remove(id: string): Promise<void> {
    const entry = this.#entry(id)
    if (!entry || !this.#isAntigravity(entry)) {
      throw new Error('This is not an account of an agent that holds more than one here.')
    }
    if (this.#originalId(entry) === String(entry['id'])) {
      throw new Error("This agent's original account cannot be removed.")
    }
    const home = this.#homeOf(entry)
    if (home === null) {
      throw new Error(`The account ${JSON.stringify(String(entry['id']))} has no home of its own to remove.`)
    }
    // Refused before anything moves: a hand-edited `agents.json` can name a
    // folder this desk never made, and the Trash is not reversible enough to
    // take a guess about whose it is.
    const accountsDir = resolve(this.options.stateDir, 'accounts')
    if (!isUnder(home, accountsDir)) {
      throw new Error(`The account ${JSON.stringify(String(entry['id']))} keeps its home outside ${accountsDir}; refusing to remove it.`)
    }
    this.options.store.remove(id)
    this.options.log?.('account removed', { runtime: id, home })
    if (!this.options.trash) return
    try {
      await this.options.trash(home)
    } catch (error) {
      this.options.log?.('the account home could not be moved to the Trash', {
        runtime: id,
        home,
        error: String(error),
      })
    }
  }

  /** The first `<name> N` no row of this agent already uses. */
  #nextName(originalId: string, originalName: string): string {
    const used = new Set<string>()
    for (const entry of this.options.store.entries()) {
      if (this.#originalId(entry) !== originalId) continue
      if (typeof entry['name'] === 'string') used.add(entry['name'])
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${originalName} ${n}`
      if (!used.has(candidate)) return candidate
    }
  }
}
