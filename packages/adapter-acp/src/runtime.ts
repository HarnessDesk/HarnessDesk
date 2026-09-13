import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  approvalId,
  itemId,
  runtimeId,
  sessionId as makeSessionId,
  turnId,
  type Account,
  type AccountStatus,
  type AuthMethod,
  type LoginStart,
  type AgentEvent,
  type AgentItem,
  type AgentRuntime,
  type CatalogRefresh,
  type AgentSession,
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  type ConfigOption,
  type OptionConfirm,
  type ContextBreakdown,
  type ContextSegment,
  type ItemId,
  type ItemStatus,
  type OptionCategory,
  type ListSessionsQuery,
  type ModelInfo,
  type OptionValue,
  type Page,
  type RateLimits,
  type RuntimeHealth,
  type SecretReload,
  type RuntimeInfo,
  NO_CAPABILITIES,
  type InstallationCheck,
  type Session,
  type SessionId,
  type SessionOptions,
  type SessionSettings,
  type SessionDeletion,
  type SessionSummary,
  type SessionUsage,
  type SkillInfo,
  type TokenUsage,
  type Turn,
  type TurnId,
  type Unsubscribe,
  type UserContent,
  type UserMessageItem,
  type PeelOptions,
  findOption,
  peelUserContent,
  refuseOptionValue,
  SessionFolderGoneError,
  SessionGoneError,
  openingOf,
} from '@harnessdesk/protocol'
import {
  AcpConnection,
  AcpError,
  type AcpAvailableCommand,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpUpdateMeta,
  type AcpNewSessionResult,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpModel,
  type AcpModelState,
  type AcpSessionModeState,
  type AcpToolCallUpdate,
  type AcpSessionRow,
  type AcpPromptMeta,
  type AcpPromptResponse,
  type AcpSessionUpdate,
  type AcpStopReason,
  type AcpUsage,
  ACP_TASKS_CAPABILITY,
  ACP_TASKS_NOTIFICATION,
  type AcpTasksChanged,
  ACP_SESSION_DELETE,
  ACP_SESSION_DELETE_CAPABILITY,
  ACP_INSTRUCTIONS_CAPABILITY,
  type AcpSessionDeleted,
  ACP_DELEGATION_NOTIFICATION,
  type AcpDelegation,
  type AcpDelegationChanged,
  type AcpDelegationUsage,
} from '@harnessdesk/transport-acp'

import { CliAccount, type AcpAccountCommands } from './account.js'
import { AcpExtensions } from './extensions.js'
import { resolveExecutable, type AcpExecutableSpec, type ResolvedExecutable } from './executable.js'
import { CliMcp, type AcpMcpCommands } from './mcp.js'
import { AcpTasks } from './tasks.js'

/**
 * `AgentRuntime` over the Agent Client Protocol.
 *
 * One configured agent — Claude Code, Gemini CLI, any of the ~40 — is one
 * instance of this class with its own id, command and presentation. The
 * mapping holds to the protocol's own rule from both sides: ACP's session
 * modes and config options land on `ConfigOption` unchanged in shape, which
 * is the test that `ConfigOption` was designed against a protocol rather than
 * against Codex.
 *
 * Two ACP capabilities are declined on purpose: `fs` and `terminal`.
 * The backend owns execution. A conforming agent therefore never asks this
 * client to read a file or run a command on its behalf.
 */

/**
 * A secret an agent needs in its environment — a provider API key, most
 * often. Declared in the registry so the shell can offer a field for it and
 * the broker can keep it; the value is never part of the registry itself.
 */
export interface AcpSecretSpec {
  /** The environment variable the agent reads, e.g. `DEEPSEEK_API_KEY`. */
  readonly env: string
  /** What to call the field: "DeepSeek API key". */
  readonly label: string
  /** Where the user gets one. */
  readonly helpUrl?: string
  /** Shown under the field. */
  readonly description?: string
  /**
   * The other places this agent looks for the value, in its own precedence
   * order — DeepSeek Harness reads `~/.dsh/.credentials.yaml` (what its own
   * Models page writes) and two `.env` files besides its environment.
   *
   * HarnessDesk reads these to answer one question only: *does the agent
   * already have a key*. Without that it says "not signed in" about an agent
   * that runs perfectly, and offers a field for a key that is already there.
   * The value is never read into the interface, never logged, and never
   * written here — HarnessDesk owns exactly one copy, in its own broker.
   */
  readonly alsoAt?: readonly AcpSecretSource[]
}

/** One file an agent reads a secret from, and what to call it. */
export interface AcpSecretSource {
  /** Absolute, or `~`-relative to the user's home. */
  readonly path: string
  /** `yaml`: `KEY: value`. `dotenv`: `KEY=value`. */
  readonly format: 'yaml' | 'dotenv'
  /** How to name it to a person, e.g. "DeepSeek Harness's own store". */
  readonly label: string
}

/** What the host decided about starting this agent: run this, or do not, and why. */
export type AcpLaunchDecision =
  | {
      readonly command: string
      readonly args: readonly string[]
      readonly env?: Readonly<Record<string, string>>
      /** The version of what will run, when the host read one. */
      readonly version: string | null
    }
  | {
      readonly blocked: {
        readonly reason: 'notInstalled' | 'versionTooOld' | 'unknown'
        readonly message: string
        readonly remediation?: string
      }
    }

/**
 * Where an agent that puts no usage on the wire keeps its own count, read
 * around a turn. See `AcpAgentConfig.usageRecord`.
 */
export interface AcpUsageRecord {
  /** How far the session's record has got, taken before a turn; null where it cannot be read. */
  mark(sessionId: string): number | null
  /** What the record gained after `mark`, in ACP's usage shape; null where it gained nothing readable. */
  since(sessionId: string, mark: number): AcpUsage | null
}

export interface AcpAgentConfig {
  /** Stable runtime id, e.g. `claude-code`. Shown nowhere; keyed everywhere. */
  readonly id: string
  readonly name: string
  /** Whose mark to show — a lobe-icons key, e.g. `claudecode`. See `RuntimePresentation.brand`. */
  readonly brand?: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /**
   * Where to start the process. A bridge that must run from its own checkout
   * — a repo-adjacent agent, a workspace runner — needs this; without it the
   * agent inherits HarnessDesk's directory, which is rarely what it wants.
   */
  readonly cwd?: string
  /**
   * Secrets the agent needs in its environment. HarnessDesk offers a field
   * for each, keeps the value in the credential broker, and injects it when
   * the process starts — so a key never sits in `agents.json`.
   */
  readonly secrets?: readonly AcpSecretSpec[]
  /** Reads a stored secret at spawn time. Supplied by the host, not the registry. */
  readonly resolveSecret?: (env: string) => string | undefined
  readonly tagline?: string
  /** How to install the agent, for the first-run screen. */
  readonly installCommand?: string
  /**
   * The npm package the agent is published as, when it is. Lets the host say
   * when a newer one exists — see `RuntimeInfo.update`.
   */
  readonly package?: string
  /**
   * When `command` is a bridge that can be pointed at the real agent CLI:
   * which CLI, and which environment variable the bridge reads its path
   * from. See `executable.ts`.
   */
  readonly executable?: AcpExecutableSpec
  /**
   * Decides what is spawned, when the host knows more than the row does:
   * which of several installed copies of the agent should answer, whether
   * a service it needs is running, whether its own configuration passes
   * its own validation. Called before every start and again by
   * `checkInstallation`. `null` means "run the row as written"; a launch
   * replaces the command; a block is the reason the agent will not start,
   * reported as health rather than tried.
   */
  readonly resolveLaunch?: (occasion: 'start' | 'recheck') => Promise<AcpLaunchDecision | null>
  /**
   * Finds the CLI a bridge should drive, in place of a plain PATH lookup —
   * the host's discovery picks the newest copy, or the pinned one. Absent,
   * `executable` is resolved on PATH as before.
   */
  readonly resolveExecutable?: (spec: AcpExecutableSpec) => Promise<ResolvedExecutable | null>
  /**
   * Who the agent is signed in as, from the agent's own files, for an agent
   * with no status command to ask. ACP has no account query, and a session
   * that opened proves only *that* the agent is signed in; this names the
   * account the agent itself wrote down, or returns null when its record
   * names nobody and "Signed in" is all that can be said. Supplied by the
   * host, which knows where each agent keeps that record — never by the
   * registry.
   */
  readonly resolveIdentity?: () => Account | null
  /**
   * Where an agent that puts no usage on the wire writes it down.
   * Antigravity's server counts every model call in its own conversation
   * store and sends none of it over ACP. Asked when a turn opens, for a mark
   * of where the record stands, and when the turn closes, for what it gained
   * since — so the turn's usage is the agent's own count, read and never
   * estimated. Consulted only when the agent's answer carried no usage of
   * its own. Supplied by the host, which knows where the agent keeps its
   * store; never by the registry.
   */
  readonly usageRecord?: AcpUsageRecord
  /**
   * How to ask the agent's own CLI who is signed in, and how to sign in and
   * out. ACP cannot answer any of that; the CLI can. See `account.ts`.
   */
  readonly account?: AcpAccountCommands
  /**
   * How to list the agent's MCP servers. ACP carries no extension plane; the
   * CLI behind the agent does. When present, `runtime/mcp/list` returns the
   * servers rather than an empty array. See `mcp.ts`.
   */
  readonly mcp?: AcpMcpCommands
  /**
   * An MCP server carrying HarnessDesk's plugin tools, handed to the agent
   * in `session/new`. This is how a plugin's capability reaches ACP agents —
   * the same tools Codex gets as dynamic tools.
   */
  readonly toolServer?: {
    readonly name: string
    readonly command: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    /**
     * Told which session each spawned bridge belongs to. The bridge is
     * spawned by the *agent*, per session, from the config it got in
     * `session/new` — so the only name that crosses all three processes is
     * a token minted here and put in that bridge's environment. Whoever
     * builds the runtime keeps the token → session map; this is how a tool
     * called over MCP finally knows which conversation called it.
     */
    readonly onSession?: (token: string, sessionId: string) => void
    /**
     * Told the token before the open is sent, when the session has no id
     * yet. The agent spawns the bridge while the open is in flight and the
     * bridge asks the gateway for its instructions at its own handshake, so
     * whoever answers that question needs to know whose token it is first.
     */
    readonly onOpen?: (token: string) => void
  }
  /**
   * The desk's standing instruction for the agent, read when a session is
   * opened and put in `session/new`'s and `session/load`'s `_meta` under
   * `harnessdesk.instructions`. A bridge that declared the capability in its
   * handshake folds it into the agent's own instruction layer; every other
   * agent ignores the key, and hears the sentence only through the tool
   * server's own `instructions`, if it accepted one.
   */
  readonly instructions?: () => string
  readonly logger?: {
    debug?(message: string, details?: unknown): void
    info?(message: string, details?: unknown): void
    warn?(message: string, details?: unknown): void
  }
}

const PROTOCOL_VERSION = 1

/**
 * What a start that arrives after the host has finished with the agent says.
 * One sentence for both refusals below, so they cannot drift apart.
 */
const shutDown = (name: string): Error => new Error(`${name} has been shut down.`)

/** ACP's stdio MCP server shape; env rides as {name, value} pairs. */
/**
 * Not every ACP agent accepts an MCP server. DeepSeek Harness's bridge
 * refuses a non-empty `mcpServers` outright ("Invalid params: mcpServers is
 * not supported"), and an agent that cannot host our tool bridge should
 * still open sessions — it simply does not get HarnessDesk's plugin tools.
 * The refusal is learned once, from the agent's own answer, and remembered.
 */
const REFUSES_TOOL_SERVER = /mcpServers?\b/i

const mcpServersOf = (config: AcpAgentConfig, caller: string): readonly object[] =>
  config.toolServer
    ? [
        {
          name: config.toolServer.name,
          command: config.toolServer.command,
          args: [...config.toolServer.args],
          env: [
            ...Object.entries(config.toolServer.env ?? {}).map(([name, value]) => ({ name, value })),
            // The correlation token: the agent spawns this bridge for the
            // session it is opening, so the env is the one channel that ties
            // the bridge's tool calls back to that session.
            { name: 'HD_TOOLS_CALLER', value: caller },
          ],
        },
      ]
    : []

/**
 * The text an agent attached to a permission request, flattened.
 *
 * ACP's `ToolCallUpdate.content` is a list of blocks; a permission request
 * uses it for the explanation. Only text is read — a diff or an image block
 * on an approval is a rendering job this surface does not have.
 */
/**
 * What to call a tool call.
 *
 * ACP's `title` is meant to be the agent's own words about its own call, and
 * usually is — Cursor sends `Read README.md`, `Edit game.html`. For an MCP
 * tool it sends the literal word `Mcp`, for every one of them: twenty browser
 * calls, nine board calls and a file read all arrive under one nameless label.
 * The transcript then cannot say what an agent did, only that it did
 * something — and the browser pane, which recognises a browser call by its
 * name, reports *Idle* while that agent has both hands on the page.
 *
 * The call's own input carries the answer, and the adapter already keeps it:
 * `toolName` is the tool as its server registered it, `name` the same thing
 * namespaced. Used only where the title says nothing, because a real title is
 * the agent's own sentence and always wins.
 */
const GENERIC_TITLES = new Set(['mcp', 'tool', 'other', 'execute'])

