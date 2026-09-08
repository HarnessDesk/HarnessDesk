import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'

import type { Catalog } from './mapping/options.js'

/**
 * What Codex currently offers — models, collaboration modes, permission
 * profiles — fetched once and held, because every session's option list is
 * computed from it and the lists change only when the account or the
 * configuration does.
 *
 * Profiles are keyed by working directory: a project can define its own in a
 * config layer, and a thread in that project should see them.
 */
/**
 * The reason in an app-server log line that says its vendor catalogue could
 * not be read, or null for any other line.
 *
 * Codex fetches the model list from OpenAI at start and, when it cannot
 * decode the answer — a build that predates a reasoning level the catalogue
 * now names — falls back to the presets compiled into it, and says so only
 * on stderr: `failed to refresh available models: … unknown variant \`max\`
 * …; body: {…}`. That list looks complete and is not; the reason is the one
 * fact that explains it, so it is kept and shown on the model option.
 */
export const catalogWarningIn = (line: string): string | null => {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '')
  const match = /failed to refresh available models: (.*)$/.exec(plain)
  if (!match) return null
  return match[1]!
    .replace(/; body: .*$/, '')
    .replace(/ at line \d+ column \d+/, '')
    .replace(/^stream disconnected before completion: /, '')
    .trim()
}

export class CodexCatalog {
  #models: Promise<readonly CodexProtocol.v2.Model[]> | null = null
  #warning: string | null = null
  #modes: Promise<readonly CodexProtocol.v2.CollaborationModeMask[]> | null = null
  readonly #profiles = new Map<string, Promise<readonly CodexProtocol.v2.PermissionProfileSummary[]>>()

  constructor(private readonly server: CodexAppServer) {}

  async load(cwd: string): Promise<Catalog> {
    const [models, modes, profiles, requirements] = await Promise.all([
      this.models(),
      this.modes(),
      this.profiles(cwd),
      this.requirements(),
    ])
    return { models, modes, profiles, requirements, warning: this.#warning }
  }

  /**
   * Remembers why the vendor catalogue could not be read. Held for the life
   * of the process rather than the cached read — a decode failure is the
   * binary's, and the same binary fails the same way after a sign-in — and
   * dropped by `forgetWarning` when a new process starts.
   */
  noteWarning(reason: string): void {
    this.#warning = reason
  }

  forgetWarning(): void {
    this.#warning = null
  }

  get warning(): string | null {
    return this.#warning
  }

  #requirements: Promise<CodexProtocol.v2.ConfigRequirements | null> | null = null

  /** A managed configuration's limits, or null. Cached; cleared on `invalidate`. */
  requirements(): Promise<CodexProtocol.v2.ConfigRequirements | null> {
    this.#requirements ??= this.server
      .request('configRequirements/read', undefined)
      .then((response) => response.requirements)
      .catch(() => null)
    return this.#requirements
  }

  models(): Promise<readonly CodexProtocol.v2.Model[]> {
    this.#models ??= this.server
      .request('model/list', {})
      .then((response) => response.data)
      .catch((error: unknown) => {
        this.#models = null
        throw error
      })
    return this.#models
  }

  /**
   * Collaboration modes are experimental; a Codex without them is a Codex
   * without a mode control, not a failure.
   */
  modes(): Promise<readonly CodexProtocol.v2.CollaborationModeMask[]> {
    this.#modes ??= this.server
      .request('collaborationMode/list', {})
      .then((response) => response.data)
      .catch(() => [])
    return this.#modes
  }

  profiles(cwd: string): Promise<readonly CodexProtocol.v2.PermissionProfileSummary[]> {
    let pending = this.#profiles.get(cwd)
    if (!pending) {
      pending = this.server
        .request('permissionProfile/list', { cwd })
        .then((response) => response.data)
        .catch((error: unknown) => {
          this.#profiles.delete(cwd)
          throw error
        })
      this.#profiles.set(cwd, pending)
    }
    return pending
  }

  /**
   * Forgets every cached read; the next one refetches. Called when the
   * account changes, on a refresh, and when the process restarts.
   */
  invalidate(): void {
    this.#models = null
    this.#modes = null
    this.#profiles.clear()
    this.#requirements = null
  }
}
