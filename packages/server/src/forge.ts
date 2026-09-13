import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import type { ForgeEngine, ForgeIdentity, ForgeRunOptions, ForgeRunResult, ForgeScope, ForgeSeat } from '@harnessdesk/cordis-host'
import { isForgeReference, itemId, type ConfigOption, type ForgeReference, type PublicationItem } from '@harnessdesk/protocol'

import { seatOf } from './seat.js'

/**
 * The forge plane: what the desk adds around a git forge.
 *
 * A pull request an agent opens from here is published *through the desk*,
 * and two things follow from that which nothing else can supply. The
 * **seat** — which agent, on which model, at which effort — is a fact about
 * the conversation that made the tool call; the Git plugin renders it into
 * the signature the person configured, and this is where it is read from.
 * The **record** of what was published belongs in the transcript, drawn as
 * the object it is rather than as a line of shell output; this is what puts
 * it there, as a `publication` item in the turn that was running.
 *
 * The forge itself is reached with the person's own `gh`, by the plugin,
 * under its `shell` grant — the credential stays where it was, and a GitHub
 * App the desk installs later becomes a second way to reach the same forge
 * (`ForgeIdentity.via`), not a different feature.
 *
 * And one sentence for the agents: the standing instruction that names the
 * `pr_*` tools, handed to each agent through its own instruction layer —
 * never through the conversation, which is the person's. See `instructions`.
 */

/** The forge plane's window onto the host. */
export interface ForgePort {
  /** The agent behind a runtime — its presentation name and version — or null when the host has no such runtime. */
  agentOf(runtime: string): { readonly name: string; readonly version: string | null } | null
  /** The controls of a conversation with their current values, or null when the host holds no such conversation. */
  optionsOf(runtime: string, sessionId: string): readonly ConfigOption[] | null
  /**
   * Puts a publication into a conversation's transcript, in the turn that is
   * running. False when the host holds no such conversation, or it has no
   * turn to put it in.
   */
  record(runtime: string, sessionId: string, item: PublicationItem): boolean
  /** Whether the `pr_*` tools are registered right now — the instruction names them. */
  toolsOffered(): boolean
}

export interface ForgePlaneOptions {
  /**
   * The person's `gh`, used by the default runner. Overridable so a test can
   * answer as a forge would, and so the packaged app can point at the copy it
   * found.
   */
  readonly gh?: GhRunner
  /**
   * A repository-scoped forge transport. The desktop supplies no App key or
   * token: a future hosted service selects a short-lived installation token
   * from `options.cwd` and returns an identity with `via: 'app'`.
   */
  readonly runner?: ForgeRunner
  /** How long an identity answer stands before `gh` is asked again. */
  readonly identityTtlMs?: number
}

export type GhRunner = (args: readonly string[], options?: ForgeRunOptions) => Promise<ForgeRunResult>

/**
 * The only seam a future GitHub App needs. It receives the actual checkout
 * path for every operation, so its service can select that repository's
 * installation; credentials remain service-side and are never persisted in
 * the desktop or exposed to a plugin.
 */
export interface ForgeRunner {
  identity(options: ForgeRunOptions, scope: ForgeScope): Promise<ForgeIdentity>
  run(args: readonly string[], options: ForgeRunOptions, scope: ForgeScope): Promise<ForgeRunResult>
}

const run = promisify(execFile)