const namedByItsInput = (raw: unknown): string | null => {
  if (raw === null || typeof raw !== 'object') return null
  const input = raw as { readonly toolName?: unknown; readonly name?: unknown }
  for (const candidate of [input.toolName, input.name]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

export const toolNameOf = (
  update: { readonly title?: string; readonly kind?: string; readonly rawInput?: unknown },
  /**
   * What this call is already called, when one announcement has been seen.
   *
   * A call arrives more than once — announced, updated, completed — and the
   * later notices often carry the same generic title and nothing else. Without
   * this the merge copied that title verbatim and put `Mcp` back over a
   * `browser_open` that had already been worked out, so the *completed* row
   * lost the name. That is the row a person reads afterwards, and the one the
   * browser pane reads to say who is driving it.
   */
  already?: string,
): string => {
  const title = update.title?.trim()
  // The agent's own sentence wins whenever it actually says something.
  if (title && !GENERIC_TITLES.has(title.toLowerCase())) return title
  const named = namedByItsInput(update.rawInput)
  if (named) return named
  // Nothing better here: keep what was already resolved rather than letting a
  // second generic title undo the first one.
  const kept = already?.trim()
  if (kept && !GENERIC_TITLES.has(kept.toLowerCase())) return kept
  return title ?? kept ?? update.kind ?? 'tool'
}

const permissionReason = (toolCall: AcpToolCallUpdate): string | null => {
  const text = (toolCall.content ?? [])
    .map((block) => {
      if (block['type'] === 'text' && typeof block['text'] === 'string') return block['text']
      const inner = block['content']
      if (
        block['type'] === 'content' &&
        typeof inner === 'object' &&
        inner !== null &&
        (inner as { type?: unknown }).type === 'text' &&
        typeof (inner as { text?: unknown }).text === 'string'
      ) {
        return (inner as { text: string }).text
      }
      return ''
    })
    .filter((part) => part.trim() !== '')
    .join('\n')
    .trim()
  return text === '' ? null : text
}

/**
 * Whether a path is still a directory an agent could be started in.
 *
 * Kept identical in semantics to `isDirectory` in `packages/server/src/host.ts`
 * so the refusal-sourced fact and the listing-sourced fact cannot drift.
 */
export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Mode and model decide which other options exist, so they apply first. */
const rankOptionId = (id: string): number => (id === 'mode' ? 0 : id === 'model' ? 1 : 2)

/** An agent's confirmation copy, with its optional link normalised away when absent. */
const acpConfirm = (confirm: {
  readonly title: string
  readonly body: string
  readonly action: string
  readonly learnMore?: string | null
}): OptionConfirm => ({
  title: confirm.title,
  body: confirm.body,
  action: confirm.action,
  ...(confirm.learnMore ? { learnMore: confirm.learnMore } : {}),
})

/** A level id as shown: the bridge's label, else the id the agent used. */
const levelOf = (level: { readonly id: string; readonly label?: string | null }): {
  readonly id: string
  readonly label: string
} => ({ id: level.id, label: level.label?.trim() || level.id })

/** The reasoning levels a bridge named on the model itself, if it named any. */
const levelsOfModel = (
  model: AcpModel,
): readonly { readonly id: string; readonly label: string }[] | null => {
  const levels = model._meta?.harnessdesk?.effortLevels
  return levels ? levels.map(levelOf) : null
}

/**
 * The reasoning levels a session's own options describe — the fallback for an
 * agent that declares one effort control for whatever model is current. The
 * choice that means "leave it to the agent" is not a level and is dropped:
 * a catalogue lists what a model can do, not what a session was set to.
 */
const levelsOfOptions = (
  options: readonly AcpConfigOption[],
): readonly { readonly id: string; readonly label: string }[] => {
  const effort = options.find((option) => option.category === 'thought_level' && option.type === 'select')
  return (effort?.options ?? [])
    .filter((choice) => choice.value !== 'default')
    .map((choice) => levelOf({ id: choice.value, label: choice.name }))
}

/**
 * Whether a declared secret is available to the agent, and from where — never
 * what it is.
 *
 * The order is the agent's own: HarnessDesk's broker feeds the process
 * environment, which every agent reads first, and the declared files are
 * consulted in the order the registry lists them. Reporting the source is the
 * point: "not signed in" about an agent that has a key in its own store is
 * false, and so is "key stored" when the interface's copy is the one being
 * ignored.
 */
export const whereSecretLives = (
  secret: AcpSecretSpec,
  resolve?: (env: string) => string | undefined,
): { readonly kind: 'apiKey' | 'externalKey'; readonly detail: string } | null => {
  if (typeof resolve?.(secret.env) === 'string') return { kind: 'apiKey', detail: 'API key' }
  const inherited = process.env[secret.env]
  if (typeof inherited === 'string' && inherited !== '') {
    return { kind: 'externalKey', detail: `the ${secret.env} in HarnessDesk's environment` }
  }
  for (const source of secret.alsoAt ?? []) {
    if (readsKey(source, secret.env)) return { kind: 'externalKey', detail: source.label }
  }
  return null
}

/** True when the file names this key with a non-empty value. Reads no value out. */
const readsKey = (source: AcpSecretSource, key: string): boolean => {
  const path = source.path.startsWith('~')
    ? join(homedir(), source.path.slice(1))
    : source.path
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  // YAML is matched in both styles the store is written in: a block mapping
  // per line, and the one-line flow mapping DSH's own writer produces
  // (`{ DEEPSEEK_API_KEY: sk-… }`). A key only found at the start of a line
  // would miss the file the vendor actually writes.
  const found =
    source.format === 'yaml'
      ? new RegExp(`(?:^|[{,])\\s*${key}\\s*:\\s*([^,}\\n]*)`, 'm').exec(text)
      : new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(text)
  if (!found) return false
  const value = found[1]!.trim().replace(/^['"]|['"]$/g, '').trim()
  return value.length > 0 && !value.startsWith('#')
}

/**
 * ACP's four categories are the capability surface's four; an agent's own
 * (`_something`, by ACP convention) passes through for the interface to
 * treat as `other`. Anything else is `other` outright.
 */
const acpCategory = (category: string | null | undefined): OptionCategory => {
  if (category === 'mode' || category === 'model' || category === 'thought_level' || category === 'other') {
    return category
  }
  return category?.startsWith('_') ? (category as `_${string}`) : 'other'
}

export class AcpRuntime implements AgentRuntime {
  readonly #config: AcpAgentConfig
  /** Set when the agent answered that it cannot take an MCP tool server. */
  #toolServerRefused = false
  /** The agent's bridge declared that it carries the desk's standing instruction. */
  #briefs = false

  readonly #connection: AcpConnection
  readonly #sessions = new Map<SessionId, AcpSession>()
  readonly #listeners = new Set<(event: AgentEvent) => void>()
  readonly #healthListeners = new Set<(health: RuntimeHealth) => void>()
  readonly #infoListeners = new Set<() => void>()
  #health: RuntimeHealth = { state: 'starting' }
  #initialized: AcpInitializeResult | null = null
  /** The agent CLI behind the bridge, once looked for; null when not found or not declared. */
  #executable: ResolvedExecutable | null = null
  /** What the host last decided to run, when it decides at all. */
  #launch: AcpLaunchDecision | null = null
  readonly #account: CliAccount | null
  readonly extensions: AcpExtensions | undefined
  /**
   * Set once the agent has shown it speaks the background-task extension —
   * either by declaring it at `initialize`, or by pushing a list, which is
   * the stronger evidence of the two.
   */
  #tasks: AcpTasks | null = null
  /**
   * Set the moment `dispose()` begins, and never cleared.
   *
   * The host disposes a runtime on its way out — `Host.dispose()` at quit,
   * `unregister` when an account is removed — and after that nothing is
   * coming back to reap what it spawns. That matters because a start can be
   * *in flight* when dispose lands: the catalogue refresher restarts an idle
   * agent through `#restartIfIdle`, and between that stop and the spawn
   * `start()` yields twice, once to ask the host what to run and once to find
   * the CLI on disk. Land the quit in that gap and there is nothing for the
   * transport to notice — the old family was reaped before the gap opened, so
   * the shutdown returns at once — and the woken start puts a bridge, the
   * vendor CLI behind it and that CLI's own MCP servers into a process table
   * nobody will look at again. Exactly the family
   * `transport-acp/test/lifetime.test.ts` exists to prevent, reached by a
   * door on this side of it.
   *
   * `AcpConnection` cannot answer this and should not try. Its rule is one
   * generation at a time, which a start arriving with nothing in flight
   * satisfies honestly; that there will be no *next* caller is the host's
   * knowledge, and this is where the host keeps it.
   */
  #disposed = false

  constructor(config: AcpAgentConfig) {
    this.#config = config
    this.#account = config.account
      ? new CliAccount(
          config.account,
          runtimeId(config.id),
          (event) => this.emit(event),
          (message, details) => config.logger?.debug?.(message, details),
        )
      : null
    this.extensions = config.mcp
      ? new AcpExtensions(new CliMcp(config.mcp, (msg, details) => config.logger?.debug?.(msg, details)))
      : undefined
    this.#connection = new AcpConnection({
      command: config.command,
      args: config.args ?? [],
      ...(config.env ? { env: config.env } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      // Secrets are read at spawn, not at registration: a key stored after
      // the app started must reach the next process without a restart.
      env: () => ({
        ...config.env,
        ...Object.fromEntries(
          (config.secrets ?? [])
            .map((secret) => [secret.env, config.resolveSecret?.(secret.env)])
            .filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
        ),
      }),
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onAgentRequest(method, params),
      onStderr: (line) => config.logger?.debug?.('agent stderr', { agent: config.id, line }),
      /* Not `onStderr`: that is the agent's own output and the host files it
         at `debug`, which a default run drops on the floor. This is the host
         saying a shutdown did not finish, and it is the only reason the kill
         ceiling is a ceiling rather than a number somebody picked. */
      onShutdownIncomplete: (detail) =>
        config.logger?.warn?.('agent shutdown incomplete', { agent: config.id, detail }),
      onExit: (code) => this.#onExit(code),
    })
  }

  get info(): RuntimeInfo {
    return {
      id: runtimeId(this.#config.id),
      name: this.#config.name,
      // The bridge's own version, as it introduced itself; the CLI it drives
      // is reported separately, because that is the one that decides which
      // models exist.
      version: this.#initialized?.agentInfo?.version ?? null,
      drives: this.#config.executable
        ? this.#executable
          ? { command: this.#config.executable.command, version: this.#executable.version }
          : null
        : null,
      capabilities: this.#capabilities(),
      presentation: {
        name: this.#config.name,
        // What an ACP agent declares are commands; some of them are skills
        // and some are `/compact`. The page says both rather than filing
        // half the list under the wrong word.
        skillsLabel: 'Skills & commands',
        ...(this.#config.brand ? { brand: this.#config.brand } : {}),
        ...(this.#config.tagline ? { tagline: this.#config.tagline } : {}),
        ...(this.#config.installCommand || this.#config.package
          ? {
              install: {
                ...(this.#config.installCommand ? { command: this.#config.installCommand } : {}),
                ...(this.#config.package ? { package: this.#config.package } : {}),
              },
            }
          : {}),
      },
    }
  }

  /**
   * What this runtime can claim right now — observations, never defaults.
   *
   * Before the handshake nothing has been observed, and an agent that cannot
   * start can do nothing, so nearly everything is false. The one exception
   * is `account`, which is answered by the agent's own CLI or by the
   * credential broker and is therefore true or false independent of whether
   * the agent's process ever came up. Everything else arrives with its
   * evidence: the handshake for the protocol-level claims, the agent's
   * declarations for the rest.
   */
  #capabilities(): RuntimeInfo['capabilities'] {
    const shaken = this.#initialized !== null
    return {
      ...NO_CAPABILITIES,
      // ACP declares how to authenticate but never whether you already are
      // — so claiming an account from authMethods alone painted "not signed
      // in" over agents that were. The surface exists when the registry
      // names CLI commands that can answer truthfully, or names a secret,
      // which the credential broker can always answer about — or once the
      // agent's own answers have shown the state, a session that opened or
      // one it refused for want of a sign-in.
      account:
        this.#account !== null || (this.#config.secrets?.length ?? 0) > 0 || this.#signIn.state !== 'unknown',
      ...(shaken
        ? {
            resume:
              (this.#initialized?.agentCapabilities?.loadSession ?? false) ||
              Boolean(this.#initialized?.agentCapabilities?.sessionCapabilities?.resume),
            // Protocol-level: `session/cancel`, plan entries and thought
            // chunks are ACP's own vocabulary, claimable once this agent has
            // shown it speaks ACP at all — and not a moment before, which is
            // how an agent that never launched came to claim all three.
            interrupt: true,
            plans: true,
            reasoning: true,
            listHistory: Boolean(this.#initialized?.agentCapabilities?.sessionCapabilities?.list),
            imageInput: this.#initialized?.agentCapabilities?.promptCapabilities?.image ?? false,
            // The agent's own commands are its skills — Claude Code declares
            // its 51, Cursor its own — and they arrive per session, so this
            // is true once one has been heard rather than promised in advance.
            skills: this.#commands.length > 0,
            // A bridge that knows where its agent writes can delete a stored
            // conversation, and says so in the handshake. Nothing else can.
            deleteHistory: this.#canDelete,
            // Offered in configuration, and not yet refused by the agent —
            // the refusal is observed on the first real or probe session,
            // which `start` opens eagerly for exactly this reason.
            pluginTools: Boolean(this.#config.toolServer) && !this.#toolServerRefused,
            backgroundTasks: this.#tasks !== null,
            instructions: this.#briefs,
          }
        : {}),
    }
    // ACP has no archive method and no archived flag on a listed session, so
    // `archiveHistory` stays false always: the host keeps the mark instead —
    // see `SessionArchive` — which is why archiving still works for every
    // agent behind this adapter.
  }

  async start(): Promise<void> {
    // A start that never begins. Not the guard that holds the invariant —
    // that one is welded to the spawn in `#spawnBridge` — but the two lines
    // below each shell out to a subprocess of their own, the host's launch
    // decision and the CLI's `--version`, and a shutdown is no time to start
    // either. Refusing here also leaves a disposed runtime's health as it
    // was, rather than reporting a runtime that is gone as `starting`.
    if (this.#disposed) throw shutDown(this.#config.name)
    this.#setHealth({ state: 'starting' })
    // A fresh process is a fresh question: what the last one showed about
    // its sign-in may be the very thing that changed between the two.
    this.#signIn = { state: 'unknown' }
    if (!(await this.#decideLaunch())) {
      throw new Error(`${this.#config.name} will not start: ${(this.#health as { message?: string }).message ?? 'blocked'}`)
    }
    await this.#pointAtExecutable()
    // Waits, when a previous generation is still being seen out: the bridge
    // and everything it spawned share this runtime's workspace, and two of
    // them in it at once is two agents editing the same files.
    if (!(await this.#spawnBridge())) {
      /* A stop overtook this start while it waited — a quit, or a restart the
         user asked for twice. Nothing was spawned, so the handshake below
         would fail with "the agent is not running", and the catch that
         follows would read that as an agent that is not installed and tell
         the person to reinstall a CLI sitting on their disk, working. The
         difference between "did not start" and "is not there" is the whole of
         what this branch exists to keep. */
      const message = `${this.#config.name} was stopped while it was starting.`
      this.#setHealth({ state: 'unavailable', reason: 'unknown', message })
      throw new Error(message)
    }
    try {
      this.#initialized = await this.#connection.request<AcpInitializeResult>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // Declined, deliberately and forever. See the class comment.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
      const declared = (this.#initialized._meta as { harnessdesk?: Record<string, unknown> } | undefined)
        ?.harnessdesk
      if (declared?.[ACP_TASKS_CAPABILITY] === true) this.#adoptTasks()
      this.#canDelete = declared?.[ACP_SESSION_DELETE_CAPABILITY] === true
      this.#briefs = declared?.[ACP_INSTRUCTIONS_CAPABILITY] === true
      this.#setHealth({ state: 'ready' })
      // The handshake is what turned the capability claims on, and a window
      // may already be drawn from the all-false version.
      for (const listener of this.#infoListeners) listener()
      // `pluginTools` above is still a declaration; the agent's answer is the
      // observation. The probe is free until prompted, and opening it now is
      // what turns "offered" into "accepted" or "refused" within moments of
      // start instead of at the first conversation.
      void this.#observeToolReach()
    } catch (error) {
      this.#setHealth({
        state: 'unavailable',
        reason: 'notInstalled',
        message: `${this.#config.name} did not answer the ACP handshake: ${describeAcp(error)}`,
        ...(this.#config.installCommand
          ? { remediation: `Install it with \`${this.#config.installCommand}\`.` }
          : {}),
      })
      throw error
    }
  }

  /**
   * The only place a bridge is born, and the last gate before it is.
   *
   * The check is welded to the spawn rather than left a few lines above it
   * because everything above *is* a few lines above it: `start()` awaits the
   * launch decision and then the CLI lookup, and a third await added there
   * later would silently widen a window a hand-placed guard had been sized
   * for — which is how this door opened in the first place. Here there is no
   * window to widen. The two statements are one function, and nothing can be
   * put between them without editing this and reading why not to.
   *
   * A caller that reaches this after dispose is not misbehaving; it started
   * before the quit did. It is told rather than quietly returning, because
   * the caller is `#restartIfIdle`, and a silent refusal there becomes
   * `restarted: true` — a re-read reported to whoever asked for one, and the
   * agent's whole catalogue thrown away for it.
   *
   * Two guards stand here and they answer different halves. This one is the
   * host's: nothing is in flight and nobody is coming back, so no generation
   * may be born at all. The `false` that `#connection.start()` can return is
   * the transport's: a stop overtook a start that was waiting for the last
   * family to be reaped. Neither can answer the other's question — with
   * nothing in flight the transport has no stop to notice, and a runtime that
   * is merely restarting has not been disposed.
   */
  async #spawnBridge(): Promise<boolean> {
    if (this.#disposed) {
      /* And it says so in the health, because its sibling does. `start()` set
         `starting` on the way in, and the other refusal that can land here —
         the `false` of a start #68 abandoned, three lines below the call —
         leaves `unavailable` behind it. A throw that left `starting` standing
         would make two guards an arm's length apart disagree about what a
         runtime that did not start looks like. Nothing reads it on the quit
         path, which is why this is tidiness rather than a fix; two reviewers
         found the inconsistency independently, which is why it is worth the
         three lines. */
      const refusal = shutDown(this.#config.name)
      this.#setHealth({ state: 'unavailable', reason: 'unknown', message: refusal.message })
      throw refusal
    }
    return this.#connection.start()
  }

  /**
   * Observes whether the tool server actually reaches this agent, by opening
   * the draft probe the first session would open anyway. A refusal is
   * learned in `#openWithTools`, remembered, and announced; an acceptance is
   * the probe opening at all. Failure to open a probe says nothing about
   * tools and is only logged.
   */
  async #observeToolReach(): Promise<void> {
    if (!this.#config.toolServer || this.#toolServerRefused) return
    try {
      await this.#openProbe()
    } catch (error) {
      this.#config.logger?.debug?.('the agent would not open a probe session', {
        agent: this.#config.id,
        error: describeAcp(error),
      })
    }
  }

  /**
   * Finds the agent CLI the registry says the bridge should drive, and puts
   * its path where the bridge looks. Done before every start, so a CLI
   * installed or upgraded since the last one is picked up on restart.
   */
  async #pointAtExecutable(): Promise<void> {
    const spec = this.#config.executable
    if (!spec) return
    this.#executable = await this.#resolveExecutable(spec)
    if (this.#executable) {
      this.#connection.withEnv({ [spec.env]: this.#executable.path })
      this.#config.logger?.info?.('driving the installed agent CLI', {
        agent: this.#config.id,
        path: this.#executable.path,
        version: this.#executable.version,
      })
    } else {
      this.#config.logger?.warn?.('agent CLI not found; the bridge will use its embedded copy', {
        agent: this.#config.id,
        command: spec.command,
      })
    }
  }

  #resolveExecutable(spec: AcpExecutableSpec): Promise<ResolvedExecutable | null> {
    return this.#config.resolveExecutable ? this.#config.resolveExecutable(spec) : resolveExecutable(spec)
  }

  /**
   * Asks the host what to run, and applies the answer: a launch replaces
   * the row's command for the next start; a block becomes this runtime's
   * health, with the host's own words, and the start is not attempted —
   * spawning an agent whose Gateway is down or whose config its own
   * validator refuses would only produce a less readable failure a moment
   * later. Returns whether starting may go ahead.
   */
  async #decideLaunch(): Promise<boolean> {
    if (!this.#config.resolveLaunch) return true
    let decision: AcpLaunchDecision | null
    try {
      decision = await this.#config.resolveLaunch('start')
    } catch (error) {
      this.#config.logger?.warn?.('the launch decision failed; running the row as written', {
        agent: this.#config.id,
        error: String(error),
      })
      decision = null
    }
    this.#launch = decision
    if (decision && 'blocked' in decision) {
      this.#setHealth({
        state: 'unavailable',
        reason: decision.blocked.reason,
        message: decision.blocked.message,
        ...(decision.blocked.remediation ? { remediation: decision.blocked.remediation } : {}),
      })
      return false
    }
    if (decision) {
      this.#connection.withCommand(decision.command, decision.args)
      if (decision.env) this.#connection.withEnv(decision.env)
      this.#config.logger?.info?.('running the chosen install', {
        agent: this.#config.id,
        command: decision.command,
        version: decision.version,
      })
    }
    return true
  }

  /** The version of what is running, as the host read it — for a direct agent, the CLI's own. */
  get launchedVersion(): string | null {
    return this.#launch && !('blocked' in this.#launch) ? this.#launch.version : null
  }

  async dispose(): Promise<void> {
    // Before the first `await`, so a `start()` already parked on one of its
    // own reads it the moment it wakes. Every caller sets it synchronously
    // just by calling — `Host.dispose()`'s whole `Promise.all` included,
    // because `map` runs each `dispose()` up to its first yield before any of
    // them gets to continue.
    this.#disposed = true
    await this.#connection.stop()
    this.#sessions.clear()
    this.#probe = null
    this.#probeId = null
    this.#opening = null
  }

  /**
   * `AgentRuntime.refreshCatalog`, the ACP way. The protocol declares models
   * and modes in `session/new` and has no "list them again"; the only clean
   * re-ask is a fresh process — opening probe sessions on a timer would leak
   * one per tick into the agent. So: when nothing but the probe is open, the
   * agent is stopped and started, which also re-resolves the CLI it drives;
   * with a session open, nothing happens and the next `session/new` declares
   * whatever the agent knows then.
   */
  async refreshCatalog(): Promise<CatalogRefresh> {
    const done = await this.#restartIfIdle('refresh')
    if (!done.restarted) return { refreshed: false, ...(done.reason ? { reason: done.reason } : {}) }
    this.emit({ type: 'catalog/changed', runtime: runtimeId(this.#config.id) })
    return { refreshed: true }
  }

  /**
   * Re-asks the host what to run. A different command or version than the
   * one running is a change, moved onto when idle; a block for an agent
   * that is currently running is not — the process is up and answering,
   * and the next start will report the block if it still holds.
   */
  async #checkLaunch(): Promise<InstallationCheck | null> {
    if (!this.#config.resolveLaunch) return null
    let decision: AcpLaunchDecision | null
    try {
      decision = await this.#config.resolveLaunch('recheck')
    } catch {
      return null
    }
    const before = this.#launch
    const runnable = decision && !('blocked' in decision) ? decision : null
    const was = before && !('blocked' in before) ? before : null
    const same =
      (runnable === null && was === null) ||
      (runnable !== null && was !== null && runnable.command === was.command && runnable.version === was.version)
    if (same || (decision && 'blocked' in decision)) return null
    const report = { changed: true as const, from: was?.version ?? null, to: runnable?.version ?? null }
    const { restarted } = await this.#restartIfIdle('a different install of the agent should answer')
    if (restarted) this.emit({ type: 'catalog/changed', runtime: runtimeId(this.#config.id) })
    return { ...report, restarted }
  }

  /**
   * `AgentRuntime.checkInstallation`: is the CLI behind the bridge still the
   * one that was found at start? A different path or version is reported,
   * and moved onto when idle. Without `executable` there is nothing to
   * compare, and `refreshCatalog` covers the rest.
   */
  async checkInstallation(): Promise<InstallationCheck> {
    if (this.#health.state !== 'ready') return { changed: false }
    const launchCheck = await this.#checkLaunch()
    if (launchCheck) return launchCheck
    const spec = this.#config.executable
    if (!spec) return { changed: false }
    const found = await this.#resolveExecutable(spec)
    const before = this.#executable
    const same =
      (found === null && before === null) ||
      (found !== null && before !== null && found.path === before.path && found.version === before.version)
    if (same) return { changed: false }
    const report = { changed: true as const, from: before?.version ?? null, to: found?.version ?? null }
    const { restarted } = await this.#restartIfIdle('the agent CLI changed on disk')
    if (restarted) this.emit({ type: 'catalog/changed', runtime: runtimeId(this.#config.id) })
    return { ...report, restarted }
  }

  /**
   * Stops and starts the agent when that loses nothing, and says why when it
   * will not.
   *
   * Idle means no turn in flight, not no session open — a window nearly
   * always has a conversation open, and a rule that waited for none would
   * never fire. Open sessions are dropped on the restart and resumed by the
   * host through `session/load` on their next use, so this is only allowed
   * for an agent that keeps its sessions; one that does not would lose the
   * conversation, and waits until nothing but the probe is open.
   */
  async #restartIfIdle(why: string): Promise<{ restarted: boolean; reason?: string }> {
    // Every refusal carries the sentence that explains it. The boolean alone
    // was enough while the only caller was a background timer; the moment a
    // person presses a button that ends here, "no" without "because" is a
    // control that appears to do nothing.
    //
    // A crashed agent is the one "not running" this can fix. Its own health
    // says "select the runtime again to restart it", a selection runs exactly
    // this, and until now the answer was "It is not running" — the sentence
    // that made the advice unfollowable. The process is gone, so there is no
    // turn to wait for and nothing open worth keeping: every session it held
    // was told its agent died when it exited. Any other not-ready state — a
    // start in progress, a launch the host blocked, a stop that overtook a
    // start — is left to the path that put it there.
    const crashed = this.#health.state === 'unavailable' && this.#health.reason === 'crashed'
    if (this.#health.state !== 'ready' && !crashed) {
      return { restarted: false, reason: 'It is not running.' }
    }
    const live = crashed
      ? []
      : [...this.#sessions.values()].filter((session) => session.id !== this.#probeId)
    const busy = live.filter((session) => session.busy)
    if (busy.length > 0) {
      this.#config.logger?.debug?.('agent restart deferred; a turn is in flight', {
        agent: this.#config.id,
        why,
        busy: busy.length,
      })
      return {
        restarted: false,
        reason:
          busy.length === 1
            ? 'A turn is in flight; it will re-read once that finishes.'
            : `${busy.length} turns are in flight; it will re-read once they finish.`,
      }
    }
    if (live.length > 0 && !this.info.capabilities.resume) {
      this.#config.logger?.debug?.('agent restart deferred; it keeps no sessions and some are open', {
        agent: this.#config.id,
        why,
        open: live.length,
      })
      return {
        restarted: false,
        reason:
          'It keeps no conversations of its own, so restarting it would lose the ones that are open.',
      }
    }
    this.#config.logger?.info?.('restarting agent', { agent: this.#config.id, why })
    await this.#connection.stop()
    this.#sessions.clear()
    this.#probe = null
    this.#probeId = null
    this.#opening = null
    // The catalogue was the old process's answer; the new one re-declares it
    // on its first session, default and all — commands included, since an
    // upgraded CLI is exactly how a new skill appears.
    this.#catalogDefault = null
    this.#commands = []
    await this.start()
    return { restarted: true }
  }

  /**
   * A declared secret changed. The agent read its environment when it
   * started, so the only way the new value reaches it is a new process.
   *
   * Unlike a catalogue refresh this restarts even when sessions are open and
   * the agent cannot resume them: an agent missing its key fails every turn,
   * so a conversation kept alive against it is worth nothing. A turn actually
   * in flight is still never killed — the host says the key applies next
   * start, and means it.
   */
  async reloadSecrets(): Promise<SecretReload> {
    if ((this.#config.secrets?.length ?? 0) === 0) return 'unsupported'
    if (this.#health.state !== 'ready') return 'restarted'
    const busy = [...this.#sessions.values()].some(
      (session) => session.id !== this.#probeId && session.busy,
    )
    if (busy) {
      this.#config.logger?.info?.('secret changed but a turn is in flight; it applies next start', {
        agent: this.#config.id,
      })
      return 'busy'
    }
    this.#config.logger?.info?.('restarting agent', { agent: this.#config.id, why: 'a secret changed' })
    await this.#connection.stop()
    this.#sessions.clear()
    this.#probe = null
    this.#probeId = null
    this.#opening = null
    this.#catalogDefault = null
    this.#commands = []
    await this.start()
    return 'restarted'
  }

  health(): RuntimeHealth {
    return this.#health
  }

  onHealthChange(listener: (health: RuntimeHealth) => void): Unsubscribe {
    this.#healthListeners.add(listener)
    return () => this.#healthListeners.delete(listener)
  }

  onInfoChange(listener: () => void): Unsubscribe {
    this.#infoListeners.add(listener)
    return () => this.#infoListeners.delete(listener)
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * The catalogue view of the agent's models. ACP declares models per
   * session, never as a list of its own, so the answer is whatever the
   * agent last declared — learned from the draft probe, which costs nothing
   * until it is prompted. Opening it here is what fills the settings
   * catalogue for an agent nobody has talked to yet.
   */
  async listModels(): Promise<readonly ModelInfo[]> {
    if (this.#catalog.length === 0 && this.#health.state === 'ready') {
      try {
        await this.#openProbe()
      } catch (error) {
        this.#config.logger?.debug?.('the agent would not open a probe session', {
          agent: this.#config.id,
          error: describeAcp(error),
        })
      }
    }
    this.#catalogRead = true
    return this.#catalog
  }

  /**
   * The agent's commands as skills: what it offers, with what it says each
   * one is for. ACP declares them per session, so the draft probe is opened
   * for the same reason the catalogue opens it, and nothing here can be
   * turned off — an agent's commands are configured in the agent.
   */
  async listSkills(cwd?: string): Promise<readonly SkillInfo[]> {
    // An answer of "none" belongs only to an agent that was actually asked.
    // An agent that cannot start, or will not open the probe, must *throw*:
    // callers that treat this as the agent's own report (the library's
    // reach column does, and `reported` outranks the disk there) would
    // otherwise read a dead process as "loaded nothing", and every skill on
    // disk would show as unreachable for it.
    if (this.#commands.length === 0 && this.#health.state !== 'ready') {
      throw new Error(
        this.#health.state === 'starting'
          ? 'The agent is still starting and has not said what it loaded.'
          : this.#health.message,
      )
    }
    if (this.#commands.length === 0 && this.#health.state === 'ready') {
      try {
        await this.#openProbe(cwd)
        // They are declared just *after* the session exists, as an update.
        // A moment is given for the first one; anything later arrives as
        // `catalog/changed`, and the window re-reads then.
        await this.#firstCommands()
      } catch (error) {
        this.#config.logger?.debug?.('the agent would not open a probe session', {
          agent: this.#config.id,
          error: describeAcp(error),
        })
        // Nothing was ever reported and the one chance to ask just failed:
        // "no skills" would be this adapter's claim, not the agent's.
        throw error instanceof Error ? error : new Error(describeAcp(error))
      }
    }
    return this.#commands
      .map(
        (command): SkillInfo => ({
          name: command.name,
          description: command.description?.trim() ?? '',
          enabled: true,
          toggleable: false,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Remembers what the agent declared it can be asked to run. */
  learnCommands(commands: readonly AcpAvailableCommand[]): void {
    if (commands.length === 0) return
    const same =
      commands.length === this.#commands.length &&
      commands.every((command, index) => command.name === this.#commands[index]?.name)
    this.#commands = commands
    for (const wake of this.#commandsWaiting.splice(0)) wake()
    if (!same) this.emit({ type: 'catalog/changed', runtime: runtimeId(this.#config.id) })
  }

  /**
   * Adopts what a session declared as the runtime's catalogue: the models,
   * and for each the reasoning levels it supports.
   *
   * Levels come from the model itself when the bridge says so — HarnessDesk's
   * own bridges put per-model levels in `_meta`, because Claude Code's Haiku
   * has none while its Opus has five — and otherwise from the session's own
   * `thought_level` option, which is the best a conforming agent offers.
   * `currentModelId` is the default only on the first declaration: the probe's
   * model changes as drafts are tried, and the agent's default does not.
   */
  #learnCatalog(result: AcpNewSessionResult): void {
    const models = result.models?.availableModels ?? []
    if (models.length === 0) return
    const shared = levelsOfOptions(result.configOptions ?? [])
    const isDefault = (modelId: string): boolean =>
      this.#catalogDefault === null ? modelId === result.models?.currentModelId : modelId === this.#catalogDefault
    const catalog = models.map(
      (model): ModelInfo => ({
        id: model.modelId,
        displayName: model.name,
        ...(model.description ? { description: model.description } : {}),
        reasoningLevels: levelsOfModel(model) ?? shared,
        supportsImages: this.info.capabilities.imageInput,
        ...(model._meta?.harnessdesk?.thinking
          ? { thinking: model._meta.harnessdesk.thinking }
          : {}),
        ...(isDefault(model.modelId) ? { isDefault: true } : {}),
      }),
    )
    if (this.#catalogDefault === null) this.#catalogDefault = result.models?.currentModelId ?? null
    if (JSON.stringify(catalog) === JSON.stringify(this.#catalog)) return
    this.#catalog = catalog
    // Learning it before anyone asked is not news: `listModels` opens the
    // probe before it answers, so its first answer is already complete. A
    // declaration that differs from one already handed out is news — an
    // agent that could not list its models at first ask fills the window
    // when the next session succeeds, rather than leaving it empty.
    if (this.#catalogRead) this.emit({ type: 'catalog/changed', runtime: runtimeId(this.#config.id) })
  }

  /** One sign-in method per declared secret; the id names the variable. */
  #keyMethods(): AuthMethod[] {
    return (this.#config.secrets ?? []).map((secret) => ({
      id: `apiKey:${secret.env}`,
      label: secret.label,
      flow: 'apiKey' as const,
      keyLabel: secret.label,
      ...(secret.helpUrl ? { helpUrl: secret.helpUrl } : {}),
      ...(secret.description ? { description: secret.description } : {}),
    }))
  }

  async getAccount(): Promise<AccountStatus> {
    // ACP cannot say who is signed in; the agent's CLI can, when the
    // registry says how to ask it. Without that, the surface stays empty
    // rather than guessing wrong in either direction.
    const keyMethods = this.#keyMethods()
    // A stored key is an account: it is what "signed in" means for an agent
    // that authenticates with one, and the label never carries the value.
    const keyAccounts: Account[] = (this.#config.secrets ?? []).flatMap((secret) => {
      const where = whereSecretLives(secret, this.#config.resolveSecret)
      return where ? [{ kind: where.kind, label: secret.label, planType: where.detail }] : []
    })
    if (this.#account) {
      const status = await this.#account.status()
      return {
        accounts: [...status.accounts, ...keyAccounts],
        signInMethods: [...status.signInMethods, ...keyMethods],
      }
    }
    const observed = this.#observedAccount(keyAccounts.length > 0)
    return {
      accounts: [...keyAccounts, ...observed.accounts],
      signInMethods: [...keyMethods, ...observed.signInMethods],
    }
  }

  async login(_method: string): Promise<LoginStart> {
    if (!this.#account) throw new Error(`${this.#config.name} declares no sign-in command.`)
    return this.#account.login()
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.#account?.cancel(loginId)
  }

  async logout(): Promise<void> {
    if (!this.#account) throw new Error(`${this.#config.name} declares no sign-out command.`)
    await this.#account.logout()
  }

  async getRateLimits(): Promise<RateLimits | null> {
    return null
  }

  async listSessions(query?: ListSessionsQuery): Promise<Page<SessionSummary>> {
    const live = [...this.#sessions.values()]
      .filter((session) => session.id !== this.#probeId)
      .map((session) => session.summary())
    if (!this.#initialized?.agentCapabilities?.sessionCapabilities?.list) {
      return { data: live, nextCursor: null }
    }
    // The agent keeps its own store (Claude Code writes ~/.claude/projects);
    // reading through it is what lets a conversation outlive both this
    // process and the agent's — the same rule the Codex adapter follows.
    try {
      // The workspace travels with the question when the caller has one: an
      // agent that keys its store by folder — Cursor hashes the path — can
      // only answer for a folder it has been given.
      const listed = await this.#connection.request<{ sessions?: readonly AcpSessionRow[] }>(
        'session/list',
        query?.cwd ? { cwd: query.cwd } : {},
      )
      const rows = listed.sessions ?? []
      // The agent names its own conversations — Claude Code writes a title
      // into the transcript as the turn runs — and that name is what its own
      // window shows. A session open here has no title of its own, so it
      // takes the agent's rather than falling back to the first thing the
      // user typed: one conversation, one name, in both windows.
      for (const row of rows) {
        const title = row.title?.trim()
        if (title) this.#titles.set(makeSessionId(row.sessionId), title)
        // The ask a conversation opened with, for the same reason: a session
        // loaded here has no turns of its own to take one from — the agent
        // keeps the transcript — and a row with neither name nor ask reads
        // as "Untitled session" while the agent knows exactly what it is.
        // By the rule every producer's preview follows (review of #231).
        const preview = openingOf(row.preview ?? '').slice(0, 120)
        if (preview) this.#previews.set(makeSessionId(row.sessionId), preview)
      }
      const named = live.map((summary) => {
        const title = summary.title ?? this.#titles.get(summary.id) ?? null
        const preview = summary.preview ?? this.#previews.get(summary.id) ?? null
        return title === summary.title && preview === summary.preview
          ? summary
          : { ...summary, title, preview }
      })
      const stored = rows
        .filter((row) => !this.#sessions.has(makeSessionId(row.sessionId)))
        .map(
          (row): SessionSummary => ({
            id: makeSessionId(row.sessionId),
            runtime: this.info.id,
            title: row.title?.trim() || null,
            // What the conversation opened with, for the rows an agent
            // leaves unnamed — the same split a live session has, where the
            // title is the agent's name and the preview is the ask.
            preview: openingOf(row.preview ?? '').slice(0, 120) || null,
            cwd: row.cwd,
            status: { type: 'notLoaded' },
            createdAt: row.updatedAt ? Date.parse(row.updatedAt) : 0,
            updatedAt: row.updatedAt ? Date.parse(row.updatedAt) : 0,
            git: null,
          }),
        )
      return { data: [...named, ...stored].sort((a, b) => b.updatedAt - a.updatedAt), nextCursor: null }
    } catch {
      return { data: live, nextCursor: null }
    }
  }

  /** The agent's own name for a session, as of the last listing. */
  titleOf(id: SessionId): string | null {
    return this.#titles.get(id) ?? null
  }

  /** The ask each session opened with, as of the last listing. */
  previewOf(id: SessionId): string | null {
    return this.#previews.get(id) ?? null
  }

  /** What the agent last called each session it knows about. */
  readonly #titles = new Map<SessionId, string>()
  readonly #previews = new Map<SessionId, string>()

  async searchSessions(query: string): Promise<Page<SessionSummary>> {
    const needle = query.toLowerCase()
    return {
      data: [...this.#sessions.values()]
        .map((session) => session.summary())
        .filter((summary) => (summary.preview ?? '').toLowerCase().includes(needle)),
      nextCursor: null,
    }
  }

  async readSession(id: SessionId): Promise<Session> {
    const live = this.#sessions.get(id)
    if (live) return live.snapshot()
    // ACP has no read-only fetch; loading *is* reading. Free of tokens: a
    // load replays the stored conversation, it does not prompt anything.
    const loaded = await this.resumeSession(id)
    return (loaded as AcpSession).snapshot()
  }

  /**
   * Never reached: `capabilities.archiveHistory` is false, so the host keeps
   * the mark rather than asking. Left as a guard, not as a feature.
   */
  async archiveSession(_id: SessionId, _archived: boolean): Promise<void> {
    throw new Error(`${this.#config.name} keeps no archive of its own.`)
  }

  /**
   * Removes the conversation from the agent's own store, through the bridge
   * that knows where that is. See `ACP_SESSION_DELETE`.
   *
   * A session live in this process is dropped first — the bridge is about to
   * delete the transcript underneath it, and a handle to a conversation that
   * no longer exists would answer the next prompt by re-creating it.
   */
  async deleteSession(id: SessionId): Promise<SessionDeletion> {
    if (!this.#canDelete) {
      throw new Error(`${this.#config.name} cannot delete a stored conversation.`)
    }
    const live = this.#sessions.get(id)
    if (live) {
      await live.close().catch(() => {})
      this.#sessions.delete(id)
    }
    const result = await this.#connection.request<AcpSessionDeleted>(ACP_SESSION_DELETE, {
      sessionId: String(id),
    })
    this.#titles.delete(id)
    this.#previews.delete(id)
    const disposition = result?.disposition ?? 'removed'
    const removed = result?.removed?.length ?? 0
    this.#config.logger?.debug?.('session deleted', { session: String(id), removed, disposition })
    return { disposition, removed }
  }

  /** Whether the agent declared `ACP_SESSION_DELETE` in the handshake. */
  #canDelete = false

  /**
   * What a new session would offer, before one exists — the protocol's
   * `defaultSessionOptions`. ACP only declares modes, models and config
   * options in `session/new`'s response, so the first call opens a probe
   * session — never registered, never shown, and free: an ACP session costs
   * nothing until it is prompted — and caches what it declared. Without
   * this, the composer has no model picker until after the first message,
   * which is exactly when picking the small model mattered.
   */
  async defaultSessionOptions(
    cwd?: string,
    values?: Readonly<Record<string, OptionValue>>,
  ): Promise<readonly ConfigOption[]> {
    const probe = await this.#openProbe(cwd)
    // Draft picks are applied to the probe for real: session/set_* is free of
    // token spend, and only the agent knows which options a pick reveals —
    // choosing a model family may declare that family's effort and thinking
    // controls, which a local overlay could never know about. Model and mode
    // go first, because they decide what else exists.
    const entries = Object.entries(values ?? {}).sort(
      ([a], [b]) => rankOptionId(a) - rankOptionId(b),
    )
    for (const [id, value] of entries) {
      const option = findOption(probe.options(), id)
      // Which picks may fail the call is the difference between identity and
      // dimension. A mode or a model that the agent will not take is the
      // caller's question answered wrongly — say so. A dimension is a
      // standing preference that the model just chosen may have no use for:
      // Cursor's Gemini families cannot think, so a stored `thinking: true`
      // arrives here undeclared or refused every time that model is picked.
      // Throwing on it used to take the model change down with it, which is
      // how choosing a model became impossible. It is dropped instead, and
      // the caller reads what actually landed off the returned list.
      const refusal = option ? refuseOptionValue(option, value) : `no option named ${JSON.stringify(id)}`
      if (!refusal) {
        if (option && option.currentValue !== value) await probe.setOption(id, value)
        continue
      }
      if (rankOptionId(id) < 2) {
        throw new Error(
          option
            ? refusal
            : `${this.#config.name} has no session option named ${JSON.stringify(id)}.`,
        )
      }
      this.#config.logger?.debug?.('draft pick dropped', { option: id, reason: refusal })
    }
    return probe.options()
  }

  /**
   * The draft session, opened once. It is a real session the agent counts as
   * one — never registered with the host, never listed, never prompted — and
   * the only place the agent's declarations can be read before a
   * conversation exists.
   */
  async #openProbe(cwd?: string): Promise<AcpSession> {
    if (this.#probe) return this.#probe
    // The *opening* is what is shared, not just the opened session. Two
    // callers on the same tick — the composer asking what a draft would
    // start with, Settings asking the same question — both find `#probe`
    // null and both open one. Only the last is remembered as the probe; the
    // others stay registered, unprompted and unnameable, and the agent lists
    // them forever as "Untitled session".
    this.#opening ??= this.#startProbe(cwd)
    try {
      return await this.#opening
    } catch (error) {
      // A failed open is not a cached answer: the next caller may succeed.
      this.#opening = null
      throw error
    }
  }

  async #startProbe(cwd?: string): Promise<AcpSession> {
    const where = cwd ?? process.cwd()
    const opened = await this.#openWithTools<AcpNewSessionResult>('session/new', { cwd: where })
    const probe = AcpSession.probe(this, opened, where)
    // Registered so the agent's follow-up notifications (an agent may
    // re-declare its options after set_model) reach it — but silent, and
    // hidden from every listing.
    this.#sessions.set(probe.id, probe)
    this.#probe = probe
    this.#probeId = probe.id
    this.#learnCatalog(opened)
    return probe
  }

  #probe: AcpSession | null = null
  #probeId: SessionId | null = null
  /** The probe being opened right now, so concurrent askers share one. */
  #opening: Promise<AcpSession> | null = null
  /** What the agent's answers showed about its sign-in; see `SignInObservation`. */
  #signIn: SignInObservation = { state: 'unknown' }
  /** The agent's models as last declared, for the settings catalogue. */
  #catalog: readonly ModelInfo[] = []
  /** The model the agent chose for itself, before any draft pick moved it. */
  #catalogDefault: string | null = null
  /** Whether the catalogue has been handed out, which is what makes a later change news. */
  #catalogRead = false
  /** The commands the agent last declared — its skills, in ACP's vocabulary. */
  #commands: readonly AcpAvailableCommand[] = []
  readonly #commandsWaiting: (() => void)[] = []

  /** Resolves on the first declaration, or after a moment if none comes. */
  async #firstCommands(ms = 1_000): Promise<void> {
    if (this.#commands.length > 0) return
    await new Promise<void>((resolve) => {
      // Never unref'd: this timer is the promise's only guaranteed resolver,
      // and an awaited promise whose sole resolver does not hold the event
      // loop is a promise the loop can abandon — which Node 22 does, taking
      // the whole caller down as "still pending but the loop has resolved".
      // Bounded at a second, it can only ever delay an exit, not prevent one.
      const timer = setTimeout(resolve, ms)
      this.#commandsWaiting.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * The open's `_meta` with the desk's standing instruction added under the
   * `harnessdesk` key, when there is one — beside whatever else the caller
   * put there, never in place of it. Sent whether or not the bridge declared
   * it can use it: `_meta` is the slot an agent may ignore.
   */
  #briefed(params: Record<string, unknown>): { _meta?: Record<string, unknown> } {
    const text = this.#config.instructions?.().trim() ?? ''
    if (text === '') return {}
    const meta = (params['_meta'] ?? {}) as Record<string, unknown>
    const ours = (meta['harnessdesk'] ?? {}) as Record<string, unknown>
    return { _meta: { ...meta, harnessdesk: { ...ours, [ACP_INSTRUCTIONS_CAPABILITY]: text } } }
  }

  /**
   * `session/new` or `session/load`, with the tool bridge offered unless this
   * agent has already refused it. A refusal is not a failure: retry once
   * without the bridge, remember, and log why the plugin tools are absent.
   */
  async #openWithTools<T>(method: 'session/new' | 'session/load', params: Record<string, unknown>): Promise<T> {
    const caller = randomUUID()
    const servers = this.#toolServerRefused ? [] : mcpServersOf(this.#config, caller)
    // The token's runtime is known now; its session only once the open answers.
    if (servers.length > 0) this.#config.toolServer?.onOpen?.(caller)
    // The claim closes the loop: the bridge this open spawns carries the
    // token, and whoever built the runtime now learns which session it names.
    const claim = (result: T): T => {
      const sessionId = (result as { sessionId?: unknown }).sessionId ?? params['sessionId']
      if (servers.length > 0 && typeof sessionId === 'string') {
        this.#config.toolServer?.onSession?.(caller, sessionId)
      }
      return result
    }
    try {
      return this.#opened(
        claim(await this.#connection.request<T>(method, { ...params, ...this.#briefed(params), mcpServers: servers })),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The tool-server refusal is answered first, by a retry without the
      // server; only a failure that is not that refusal is read for what
      // it says about the sign-in, so neither classification can hide the
      // other.
      if (servers.length === 0 || !REFUSES_TOOL_SERVER.test(message)) {
        this.#refusedForSignIn(error)
        throw error
      }
      // Two opens can race into the same refusal — the eager probe and the
      // first real session — and the flag flips once, so the announcement
      // happens once: a second "info changed" for the same fact is noise.
      if (!this.#toolServerRefused) {
        this.#toolServerRefused = true
        this.#config.logger?.info?.('agent does not accept an MCP tool server; HarnessDesk plugin tools are unavailable to it', {
          agent: this.#config.id,
          reason: message,
        })
        // `pluginTools` was true until this moment, and the window has been
        // saying so. Say otherwise now, or the badge stays wrong until some
        // unrelated refresh happens to correct it.
        for (const listener of this.#infoListeners) listener()
      }
      try {
        return this.#opened(await this.#connection.request<T>(method, { ...params, mcpServers: [] }))
      } catch (again) {
        this.#refusedForSignIn(again)
        throw again
      }
    }
  }

  /** A session opened: whoever the agent is signed in as, it is signed in. */
  #opened<T>(result: T): T {
    this.#noteSignIn({ state: 'observed' })
    return result
  }

  /** An open the agent refused for want of a sign-in, noted; false for any other failure. */
  #refusedForSignIn(error: unknown): boolean {
    if (!isAuthRefusal(error)) return false
    this.#noteSignIn({ state: 'required', message: describeAcp(error) })
    return true
  }

  #noteSignIn(next: SignInObservation): void {
    const before = this.#signIn
    if (before.state === next.state && (next.state !== 'required' || before.state !== 'required' || before.message === next.message)) return
    this.#signIn = next
    // `account` was false until the first observation, and a window may
    // already be drawn from that; and whoever holds the account surface
    // open should hear that the answer changed.
    if (before.state === 'unknown') for (const listener of this.#infoListeners) listener()
    this.emit({ type: 'account/changed', runtime: runtimeId(this.#config.id) })
  }

  /**
   * The account surface for an agent the desk cannot ask, from what it saw.
   * A stored key already explains a session that opened, so beside one the
   * observation adds nothing; without one it is the only evidence there is.
   * The observation says *that* the agent is signed in, and the agent's own
   * record says who as — read through `resolveIdentity` where the host knows
   * where the agent writes it, "Signed in" where it does not. Only after a
   * session opened: a record on disk is what the agent will try, not proof
   * that it still works, and a refusal outranks it.
   * A refusal is answered with the agent's declared methods, as `external`
   * flows: the desk does not drive ACP's `authenticate` yet, so the honest
   * offer is the agent's own words about how to sign in.
   */
  #observedAccount(hasKey: boolean): AccountStatus {
    const seen = this.#signIn
    if (seen.state === 'observed') {
      if (hasKey) return { accounts: [], signInMethods: [] }
      return {
        accounts: [this.#identity() ?? { kind: 'agent', label: 'Signed in', anonymous: true }],
        signInMethods: [],
      }
    }
    if (seen.state === 'required') {
      const said = firstSentence(seen.message)
      return {
        accounts: [],
        signInMethods: (this.#initialized?.authMethods ?? []).map((method) => ({
          id: `acp:${method.id}`,
          label: method.name,
          flow: 'external' as const,
          description: [method.description ?? '', said].filter((part) => part.length > 0).join(' — '),
        })),
      }
    }
    return { accounts: [], signInMethods: [] }
  }

  /**
   * Who the agent's own record says it is signed in as, or null. A reader
   * that throws is a record the desk could not read, which says nothing
   * about the sign-in — so it is logged, and the observation stands.
   */
  #identity(): Account | null {
    try {
      return this.#config.resolveIdentity?.() ?? null
    } catch (error) {
      this.#config.logger?.warn?.('could not read who the agent is signed in as', {
        agent: this.#config.id,
        error: String(error),
      })
      return null
    }
  }

  async createSession(options: SessionOptions): Promise<AgentSession> {
    /* `SessionOptions` is `Partial<SessionSettings> & …`, so `model` is legal
       to write — and it used to be read by nobody here, which made "start this
       conversation on that model" a request that was accepted and dropped. It
       cost a live run: three conversations asked for three models all came up
       on the first one's, and the room named them after the agent because that
       is what `settings()` had to fall back on.
       It folds into the option the runtime actually declares, and does not
       override an explicit `options.model` — a caller who wrote both meant the
       specific one. An id the runtime does not offer is still refused by
       `setOption`, which is the behaviour to keep: a preset that silently
       half-applies is worse than one that fails. */
    const initial: Record<string, OptionValue> = {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.options ?? {}),
    }
    const result = await this.#openWithTools<AcpNewSessionResult>('session/new', {
      cwd: options.cwd,
      // The initial values ride along in ACP's extension slot too: a bridge
      // that can only apply a control when it spawns the agent (Claude
      // Code's `--effort`) reads them here; every other agent ignores the
      // key, and the `setOption` calls below apply the values the usual way.
      ...(Object.keys(initial).length > 0 ? { _meta: { harnessdesk: { options: initial } } } : {}),
    })
    const session = new AcpSession(this, result, options.cwd)
    this.#sessions.set(session.id, session)
    this.#learnCatalog(result)
    // Initial option values ride the same path a user change would — mode
    // and model first, because they decide which other options exist.
    const ordered = Object.entries(initial).sort(([a], [b]) => rankOptionId(a) - rankOptionId(b))
    try {
      for (const [id, value] of ordered) {
        /*
         * Inapplicable is not the same as wrong, and only one of them should
         * cost the caller a session.
         *
         * These values arrive from the picks stored against the *agent*, so a
         * dimension among them is a standing preference rather than an
         * argument to this call: `thinking` when the chosen family cannot
         * think, Max mode when it has one context window. The option is
         * absent or greyed, the preference simply has no place here, and the
         * next family that can honour it still will. Dropping it is what the
         * draft probe has always done; this path never learned the same
         * lesson, and the asymmetry was a hole with no way out of it from
         * inside the app — one stored pick the current family had no place
         * for and *every* new session on that agent threw, for the life of
         * the process, with the only way back being to change the setting on
         * a session you could no longer open.
         *
         * Narrow on purpose: only an option the session *declares and greys*
         * is dropped. A value the option does not offer is a typo or a stale
         * preset and still fails the call; so does an id the agent has no
         * option for at all, which the conformance suite requires and which is
         * the difference between a preference going spare and a bug. A mode or
         * a model the agent will not take fails for the same reason — those
         * are the caller's question answered wrongly.
         */
        if (rankOptionId(id) >= 2 && findOption(session.options(), id)?.disabled) {
          this.#config.logger?.debug?.('initial pick has no place in this session', {
            option: id,
            reason: findOption(session.options(), id)?.disabled,
          })
          continue
        }
        await session.setOption(id, value)
      }
    } catch (error) {
      // A session that could not be given what it was asked for is not a
      // session anyone asked for. Left registered, it sat in the list as an
      // "Untitled session" with no turns, for the life of the process — the
      // Codex adapter has always closed it; this one kept it.
      this.#sessions.delete(session.id)
      await session.close()
      throw error
    }
    this.emit({ type: 'session/started', session: session.snapshot() })
    return session
  }

  async resumeSession(id: SessionId): Promise<AgentSession> {
    const live = this.#sessions.get(id)
    if (live) return live
    const capabilities = this.#initialized?.agentCapabilities
    if (!capabilities?.loadSession && !capabilities?.sessionCapabilities?.resume) {
      throw new SessionGoneError(
        `${this.#config.name} cannot resume ${id}: the agent keeps no session store.`,
      )
    }
    // The load replays the whole conversation as session/update notifications
    // before its response returns, so the session must exist — in replay mode,
    // folding updates into history turns without emitting live events — from
    // the moment the request is sent.
    const cwd = await this.#cwdOf(id)
    // A stored session names the folder it ran in, and loading it starts the
    // agent there. Once that folder is deleted the spawn fails deep inside the
    // agent and comes back as a bare "Internal error" that names nothing —
    // so it is checked here, while the folder's name is still in hand.
    if (!isDirectory(cwd)) {
      // Named on the wire as well as in the sentence: this is the one refusal
      // with somewhere to go afterwards, and the interface offers that by the
      // code rather than by recognising the words. See `SessionFolderGoneError`.
      throw new SessionFolderGoneError(
        `${this.#config.name} cannot open this conversation: its folder no longer exists (${cwd}).`,
        cwd,
      )
    }
    const session = AcpSession.forReplay(this, id, cwd)
    this.#sessions.set(id, session)
    try {
      const loaded = await this.#openWithTools<AcpNewSessionResult>('session/load', { sessionId: id, cwd })
      session.finishReplay(loaded)
      return session
    } catch (error) {
      this.#sessions.delete(id)
      throw error
    }
  }

  /** Where a stored session worked, from the agent's own listing. */
  async #cwdOf(id: SessionId): Promise<string> {
    try {
      const listed = await this.#connection.request<{ sessions?: readonly AcpSessionRow[] }>(
        'session/list',
        {},
      )
      const row = (listed.sessions ?? []).find((entry) => entry.sessionId === String(id))
      if (row) return row.cwd
    } catch {
      // Fall through to the working directory; the load itself will complain
      // if the id is genuinely unknown.
    }
    return process.cwd()
  }

  async forkSession(): Promise<AgentSession> {
    throw new Error(`${this.#config.name} does not support forking a session.`)
  }

  // ------------------------------------------------------------------ internal

  get connection(): AcpConnection {
    return this.#connection
  }

  get agentName(): string {
    return this.#config.name
  }

  /** Where this agent keeps its own count of usage, when it puts none on the wire. */
  get usageRecord(): AcpUsageRecord | undefined {
    return this.#config.usageRecord
  }

  emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  #setHealth(health: RuntimeHealth): void {
    this.#health = health
    for (const listener of this.#healthListeners) listener(health)
  }

  #onExit(code: number | null): void {
    this.#setHealth({
      state: 'unavailable',
      reason: 'crashed',
      message: `${this.#config.name} exited${code !== null ? ` with code ${code}` : ''}.`,
      remediation: 'Select the runtime again to restart it.',
    })
    for (const session of this.#sessions.values()) {
      session.agentDied()
      this.#tasks?.forget(session.id)
    }
  }

  /** The agent's own long-running work, for agents that report it. */
  get tasks(): AcpTasks | undefined {
    return this.#tasks ?? undefined
  }

  /**
   * Installs the extension client on first evidence the agent speaks it.
   * Lazily, so an agent that never mentions background tasks never grows a
   * `tasks` member and reports the capability as false — which is the honest
   * answer for most ACP agents, and keeps the panel off screens that would
   * only ever show it empty.
   */
  #adoptTasks(): AcpTasks {
    this.#tasks ??= new AcpTasks(this.#connection, (sessionId, tasks) =>
      this.emit({ type: 'session/tasks', sessionId, tasks }),
    )
    return this.#tasks
  }

  #onNotification(method: string, params: unknown): void {
    if (method === ACP_TASKS_NOTIFICATION) {
      const changed = params as AcpTasksChanged
      if (typeof changed?.sessionId !== 'string' || !Array.isArray(changed.tasks)) return
      // An agent that pushes a list without having declared the capability is
      // taken at its word — a list that arrived is better evidence than a
      // flag that did not — and the runtime says so, so a window drawn before
      // the first task redraws with the panel.
      const first = this.#tasks === null
      this.#adoptTasks().accept(changed.sessionId, changed.tasks)
      if (first) for (const listener of this.#infoListeners) listener()
      return
    }
    if (method === ACP_DELEGATION_NOTIFICATION) {
      const changed = params as AcpDelegationChanged
      if (typeof changed?.sessionId !== 'string' || !Array.isArray(changed.delegations)) return
      this.#sessions
        .get(makeSessionId(changed.sessionId))
        ?.acceptDelegations(changed.delegations, changed.delegated ?? null)
      return
    }
    if (method !== 'session/update') return
    const { sessionId, update } = params as { sessionId: string; update: AcpSessionUpdate }
    // Commands belong to the agent, not to one conversation, and the first
    // declaration can land before `session/new`'s reply has been read — so
    // it is taken here, where no session has to exist yet.
    if (update.sessionUpdate === 'available_commands_update') {
      this.learnCommands(update.availableCommands)
      return
    }
    this.#sessions.get(makeSessionId(sessionId))?.applyUpdate(update)
  }

  async #onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      const request = params as AcpPermissionRequest
      const session = this.#sessions.get(makeSessionId(request.sessionId))
      if (!session) throw new AcpError(`no session ${request.sessionId}`)
      return session.requestPermission(request)
    }
    // fs/* and terminal/* land here if an agent ignores the declined
    // capabilities. Refusing loudly is the boundary working, not an error in it.
    throw new AcpError(
      `This client does not serve ${method}; execution belongs to the agent.`,
    )
  }
}

