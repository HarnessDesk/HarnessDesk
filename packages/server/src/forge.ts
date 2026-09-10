import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

import type { ForgeEngine, ForgeIdentity, ForgeScope, ForgeSeat } from '@harnessdesk/cordis-host'
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
   * Runs `gh`, for the identity. Overridable so a test can answer as a forge
   * would, and so the packaged app can point at the copy it found.
   */
  readonly gh?: GhRunner
  /** How long an identity answer stands before `gh` is asked again. */
  readonly identityTtlMs?: number
}

export type GhRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const run = promisify(execFile)

/** `gh` on PATH, the way the plugin reaches it: `execFile`, never a shell. */
export const ghOnPath: GhRunner = async (args) => {
  try {
    const result = await run('gh', [...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
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

export class ForgePlane implements ForgeEngine {
  readonly #gh: GhRunner
  readonly #identityTtlMs: number
  #identity: { readonly at: number; readonly value: ForgeIdentity } | null = null
  #asking: Promise<ForgeIdentity> | null = null

  constructor(
    private readonly port: ForgePort,
    options: ForgePlaneOptions = {},
  ) {
    this.#gh = options.gh ?? ghOnPath
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
   * How the desk reaches the forge right now: the person's `gh`, as whom.
   * Cached for a while — every publication asks — and asked once at a time,
   * so a burst of tool calls does not fan out into a burst of API calls.
   */
  async identity(_scope?: ForgeScope): Promise<ForgeIdentity> {
    const now = Date.now()
    if (this.#identity && now - this.#identity.at < this.#identityTtlMs) return this.#identity.value
    if (this.#asking) return this.#asking
    this.#asking = this.#askGh().then((value) => {
      this.#identity = { at: Date.now(), value }
      this.#asking = null
      return value
    })
    return this.#asking
  }

  async #askGh(): Promise<ForgeIdentity> {
    const result = await this.#gh(['api', 'user', '--jq', '.login'])
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

  /** Forgets the cached identity — after a sign-in the desk drove, say. */
  forgetIdentity(): void {
    this.#identity = null
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
