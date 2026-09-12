import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { opensEnvelope } from '@harnessdesk/protocol'

import {
  chatPath,
  cursorMeta,
  contextLabel,
  findChatWorkspace,
  firstLine,
  readAllChats,
  readChatMode,
  readChatPreview,
  readWorkspaceChats,
  stripEnvelope,
  trashChat,
  type CursorChat,
} from './store.js'

/**
 * The agent side of ACP, implemented over the `cursor-agent` CLI.
 *
 * Cursor ships no ACP agent, and the community bridge on npm acknowledges a
 * prompt and returns `end_turn` without ever reading the reply — its own
 * comment says "for now, we'll return end_turn immediately". This is the real
 * implementation: each `session/prompt` runs one `cursor-agent --print
 * --output-format stream-json` process and translates its event stream into
 * `session/update` notifications, resolving the prompt only when the CLI
 * reports its result. Session continuity is Cursor's own: `create-chat`
 * mints the id and `--resume` carries the conversation, both verified
 * against the live CLI.
 *
 * Honesty rules the surface. Print mode runs tools without asking, so this
 * bridge declares **modes** (Agent / Plan / Ask — the CLI's own `--mode`)
 * instead of staging permission dialogs it could not enforce, and it
 * declares the account's real model list from `cursor-agent models`. The
 * prompt text always follows a `--` terminator so a prompt that begins with
 * `-` can never become a flag.
 *
 * Trust: HarnessDesk creates a session for a workspace the user chose, so
 * the folder choice is the trust grant and the bridge passes `--trust` —
 * the same posture as claude-code-acp, which operates on its cwd without a
 * second prompt.
 */

const PROTOCOL_VERSION = 1

/**
 * HarnessDesk offers every agent an MCP server carrying its plugin tools —
 * the browser tools among them. `cursor-agent` does not take one in the
 * session request, but it does take a **plugin directory** on the command
 * line, and a plugin declares MCP servers in its `.mcp.json` — the same
 * layout the marketplace ships (`.cursor-plugin/plugin.json` beside
 * `.mcp.json`, observed in `~/.cursor/plugins/cache`). So the offer is
 * accepted: each session's servers are written as a generated plugin under
 * the temp directory, and every turn passes `--plugin-dir` with
 * `--approve-mcps` so print mode does not stall on an approval prompt it
 * cannot show.
 *
 * Deliberately *not* by writing `~/.cursor/mcp.json` or the workspace's
 * `.cursor/mcp.json`: a bridge has no business editing the user's own
 * configuration. A per-chat directory is inspectable, removable, and dies
 * with the temp directory instead of outliving the session.
 *
 * The old refusal survives for the one case the directory cannot express: a
 * server with no command to spawn. Refusing by naming `mcpServers` is the
 * answer the caller knows how to handle — it retries without the server and
 * logs why the plugin tools are absent — and accepting-then-dropping would
 * leave HarnessDesk believing Cursor has tools the model was never given.
 */
interface WireToolServer {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** The session request's `mcpServers`, or null when none were offered. */
const toolServersOf = (params: Record<string, unknown>): readonly WireToolServer[] | null => {
  const raw = params['mcpServers']
  if (!Array.isArray(raw) || raw.length === 0) return null
  const servers: WireToolServer[] = []
  for (const entry of raw as readonly Record<string, unknown>[]) {
    if (typeof entry['command'] !== 'string' || entry['command'] === '') continue
    const env: Record<string, string> = {}
    // ACP spells env as [{name, value}] pairs; .mcp.json wants an object.
    for (const pair of Array.isArray(entry['env']) ? (entry['env'] as readonly Record<string, unknown>[]) : []) {
      if (typeof pair['name'] === 'string' && typeof pair['value'] === 'string') env[pair['name']] = pair['value']
    }
    servers.push({
      name: typeof entry['name'] === 'string' && entry['name'] !== '' ? entry['name'] : 'harnessdesk',
      command: entry['command'],
      args: Array.isArray(entry['args']) ? (entry['args'] as readonly unknown[]).map(String) : [],
      env,
    })
  }
  if (servers.length === 0) {
    throw new Error(
      'mcpServers is not supported in this form: cursor-agent takes MCP servers ' +
        'through a plugin directory, which can only express a server with a ' +
        'command to spawn.',
    )
  }
  return servers
}

/**
 * Writes the generated plugin for one chat and returns its directory.
 * Rewritten on every session open, because the env carries a per-open
 * correlation token (`HD_TOOLS_CALLER`) that must not go stale.
 */
export const writeToolPlugin = (
  chatId: string,
  servers: readonly WireToolServer[],
  root = join(tmpdir(), 'harnessdesk-cursor-acp'),
): string => {
  const dir = join(root, chatId, 'plugin')
  mkdirSync(join(dir, '.cursor-plugin'), { recursive: true })
  writeFileSync(
    join(dir, '.cursor-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: 'harnessdesk',
        version: '1.0.0',
        description: "HarnessDesk's plugin tools for this conversation, offered at session open.",
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: Object.fromEntries(
          servers.map((server) => [
            server.name,
            { command: server.command, args: [...server.args], env: { ...server.env } },
          ]),
        ),
      },
      null,
      2,
    ),
  )
  return dir
}

const MODES = [
  { id: 'default', name: 'Agent', description: 'Edits files and runs commands in this workspace.' },
  { id: 'plan', name: 'Plan', description: 'Read-only: analyses and proposes a plan, never edits.' },
  { id: 'ask', name: 'Ask', description: 'Read-only Q&A about the code.' },
] as const

const MODE_IDS: readonly string[] = MODES.map((mode) => mode.id)

/**
 * The session index: Cursor's own store keeps the conversations (create-chat
 * ids resume across processes), but offers no listing the bridge can read —
 * so the bridge keeps one of its own: id, cwd, first-prompt title, and when.
 * No transcript is stored here and none can be replayed; loading an indexed
 * session opens it empty with its model-side context intact, which is the
 * honest version of resume when the vendor keeps the history.
 */
interface StoredSession {
  sessionId: string
  cwd: string
  /**
   * The first thing the user asked here, kept so a chat still reads as
   * something when Cursor's own store cannot be read. Older index files
   * carry it under `title`, which is what it used to be shown as; it is a
   * preview, and Cursor's name is the title.
   */
  preview: string | null
  updatedAt: string
}

const stateDir = (): string =>
  process.env['CURSOR_ACP_STATE_DIR'] ?? join(homedir(), '.harnessdesk', 'cursor-acp')

/**
 * Where the CLI keeps its own settings — the directory `CURSOR_CONFIG_DIR`
 * names, and `~/.cursor` when it names nothing.
 */
const cursorHome = (): string => process.env['CURSOR_CONFIG_DIR'] ?? join(homedir(), '.cursor')

/**
 * The config directory the bridge runs cursor-agent against.
 *
 * It exists for one reason: Max mode. `--model <slug>` can only name the flat
 * catalogue's fixed variants, and every one of those pins a context window —
 * which is why passing a slug can never widen one. The wide window is a
 * *parameterised* selection (`{modelId, parameters}` with `context: 1m`), and
 * the place to put one is the CLI's own config. Writing that into the user's
 * `~/.cursor/cli-config.json` would change what their own `cursor-agent` and
 * Cursor do, so the bridge keeps a copy of their settings and writes its
 * model choice only into that.
 *
 * (cursor-agent 2026.08.31 also takes the bracket grammar on the flag in
 * print mode — `--model 'gemini-3.7-flash[effort=low]'` ran as "Gemini 3.7
 * Flash Low" — where 2026.08.25 refused it. The config route stays: it works
 * on both, and it is how the CLI hands back each model's full parameter set,
 * which the bracket form needs spelled out in full or drops on the floor.)
 *
 * `chats` is symlinked back to the real store rather than copied: the config
 * directory is also where cursor-agent keeps conversations, and a private one
 * would orphan every chat `--resume` needs — including the ones started in
 * Cursor itself. Measured both ways; `CURSOR_DATA_DIR` does not separate them.
 */
const configDir = (): string => join(stateDir(), 'cli-config')

/**
 * Prepares the private config directory and answers with its path.
 *
 * The user's own settings are mirrored on every call — permissions, approval
 * mode, sandbox, everything that decides how a turn behaves — so running
 * through this directory is the same as running through theirs, except for
 * the model fields the bridge owns. Their file is only ever read.
 *
 * Nothing secret is copied: cursor-agent authenticates from the login it
 * keeps outside this file, which is why a config directory holding only a
 * model selection still runs signed in.
 */