// -------------------------------------------------------------------- session

const NO_TOKENS: TokenUsage = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
}

/**
 * ACP's turn usage in the protocol's shape. ACP's `inputTokens` is the
 * whole input and `cachedReadTokens` the part of it served from cache, which
 * is also how Codex counts — so `cachedInputTokens` stays a share of
 * `inputTokens`, and the turn tail's "% cached" means the same thing for
 * every agent.
 */
const tokenUsageOf = (usage: AcpUsage): TokenUsage => ({
  totalTokens: usage.totalTokens,
  inputTokens: usage.inputTokens,
  cachedInputTokens: Math.min(usage.inputTokens, usage.cachedReadTokens ?? 0),
  // The miss half, kept rather than dropped. It arrived here from the first
  // day ACP had a usage shape and went nowhere, which left the turn tail
  // dividing hits by input and calling the quotient cache health — a figure
  // that reads a cold turn and a small turn as the same thing. Absent stays
  // absent: an agent that does not report writes must not be shown a zero.
  ...(typeof usage.cachedWriteTokens === 'number'
    ? { cacheWriteTokens: Math.min(usage.inputTokens, usage.cachedWriteTokens) }
    : {}),
  outputTokens: usage.outputTokens,
  reasoningOutputTokens: usage.thoughtTokens ?? 0,
})