/** `gh` on PATH, the way the plugin reaches it: `execFile`, never a shell. */
export const ghOnPath: GhRunner = async (args, options) => {
  try {
    const result = await run('gh', [...args], {
      cwd: options?.cwd,
      timeout: options?.timeoutMs ?? 15_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    return {
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? failure.message ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    }
  }
}

/**
 * The one sentence every agent is told, in the channel its vendor built for
 * standing instructions. One sentence and no paragraph, because the tools'
 * own descriptions carry the rest, and because a longer briefing on every
 * conversation is a tax the person did not ask to pay. Named tools, so an
 * agent that reads it knows what to call; "rather than gh", so the agent
 * that already knows `gh` understands the trade.
 */
export const FORGE_INSTRUCTION =
  'Open, update and review pull requests with the HarnessDesk pr_create, pr_update and pr_review tools rather than gh: they sign the pull request for this seat and put it in the conversation.'

const DEFAULT_IDENTITY_TTL_MS = 5 * 60_000

/** What `gh` says when nobody is signed in, in the words it has used across versions. */
const NOT_SIGNED_IN = /not logged in|not logged into|authentication|gh auth login|HTTP 401/i

const identityFromGh = async (gh: GhRunner): Promise<ForgeIdentity> => {
  const result = await gh(['api', 'user', '--jq', '.login'])
  const login = result.stdout.trim()
  if (result.exitCode === 0 && login !== '') {
    return { via: 'gh', login, available: true, reason: null }
  }
  const said = `${result.stderr} ${result.stdout}`.trim()
  const reason =
    /ENOENT|not found|spawn gh/i.test(said) || said === ''
      ? 'gh is not installed, or not on the PATH HarnessDesk was started with.'
      : NOT_SIGNED_IN.test(said)
        ? 'gh is not signed in: run `gh auth login`.'
        : said.split('\n')[0] ?? 'gh could not answer.'
  return { via: 'gh', login: null, available: false, reason }
}

const personGhRunner = (gh: GhRunner): ForgeRunner => ({
  identity: async () => identityFromGh(gh),
  run: (args, options) => gh(args, options),
})

/**
 * Plugins receive forge verbs, not an arbitrary command channel. The Git
 * plugin owns this small vocabulary; keeping it here means an App runner is
 * never an accidental way for a third-party plugin to turn its forge grant
 * into unrestricted GitHub API access.
 */
const isGitPluginCommand = (args: readonly string[]): boolean => {
  const [area, verb, target] = args
  if (area === 'pr') return ['list', 'create', 'edit', 'review', 'comment', 'view', 'checks'].includes(verb ?? '')
  if (area === 'issue') return ['view', 'comment'].includes(verb ?? '')
  return area === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(target ?? '')
}

export class ForgePlane implements ForgeEngine {
  readonly #runner: ForgeRunner
  readonly #identityTtlMs: number
  readonly #identities = new Map<string, { readonly at: number; readonly value: ForgeIdentity }>()
  readonly #asking = new Map<string, Promise<ForgeIdentity>>()

  constructor(
    private readonly port: ForgePort,
    options: ForgePlaneOptions = {},
  ) {
    this.#runner = options.runner ?? personGhRunner(options.gh ?? ghOnPath)
    this.#identityTtlMs = options.identityTtlMs ?? DEFAULT_IDENTITY_TTL_MS
  }

  /** The standing instruction for an agent, or nothing when the tools it names are not offered. */
  instructions(): string {
    return this.port.toolsOffered() ? FORGE_INSTRUCTION : ''
  }

  async seat(scope: ForgeScope): Promise<ForgeSeat | null> {
    if (!scope.runtime || !scope.sessionId) return null
    const agent = this.port.agentOf(scope.runtime)
    if (!agent) return null
    const options = this.port.optionsOf(scope.runtime, scope.sessionId)
    if (options === null) return null
    return seatOf(agent.name, options, agent.version)
  }

  /**
   * How the desk reaches this checkout's forge right now: the selected runner,
   * as whom. Cached per checkout for a while — every publication asks — and
   * asked once at a time, so a burst of tool calls does not fan out into a
   * burst of API calls.
   */
  async identity(options: ForgeRunOptions = {}, scope: ForgeScope = {}): Promise<ForgeIdentity> {
    const key = options.cwd ?? ''
    const now = Date.now()
    const previous = this.#identities.get(key)
    if (previous && now - previous.at < this.#identityTtlMs) return previous.value
    const asking = this.#asking.get(key)
    if (asking) return asking
    const next = this.#runner.identity(options, scope).then((value) => {
      this.#identities.set(key, { at: Date.now(), value })
      return value
    })
    this.#asking.set(key, next)
    void next.then(
      () => this.#asking.delete(key),
      () => this.#asking.delete(key),
    )
    return next
  }

  async run(args: readonly string[], options: ForgeRunOptions, scope: ForgeScope): Promise<ForgeRunResult> {
    if (!isGitPluginCommand(args)) {
      throw new Error('The forge runner accepts only the Git plugin’s pull-request, issue and review operations.')
    }
    return this.#runner.run(args, options, scope)
  }

  /** Forgets the cached identity — after a sign-in the desk drove, say. */
  forgetIdentity(): void {
    this.#identities.clear()
  }

  async publish(reference: ForgeReference, scope: ForgeScope): Promise<void> {
    if (!scope.runtime || !scope.sessionId) {
      throw new Error('A publication is recorded against a conversation, and this call named none.')
    }
    // The supervisor checks a child's reference at its boundary; this is the
    // same check for a built-in, which reaches the plane directly.
    if (!isForgeReference(reference)) {
      throw new Error('The publication is not a forge reference: kind, repo, number, url and via are required, in their types.')
    }
    const now = Date.now()
    const item: PublicationItem = {
      id: itemId(`publication-${randomUUID()}`),
      type: 'publication',
      reference,
      startedAt: now,
      completedAt: now,
    }
    if (!this.port.record(scope.runtime, scope.sessionId, item)) {
      throw new Error(`No conversation ${scope.sessionId} is open on ${scope.runtime} to record the publication in.`)
    }
  }
}