export const prepareConfig = (selection: Parameterised | null): string => {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const chats = join(dir, 'chats')
  if (!existsSync(chats)) {
    try {
      symlinkSync(join(cursorHome(), 'chats'), chats)
    } catch {
      // A store we cannot link to is one cursor-agent will simply make for
      // itself; conversations started elsewhere then will not resume, which
      // is worth a degraded turn rather than no turn.
    }
  }
  const config = readJson(join(cursorHome(), 'cli-config.json')) ?? { version: 1 }
  // What cursor-agent wrote here on earlier turns outlives the mirror. Every
  // turn teaches it one model's parameterised form, and mirroring the user's
  // settings over the top would throw all but the last away — which is the
  // difference between Max mode being offered for models you have used and
  // for the one you used most recently.
  const learned = readJson(join(dir, 'cli-config.json'))?.['modelParameters']
  const known = {
    ...((config['modelParameters'] ?? {}) as Record<string, unknown>),
    ...(typeof learned === 'object' && learned !== null ? (learned as Record<string, unknown>) : {}),
  }
  config['modelParameters'] = known
  // Max mode is the session's to ask for, never the IDE's to leave behind.
  // The user's own file carries `maxMode: true` whenever their editor has
  // Max mode on, and cursor-agent honours it: with no `model` of its own to
  // go by it builds the selection for `--model <slug>` with `maxMode: true`,
  // runs the turn in Max mode, and Cursor bills Max mode by the token —
  // `isTokenBasedCall: true` on the usage page, a fraction of a request for
  // a one-word reply and several requests' worth for a long turn — where the
  // same turn from a plain `cursor-agent -p` is one flat request. Measured
  // 2026-09-11 on cursor-agent 2026.09.10 (see the memory note
  // cursor-billing-rows-per-turn). So the flag says what this session
  // chose, and the mirrored `model` block goes too: it is the editor's last
  // pick with the editor's Max-mode bit inside it, and the flag rebuilds it.
  config['maxMode'] = selection !== null
  delete config['model']
  if (selection) {
    config['selectedModel'] = selection
    config['modelParameters'] = { ...known, [selection.modelId]: selection.parameters }
  } else {
    // Nothing of ours to say: the `--model` flag carries the choice, and a
    // stale selection left here would answer for a flag that is not passed.
    delete config['selectedModel']
  }
  try {
    // Written whole or not at all. Every turn of every session rewrites this
    // file, and a hundred turns starting inside ten seconds had one CLI read
    // it half-written — "Unexpected end of JSON input", and the turn was
    // lost. A rename is atomic on the same filesystem, so a reader sees the
    // old file or the new one and never the gap between. The CLI's own
    // write-back uses the same shape (`cli-config.json.<pid>.<uuid>.tmp`).
    const target = join(dir, 'cli-config.json')
    const scratch = join(dir, `cli-config.json.${process.pid}.${randomUUID()}.tmp`)
    writeFileSync(scratch, JSON.stringify(config, null, 2))
    try {
      renameSync(scratch, target)
    } catch (error) {
      // A scratch file that will not go into place is not left beside it.
      try {
        unlinkSync(scratch)
      } catch {
        // gone already, or never written
      }
      throw error
    }
  } catch {
    // An unwritable config is the user's own settings, unchanged — worse
    // than we wanted, but not a reason to refuse the turn.
  }
  sweepScratch(dir)
  return dir
}

/**
 * Scratch files an earlier bridge left when it died between write and
 * rename. Small, named for what they are, and a minute old at the least —
 * one being written right now is younger than that.
 */
const sweepScratch = (dir: string): void => {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^cli-config\.json\.\d+\.[0-9a-f-]+\.tmp$/.test(name)) continue
      const path = join(dir, name)
      try {
        if (Date.now() - statSync(path).mtimeMs > 60_000) unlinkSync(path)
      } catch {
        // taken by whoever wrote it, or already gone
      }
    }
  } catch {
    // an unreadable directory has nothing to sweep
  }
}

/** One model as the CLI's parameterised catalogue names it. */
interface Parameterised {
  readonly modelId: string
  readonly parameters: readonly { readonly id: string; readonly value: string }[]
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A `{modelId, parameters}` pair, when the value read back is one. */
const asParameterised = (raw: unknown): Parameterised | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const modelId = record['modelId']
  const parameters = record['parameters']
  if (typeof modelId !== 'string' || !Array.isArray(parameters)) return null
  const cleaned: { id: string; value: string }[] = []
  for (const entry of parameters) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, value } = entry as Record<string, unknown>
    if (typeof id === 'string' && typeof value === 'string') cleaned.push({ id, value })
  }
  return cleaned.length > 0 ? { modelId, parameters: cleaned } : null
}

/**
 * The context parameter Cursor's Max mode means: the widest window the CLI
 * offers. Cursor's own documentation calls Max mode "maxes out context
 * windows and tool calls", billed at the model's API rate plus 20%, and every
 * wide variant in the catalogue is a 1M one.
 */
const MAX_CONTEXT = '1m'

/**
 * How many cursor-agent processes may be *starting* at once.
 *
 * A room of forty members handed a page each spawns forty CLIs inside two
 * seconds, and seventeen of them died on the spot: each one fetches the
 * model catalogue as it boots, the burst had some of those fetches fail, and
 * the CLI then checked `--model` against an empty list and refused — "Cannot
 * use this model: gemini-3.8-flash-high. Available models: ". Nothing was
 * wrong with the model. The gate lets a few boot at a time; a seat is held
 * from spawn until the process says its first word (or dies), so a running
 * turn never occupies one.
 */
const START_LIMIT = Math.max(1, Number(process.env['CURSOR_ACP_START_LIMIT']) || 6)

/** Attempts a turn gets when the CLI dies before saying anything. */
const START_ATTEMPTS = 4

/** The first pause before a second attempt; each later one doubles it. */
const START_RETRY_MS = Math.max(0, Number(process.env['CURSOR_ACP_START_RETRY_MS']) || 1500)

/**
 * What a death before the first event looks like when it is the network's
 * fault and not the turn's: the empty catalogue above, and the plain
 * transport failures. A refusal with a *named* list of models is the
 * account's answer and is not retried. The stderr tail is the last few
 * lines joined with ` · `, so the empty list is followed either by the end
 * of the string or by that separator — never anchored to the end alone, or
 * one diagnostic line after the refusal would hide it.
 */
const STARTUP_TRANSIENT =
  /Available models:\s*(?:$|·)|Unexpected end of JSON input|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|Too Many Requests|\b429\b|rate limit/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A counted door: `enter` resolves with the one-shot `leave` for that seat. */
class StartGate {
  #inside = 0
  readonly #waiting: (() => void)[] = []
  constructor(private readonly limit: number) {}

  async enter(): Promise<() => void> {
    if (this.#inside >= this.limit) await new Promise<void>((resolve) => this.#waiting.push(resolve))
    this.#inside += 1
    let left = false
    return () => {
      if (left) return
      left = true
      this.#inside -= 1
      this.#waiting.shift()?.()
    }
  }
}
const CONTEXT_PARAM = 'context'

/**
 * The names a family goes by in the parameterised catalogue.
 *
 * The two catalogues mostly agree — `gpt-5.3-codex`, `composer-2.5`,
 * `gemini-3.7-flash` and `claude-opus-5` are spelled the same in both — but
 * the older Claude slugs put the version before the tier where the
 * parameterised ids put it after: the flat `claude-4.6-opus` is
 * `claude-opus-4-6`. Both spellings are offered and the first that the CLI
 * has parameters for wins, because a guess that is wrong is a guess that
 * costs a turn.
 */
const parameterisedNames = (familyId: string): readonly string[] => {
  const claude = /^claude-(\d+(?:\.\d+)?)-(opus|sonnet|haiku|fable)$/.exec(familyId)
  if (!claude) return [familyId]
  return [familyId, `claude-${claude[2]}-${claude[1]!.replace('.', '-')}`]
}

/** The same parameters with the context swapped, or null when there is none. */
const withContext = (known: Parameterised, context: string): Parameterised | null => {
  if (!known.parameters.some((entry) => entry.id === CONTEXT_PARAM)) return null
  return {
    modelId: known.modelId,
    parameters: known.parameters.map((entry) =>
      entry.id === CONTEXT_PARAM ? { id: entry.id, value: context } : entry,
    ),
  }
}

/**
 * A conversation's name from its first prompt: the first line of what the
 * user wrote, after any context block HarnessDesk prepended (a hand-off
 * packet, a referenced conversation) — the block is for the model.
 */
export const titleOf = (text: string): string => {
  const stripped = stripEnvelope(text)
  /* A message that is nothing but a context block has no line of the user's
     to be named by, and falling back to the raw text named the conversation
     `<context source="…">`, the envelope written for the model (#47). What
     the block says it is, in its `source`, is written for people; without
     one, there is no title. The label is read by the protocol's own reader:
     `wrapContext` writes it with JSON.stringify, and a pattern of this
     file's own stopped at the first `\"` (review, round 1). */
  return stripped ? firstLine(stripped) : contextLabel(text)
}

/**
 * A stored name, read. Before #47's fix, a conversation that opened with only
 * a context block was stored under the envelope's first line,
 * `<context source="…">`, for good. That line is read as its label now, and an
 * envelope whose label can't be read as no name at all, so the next turn names
 * it (review, round 4). What opens an envelope is the protocol's to say, and
 * it says `<context source="`, the only way `wrapContext` writes one: a name
 * that only starts with the word, a prompt about `<context-free grammars>` or
 * `<context switching`, is the user's own, and read as an envelope it was
 * renamed by the next turn (#188, and the review of #207). A pattern of this
 * file's own was one of four copies of that question (#224).
 */
const storedName = (stored: string | null | undefined): string | null => {
  if (!stored) return null
  if (!opensEnvelope(stored)) return stored
  const quoted = /^<context source=("(?:[^"\\]|\\.)*")/.exec(stored)?.[1]
  if (quoted === undefined) return null
  try {
    return firstLine(JSON.parse(quoted) as string) || null
  } catch {
    return null
  }
}