/**
 * A turn's tokens from the `_meta.quota` an agent answers a prompt with, in
 * ACP's own usage shape. Gemini CLI reports its usage there and nowhere else
 * — 0.59 sends no `usage` field and no `usage_update` — so until this was read
 * its sessions had no ring at all. Read by shape, not by agent: whoever sends
 * the same block is understood the same way.
 *
 * Both counts are sums over every model call the turn made, which is what
 * ACP's `usage` means too. There is no cache or thinking split in the block,
 * so none is claimed — the cache chip stays silent — and nothing in it says
 * how big the window is, so the ring is the dashed one. A turn answered
 * without a model call (a slash command the agent handles itself) reports
 * zeros, and is recorded as exactly that.
 */
const quotaUsageOf = (meta: AcpPromptMeta | null | undefined): AcpUsage | null => {
  const count = meta?.quota?.token_count
  const input = count?.input_tokens
  const output = count?.output_tokens
  if (!isTokenCount(input) || !isTokenCount(output)) return null
  return { totalTokens: input + output, inputTokens: input, outputTokens: output }
}

const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * A delegation's counts in the protocol's shape.
 *
 * Not routed through `tokenUsageOf`: ACP's own usage shape has no slot for
 * exactness, so composing the two silently produced an ordinary exact
 * `TokenUsage` and threw the floor away — a child whose output was still the
 * `message_start` placeholder then read as having produced one token rather
 * than at least one.
 *
 * Every field of the extension's usage is optional — an agent is allowed to
 * know less than the full shape — and a missing count is nothing, never a
 * guess.
 */
const delegationTokensOf = (usage: AcpDelegationUsage): TokenUsage => {
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  return {
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, usage.cachedReadTokens ?? 0),
    ...(typeof usage.cachedWriteTokens === 'number'
      ? { cacheWriteTokens: Math.min(inputTokens, usage.cachedWriteTokens) }
      : {}),
    outputTokens,
    // Only the false case travels: absent means exact, and writing `true`
    // everywhere would make an ordinary reading look like a claim.
    ...(usage.outputExact === false ? { outputExact: false } : {}),
    reasoningOutputTokens: 0,
  }
}

const DELEGATION_STATUS: Readonly<Record<string, ItemStatus>> = {
  running: 'inProgress',
  completed: 'completed',
  failed: 'failed',
  stopped: 'failed',
}

/**
 * One delegation as a transcript row.
 *
 * `previous` is whatever already stood at this id — normally the tool call
 * that spawned it, occasionally an earlier version of this same row. Its
 * `startedAt` is kept, because the call is when the delegation began and the
 * push is merely when we heard about it.
 *
 * The child is a member of the call, keyed by its own session where the agent
 * named one and by the delegation's id where it did not. Claude Code runs a
 * sub-agent inside the parent's process, so there is no session to link into
 * and the row must not offer one; the extension leaves the door open for an
 * agent whose children are real conversations.
 */