/**
 * What a conversation's row is called: what it was called before, if that
 * said anything, or this turn's title, or nothing. An empty preview is no
 * preview; kept with `??`, one written by a context-only first turn named
 * the conversation nothing for good (review, round 1).
 */
export const previewFor = (stored: string | null | undefined, text: string): string | null =>
  storedName(stored) || titleOf(text) || null

export { cursorMeta } from './store.js'

/**
 * A row as the client lists it.
 *
 * `title` is Cursor's name for the conversation or nothing at all — this
 * bridge does not write one and does not invent one. `preview` is what the
 * user asked first, which is what makes an unnamed chat legible: the same
 * split a live session already has, so a conversation reads the same
 * whether it is open or only stored.
 */
interface SessionRow {
  readonly sessionId: string
  readonly cwd: string
  readonly title: string | null
  readonly preview: string | null
  readonly updatedAt: string
}

/**
 * The session-delete extension to ACP, agent side.
 *
 * ACP can start, load, resume, fork, list, prompt and cancel a chat. It
 * cannot delete one. A client can keep an archive itself — it is only a mark
 * — but deleting has to reach the store, and only something that knows where
 * the agent writes can do that. This bridge does: `~/.cursor/chats`.
 *
 * Client → agent: `{ sessionId }`. Answers `{ removed, disposition }`.
 *
 * Copied into `@harnessdesk/transport-acp`, the client half, and into
 * `@harnessdesk/claude-acp`, the other bridge that serves it. Copied rather
 * than shared: this bridge's one HarnessDesk dependency is
 * `@harnessdesk/protocol`, for reading context blocks (#47), and the name
 * isn't in it. Change one, change the others.
 */
const SESSION_DELETE = '_harnessdesk/session/delete'

/** What this bridge declares in `initialize`'s `_meta` when it serves it. */
const SESSION_DELETE_CAPABILITY = 'deleteSession'

/**
 * A standing instruction the client hands a session under
 * `_meta.harnessdesk.instructions`. `cursor-agent` has no instruction layer
 * a print-mode turn can reach — no system prompt flag, no rules file this
 * bridge should write into the person's project — so the sentence rides
 * ahead of the first prompt of each opened session, once: the chat keeps
 * its context across `--resume`, and a briefing repeated on every turn
 * would be noise the model has already read. Declared in the handshake
 * under the same key, so a client knows the channel exists.
 */
const INSTRUCTIONS_CAPABILITY = 'instructions'

const briefingOf = (params: Record<string, unknown>): string | null => {
  const meta = params['_meta']
  const ours = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)['harnessdesk'] : undefined
  const text = typeof ours === 'object' && ours !== null ? (ours as Record<string, unknown>)[INSTRUCTIONS_CAPABILITY] : undefined
  return typeof text === 'string' && text.trim() !== '' ? text.trim() : null
}

const readIndex = (): StoredSession[] => {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir(), 'sessions.json'), 'utf8')) as {
      sessions?: readonly (StoredSession & { title?: string | null })[]
    }
    if (!Array.isArray(parsed.sessions)) return []
    return parsed.sessions.map((row) => ({
      sessionId: row.sessionId,
      cwd: row.cwd,
      preview: row.preview ?? row.title ?? null,
      updatedAt: row.updatedAt,
    }))
  } catch {
    return []
  }
}

const writeIndex = (sessions: readonly StoredSession[]): void => {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(join(stateDir(), 'sessions.json'), JSON.stringify({ sessions }, null, 2))
  } catch {
    // The index is a convenience; losing a write must not break a turn.
  }
}

/**
 * Cursor's catalog flattens what its own IDE presents as one model with
 * orthogonal dimensions — `claude-opus-5-thinking-low-fast` is the Opus 5
 * *family* with thinking on, effort low, fast on. The bridge re-derives that
 * structure from the id grammar, so the client sees a short family list plus
 * an effort select and thinking/fast toggles instead of ~190 flat rows.
 *
 * Effort `max` is a *reasoning* level above `xhigh`, not Cursor's Max mode.
 * Measured against cursor-agent 2026.08.25: `claude-opus-5-thinking-max`
 * resolves to "Claude Opus 5 300K Max" and `-xhigh` to "Claude Opus 5 300K
 * Extra High" — the same context either way, so nothing about the bill
 * changes with the level. Cursor's actual Max mode widens the window (and
 * bills the model's API rate plus 20%) on legacy request-based plans only,
 * and is the session's own `max-mode` switch below, carried through the
 * config directory rather than the flag. So `max` is offered like any other
 * level, and the level never touches the bill.
 */
const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]
const EFFORT_LABEL: Record<Effort, string> = {
  default: 'Default',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** The three orthogonal dimensions a Cursor model id encodes. */
interface Dimensions {
  effort: Effort
  thinking: boolean
  fast: boolean
}

interface CatalogVariant extends Readonly<Dimensions> {
  readonly modelId: string
}

interface ModelFamily {
  readonly id: string
  readonly name: string
  readonly variants: readonly CatalogVariant[]
}

/** One concrete id → its family id and dimensions, from the id grammar. */
const parseVariant = (modelId: string): { family: string; variant: Omit<CatalogVariant, 'modelId'> } => {
  const tokens = modelId.split('-')
  let effort: Effort = 'default'
  let thinking = false
  let fast = false
  for (;;) {
    const last = tokens[tokens.length - 1]
    if (tokens.length <= 1 || last === undefined) break
    if (last === 'fast' && !fast) fast = true
    else if (last === 'thinking' && !thinking) thinking = true
    else if (effort === 'default' && (EFFORTS as readonly string[]).includes(last)) {
      effort = last as Effort
      if (last === 'high' && tokens[tokens.length - 2] === 'extra') tokens.pop()
      if (tokens[tokens.length - 1] === 'extra') effort = 'xhigh'
    } else break
    tokens.pop()
  }
  return { family: tokens.join('-'), variant: { effort, thinking, fast } }
}

/**
 * A family's reasoning levels, in ACP's `_meta`, so a client's catalogue can
 * show what each model offers rather than what the current session is set to.
 *
 * A family whose ids carry no effort token (`gpt-5.2`) says so with an empty
 * list rather than by silence — silence would be read as "ask the session".
 */
const metaOf = (family: ModelFamily): { _meta: Record<string, unknown> } => {
  const levels = [...new Set(family.variants.map((variant) => variant.effort))]
    .filter((effort) => effort !== 'default')
    .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))
  // Whether the family thinks is a property of the family, not of the
  // session, so the catalogue can say it: Cursor ships a thinking and a
  // non-thinking variant of each effort for the Claude families, only
  // thinking ones for Fable, and neither for Gemini or Composer.
  const thinks = new Set(family.variants.map((variant) => variant.thinking))
  const thinking = thinks.size > 1 ? 'optional' : thinks.has(true) ? 'always' : null
  return {
    _meta: {
      harnessdesk: {
        effortLevels: levels.map((effort) => ({ id: effort, label: EFFORT_LABEL[effort] })),
        ...(thinking ? { thinking } : {}),
      },
    },
  }
}

/**
 * The family's display name: any variant's label minus the dimension words,
 * and minus the window.
 *
 * The flat catalogue's labels carry a context window — "Claude Opus 4.6 1M",
 * "Claude Opus 5 1M Thinking" — and it is not a fact about the family: the
 * window is per variant, `--model <slug>` pins it, and the label's figure is
 * not what runs (measured: a "1M"-labelled slug resolves to 300K or 200K, as
 * the `system` event then says). Cursor's own picker names the model without
 * it. Left in, the picker here read "Claude Opus 4.6 1M" beside a Max mode
 * switch that was off — a wide window and a narrow one on the same row. The
 * window that actually ran is on the Max mode switch instead ("Running at
 * 200K"), read from the turn.
 *
 * A window is its own word — "Opus 4.6 1M", never "Opus-1M" — so only a
 * figure standing alone between spaces comes off. A name that carries a
 * figure of its own ("Zed-4K") keeps it.
 */
const familyName = (labels: readonly string[]): string => {
  const label = labels[0] ?? ''
  return (
    label
      .replace(/\b(Extra High|None|Minimal|Low|Medium|High|Max|Thinking|Fast)\b/g, '')
      .replace(/(^|\s)\d+(?:\.\d+)?[KM](?=\s|$)/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim() || label
  )
}

/** stream-json `tool_call` payload keys → ACP tool kinds. */
/** ACP's unstable turn usage, as far as this CLI can fill it. */
interface TurnUsage {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Of the input, what was served from cache — when the CLI said. */
  readonly cachedReadTokens?: number
  /** Of the input, what was written to cache — when the CLI said. */
  readonly cachedWriteTokens?: number
}

/** How a turn ended, with its tokens when the CLI counted them. */
interface TurnOutcome {
  readonly stopReason: string
  readonly usage?: TurnUsage
}

/**
 * `result.usage` as ACP's turn usage, when the CLI sent one with numbers in it.
 *
 * Input and output have always been there. cursor-agent 2026.08.31 added the
 * cache split — `cacheReadTokens` and `cacheWriteTokens` beside them — and
 * ACP has slots for both, so the turn tail's "% cached" can mean for Cursor
 * what it means for every other agent. Absent stays absent: a CLI that does
 * not count cache must not be shown a zero.
 */
const usageOf = (raw: unknown): TurnUsage | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const number = (key: string): number | null =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : null
  const input = number('inputTokens')
  const output = number('outputTokens')
  if (input === null && output === null) return null
  const read = number('cacheReadTokens')
  const write = number('cacheWriteTokens')
  return {
    totalTokens: (input ?? 0) + (output ?? 0),
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(read !== null ? { cachedReadTokens: read } : {}),
    ...(write !== null ? { cachedWriteTokens: write } : {}),
  }
}