const subagentItemOf = (
  id: ItemId,
  delegation: AcpDelegation,
  previous: AgentItem | null,
): Extract<AgentItem, { type: 'subagent' }> => {
  // What actually answered, falling back to what was asked for. A child may
  // fall back to another model, and a helper model may run inside it.
  const model = delegation.models?.[0] ?? delegation.requestedModel ?? null
  // Only worth a badge when the two disagree — "asked for opus, ran on
  // haiku" is a fact; repeating the model beside itself is furniture.
  const asked =
    delegation.requestedModel && delegation.requestedModel !== model
      ? `asked for ${delegation.requestedModel}`
      : null
  const usage = delegation.usage ? delegationTokensOf(delegation.usage) : null
  return {
    id,
    type: 'subagent',
    action: 'spawn',
    status: DELEGATION_STATUS[delegation.state ?? 'running'] ?? 'inProgress',
    ...(delegation.prompt ? { prompt: delegation.prompt } : {}),
    ...(model ? { model } : {}),
    members: [
      {
        sessionId: delegation.sessionId ?? delegation.id,
        nickname: delegation.label ?? delegation.id,
        role: asked,
        state: delegation.state ?? null,
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        // Openable only where the agent named a conversation of its own.
        openable: typeof delegation.sessionId === 'string' && delegation.sessionId.length > 0,
      },
    ],
    ...(usage ? { usage } : {}),
    ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : { startedAt: delegation.startedAt ?? Date.now() }),
    ...(delegation.endedAt !== undefined ? { completedAt: delegation.endedAt } : {}),
  }
}

/**
 * The context composition an agent attached to a `usage_update`, narrowed to
 * what the protocol declares.
 *
 * Read defensively rather than trusted: `_meta` is by definition the slot
 * where anyone may put anything, so a segment without a positive token count
 * or a label is dropped, and a payload with nothing left is no breakdown at
 * all. Nothing here is derived — a runtime that reports two segments gets two
 * segments, and the missing third is the runtime's statement, not a gap to
 * fill in.
 */
const contextBreakdownOf = (meta: AcpUpdateMeta | null | undefined): ContextBreakdown | null => {
  const source = meta?.harnessdesk?.contextBreakdown
  if (!source) return null
  const segments: ContextSegment[] = []
  for (const segment of source.segments ?? []) {
    const tokens = segment.tokens
    const id = segment.id
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue
    if (typeof id !== 'string' || id.length === 0) continue
    segments.push({
      id,
      label: typeof segment.label === 'string' && segment.label.length > 0 ? segment.label : id,
      tokens,
      ...(typeof segment.count === 'number' && Number.isFinite(segment.count)
        ? { count: segment.count }
        : {}),
    })
  }
  if (segments.length === 0) return null
  return {
    segments,
    // Absent means approximate. An agent that has not thought about the
    // question has not earned the claim that its numbers are exact.
    approximate: source.approximate !== false,
    source: typeof source.source === 'string' && source.source.length > 0 ? source.source : 'the agent',
  }
}

const describeAcp = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * What the agent's own answers have said about its sign-in. ACP has no
 * account query, so this is never asked; it is observed. A session that
 * opened is an agent that is signed in, whoever it is signed in as; a
 * `session/new` refused for want of authentication is an agent that is not,
 * in its own words. Until either has happened the answer is "unknown", which
 * the account surface keeps apart from "signed out" — the two used to be one
 * empty list, and the desk read it as the second.
 */
type SignInObservation =
  | { readonly state: 'unknown' }
  | { readonly state: 'observed' }
  | { readonly state: 'required'; readonly message: string }

/**
 * ACP's own refusal for a session that needs a sign-in first is `-32000
 * auth_required` with the words "Authentication required" — but -32000 is
 * also the head of JSON-RPC's reserved server-error range, and an agent's
 * "internal server error" wears the same number. So the words decide, in
 * the message or in the details the agent attached: Antigravity's
 * server sends the code and the words, a bridge may send the words alone,
 * and a bare -32000 is a failure of some other kind.
 */
const AUTH_REQUIRED_WORDS =
  /authentication required|not authenticated|unauthenticated|auth[_ -]required|login required|sign[- ]?in required|not (?:signed|logged) in/i
const isAuthRefusal = (error: unknown): boolean =>
  error instanceof AcpError && AUTH_REQUIRED_WORDS.test(`${error.message}\n${error.details ?? ''}`)

/** The first sentence of what an agent said, for a line a person reads. */
const firstSentence = (text: string): string => {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  const cut = line.search(/[.!?](\s|$)/)
  return (cut === -1 ? line : line.slice(0, cut + 1)).slice(0, 200)
}

const textOf = (block: AcpContentBlock): string => (block.type === 'text' ? block.text : '')

/**
 * Arguments that say nothing yet. A call announced before its input is known
 * arrives as `null` or `{}`; either way the later announcement's input is
 * the one worth keeping, and anything already substantive is not overwritten.
 */
const emptyArgs = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)

/**
 * A raw tool output with its image bytes elided. The picture itself travels
 * as an image part beside this copy; keeping the base64 here too would ship
 * and store every screenshot twice.
 */
const withoutImageBytes = (raw: unknown): unknown =>
  Array.isArray(raw)
    ? raw.map((entry) => {
        const block = entry as { type?: unknown; data?: unknown; source?: unknown }
        if (block && typeof block === 'object' && block.type === 'image') {
          return { type: 'image', data: '(shown below)' }
        }
        return entry
      })
    : raw

/**
 * A replayed prompt block as the user content it was. An image comes back as
 * the bytes we sent, re-wrapped as the data URL the transcript renders; a
 * resource link is the file mention it stood for.
 */
/**
 * What an ACP agent's own CLI wraps around a prompt before sending it.
 *
 * Claude Code injects reminders and slash-command output into the message it
 * stores as the user's turn, and its desktop app pins a note to a screenshot
 * the person drew on before sending it; `claude-acp` already knows these
 * tags, but only to keep a session from being *named* after one. They are the
 * same species as Codex's ambient block: real context the model received, no
 * part of what anyone typed. The list is here rather than in `claude-acp`
 * because this is where an ACP transcript becomes items, and the layering
 * rule keeps adapters from importing each other.
 */
const ACP_ENVELOPE: PeelOptions = {
  tags: {
    'system-reminder': 'System reminder',
    'local-command-caveat': 'Slash command',
    'local-command-stdout': 'Command output',
    'local-command-stderr': 'Command output',
    'command-name': 'Slash command',
    'command-message': 'Slash command',
    'command-args': 'Slash command',
    // What the desktop app says about a picture the person drew on: the
    // sentence is about the image in the same message, so it folds beside it
    // rather than reading as something anyone typed.
    'preview-annotation-context': 'Annotated screenshot',
  },
}

/**
 * Add a replayed content block to the user message it belongs to, with the
 * agent's own scaffolding peeled off and kept beside the words.
 *
 * Per block, because that is how they arrive: the comment at the call site
 * records that a composed prompt replays as one chunk per part, so a wrapper
 * is a whole block rather than something spanning two.
 */
const withUserContent = (item: UserMessageItem, block: AcpContentBlock): UserMessageItem => {
  const { content, context } = peelUserContent([userContentOf(block)], ACP_ENVELOPE)
  const kept = [...item.context ?? [], ...context]
  return {
    ...item,
    content: [...item.content, ...content],
    ...(kept.length > 0 ? { context: kept } : {}),
  }
}

const userContentOf = (block: AcpContentBlock): UserContent => {
  switch (block.type) {
    case 'image':
      return { type: 'image', url: `data:${block.mimeType || 'image/png'};base64,${block.data}` }
    case 'resource_link': {
      const path = block.uri.replace(/^file:\/\//, '')
      return { type: 'mention', name: block.name || path.split('/').pop() || path, path }
    }
    default:
      return { type: 'text', text: textOf(block) }
  }
}

/**
 * The sentence a chunk carries when the agent has marked it as its own
 * housekeeping rather than as speech — the echo of a slash command it ran,
 * a background task reporting back, a turn the person stopped.
 *
 * `_meta` is ACP's extension slot, and `harnessdesk.notice` is the key our
 * bridges set. An agent that says nothing there is taken at its word: what it
 * replays as a user message is read as one.
 */
/**
 * The question a permission request is really asking, when our Claude bridge
 * says so — in `_meta.harnessdesk.question`, or, for a transport that drops
 * `_meta`, as the tool call's own input: one `questions` entry with a
 * question and options. Anything else is a permission.
 */
const questionOf = (
  request: AcpPermissionRequest,
): { question: string; header: string; multiSelect: boolean; options: readonly { label?: string; description?: string }[] } | null => {
  const marker = (request._meta?.['harnessdesk'] as { question?: unknown } | undefined)?.question
  const rawInput = request.toolCall.rawInput as { questions?: unknown } | undefined
  const fromInput = Array.isArray(rawInput?.questions) ? rawInput.questions[0] : undefined
  const candidate = (typeof marker === 'object' && marker !== null ? marker : fromInput) as
    | { question?: unknown; header?: unknown; options?: unknown }
    | undefined
  if (!candidate || typeof candidate.question !== 'string' || !Array.isArray(candidate.options)) return null
  return {
    question: candidate.question,
    header: typeof candidate.header === 'string' ? candidate.header : '',
    multiSelect: (candidate as { multiSelect?: unknown }).multiSelect === true,
    options: candidate.options.map((option) => ({
      ...(typeof (option as { label?: unknown })?.label === 'string' ? { label: (option as { label: string }).label } : {}),
      ...(typeof (option as { description?: unknown })?.description === 'string'
        ? { description: (option as { description: string }).description }
        : {}),
    })),
  }
}

const noticeOf = (update: Extract<AcpSessionUpdate, { sessionUpdate: 'user_message_chunk' }>): string | null => {
  const marker = update._meta?.['harnessdesk']
  if (typeof marker !== 'object' || marker === null) return null
  if ((marker as { notice?: unknown }).notice !== true) return null
  const text = textOf(update.content).trim()
  return text.length > 0 ? text : null
}

class AcpSession implements AgentSession {
  readonly id: SessionId
  readonly runtime
  readonly #host: AcpRuntime
  readonly #cwd: string
  #modes: AcpSessionModeState | null
  #models: AcpModelState | null
  #configOptions: readonly AcpConfigOption[]
  #turns: Turn[] = []
  #currentTurn: MutableTurn | null = null
  /** What the agent has said about tokens, if anything. Null until it does. */
  #usage: SessionUsage | null = null
  /**
   * Set once a turn went by that nobody could account for.
   *
   * The chain cannot be read off the total alone, which is why this is a flag
   * rather than an inference: an empty total is the *start* of the chain, so an
   * unknown first turn would leave the next known one opening a fresh exact
   * count over a hole. Never cleared — a gap is permanent.
   */
  #writeChainBroken = false

  /** True while a turn is in flight. */
  get busy(): boolean {
    return this.#currentTurn !== null && !this.#replaying
  }
  #counter = 0
  readonly #pendingPermissions = new Map<
    ApprovalId,
    (outcome: AcpPermissionOutcome) => void
  >()

  #replaying = false

  constructor(host: AcpRuntime, opened: AcpNewSessionResult, cwd: string) {
    this.#host = host
    this.id = makeSessionId(opened.sessionId)
    this.runtime = host.info.id
    this.#cwd = cwd
    this.#modes = opened.modes ?? null
    this.#models = opened.models ?? null
    this.#configOptions = opened.configOptions ?? []
  }

  /**
   * A session being loaded from the agent's store. Until `finishReplay`, the
   * updates that arrive are history being re-read, not work being done:
   * they fold into turns silently, and nothing is emitted to the window.
   */
  static forReplay(host: AcpRuntime, id: SessionId, cwd: string): AcpSession {
    const session = new AcpSession(host, { sessionId: String(id) }, cwd)
    session.#replaying = true
    return session
  }

  /** The draft-options probe: a real session that never says anything. */
  static probe(host: AcpRuntime, opened: AcpNewSessionResult, cwd: string): AcpSession {
    const session = new AcpSession(host, opened, cwd)
    session.#replaying = true // never finished: the probe stays silent for life
    return session
  }

  finishReplay(loaded: AcpNewSessionResult): void {
    // Close the trailing history turn, then adopt whatever the load declared.
    const open = this.#currentTurn
    if (open) {
      this.#currentTurn = null
      this.#turns.push({
        id: open.id,
        items: [...open.items],
        status: 'completed',
        startedAt: open.startedAt,
      })
    }
    this.#replaying = false
    this.#modes = loaded.modes ?? this.#modes
    this.#models = loaded.models ?? this.#models
    this.#configOptions = loaded.configOptions ?? this.#configOptions
    this.#host.emit({ type: 'session/started', session: this.snapshot() })
  }

  settings(): SessionSettings {
    return { cwd: this.#cwd, model: this.#models?.currentModelId ?? this.#host.agentName }
  }

  /**
   * Both directions: modes become the `mode` select, and ACP's own config
   * options land unchanged — a select is a select, a toggle is a
   * boolean. No translation table, which is the point.
   */
  options(): readonly ConfigOption[] {
    const options: ConfigOption[] = []
    if (this.#models && this.#models.availableModels.length > 0) {
      options.push({
        type: 'select',
        id: 'model',
        category: 'model',
        label: 'Model',
        currentValue: this.#models.currentModelId,
        choices: this.#models.availableModels.map((model) => ({
          value: model.modelId,
          label: model.name,
          ...(model.description ? { description: model.description } : {}),
        })),
      })
    }
    if (this.#modes && this.#modes.availableModes.length > 0) {
      options.push({
        type: 'select',
        id: 'mode',
        category: 'mode',
        label: 'Mode',
        currentValue: this.#modes.currentModeId,
        choices: this.#modes.availableModes.map((mode) => ({
          value: mode.id,
          label: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      })
    }
    for (const option of this.#configOptions) {
      // The agent says where its control belongs; an unfamiliar or absent
      // category lands under "More", which is what `other` means.
      const category = acpCategory(option.category)
      if (option.type === 'toggle') {
        options.push({
          type: 'boolean',
          id: option.id,
          category,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
          ...(option.disabled ? { disabled: option.disabled } : {}),
          ...(option.confirm ? { confirm: acpConfirm(option.confirm) } : {}),
          currentValue: option.currentValue === true,
        })
      } else {
        options.push({
          type: 'select',
          id: option.id,
          category,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
          ...(option.disabled ? { disabled: option.disabled } : {}),
          ...(option.confirm ? { confirm: acpConfirm(option.confirm) } : {}),
          currentValue: String(option.currentValue),
          choices: (option.options ?? []).map((choice) => ({
            value: choice.value,
            label: choice.name,
            ...(choice.description ? { description: choice.description } : {}),
            ...(choice.disabled ? { disabled: choice.disabled } : {}),
          })),
        })
      }
    }
    return options
  }

  async setOption(id: string, value: OptionValue): Promise<void> {
    const option = findOption(this.options(), id)
    if (!option) throw new Error(`${this.#host.agentName} has no session option named ${JSON.stringify(id)}.`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    if (id === 'mode' && this.#modes) {
      await this.#host.connection.request('session/set_mode', {
        sessionId: this.id,
        modeId: value,
      })
      this.#modes = { ...this.#modes, currentModeId: value as string }
    } else if (id === 'model' && this.#models) {
      // Picking the model a session already runs is a no-op worth skipping:
      // Claude Code records every model change as a `/model` command in its
      // own transcript, and that echo is read back on the next open.
      if (this.#models.currentModelId === value) return
      await this.#host.connection.request('session/set_model', {
        sessionId: this.id,
        modelId: value,
      })
      this.#models = { ...this.#models, currentModelId: value as string }
    } else {
      await this.#host.connection.request('session/set_config_option', {
        sessionId: this.id,
        // ACP's field is `configId` (SessionConfigId); the SDK's validator
        // rejects anything else with "Invalid params".
        configId: id,
        value,
      })
      this.#configOptions = this.#configOptions.map((entry) =>
        entry.id === id ? { ...entry, currentValue: value as string | boolean } : entry,
      )
    }
    this.#emit({ type: 'session/options', sessionId: this.id, options: this.options() })
  }

  async send(input: readonly UserContent[]): Promise<TurnId> {
    const id = turnId(`turn-${++this.#counter}`)
    const userItem: AgentItem = {
      id: itemId(`${id}-user`),
      type: 'userMessage',
      content: input,
      startedAt: Date.now(),
    }
    const turn: MutableTurn = { id, items: [userItem], startedAt: Date.now() }
    this.#currentTurn = turn
    this.#host.emit({
      type: 'turn/started',
      sessionId: this.id,
      turn: { id, items: [...turn.items], status: 'inProgress', startedAt: turn.startedAt },
    })
    this.#host.emit({ type: 'session/status', sessionId: this.id, status: { type: 'active' } })

    const prompt: AcpContentBlock[] = input.flatMap((content): AcpContentBlock[] => {
      if (content.type === 'text') return [{ type: 'text', text: content.text }]
      if (content.type === 'image') {
        const [meta, data] = content.url.split(',', 2)
        return data
          ? [{ type: 'image', data, mimeType: meta?.replace(/^data:|;base64$/g, '') ?? 'image/png' }]
          : []
      }
      if (content.type === 'mention' || content.type === 'skill') {
        return [{ type: 'resource_link', uri: `file://${content.path}`, name: content.name }]
      }
      return []
    })

    // Where the agent's own usage record stands before the turn, for an agent
    // that counts there rather than on the wire: what it gains from here on
    // is this turn's.
    const mark = this.#markRecord()

    // ACP's prompt resolves when the *turn* ends; the send contract resolves
    // on acceptance. Fire, return, and settle the turn when the agent does —
    // including when it dies, which must fail the turn, never strand it.
    void this.#host.connection
      .request<AcpPromptResponse>('session/prompt', { sessionId: this.id, prompt })
      .then((response) => {
        // The turn's tokens land before the turn does, so the finished turn's
        // tail already has them to show. ACP's own field first; an agent that
        // counts in the extension slot instead is read from there, and one
        // that says nothing at all, from its own record if it keeps one.
        const usage = response.usage ?? quotaUsageOf(response._meta) ?? this.#recordedSince(mark)
        if (usage) this.#recordTurnUsage(usage)
        // A turn nobody could account for is not the one before it: its figures
        // are unknown, so the last turn shows none rather than the previous
        // turn's under this one's name. For every runtime, not only the ones
        // that keep a record of their own — an agent that reports usage on some
        // turns and not others is the commoner shape, and it was the one left
        // showing turn one's tokens and cache chip under turn two (#159).
        else this.#forgetLastTurn()
        this.#finishTurn(turn, response.stopReason)
      })
      .catch((error: unknown) => this.#failTurn(turn, describeAcp(error)))
    return id
  }

  async steer(): Promise<void> {
    throw new Error(`${this.#host.agentName} cannot steer a running turn; interrupt it instead.`)
  }

  async interrupt(): Promise<void> {
    this.#host.connection.notify('session/cancel', { sessionId: this.id })
  }

  async respondToApproval(id: ApprovalId, decision: ApprovalDecision): Promise<void> {
    const resolve = this.#pendingPermissions.get(id)
    if (!resolve) return
    this.#pendingPermissions.delete(id)
    // A question's answer is an option too: the card answers with the chosen
    // option ids per question, and the one question a request carries has
    // its answers, which are options the agent offered. Several — a
    // multi-select — travel as one id joined with `+`, because ACP's outcome
    // carries one; our Claude bridge splits it again. (Codex's and Cursor's
    // reviews of #50.)
    const chosen = decision.type === 'answers' ? (Object.values(decision.answers)[0] ?? []).filter(Boolean) : []
    const outcome: AcpPermissionOutcome =
      decision.type === 'option'
        ? { outcome: 'selected', optionId: decision.optionId }
        : chosen.length > 0
          ? { outcome: 'selected', optionId: chosen.join('+') }
          : { outcome: 'cancelled' }
    resolve(outcome)
    this.#host.emit({
      type: 'approval/resolved',
      sessionId: this.id,
      approvalId: id,
      resolution: { outcome: 'decided', decision },
    })
  }

  async updateSettings(): Promise<void> {
    throw new Error(`${this.#host.agentName} has no mutable settings beyond its options.`)
  }

  async setTitle(): Promise<void> {
    throw new Error(`${this.#host.agentName} does not support naming a session.`)
  }

  async close(): Promise<void> {
    // ACP has no explicit close; dropping our handle is the whole gesture.
  }

  // ------------------------------------------------------------------ internal

  summary(): SessionSummary {
    const preview = this.#turns
      .flatMap((turn) => turn.items)
      .find((item) => item.type === 'userMessage')
    return {
      id: this.id,
      runtime: this.runtime,
      // Whatever the agent has called this conversation, if it has been
      // heard saying so; `listSessions` is where that is learned.
      title: this.#host.titleOf(this.id),
      preview:
        preview?.type === 'userMessage'
          ? // Named from the whole message, before the cut: a block cut short has no label to read (#186).
            openingOf(preview.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')).slice(0, 120) || null
          : // Loaded, not replayed: the agent's own record of how this
            // conversation opened stands in for turns this process never saw.
            this.#host.previewOf(this.id),
      cwd: this.#cwd,
      status: this.#currentTurn ? { type: 'active' as const } : { type: 'idle' as const },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      git: null,
    }
  }

  snapshot(): Session {
    return {
      ...this.summary(),
      turns: [
        ...this.#turns,
        ...(this.#currentTurn
          ? [
              {
                id: this.#currentTurn.id,
                items: [...this.#currentTurn.items],
                status: 'inProgress' as const,
                startedAt: this.#currentTurn.startedAt,
              },
            ]
          : []),
      ],
      itemsLoaded: true,
      forkedFrom: null,
      settings: this.settings(),
      options: this.options(),
      usage: this.#usage,
    }
  }

  applyUpdate(update: AcpSessionUpdate): void {
    if (this.#replaying && update.sessionUpdate === 'user_message_chunk') {
      // Housekeeping the agent has owned up to is never speech, so it neither
      // joins the message beside it nor speaks for the person. It still opens
      // a turn: what follows a background task's report is the agent's answer
      // to it, and a turn is where that answer hangs.
      const notice = noticeOf(update)
      // A prompt with several content blocks — a context chip, a hand-off
      // packet, then the instruction — is replayed as several consecutive
      // chunks. Until the agent has said anything they are one message, not
      // one turn each: split, every block but the last would read as a turn
      // the agent left unanswered.
      const open = this.#currentTurn
      if (!notice && open && open.items.every((item) => item.type === 'userMessage')) {
        const first = open.items[0]
        if (first && first.type === 'userMessage') {
          open.items[0] = withUserContent(first, update.content)
          return
        }
      }
      // Each stored user message opens the next history turn.
      if (open) {
        this.#currentTurn = null
        this.#turns.push({
          id: open.id,
          items: [...open.items],
          status: 'completed',
          startedAt: open.startedAt,
        })
      }
      const id = turnId(`turn-${++this.#counter}`)
      this.#currentTurn = {
        id,
        items: [
          notice
            ? { id: itemId(`${id}-notice`), type: 'notice', text: notice }
            : withUserContent(
                { id: itemId(`${id}-user`), type: 'userMessage', content: [] },
                update.content,
              ),
        ],
        startedAt: Date.now(),
      }
      return
    }
    const turn = this.#currentTurn
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        // Live, a user-role chunk is never the person — the person's words
        // are the prompt the client sent. It is the agent's own housekeeping
        // owned up to as a notice: a child's report relayed into the
        // conversation, the runtime saying a child settled. Read as a notice
        // on the turn, so what the agent answered next is seen to have been
        // answered to something. Unmarked chunks are dropped as before.
        if (!turn) return
        const notice = noticeOf(update)
        if (!notice) return
        const item: AgentItem = { id: itemId(`${turn.id}-n${turn.items.length}`), type: 'notice', text: notice, startedAt: Date.now() }
        turn.items.push(item)
        this.#emit({ type: 'item/started', sessionId: this.id, turnId: turn.id, item })
        this.#emit({ type: 'item/completed', sessionId: this.id, turnId: turn.id, item })
        return
      }
      case 'agent_message_chunk': {
        if (!turn) return
        const item = this.#appendText(turn, 'assistantMessage', textOf(update.content))
        this.#emit({
          type: 'item/delta',
          sessionId: this.id,
          turnId: turn.id,
          itemId: item.id,
          delta: { kind: 'assistantText', text: textOf(update.content) },
        })
        return
      }
      case 'agent_thought_chunk': {
        if (!turn) return
        const item = this.#appendText(turn, 'reasoning', textOf(update.content))
        this.#emit({
          type: 'item/delta',
          sessionId: this.id,
          turnId: turn.id,
          itemId: item.id,
          delta: { kind: 'reasoningText', index: 0, text: textOf(update.content) },
        })
        return
      }
      case 'tool_call': {
        if (!turn) return
        const id = itemId(update.toolCallId)
        const index = turn.items.findIndex((item) => item.id === id)
        // One call is announced more than once — the permission flow says a
        // tool is coming, the stream says it again with the real input — and
        // a second row for the same id shows one call twice, the copy the
        // completion never finds stuck "running" forever. One id, one row:
        // later announcements fill in what the first did not know.
        const previous = index === -1 ? null : (turn.items[index] as Extract<AgentItem, { type: 'toolCall' }>)
        // A later announcement must not put the generic label back over a
        // name the first one worked out.
        const named = toolNameOf(update, previous?.tool)
        const item: AgentItem = previous
          ? {
              ...previous,
              tool: named,
              ...(update.rawInput !== undefined && emptyArgs(previous.args) ? { args: update.rawInput } : {}),
            }
          : {
              id,
              type: 'toolCall',
              tool: named,
              source: { kind: 'builtin' },
              status: 'inProgress',
              args: update.rawInput ?? null,
              startedAt: Date.now(),
            }
        if (previous) turn.items[index] = item
        else turn.items.push(item)
        this.#emit({ type: 'item/started', sessionId: this.id, turnId: turn.id, item })
        return
      }
      case 'tool_call_update': {
        if (!turn) return
        const index = turn.items.findIndex((item) => item.id === update.toolCallId)
        // An update can outrun its announcement, or be the only notice a
        // call ever gets. A row appearing late beats a result thrown away.
        const previous: Extract<AgentItem, { type: 'toolCall' }> =
          index === -1
            ? {
                id: itemId(update.toolCallId),
                type: 'toolCall',
                tool: toolNameOf(update),
                source: { kind: 'builtin' },
                status: 'inProgress',
                args: null,
                startedAt: Date.now(),
              }
            : (turn.items[index] as Extract<AgentItem, { type: 'toolCall' }>)
        const status =
          update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'inProgress'
        // A picture in the tool's content — a screenshot, a Read of a PNG —
        // becomes an image part the transcript can draw. The raw copy keeps
        // everything else but not the same megabytes twice.
        const images = (update.content ?? []).flatMap((entry) => {
          if (entry.type !== 'content') return []
          const block = entry.content as { type?: string; data?: string; mimeType?: string }
          return block.type === 'image' && typeof block.data === 'string' && block.data.length > 0
            ? [
                {
                  type: 'image' as const,
                  url: `data:${block.mimeType || 'image/png'};base64,${block.data}`,
                  mimeType: block.mimeType || 'image/png',
                },
              ]
            : []
        })
        const next: AgentItem = {
          ...previous,
          status,
          // Some agents (Claude Code among them) only name the tool and hand
          // over its input on the update; keep the late details rather than
          // dropping them — but never let a generic title on the way past
          // rename a call that has already been identified.
          tool: toolNameOf(update, previous.tool),
          ...(update.rawInput !== undefined && emptyArgs(previous.args)
            ? { args: update.rawInput }
            : {}),
          ...(update.rawOutput !== undefined || images.length > 0
            ? {
                result: [
                  ...(update.rawOutput !== undefined
                    ? [
                        {
                          type: 'json' as const,
                          value: images.length > 0 ? withoutImageBytes(update.rawOutput) : update.rawOutput,
                        },
                      ]
                    : []),
                  ...images,
                ],
              }
            : {}),
          ...(status !== 'inProgress' ? { completedAt: Date.now() } : {}),
        }
        if (index === -1) {
          turn.items.push(next)
          this.#emit({ type: 'item/started', sessionId: this.id, turnId: turn.id, item: next })
        } else {
          turn.items[index] = next
        }
        if (status !== 'inProgress') {
          this.#emit({ type: 'item/completed', sessionId: this.id, turnId: turn.id, item: next })
        }
        return
      }
      case 'plan': {
        if (!turn) return
        this.#emit({
          type: 'turn/plan',
          sessionId: this.id,
          turnId: turn.id,
          steps: update.entries.map((entry) => ({
            step: entry.content,
            status: entry.status === 'in_progress' ? ('inProgress' as const) : entry.status,
          })),
        })
        return
      }
      case 'current_model_update': {
        if (this.#models) {
          this.#models = { ...this.#models, currentModelId: update.currentModelId }
          this.#emit({ type: 'session/options', sessionId: this.id, options: this.options() })
        }
        return
      }
      case 'current_mode_update': {
        if (this.#modes) {
          this.#modes = { ...this.#modes, currentModeId: update.currentModeId }
          this.#emit({ type: 'session/options', sessionId: this.id, options: this.options() })
        }
        return
      }
      case 'config_option_update': {
        this.#configOptions = update.configOptions
        this.#emit({ type: 'session/options', sessionId: this.id, options: this.options() })
        return
      }
      case 'usage_update': {
        // Context fill is the agent's to compute — it knows what it sends the
        // model. Here it is kept as said; the renderer divides.
        const breakdown = contextBreakdownOf(update._meta)
        this.#usage = {
          total: this.#usage?.total ?? NO_TOKENS,
          last: this.#usage?.last ?? NO_TOKENS,
          contextUsed: update.used,
          contextWindow: update.size,
          cost: update.cost ?? this.#usage?.cost ?? null,
          // A fill without a composition does not erase the last one: the
          // meter that reports the two moves them on different events. The
          // delegated share is the same bargain, and for the same reason —
          // it arrives on the extension channel, on its own schedule, and a
          // usage update that rebuilt the record without it wiped it every
          // turn.
          delegated: this.#usage?.delegated ?? null,
          breakdown: breakdown ?? this.#usage?.breakdown ?? null,
        }
        this.#emit({ type: 'usage/updated', sessionId: this.id, usage: this.#usage })
        return
      }
      default:
        return
    }
  }

  /**
   * The delegation list an agent pushed: what this session handed off.
   *
   * The agent that spawned a child also called a tool to do it, so the row
   * for that call is already in the turn under the same id. It is **upgraded
   * in place** rather than joined by a second row — `SubagentItem`'s own
   * comment is the rule here: a delegation has its own transcript, its own
   * model and its own lifetime, and rendering it as one more tool row loses
   * all three. One id, one row, the way `tool_call_update` already works.
   *
   * **A delegation belongs to the turn that started it, not to whichever turn
   * happens to be open.** The list is pushed whole whenever anything in it
   * moves, so a child of turn 1 that is still running reappears in every push
   * made during turn 2. Targeting the open turn put a second row there and
   * left the first stuck at its old state. So each delegation is matched to
   * the turn that already carries its id, wherever that is, and only one the
   * session has never seen falls back to the turn in flight.
   */
  acceptDelegations(
    delegations: readonly AcpDelegation[],
    delegated: AcpDelegationUsage | null,
  ): void {
    const open = this.#currentTurn
    // A closed turn's items are `readonly` and were already handed out with
    // `turn/completed`, so each one touched is copied once here and the whole
    // turn replaced at the end, rather than written through a cast.
    const edited = new Map<number, AgentItem[]>()
    const itemsAt = (turn: number): AgentItem[] => {
      if (turn === OPEN_TURN) return open?.items ?? []
      const already = edited.get(turn)
      if (already) return already
      const copy = [...(this.#turns[turn]?.items ?? [])]
      edited.set(turn, copy)
      return copy
    }
    // Newest first: a repeated id is far likelier to be the turn in flight or
    // the one just before it than the first turn of a long conversation.
    const ownerOf = (id: ItemId): { turn: number; at: number } | null => {
      if (open) {
        const at = open.items.findIndex((item) => item.id === id)
        if (at !== -1) return { turn: OPEN_TURN, at }
      }
      for (let turn = this.#turns.length - 1; turn >= 0; turn -= 1) {
        const at = (edited.get(turn) ?? this.#turns[turn]?.items ?? []).findIndex((item) => item.id === id)
        if (at !== -1) return { turn, at }
      }
      return null
    }
    // Where a delegation nothing has seen before goes: the turn in flight, or
    // the one that just closed when a final push lands after it.
    const fallback: { turn: number; at: number } | null = open
      ? { turn: OPEN_TURN, at: -1 }
      : this.#turns.length > 0
        ? { turn: this.#turns.length - 1, at: -1 }
        : null

    for (const delegation of delegations) {
      if (typeof delegation?.id !== 'string' || delegation.id.length === 0) continue
      const id = itemId(delegation.id)
      const owner = ownerOf(id) ?? fallback
      if (!owner) continue
      const turnId = owner.turn === OPEN_TURN ? open?.id : this.#turns[owner.turn]?.id
      if (turnId === undefined) continue
      const items = itemsAt(owner.turn)
      const item = subagentItemOf(id, delegation, owner.at === -1 ? null : (items[owner.at] ?? null))
      if (owner.at === -1) items.push(item)
      else items[owner.at] = item
      this.#emit({
        type: item.status === 'inProgress' ? 'item/started' : 'item/completed',
        sessionId: this.id,
        turnId,
        item,
      })
    }
    for (const [turn, items] of edited) {
      const previous = this.#turns[turn]
      if (previous) this.#turns[turn] = { ...previous, items }
    }
    // A share of the session's total and never an addition to it — the
    // runtimes that attribute child spend have already folded it into their
    // own counts. Carried so the window can split a figure it must not
    // re-sum.
    const share = delegated ? delegationTokensOf(delegated) : null
    if (share) {
      this.#usage = { ...(this.#usage ?? { total: NO_TOKENS, last: NO_TOKENS }), delegated: share }
      this.#emit({ type: 'usage/updated', sessionId: this.id, usage: this.#usage })
    }
  }

  /** How far the agent's own usage record has got; null where it keeps none the desk can read. */
  #markRecord(): number | null {
    try {
      return this.#host.usageRecord?.mark(this.id) ?? null
    } catch {
      return null
    }
  }

  /** What the agent's own record gained since `mark`: the turn just closed, as the agent counted it. */
  #recordedSince(mark: number | null): AcpUsage | null {
    if (mark === null) return null
    try {
      return this.#host.usageRecord?.since(this.id, mark) ?? null
    } catch {
      return null
    }
  }

  /** The last turn's figures withdrawn: this turn's are unknown, and the ones before it are not its. */
  #forgetLastTurn(): void {
    // Ahead of the early return: a *first* turn nobody could account for
    // leaves no figures to withdraw and still breaks the write chain.
    this.#writeChainBroken = true
    if (!this.#usage) return
    this.#usage = { ...this.#usage, last: NO_TOKENS }
    this.#emit({ type: 'usage/updated', sessionId: this.id, usage: this.#usage })
  }

  /** A finished turn's tokens: they become `last`, and join the running total. */
  #recordTurnUsage(usage: AcpUsage): void {
    const turn = tokenUsageOf(usage)
    const previous = this.#usage?.total ?? NO_TOKENS
    // The running total carries a write count only while the chain of turns
    // behind it is unbroken. An empty total is the start of the chain, not a
    // gap in it; a total that has tokens but no write count is a gap, and a
    // gap is permanent. A turn that reported *nothing* is a gap the total
    // cannot show at all — it never got here to leave a mark — which is what
    // `#writeChainBroken` remembers on its behalf.
    const priorKnown =
      !this.#writeChainBroken && (previous.cacheWriteTokens !== undefined || previous.totalTokens === 0)
    const cacheWriteTotal =
      priorKnown && turn.cacheWriteTokens !== undefined
        ? (previous.cacheWriteTokens ?? 0) + turn.cacheWriteTokens
        : null
    this.#usage = {
      ...(this.#usage ?? {}),
      total: {
        totalTokens: previous.totalTokens + turn.totalTokens,
        inputTokens: previous.inputTokens + turn.inputTokens,
        cachedInputTokens: previous.cachedInputTokens + turn.cachedInputTokens,
        // A sum is only knowable when **every** turn in it was. One turn that
        // reported nothing makes the total unknown from then on, and it never
        // comes back: an earlier `?? 0` turned a silent turn into a zero, so a
        // session that reported 50 writes once and then went quiet claimed an
        // exact 50 for the whole conversation.
        ...(cacheWriteTotal === null ? {} : { cacheWriteTokens: cacheWriteTotal }),
        outputTokens: previous.outputTokens + turn.outputTokens,
        reasoningOutputTokens: previous.reasoningOutputTokens + turn.reasoningOutputTokens,
      },
      last: turn,
    }
    this.#emit({ type: 'usage/updated', sessionId: this.id, usage: this.#usage })
  }

  /** Emits unless this session is replaying stored history. */
  #emit(event: Parameters<AcpRuntime['emit']>[0]): void {
    if (!this.#replaying) this.#host.emit(event)
  }

  requestPermission(request: AcpPermissionRequest): Promise<{ outcome: AcpPermissionOutcome }> {
    const id = approvalId(`acp-${request.toolCall.toolCallId}-${Date.now().toString(36)}`)
    // A question is not a permission. Our Claude bridge carries Claude Code's
    // `AskUserQuestion` as a permission request whose options are the
    // answers, with the question beside them; drawn as a permission it would
    // ask "Grant additional access?" over a list of libraries. Read as a
    // question it becomes the same card Codex's questions already get.
    const asked = questionOf(request)
    if (asked) {
      const approval: Approval = {
        id,
        sessionId: this.id,
        ...(this.#currentTurn ? { turnId: this.#currentTurn.id } : {}),
        itemId: itemId(request.toolCall.toolCallId),
        requestedAt: Date.now(),
        type: 'userInput',
        tool: 'AskUserQuestion',
        questions: [
          {
            id: 'q',
            question: asked.question,
            ...(asked.header ? { header: asked.header } : {}),
            multiSelect: asked.multiSelect,
            options: request.options
              .filter((option) => option.kind === 'allow_once' || option.kind === 'allow_always')
              .map((option) => {
                // The description belongs to the choice with this label, not
                // to whichever choice sits at the same index after the
                // reject option was filtered out. (Cursor's review of #50.)
                const described = asked.options.find((one) => one.label === option.name)
                return {
                  id: option.optionId,
                  label: option.name,
                  ...(described?.description ? { description: described.description } : {}),
                }
              }),
          },
        ],
      }
      return new Promise((resolve) => {
        this.#pendingPermissions.set(id, (outcome) => resolve({ outcome }))
        this.#host.emit({ type: 'approval/requested', approval })
      })
    }
    const approval: Approval = {
      id,
      sessionId: this.id,
      ...(this.#currentTurn ? { turnId: this.#currentTurn.id } : {}),
      itemId: itemId(request.toolCall.toolCallId),
      requestedAt: Date.now(),
      type: 'permission',
      summary: request.toolCall.title ?? 'The agent asks permission to continue.',
      // Why the agent is asking, when the agent said. ACP carries that on the
      // request's own tool call, and reading only the title threw it away:
      // DeepSeek Harness sends "escalate sandbox to danger-full-access: the
      // user asked me to write outside the workspace" and the dialog showed
      // `write`. A decision needs the sentence, not the verb.
      ...(permissionReason(request.toolCall) ? { reason: permissionReason(request.toolCall) } : {}),
      options: request.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        intent:
          option.kind === 'allow_once'
            ? ('approve' as const)
            : option.kind === 'allow_always'
              ? ('approveAlways' as const)
              : ('deny' as const),
      })),
    }
    return new Promise((resolve) => {
      this.#pendingPermissions.set(id, (outcome) => resolve({ outcome }))
      this.#host.emit({ type: 'approval/requested', approval })
    })
  }

  agentDied(): void {
    const turn = this.#currentTurn
    if (turn) this.#failTurn(turn, `${this.#host.agentName} exited mid-turn.`)
    for (const [id, resolve] of this.#pendingPermissions) {
      resolve({ outcome: 'cancelled' })
      this.#host.emit({
        type: 'approval/resolved',
        sessionId: this.id,
        approvalId: id,
        resolution: { outcome: 'abandoned', reason: 'The agent exited.' },
      })
    }
    this.#pendingPermissions.clear()
  }

  #appendText(
    turn: MutableTurn,
    type: 'assistantMessage' | 'reasoning',
    text: string,
  ): AgentItem {
    const last = turn.items[turn.items.length - 1]
    if (last && last.type === type) {
      const updated: AgentItem =
        type === 'assistantMessage'
          ? { ...(last as Extract<AgentItem, { type: 'assistantMessage' }>), text: (last as Extract<AgentItem, { type: 'assistantMessage' }>).text + text }
          : {
              ...(last as Extract<AgentItem, { type: 'reasoning' }>),
              content: [((last as Extract<AgentItem, { type: 'reasoning' }>).content[0] ?? '') + text],
            }
      turn.items[turn.items.length - 1] = updated
      return updated
    }
    const item: AgentItem =
      type === 'assistantMessage'
        ? { id: itemId(`${turn.id}-a${turn.items.length}`), type, text, startedAt: Date.now() }
        : { id: itemId(`${turn.id}-r${turn.items.length}`), type, summary: [], content: [text], startedAt: Date.now() }
    turn.items.push(item)
    // The started item goes out empty: the chunk that created it follows as
    // the first delta, and sending the text both ways doubles it on screen.
    const bare: AgentItem =
      type === 'assistantMessage'
        ? { ...(item as Extract<AgentItem, { type: 'assistantMessage' }>), text: '' }
        : { ...(item as Extract<AgentItem, { type: 'reasoning' }>), content: [] }
    this.#host.emit({ type: 'item/started', sessionId: this.id, turnId: turn.id, item: bare })
    return item
  }

  #finishTurn(turn: MutableTurn, stopReason: AcpStopReason): void {
    if (this.#currentTurn?.id !== turn.id) return
    this.#currentTurn = null
    const status =
      stopReason === 'cancelled' ? 'interrupted' : stopReason === 'end_turn' ? 'completed' : 'failed'
    const finished: Turn = {
      id: turn.id,
      items: [...turn.items],
      status,
      ...(status === 'failed'
        ? { error: { message: `The agent stopped: ${stopReason.replace(/_/g, ' ')}.` } }
        : {}),
      startedAt: turn.startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - turn.startedAt,
    }
    this.#turns.push(finished)
    this.#host.emit({ type: 'turn/completed', sessionId: this.id, turn: finished })
    this.#host.emit({ type: 'session/status', sessionId: this.id, status: { type: 'idle' } })
  }

  #failTurn(turn: MutableTurn, message: string): void {
    if (this.#currentTurn?.id !== turn.id) return
    this.#currentTurn = null
    const finished: Turn = {
      id: turn.id,
      items: [...turn.items],
      status: 'failed',
      error: { message },
      startedAt: turn.startedAt,
      completedAt: Date.now(),
    }
    this.#turns.push(finished)
    this.#host.emit({ type: 'turn/completed', sessionId: this.id, turn: finished })
    this.#host.emit({ type: 'session/status', sessionId: this.id, status: { type: 'idle' } })
    this.#host.emit({
      type: 'error',
      sessionId: this.id,
      error: { message, code: 'runtimeUnavailable' },
    })
  }
}

/** `acceptDelegations`' stand-in index for the turn in flight. */
const OPEN_TURN = -1

interface MutableTurn {
  readonly id: TurnId
  items: AgentItem[]
  readonly startedAt: number
}