const TOOL_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^(edit|write|create|apply|patch)/i, 'edit'],
  [/^(read|cat|open)/i, 'read'],
  [/^(shell|bash|terminal|run|command)/i, 'execute'],
  [/^(grep|glob|ls|list|search|find|semsearch)/i, 'search'],
  [/^(delete|remove|rm)/i, 'delete'],
  [/^(fetch|web|browser)/i, 'fetch'],
]

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

interface Session {
  readonly chatId: string
  readonly cwd: string
  modeId: string
  /** The resolved concrete catalog id ('auto' when the family is auto). */
  modelId: string
  familyId: string
  /**
   * The dimensions of the id that is actually going to run — what `#resolve`
   * settled on for this family, and what the controls read back.
   */
  effort: Effort
  thinking: boolean
  fast: boolean
  /**
   * Cursor's Max mode for this session: the widest context window the model
   * offers, billed at the model's API rate plus 20%. Off unless the person
   * turned it on and was told what it costs.
   */
  maxMode: boolean
  /** The window the last turn actually ran with, as cursor-agent named it. */
  context: string | null
  /**
   * The dimensions the user asked for, which outlive the family they were
   * asked for on. Cursor's families do not share a set of dimensions —
   * Gemini 3.7 Flash cannot think, Composer 2.5 has no effort levels — and a
   * preference that is dropped on the way through such a family is a
   * preference the user has to set again on the way back. `#resolve` scores
   * against these; `effort`/`thinking`/`fast` above are what came of it.
   */
  wanted: Dimensions
  /** `--sandbox`: `default` leaves the CLI's own configuration alone. */
  sandbox: 'default' | 'enabled' | 'disabled'
  /** The generated tool plugin's directory, when the session was offered one. */
  pluginDir: string | null
  /** Images written to disk for this conversation so far; names the next file. */
  imageCount: number
  /** The client's standing instruction, sent ahead of the first prompt; see `INSTRUCTIONS_CAPABILITY`. */
  briefing: string | null
  briefed: boolean
  child: ChildProcess | null
  cancelled: boolean
  /**
   * Wakes a turn that is waiting — for a start seat, or through a retry
   * pause — so a Stop pressed then is honoured then, not when the wait
   * happens to end. Set only while such a wait is in progress.
   */
  wake?: (() => void) | undefined
}

interface ModelRow {
  readonly modelId: string
  readonly name: string
}

export interface BridgeOptions {
  /** The cursor-agent executable. Defaults to `cursor-agent` on PATH. */
  readonly command?: string
  readonly input?: Readable
  readonly output?: Writable
  /** Diagnostics; defaults to stderr. Never the protocol stream. */
  readonly log?: (line: string) => void
}

export class CursorAcpBridge {
  readonly #command: string
  readonly #input: Readable
  readonly #output: Writable
  readonly #log: (line: string) => void
  readonly #sessions = new Map<string, Session>()
  /** Opening asks read out of Cursor's store, by chat and timestamp. */
  readonly #previews = new Map<string, string | null>()
  #models: readonly ModelRow[] | null = null
  #modelsListedAt = 0

  constructor(options: BridgeOptions = {}) {
    this.#command = options.command ?? process.env['CURSOR_ACP_COMMAND'] ?? 'cursor-agent'
    this.#input = options.input ?? process.stdin
    this.#output = options.output ?? process.stdout
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`))
  }

  /** Reads ACP off `input` until it ends. Resolves when the stream closes. */
  async serve(): Promise<void> {
    const lines = createInterface({ input: this.#input })
    for await (const line of lines) {
      if (line.trim() === '') continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        this.#log(`cursor-acp: unparseable frame: ${line.slice(0, 120)}`)
        continue
      }
      // Requests and notifications are handled without blocking the loop —
      // a prompt runs for minutes and session/cancel must get through.
      void this.#dispatch(message)
    }
    // The client is gone; leave no cursor-agent running for nobody.
    for (const session of this.#sessions.values()) {
      session.cancelled = true
      session.child?.kill('SIGTERM')
    }
  }

  async #dispatch(message: JsonRpcMessage): Promise<void> {
    const { id, method, params = {} } = message
    if (!method) return // a response; this bridge sends no client-bound requests
    try {
      const result = await this.#handle(method, params)
      if (id !== undefined) this.#send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // A refusal that names its own JSON-RPC code keeps it — an unknown
      // session id is `-32602`, the params naming nothing, which is what the
      // other bridges answer and what a client can act on without reading
      // the sentence. Everything else is the internal error it always was.
      const named = error instanceof Error ? (error as { code?: unknown })['code'] : undefined
      const code = typeof named === 'number' ? named : -32603
      if (id !== undefined) {
        this.#send({ jsonrpc: '2.0', id, error: { code, message: reason } })
      } else {
        this.#log(`cursor-acp: ${method} failed: ${reason}`)
      }
    }
  }

  async #handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {} },
            // Images: cursor-agent has no image flag, but it reads an image
            // file the prompt names with `@path` — so each image block is
            // written to disk and referenced. See #textOf.
            promptCapabilities: { image: true, audio: false, embeddedContext: false },
          },
          authMethods: [],
          // ACP can list a chat but not remove one. This bridge knows where
          // Cursor keeps them, so it serves the extension that can.
          _meta: { harnessdesk: { [SESSION_DELETE_CAPABILITY]: true, [INSTRUCTIONS_CAPABILITY]: true } },
        }
      case 'session/new':
        return this.#newSession(params)
      case 'session/prompt':
        return this.#prompt(params)
      case 'session/cancel':
        return this.#cancel(params)
      case 'session/set_mode':
        return this.#setMode(params)
      case 'session/set_model':
        return this.#setModel(params)
      case 'session/set_config_option':
        return this.#setConfigOption(params)
      case 'session/list': {
        const cwd = typeof params['cwd'] === 'string' && params['cwd'] !== '' ? params['cwd'] : null
        return { sessions: this.#listSessions(cwd) }
      }
      case 'session/load':
        return this.#loadSession(params)
      case SESSION_DELETE:
        return this.#deleteSession(params)
      default:
        throw new Error(`method not supported: ${method}`)
    }
  }

  // ---------------------------------------------------------------- session

  /**
   * What the CLI has told us about a family's parameterised form, by family
   * id. Two sources, both the CLI's own writing rather than our guessing:
   * the `modelParameters` it keeps in the user's config, which already
   * covers every model they have ever picked in Cursor, and the same field
   * in our own config, which it rewrites after every turn we run. So an
   * ordinary turn on a model is what teaches the bridge how to ask for that
   * model's wide window.
   */
  #parameterised = new Map<string, Parameterised>()
  #learnedFrom: string | null = null

  /** Everything the CLI has written down about parameterised models, merged. */
  #knownParameters(): Record<string, Parameterised> {
    const known: Record<string, Parameterised> = {}
    for (const home of [cursorHome(), configDir()]) {
      const config = readJson(join(home, 'cli-config.json'))
      const map = config?.['modelParameters']
      if (typeof map !== 'object' || map === null) continue
      for (const [modelId, parameters] of Object.entries(map as Record<string, unknown>)) {
        const entry = asParameterised({ modelId, parameters })
        if (entry) known[modelId] = entry
      }
    }
    return known
  }

  /** The parameterised form of a family, if anything has taught us one. */
  #parameterisedFor(familyId: string): Parameterised | null {
    const remembered = this.#parameterised.get(familyId)
    if (remembered) return remembered
    const known = this.#knownParameters()
    for (const name of parameterisedNames(familyId)) {
      const found = known[name]
      if (found) {
        this.#parameterised.set(familyId, found)
        return found
      }
    }
    return null
  }

  /**
   * Reads back what the CLI settled on after a turn. It writes the
   * parameterised selection its `--model` slug mapped to, which is the only
   * place that mapping is ever spelled out.
   */
  #learn(familyId: string): void {
    if (familyId === 'auto') return
    const selection = asParameterised(readJson(join(configDir(), 'cli-config.json'))?.['selectedModel'])
    if (selection) {
      this.#parameterised.set(familyId, selection)
      this.#learnedFrom = familyId
    }
  }

  /** The full catalog, grouped into families by the id grammar. */
  async #families(): Promise<readonly ModelFamily[]> {
    const rows = await this.#listModels()
    const grouped = new Map<string, { labels: string[]; variants: CatalogVariant[] }>()
    for (const row of rows) {
      const { family, variant } = parseVariant(row.modelId)
      const entry = grouped.get(family) ?? { labels: [], variants: [] }
      entry.labels.push(row.name)
      entry.variants.push({ modelId: row.modelId, ...variant })
      grouped.set(family, entry)
    }
    return [...grouped.entries()].map(([id, entry]) => ({
      id,
      name: familyName(entry.labels),
      variants: entry.variants,
    }))
  }

  /**
   * The concrete catalog id for a family and the dimensions the user asked
   * for, preferring an exact match and degrading one dimension at a time —
   * the choice that cannot be honoured is adjusted, never silently
   * substituted with a whole other model.
   */
  #resolve(session: Session, family: ModelFamily): CatalogVariant {
    const wanted = session.wanted
    const score = (v: CatalogVariant): number =>
      (v.effort === wanted.effort ? 4 : 0) +
      (v.thinking === wanted.thinking ? 2 : 0) +
      (v.fast === wanted.fast ? 1 : 0)
    const best = [...family.variants].sort(
      (a, b) => score(b) - score(a) || EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort),
    )[0]
    if (!best) throw new Error(`the ${family.name} family offers no variants`)
    return best
  }

  /**
   * The session's controls: the current family's dimensions, and the
   * sandbox, which is the CLI's own `--sandbox` and belongs to no model.
   *
   * A dimension the current family has no say in — Gemini 3.7 Flash cannot
   * think, Composer 2.5 has one effort — is declared all the same, switched
   * to what will actually run and greyed with the reason. Declaring it is
   * what lets a client carry the preference across a model change instead of
   * losing it: an option that vanishes from the list is a value the client
   * is still holding and can no longer name, and the round trip that
   * re-offers it then fails on a control nobody can see. Greyed also says
   * the true thing out loud — *this* model does not think — where an absent
   * switch only leaves a gap.
   */
  #optionsOf(session: Session, family: ModelFamily | undefined): readonly Record<string, unknown>[] {
    const options: Record<string, unknown>[] = [
      {
        id: 'sandbox',
        name: 'Sandbox',
        description: "Run commands inside Cursor's sandbox, whatever its configuration says.",
        type: 'select',
        currentValue: session.sandbox,
        options: [
          { value: 'default', name: 'Default', description: "Cursor's own configuration for this workspace." },
          { value: 'enabled', name: 'On', description: 'Commands run sandboxed.' },
          { value: 'disabled', name: 'Off', description: 'Commands run unsandboxed. Use with care.' },
        ],
      },
    ]
    if (!family || family.id === 'auto') return options
    const variants = family.variants
    const efforts = [...new Set(variants.map((v) => v.effort))].sort(
      (a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b),
    )
    options.push({
      id: 'effort',
      name: 'Reasoning effort',
      description: 'How hard the model works before it answers.',
      category: 'thought_level',
      type: 'select',
      currentValue: session.effort,
      options: efforts.map((effort) => ({ value: effort, name: EFFORT_LABEL[effort] })),
      ...(efforts.length > 1
        ? {}
        : { disabled: `${family.name} runs at one level of effort; there is nothing to choose.` }),
    })
    options.push({
      id: 'thinking',
      name: 'Thinking',
      description: 'Extended reasoning before answering.',
      category: 'thought_level',
      type: 'toggle',
      currentValue: session.thinking,
      ...(new Set(variants.map((v) => v.thinking)).size > 1
        ? {}
        : {
            disabled: session.thinking
              ? `${family.name} always thinks before it answers; the switch cannot turn that off.`
              : `${family.name} has no thinking mode.`,
          }),
    })
    options.push({
      id: 'fast',
      name: 'Fast',
      description: "Cursor's fast lane for this model — quicker, and billed at a higher rate.",
      type: 'toggle',
      currentValue: session.fast,
      ...(new Set(variants.map((v) => v.fast)).size > 1
        ? {}
        : { disabled: `${family.name} has no fast lane.` }),
    })
    // Cursor's own words for what this costs, because it is not a setting to
    // discover by its effects: the window it widens is billed at the model's
    // API rate plus 20%, and only legacy request-based plans have it at all.
    const known = this.#parameterisedFor(family.id)
    const wide = known ? withContext(known, MAX_CONTEXT) : null
    options.push({
      id: 'max-mode',
      name: 'Max mode',
      description: session.context
        ? `Maxes out the context window and tool calls — billed at API pricing. Running at ${session.context}.`
        : 'Maxes out the context window and tool calls — billed at API pricing.',
      type: 'toggle',
      currentValue: session.maxMode,
      // Cursor puts this behind a card of its own rather than a switch, and
      // so does HarnessDesk: it is the one control here that changes the bill.
      confirm: {
        title: 'Max mode',
        body: "Maxes out context windows and tool calls. For advanced users that are cost insensitive. Billed at the model's API rate plus 20%, on legacy request-based plans.",
        action: 'Enable Max mode',
        learnMore: 'https://cursor.com/help/ai-features/max-mode',
      },
      ...(wide
        ? {}
        : {
            disabled: known
              ? `${family.name} has one context window; there is no wider one to switch to.`
              : `Send one message on ${family.name} first — Cursor only names a model's context windows once it has run it.`,
          }),
    })
    return options
  }

  /** Applies (possibly adjusted) dimensions; returns the family for announcing. */
  async #applyDimensions(session: Session, familyId: string): Promise<ModelFamily | undefined> {
    const families = await this.#families()
    const family = families.find((entry) => entry.id === familyId)
    if (!family) throw new Error(`model ${JSON.stringify(familyId)} is not offered by this Cursor account`)
    session.familyId = familyId
    if (familyId === 'auto') {
      // Cursor picks the model per turn, so none of the dimensions apply;
      // the standing preference survives for whichever family comes next.
      session.modelId = 'auto'
    } else {
      const resolved = this.#resolve(session, family)
      session.modelId = resolved.modelId
      session.effort = resolved.effort
      session.thinking = resolved.thinking
      session.fast = resolved.fast
    }
    return family
  }

  #announceOptions(session: Session, family: ModelFamily | undefined): void {
    this.#notifyUpdate(session.chatId, {
      sessionUpdate: 'config_option_update',
      configOptions: this.#optionsOf(session, family),
    })
  }

  async #openSession(
    chatId: string,
    cwd: string,
    modeId: string | null = null,
    pluginDir: string | null = null,
    briefing: string | null = null,
  ): Promise<unknown> {
    const families = await this.#families()
    const session: Session = {
      chatId,
      cwd,
      modeId: modeId ?? 'default',
      modelId: 'auto',
      familyId: 'auto',
      effort: 'high',
      thinking: false,
      fast: false,
      wanted: { effort: 'high', thinking: false, fast: false },
      maxMode: false,
      context: null,
      sandbox: 'default',
      pluginDir,
      imageCount: 0,
      briefing,
      briefed: false,
      child: null,
      cancelled: false,
    }
    this.#sessions.set(chatId, session)
    // After the reply, never before it: a client has no session to attach
    // the list to until it has read the id.
    queueMicrotask(() => this.#declareSkills(session))
    return {
      sessionId: chatId,
      modes: {
        currentModeId: session.modeId,
        availableModes: MODES.map((mode) => ({ ...mode })),
      },
      ...(families.length > 0
        ? {
            models: {
              currentModelId: session.familyId,
              availableModels: families.map((family) => ({
                modelId: family.id,
                name: family.name,
                ...metaOf(family),
              })),
            },
          }
        : {}),
      configOptions: this.#optionsOf(session, families.find((entry) => entry.id === session.familyId)),
    }
  }

  /**
   * What Cursor can be asked to run, as ACP's available commands.
   *
   * `cursor-agent` has no "list my skills", so they are read where Cursor
   * keeps them: `SKILL.md` files under `~/.cursor/skills-cursor` and
   * `~/.cursor/skills`, plus the workspace's own `.cursor/skills` — the same
   * folders Cursor itself scans, with the name and description out of each
   * file's front matter. Nothing is invented: a folder that is not there
   * contributes nothing, and a file without a description is listed by name.
   */
  #declareSkills(session: Session): void {
    const skills = readCursorSkills(session.cwd)
    if (skills.length === 0) return
    this.#notifyUpdate(session.chatId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    })
  }

  async #newSession(params: Record<string, unknown>): Promise<unknown> {
    const servers = toolServersOf(params)
    const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : process.cwd()
    const chatId = (await this.#run(['create-chat'], cwd)).trim()
    if (chatId === '' || chatId.includes('\n')) {
      throw new Error(`cursor-agent create-chat returned no usable id: ${JSON.stringify(chatId)}`)
    }
    // Not remembered yet: a chat becomes a conversation on its first prompt.
    // Options probes and abandoned drafts create chats too, and indexing
    // them filled the session list with untitled rows nobody had spoken to.
    return this.#openSession(chatId, cwd, null, servers ? writeToolPlugin(chatId, servers) : null, briefingOf(params))
  }

  /**
   * Opens an indexed session. Nothing is replayed — the transcript lives in
   * Cursor and cannot be read back — but the conversation's model-side
   * context is intact: the next prompt rides `--resume` on the same chat.
   */
  async #loadSession(params: Record<string, unknown>): Promise<unknown> {
    const servers = toolServersOf(params)
    const sessionId = String(params['sessionId'] ?? '')
    const asked = typeof params['cwd'] === 'string' && params['cwd'] !== '' ? params['cwd'] : null
    // A chat started in Cursor was never in this bridge's index, and it is
    // resumable all the same: the id is Cursor's and `--resume` takes it.
    // What has to be found is the workspace, since the store is keyed by a
    // hash of the path — so the workspaces this bridge knows are asked.
    const cwd =
      asked ??
      readIndex().find((entry) => entry.sessionId === sessionId)?.cwd ??
      findChatWorkspace(sessionId, this.#knownWorkspaces()) ??
      readAllChats().find((chat) => chat.chatId === sessionId)?.cwd ??
      null
    if (cwd === null) {
      throw Object.assign(
        new Error(
          `no record of session ${sessionId}: neither this bridge nor Cursor's store ` +
            'has it under any workspace seen here — open it with its folder.',
        ),
        { code: -32602 },
      )
    }
    return this.#openSession(
      sessionId,
      cwd,
      readChatMode(sessionId, cwd, MODE_IDS),
      servers ? writeToolPlugin(sessionId, servers) : null,
      briefingOf(params),
    )
  }

  /** Every workspace this bridge has opened a session for, or recorded one in. */
  #knownWorkspaces(): readonly string[] {
    return [
      ...new Set([
        ...[...this.#sessions.values()].map((session) => session.cwd),
        ...readIndex().map((row) => row.cwd),
      ]),
    ]
  }

  /**
   * The session list: Cursor's store first, this bridge's index second.
   *
   * Cursor's chats are Cursor's however they were started — in its IDE, by
   * `cursor-agent` in a terminal, or here — and the store is the only place
   * that knows about all three. It is keyed by a hash of the workspace
   * path, which does not run backwards, so a listing is per workspace: the
   * one the client asked about, or every one this bridge has seen. That is
   * the same scoping Cursor's own picker offers ("This workspace" / "All
   * chats"), minus the workspaces nobody here has named.
   *
   * The index still answers for a chat whose folder has not appeared yet,
   * or whose store this bridge cannot read — it is a fallback now, not the
   * source of truth it used to be.
   */
  /**
   * Removes a chat from Cursor's store and from this bridge's index.
   *
   * The chat folder goes to the Trash — see `trashChat` — and the index row
   * goes with it, so the listing agrees immediately rather than after Cursor
   * next writes. A chat with nothing stored answers with an empty list and no
   * error: a conversation that never took a turn was never written down, and
   * a delete that finds nothing to delete has still done what was asked.
   */
  #deleteSession(params: Record<string, unknown>): { removed: string[]; disposition: 'trash' } {
    const chatId = String(params['sessionId'] ?? '')
    if (chatId === '') throw new Error('A session id is required.')
    const live = this.#sessions.get(chatId)
    if (live) {
      live.cancelled = true
      live.child?.kill('SIGTERM')
      this.#sessions.delete(chatId)
    }
    this.#previews.delete(chatId)
    writeIndex(readIndex().filter((row) => row.sessionId !== chatId))
    const path = chatPath(chatId)
    const removed = path !== null && trashChat(path) ? [path] : []
    return { removed, disposition: 'trash' }
  }

  #listSessions(scope: string | null): readonly SessionRow[] {
    const index = readIndex()
    const workspaces = scope !== null ? [scope] : this.#knownWorkspaces()
    const chats: CursorChat[] = workspaces.flatMap((cwd) => [...readWorkspaceChats(cwd)])
    // Asked about everything, every chat that records its own workspace is
    // part of the answer — including folders nobody has opened here, which
    // is where a terminal's `cursor-agent` chats live.
    if (scope === null) chats.push(...readAllChats())
    const rows = new Map<string, SessionRow>()
    for (const chat of chats) {
      if (rows.has(chat.chatId)) continue
      const ours = index.find((row) => row.sessionId === chat.chatId)
      const seen = ours ? Date.parse(ours.updatedAt) : 0
      rows.set(chat.chatId, {
        sessionId: chat.chatId,
        cwd: chat.cwd,
        title: chat.title,
        // Cursor's own transcript first: it holds the ask the conversation
        // opened with, where this bridge's index holds whatever was last
        // sent through it — and a conversation is named by how it began.
        preview: this.#preview(chat.chatId, chat.cwd, chat.updatedAt) ?? storedName(ours?.preview),
        updatedAt: new Date(Math.max(chat.updatedAt, seen)).toISOString(),
      })
    }
    for (const row of index) {
      if (rows.has(row.sessionId)) continue
      if (scope !== null && row.cwd !== scope) continue
      rows.set(row.sessionId, {
        sessionId: row.sessionId,
        cwd: row.cwd,
        title: cursorMeta(row.sessionId, row.cwd).title,
        preview: storedName(row.preview),
        updatedAt: row.updatedAt,
      })
    }
    return [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /**
   * The opening ask of a chat this bridge never ran, read once. A prompt
   * does not change after it is sent, so it is remembered against the
   * chat's timestamp — which also retries the read for a chat that was
   * still being written when it was first listed.
   */
  #preview(chatId: string, cwd: string, updatedAt: number): string | null {
    const key = `${chatId}:${updatedAt}`
    const known = this.#previews.get(key)
    if (known !== undefined) return known
    const preview = readChatPreview(chatId, cwd)
    this.#previews.set(key, preview)
    return preview
  }

  #rememberSession(chatId: string, cwd: string, preview: string | null): void {
    const rows = readIndex().filter((entry) => entry.sessionId !== chatId)
    const existing = readIndex().find((entry) => entry.sessionId === chatId)
    rows.push({
      sessionId: chatId,
      cwd,
      preview: preview ?? existing?.preview ?? null,
      updatedAt: new Date().toISOString(),
    })
    writeIndex(rows)
  }

  #session(params: Record<string, unknown>): Session {
    const id = String(params['sessionId'] ?? '')
    const session = this.#sessions.get(id)
    if (!session) throw new Error(`unknown session: ${id}`)
    return session
  }

  #setMode(params: Record<string, unknown>): null {
    const session = this.#session(params)
    const modeId = String(params['modeId'] ?? '')
    if (!MODES.some((mode) => mode.id === modeId)) {
      throw new Error(`mode ${JSON.stringify(modeId)} is not one of ${MODES.map((m) => m.id).join(', ')}`)
    }
    session.modeId = modeId
    this.#notifyUpdate(session.chatId, { sessionUpdate: 'current_mode_update', currentModeId: modeId })
    return null
  }

  async #setModel(params: Record<string, unknown>): Promise<null> {
    const session = this.#session(params)
    const familyId = String(params['modelId'] ?? '')
    const family = await this.#applyDimensions(session, familyId)
    // The model announcement precedes the option one: a client folding these
    // into a single view must never see new options against the old model.
    this.#notifyUpdate(session.chatId, { sessionUpdate: 'current_model_update', currentModelId: familyId })
    this.#announceOptions(session, family)
    return null
  }

  /**
   * A dimension is written to the standing preference, never straight to the
   * running id: `#applyDimensions` then decides what this family can make of
   * it. Asking for thinking on a family that cannot think is therefore not
   * an error — it is a preference that will be honoured by the next family
   * that can, and the greyed switch says so meanwhile.
   */
  async #setConfigOption(params: Record<string, unknown>): Promise<null> {
    const session = this.#session(params)
    const optionId = String(params['configId'] ?? params['configOptionId'] ?? '')
    const value = params['value']
    if (optionId === 'effort') {
      if (typeof value !== 'string' || !(EFFORTS as readonly string[]).includes(value)) {
        throw new Error(`effort ${JSON.stringify(value)} is not one of the values Effort offers`)
      }
      session.wanted.effort = value as Effort
    } else if (optionId === 'thinking' || optionId === 'fast') {
      if (typeof value !== 'boolean') throw new Error(`${optionId} is a toggle; it takes true or false`)
      session.wanted[optionId] = value
    } else if (optionId === 'sandbox') {
      if (value !== 'default' && value !== 'enabled' && value !== 'disabled') {
        throw new Error(`sandbox ${JSON.stringify(value)} is not one of default, enabled, disabled`)
      }
      session.sandbox = value
    } else if (optionId === 'max-mode') {
      if (typeof value !== 'boolean') throw new Error('max-mode is a toggle; it takes true or false')
      session.maxMode = value
    } else {
      throw new Error(`no option ${JSON.stringify(optionId)}`)
    }
    const family = await this.#applyDimensions(session, session.familyId)
    this.#announceOptions(session, family)
    return null
  }

  #cancel(params: Record<string, unknown>): null {
    const session = this.#sessions.get(String(params['sessionId'] ?? ''))
    if (!session) return null
    // Set whether or not a process exists yet: a turn waiting for a start
    // seat, or pausing before another attempt, has nothing to kill — and a
    // Stop pressed then used to be lost, with the process starting after
    // it and running the prompt the user had just stopped.
    session.cancelled = true
    session.wake?.()
    if (!session.child) return null
    const child = session.child
    child.kill('SIGTERM')
    const escalate = setTimeout(() => child.kill('SIGKILL'), 3_000)
    escalate.unref()
    child.once('exit', () => clearTimeout(escalate))
    return null
  }

  // ----------------------------------------------------------------- prompt

  async #prompt(params: Record<string, unknown>): Promise<TurnOutcome> {
    const session = this.#session(params)
    if (session.child) throw new Error('a turn is already running in this session')
    const text = this.#textOf(params['prompt'], session)
    if (text.trim() === '') throw new Error('the prompt contains no text')

    // Two ways to name a model, and only one of them can widen a window.
    // `--model <slug>` names a fixed variant of the flat catalogue, context
    // included, so it is what an ordinary turn uses — every slug in that
    // catalogue is known to work. Max mode needs the parameterised selection
    // instead, which lives in the config rather than on the command line, so
    // the flag comes off and the config carries the choice.
    const wide =
      session.maxMode && session.familyId !== 'auto'
        ? (() => {
            const known = this.#parameterisedFor(session.familyId)
            return known ? withContext(known, MAX_CONTEXT) : null
          })()
        : null
    const configHome = prepareConfig(wide)

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--trust',
      '--resume',
      session.chatId,
      ...(!wide && session.modelId !== 'auto' ? ['--model', session.modelId] : []),
      ...(session.modeId !== 'default' ? ['--mode', session.modeId] : []),
      // Left off entirely at `default`, because the flag overrides Cursor's
      // own configuration and "no opinion" is not one of its two values.
      ...(session.sandbox !== 'default' ? ['--sandbox', session.sandbox] : []),
      // The generated tool plugin, when the session was offered one.
      // `--approve-mcps` rides with it: print mode has no way to show the
      // CLI's per-server approval prompt, and the only server in this
      // directory is the one HarnessDesk itself offered.
      ...(session.pluginDir ? ['--plugin-dir', session.pluginDir, '--approve-mcps'] : []),
      '--', // a prompt that begins with `-` must stay a prompt
      // The client's briefing rides ahead of the first prompt only; the chat
      // remembers it from there. Marked briefed only once a turn has run
      // (below): a turn stopped at the start gate, or a spawn that died
      // before its first word and was not retried, never showed it to the
      // agent, and the next prompt carries it again.
      session.briefing && !session.briefed ? `${session.briefing}\n\n${text}` : text,
    ]

    session.cancelled = false
    const asked = readIndex().find((entry) => entry.sessionId === session.chatId)?.preview
    this.#rememberSession(session.chatId, session.cwd, previewFor(asked, text))

    for (let attempt = 1; ; attempt += 1) {
      const spoke = { yet: false }
      const leave = await this.#seat(session)
      // Stopped while waiting for the seat, or in the moment it came: the
      // seat goes straight back and nothing is spawned for a turn the user
      // has already ended.
      if (leave === null || session.cancelled) {
        leave?.()
        return { stopReason: 'cancelled' }
      }
      try {
        const outcome = await this.#runTurn(session, args, configHome, spoke, leave)
        // The agent has read the prompt — briefing included — whatever the
        // turn's outcome; the chat remembers it under `--resume`.
        session.briefed = true
        return outcome
      } catch (error) {
        leave()
        const said = error instanceof Error ? error.message : String(error)
        if (session.cancelled || spoke.yet || attempt >= START_ATTEMPTS || !STARTUP_TRANSIENT.test(said)) {
          throw error
        }
        // The process died before its first event for a reason that reads as
        // the network's, so nothing of this turn has happened yet and it can
        // simply be started again — after a pause that doubles each time,
        // with jitter, so a burst that caused it does not repeat itself in
        // step. A Stop during the pause ends the wait at once.
        this.#log(`cursor-acp: cursor-agent died before it said anything (attempt ${attempt} of ${START_ATTEMPTS}): ${said}`)
        await this.#pause(session, START_RETRY_MS * 2 ** (attempt - 1) + Math.random() * (START_RETRY_MS / 2))
        if (session.cancelled) return { stopReason: 'cancelled' }
      }
    }
  }

  readonly #gate = new StartGate(START_LIMIT)

  /**
   * A seat at the start gate, or `null` if the turn was stopped while
   * waiting for one. A seat that arrives after the turn gave up waiting is
   * handed straight back, so a Stop never leaks a seat.
   */
  async #seat(session: Session): Promise<(() => void) | null> {
    let abandoned = false
    const seat = this.#gate.enter().then((leave) => {
      if (!abandoned) return leave
      leave()
      return null
    })
    const stopped = new Promise<null>((resolve) => {
      session.wake = () => resolve(null)
    })
    try {
      const got = await Promise.race([seat, stopped])
      if (got === null) abandoned = true
      return got
    } finally {
      session.wake = undefined
    }
  }

  /** A pause a Stop can cut short. */
  async #pause(session: Session, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      session.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    session.wake = undefined
  }

  /** One cursor-agent process for one turn, from spawn to exit. */
  #runTurn(
    session: Session,
    args: readonly string[],
    configHome: string,
    spoke: { yet: boolean },
    leave: () => void,
  ): Promise<TurnOutcome> {
    const child = spawn(this.#command, [...args], {
      cwd: session.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CURSOR_CONFIG_DIR: configHome },
    })
    session.child = child

    const stderrTail: string[] = []
    createInterface({ input: child.stderr! }).on('line', (line) => {
      stderrTail.push(line)
      if (stderrTail.length > 20) stderrTail.shift()
      this.#log(`cursor-agent: ${line}`)
    })

    // After streaming a message's deltas the CLI re-sends the complete text
    // as one more assistant event — with `timestamp_ms` mid-turn, without it
    // at the end, so the timestamp cannot tell a repeat from a delta. What
    // can: the repeat exactly equals everything accumulated since the last
    // boundary. The length floor keeps a genuinely stuttered short token
    // from being mistaken for a boundary.
    let accumulated = ''
    let outcome: TurnOutcome | Error | null = null

    const capture = process.env['CURSOR_ACP_CAPTURE']
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (line.trim() === '') return
      if (capture) {
        // Debugging aid: the raw stream-json tape, appended verbatim. The
        // CLI's dialect is undocumented; when rendering looks wrong, this
        // file is the evidence of what was actually said.
        try {
          appendFileSync(capture, `${line}\n`)
        } catch {
          // capture must never break a turn
        }
      }
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.#log(`cursor-agent: non-JSON output: ${line.slice(0, 120)}`)
        return
      }
      // The process has booted and spoken: its seat at the start gate is
      // free, and from here a death is the turn's own and is not retried.
      spoke.yet = true
      leave()
      const consumed = this.#translate(session, event, {
        accumulated: () => accumulated,
        append: (text) => {
          accumulated += text
        },
        boundary: () => {
          accumulated = ''
        },
        settle: (value) => {
          outcome ??= value
        },
      })
      if (!consumed) this.#log(`cursor-agent: unhandled event type ${String(event['type'])}`)
    })

    return new Promise((resolve, reject) => {
      child.once('error', (error) => {
        session.child = null
        leave()
        reject(
          error.message.includes('ENOENT')
            ? new Error(`${this.#command} was not found — is the Cursor CLI installed and on PATH?`)
            : error,
        )
      })
      child.once('exit', (code) => {
        session.child = null
        leave()
        this.#learn(session.familyId)
        if (session.maxMode && session.context !== null && !/^1M$/i.test(session.context)) {
          // The CLI drops a parameter combination it dislikes and runs the
          // model's default instead, saying so only in its debug log. The
          // window it named is the evidence; the switch goes back off rather
          // than sitting on claiming something that did not happen.
          session.maxMode = false
          this.#log(`cursor-acp: Max mode is not offered for ${session.familyId}; ran at ${session.context}`)
        }
        void this.#families()
          .then((families) => families.find((entry) => entry.id === session.familyId))
          .then((family) => this.#announceOptions(session, family))
          .catch(() => {})
        if (session.cancelled) {
          resolve({ stopReason: 'cancelled' })
        } else if (outcome instanceof Error) {
          reject(outcome)
        } else if (outcome) {
          resolve(outcome)
        } else {
          const tail = stderrTail.slice(-3).join(' · ')
          reject(
            new Error(
              `cursor-agent exited (code ${String(code)}) without reporting a result${tail ? ` — ${tail}` : ''}`,
            ),
          )
        }
      })
    })
  }

  /**
   * One stream-json event → zero or more `session/update` notifications.
   * Returns false for an event type this bridge does not know, so the
   * unknown is logged instead of silently dropped.
   */
  #translate(
    session: Session,
    event: Record<string, unknown>,
    turn: {
      accumulated: () => string
      append: (text: string) => void
      boundary: () => void
      settle: (value: TurnOutcome | Error) => void
    },
  ): boolean {
    const type = event['type']
    switch (type) {
      case 'system': {
        // cursor-agent names the model it actually resolved to, context
        // window and all — "Claude Opus 5 1M High". It is the only honest
        // answer about what ran: the flat catalogue's own labels say 1M for
        // ids that resolve to 300K, and a parameter combination the CLI
        // dislikes is dropped for the model's default without a word.
        const named = event['model']
        if (typeof named === 'string') {
          const window = /\b(\d+(?:\.\d+)?[KM]|1M)\b/.exec(named)
          session.context = window ? window[1]! : null
        }
        return true
      }
      case 'user':
        return true // the echo of our own prompt
      case 'thinking': {
        turn.boundary() // a message never straddles a thinking block
        if (event['subtype'] === 'delta' && typeof event['text'] === 'string') {
          this.#notifyUpdate(session.chatId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event['text'] },
          })
        }
        return true
      }
      case 'assistant': {
        const message = event['message'] as { content?: readonly Record<string, unknown>[] } | undefined
        for (const part of message?.content ?? []) {
          if (part['type'] !== 'text' || typeof part['text'] !== 'string') continue
          const text = part['text']
          const whole = turn.accumulated()
          // The end-of-message repeat: everything said since the last boundary,
          // re-sent as one more event. It is a boundary marker, not new text.
          //
          // Equalling the accumulation *is* the signal, and it is the whole of
          // it. The repeat comes both mid-turn (before a tool call, carrying a
          // `timestamp_ms`) and at the very end (without one), so the timestamp
          // cannot be the test — but neither can a length.
          //
          // This used to also require sixteen characters, which mistook a size
          // for a signal: every reply shorter than that was appended twice.
          // "pong" arrived as "pongpong", and did so all the way through — the
          // transcript, the room's channel, and the audit. Verified against the
          // real CLI: `pong` doubles, `acknowledged and standing by` does not.
          //
          // What the floor was guarding is real but much smaller: an agent whose
          // whole message so far is one short piece, repeating that piece. That
          // now reads as two short messages rather than one doubled one, which
          // is the better failure of the two — it says something that happened
          // instead of something that did not.
          if (text === whole && whole !== '') {
            turn.boundary()
            continue
          }
          turn.append(text)
          this.#notifyUpdate(session.chatId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          })
        }
        return true
      }
      case 'tool_call': {
        turn.boundary() // a message never straddles a tool call
        const callId = String(event['call_id'] ?? '')
        const wrapper = (event['tool_call'] ?? {}) as Record<string, unknown>
        const key = Object.keys(wrapper).find((entry) => entry.endsWith('ToolCall'))
        const call = key ? (wrapper[key] as Record<string, unknown>) : undefined
        const args = call?.['args'] ?? null
        const result = (call as { result?: Record<string, unknown> } | undefined)?.result
        if (event['subtype'] === 'started') {
          this.#notifyUpdate(session.chatId, {
            sessionUpdate: 'tool_call',
            toolCallId: callId,
            title: this.#titleOf(key, args),
            kind: this.#kindOf(key),
            status: 'in_progress',
            rawInput: args,
          })
        } else if (event['subtype'] === 'completed') {
          const failed = result !== undefined && !('success' in result)
          this.#notifyUpdate(session.chatId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: failed ? 'failed' : 'completed',
            rawOutput: result ?? null,
          })
        }
        return true
      }
      case 'result': {
        if (event['is_error'] === true) {
          turn.settle(new Error(typeof event['result'] === 'string' ? event['result'] : 'cursor-agent reported an error'))
        } else {
          // The CLI counts the turn's tokens on its result — input, output,
          // and since 2026.08.31 the cache split — but no window size. They
          // ride the reply as ACP's unstable `usage`; the fill stays unknown,
          // and the client says so rather than guessing.
          const usage = usageOf(event['usage'])
          turn.settle(usage ? { stopReason: 'end_turn', usage } : { stopReason: 'end_turn' })
        }
        return true
      }
      default:
        return false
    }
  }

  #titleOf(key: string | undefined, args: unknown): string {
    const kind = (key ?? 'tool').replace(/ToolCall$/, '')
    const record = (args ?? {}) as Record<string, unknown>
    const path = typeof record['path'] === 'string' ? record['path'] : undefined
    const command = typeof record['command'] === 'string' ? record['command'] : undefined
    if (path) return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${basename(path)}`
    if (command) return `Run ${command.length > 60 ? `${command.slice(0, 57)}…` : command}`
    return kind.charAt(0).toUpperCase() + kind.slice(1)
  }

  #kindOf(key: string | undefined): string {
    const name = (key ?? '').replace(/ToolCall$/, '')
    for (const [pattern, kind] of TOOL_KINDS) if (pattern.test(name)) return kind
    return 'other'
  }

  /**
   * The prompt as one string for the command line. Text is itself; a file
   * mention is its path; an image is written under the temp directory and
   * named with the `@path` the CLI reads images through — after the text, so
   * the first line the user wrote stays the title.
   */
  #textOf(prompt: unknown, session?: Session): string {
    if (!Array.isArray(prompt)) return ''
    const parts: string[] = []
    const images: string[] = []
    for (const block of prompt as readonly Record<string, unknown>[]) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
      else if (block['type'] === 'resource_link' && typeof block['uri'] === 'string') {
        parts.push(String(block['uri']).replace(/^file:\/\//, ''))
      } else if (block['type'] === 'image' && typeof block['data'] === 'string' && session) {
        images.push(this.#spillImage(session, block['data'], String(block['mimeType'] ?? 'image/png')))
      }
    }
    if (images.length > 0) {
      parts.push(
        images.length === 1
          ? `The user attached this image; look at it: @${images[0]}`
          : `The user attached these images; look at them:\n${images.map((path) => `@${path}`).join('\n')}`,
      )
    }
    return parts.join('\n\n')
  }

  /** Writes one image block to disk and returns its path. One file per image, per turn. */
  #spillImage(session: Session, data: string, mimeType: string): string {
    const extension =
      mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : mimeType === 'image/gif' ? 'gif' : 'png'
    const dir = join(tmpdir(), 'harnessdesk-cursor-acp', session.chatId)
    mkdirSync(dir, { recursive: true })
    session.imageCount += 1
    const path = join(dir, `image-${session.imageCount}.${extension}`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  // ------------------------------------------------------------------ wire

  #send(message: JsonRpcMessage): void {
    this.#output.write(`${JSON.stringify(message)}\n`)
  }

  #notifyUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.#send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    })
  }

  /** One short-lived cursor-agent subcommand; stdout, trimmed of nothing. */
  #run(args: readonly string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#command,
        [...args],
        { cwd, timeout: 30_000, env: { ...process.env } },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim().split('\n').slice(-2).join(' · ')
            reject(new Error(`cursor-agent ${args.join(' ')} failed: ${detail || error.message}`))
          } else {
            resolve(stdout)
          }
        },
      )
    })
  }

  /**
   * `cursor-agent models` prints `id - label` lines. Cached, but not for the
   * process: Cursor adds models server-side with no binary change, so a
   * bridge that listed once at start would show last week's catalogue to a
   * window that has been open all week. The next `session/new` after the
   * cache ages out re-asks; `CURSOR_ACP_MODELS_TTL_MS` sets the age (tests
   * set it to 0).
   */
  async #listModels(): Promise<readonly ModelRow[]> {
    if (this.#models && Date.now() - this.#modelsListedAt < modelsTtlMs()) return this.#models
    try {
      const output = await this.#run(['models'], process.cwd())
      const rows: ModelRow[] = []
      for (const line of output.split('\n')) {
        const match = /^(\S+) - (.+)$/.exec(line.trim())
        if (match) rows.push({ modelId: match[1]!, name: match[2]! })
      }
      this.#models = rows
      this.#modelsListedAt = Date.now()
    } catch (error) {
      // No model list is a degraded surface, not a broken session — and a
      // list that was there before is better than an empty one now. The ask
      // is not marked as done: a `cursor-agent` that failed once (the first
      // run of the day is the slow one) is asked again on the next need,
      // rather than serving an empty catalogue for the whole TTL.
      this.#log(`cursor-acp: could not list models: ${error instanceof Error ? error.message : String(error)}`)
      this.#models ??= []
    }
    return this.#models
  }
}

const DEFAULT_MODELS_TTL_MS = 10 * 60 * 1000

/**
 * Cursor's skills, from the folders Cursor scans: the ones it ships with,
 * the user's own, and the workspace's. Nearest wins — a workspace skill
 * shadows a personal one of the same name, as Cursor resolves it.
 */
export const readCursorSkills = (
  cwd: string,
  home = homedir(),
): readonly { readonly name: string; readonly description: string }[] => {
  const roots = [
    join(home, '.cursor', 'skills-cursor'),
    join(home, '.cursor', 'skills'),
    join(cwd, '.cursor', 'skills'),
  ]
  const found = new Map<string, { name: string; description: string }>()
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue // Not every root exists; that is the common case, not an error.
    }
    for (const entry of entries) {
      let text: string
      try {
        text = readFileSync(join(root, entry, 'SKILL.md'), 'utf8')
      } catch {
        continue
      }
      const front = frontMatterOf(text)
      const name = front['name']?.trim() || entry
      found.set(name, { name, description: front['description']?.trim() ?? '' })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The leading `---` block of a SKILL.md, as flat fields.
 *
 * Enough YAML for these headers and no more: `key: value`, quoted or not,
 * and the folded/literal block scalars Cursor's own skills use for a
 * description that runs past one line (`description: >-`, then indented
 * lines). A nested mapping (`metadata:`) is skipped rather than guessed at.
 */
const frontMatterOf = (text: string): Record<string, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const lines = (match[1] ?? '').split('\n')
  const fields: Record<string, string> = {}
  for (let index = 0; index < lines.length; index += 1) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index] ?? '')
    if (!pair) continue
    const key = pair[1]!
    const value = (pair[2] ?? '').trim()
    if (/^[>|][-+]?$/.test(value)) {
      // A block scalar: the indented lines that follow, joined as one.
      const folded: string[] = []
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? '')) {
        folded.push((lines[index + 1] ?? '').trim())
        index += 1
      }
      fields[key] = folded.join(' ')
      continue
    }
    fields[key] = value.replace(/^["']|["']$/g, '')
  }
  return fields
}

const modelsTtlMs = (): number => {
  const raw = process.env['CURSOR_ACP_MODELS_TTL_MS']
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MODELS_TTL_MS
}
