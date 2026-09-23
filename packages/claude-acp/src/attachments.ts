import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Phase 12's attachment-loading extension, agent side.
 *
 * The names and shapes here are duplicated from `@harnessdesk/transport-acp`,
 * the client half, on purpose: this bridge has no HarnessDesk dependency, so
 * any ACP client — HarnessDesk's own, or a third party's — can drive it.
 * Change one, change the other.
 *
 * What this file turns a host's isolated `AttachmentInput` into is exactly
 * what decision 16 of the phase-12 plan asks for: an isolated skill filter
 * (a host-generated plugin containing nothing but the approved skill
 * directories, `settingSources: []` so no ambient project/user location is
 * ever read), and `strictMcpConfig: true` so the only server this session's
 * Claude Agent SDK query can reach is the one ACP's own `mcpServers` already
 * carries — the `harnessdesk` gateway `bootstrap.ts` wires to
 * `McpToolGateway`, through which a Seat's approved external tools are
 * actually reachable (see `packages/server/src/attachments/gate.ts` and
 * `packages/mcp-tools/src/main.ts`). This file never dials anything out
 * itself; it stages bytes and shapes options, nothing more.
 */

export const ATTACHMENTS_CAPABILITY = 'attachments'
export const ATTACHMENT_RECEIPT = '_harnessdesk/attachment_receipt'

/** What this bridge declares in `initialize`'s `_meta.harnessdesk.attachments`. */
export const ATTACHMENT_CAPABILITY_VALUE = { version: 1 as const, skills: true, mcp: true, suppressUnapproved: true }

export interface AttachmentInput {
  readonly key: string
  readonly skills: readonly { readonly name: string; readonly digest: string; readonly path: string }[] | null
  readonly mcp: readonly { readonly name: string; readonly digest: string; readonly endpoint: string }[] | null
  readonly notes: { readonly digest: string; readonly text: string } | null
}

export interface AttachmentReceiptResult {
  readonly key: string
  readonly loaded: readonly { readonly kind: 'skill' | 'mcp' | 'notes'; readonly name: string; readonly digest: string }[]
  readonly refused: readonly { readonly kind: 'skill' | 'mcp' | 'notes'; readonly name: string; readonly reason: string }[]
}

/** The one plugin name every staged bundle is given, and the qualifier every staged skill's exposed name carries. */
const PLUGIN_NAME = 'harnessdesk'
/** The ACP-level `mcpServers` name `bootstrap.ts` gives the desk's own gateway (`toolServer = { name: 'harnessdesk', ... }`). */
const GATEWAY_SERVER_NAME = 'harnessdesk'

// ------------------------------------------------------------ decode (host → agent)

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeNamedDigest = (value: unknown): { readonly name: string; readonly digest: string; readonly path: string } | null => {
  if (!isPlainObject(value)) return null
  const { name, digest, path } = value
  if (typeof name !== 'string' || typeof digest !== 'string' || typeof path !== 'string') return null
  if (name.length === 0 || path.length === 0) return null
  return { name, digest, path }
}

const decodeMcpEntry = (value: unknown): { readonly name: string; readonly digest: string; readonly endpoint: string } | null => {
  if (!isPlainObject(value)) return null
  const { name, digest, endpoint } = value
  if (typeof name !== 'string' || typeof digest !== 'string' || typeof endpoint !== 'string') return null
  if (name.length === 0) return null
  return { name, digest, endpoint }
}

/**
 * Strictly decodes `_meta.harnessdesk.attachments` from an incoming
 * `session/new` or `session/load` request. Anything other than exactly
 * `{version: 1, input: {...}}`, with every named entry itself well-shaped,
 * is `null` — a host that sends something this bridge cannot read exactly is
 * a host this extension was never negotiated with, never a best-effort
 * repair of a malformed message.
 */
export function decodeAttachmentInput(meta: Record<string, unknown> | null | undefined): AttachmentInput | null {
  const harnessdesk = meta?.['harnessdesk']
  if (!isPlainObject(harnessdesk)) return null
  const declared = harnessdesk[ATTACHMENTS_CAPABILITY]
  if (!isPlainObject(declared) || declared['version'] !== 1) return null
  const input = declared['input']
  if (!isPlainObject(input)) return null
  const { key, skills, mcp, notes } = input
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) return null
  if (skills !== null && !Array.isArray(skills)) return null
  if (mcp !== null && !Array.isArray(mcp)) return null
  const decodedSkills = skills === null ? null : skills.map(decodeNamedDigest)
  if (decodedSkills && decodedSkills.some((one) => one === null)) return null
  const decodedMcp = mcp === null ? null : mcp.map(decodeMcpEntry)
  if (decodedMcp && decodedMcp.some((one) => one === null)) return null
  let decodedNotes: { readonly digest: string; readonly text: string } | null = null
  if (notes !== null && notes !== undefined) {
    if (!isPlainObject(notes) || typeof notes['digest'] !== 'string' || typeof notes['text'] !== 'string') return null
    decodedNotes = { digest: notes['digest'], text: notes['text'] }
  }
  return {
    key,
    skills: decodedSkills as readonly { readonly name: string; readonly digest: string; readonly path: string }[] | null,
    mcp: decodedMcp as readonly { readonly name: string; readonly digest: string; readonly endpoint: string }[] | null,
    notes: decodedNotes,
  }
}

// ------------------------------------------------------------ staging

/** `~` is the only shortening `shortPath` (the host's own labeler) ever applies; reversing it is exact, never a guess. */
const resolveHome = (path: string): string => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

/**
 * Copies one skill's bundle byte for byte, refusing outright the moment any
 * path in the tree — the bundle root or anything under it — is not an
 * ordinary file or directory. A symlink here could point anywhere the
 * approving person never saw; staging it would silently substitute whatever
 * it currently resolves to for the bytes that were actually reviewed, which
 * is exactly the class of bug this repository has already found and fixed
 * more than once in its own copy/backup paths.
 */
function copyBundle(from: string, to: string): void {
  const st = lstatSync(from)
  if (st.isSymbolicLink()) throw new Error(`${from} is a symlink, not part of an approved bundle.`)
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) copyBundle(join(from, entry), join(to, entry))
    return
  }
  if (!st.isFile()) throw new Error(`${from} is neither a file nor a directory.`)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(from))
}

export interface StagedAttachments {
  /** `null` when nothing staged at all — an empty or absent skill list never creates a plugin. */
  readonly pluginPath: string | null
  readonly qualifiedNames: readonly string[]
  readonly staged: readonly { readonly name: string; readonly digest: string }[]
  readonly refused: readonly { readonly name: string; readonly reason: string }[]
}

/**
 * Rebuilds `root` from scratch as a single host-generated plugin containing
 * nothing but a minimal `.claude-plugin/plugin.json` (a name, nothing else —
 * no hooks, no commands, no `.mcp.json`: decision 9's "no repo-provided
 * manifest is carried") and one `skills/<name>/` per approved skill, copied
 * from the exact path the host resolved. A skill whose source cannot be
 * copied safely (missing, or a symlink anywhere in it) is refused, named,
 * and simply left out — the rest of the batch still stages.
 */
export function stageSkills(input: AttachmentInput, root: string): StagedAttachments {
  rmSync(root, { recursive: true, force: true })
  if (!input.skills || input.skills.length === 0) return { pluginPath: null, qualifiedNames: [], staged: [], refused: [] }
  const pluginPath = join(root, 'plugin')
  const staged: { name: string; digest: string }[] = []
  const refused: { name: string; reason: string }[] = []
  const qualifiedNames: string[] = []
  for (const skill of input.skills) {
    try {
      copyBundle(resolveHome(skill.path), join(pluginPath, 'skills', skill.name))
      staged.push({ name: skill.name, digest: skill.digest })
      qualifiedNames.push(`${PLUGIN_NAME}:${skill.name}`)
    } catch (error) {
      refused.push({ name: skill.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (staged.length === 0) return { pluginPath: null, qualifiedNames: [], staged: [], refused }
  mkdirSync(join(pluginPath, '.claude-plugin'), { recursive: true })
  writeFileSync(join(pluginPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME }), 'utf8')
  return { pluginPath, qualifiedNames, staged, refused }
}

// ------------------------------------------------------------ SDK options

export interface AttachmentOptions {
  /** Merged into `claudeCode.options` verbatim — see `bridge.ts`'s `withAttachments`. */
  readonly options: Record<string, unknown>
  /** What notes text (if any) to fold into the standing instruction, labeled, never as an unlabeled system instruction. */
  readonly notesAppend: string | null
  readonly staged: StagedAttachments
}

/**
 * Everything phase 12 adds to one session's Claude Agent SDK options for a
 * prepared, host-approved input. `null` when there is no input at all — the
 * plain path this bridge already has stays exactly as it was.
 *
 * `settingSources: []` and `strictMcpConfig: true` apply whenever attachment
 * negotiation is active at all, regardless of which one kind a particular
 * Seat happened to declare: once a Seat's loading is being scoped, ambient
 * project/user skill and MCP configuration is exactly the "unapproved
 * auto-loading" decision 12 exists to suppress, not something left half-on
 * because this Seat's own declarations only named one kind.
 */
export function attachmentOptions(input: AttachmentInput | null, stagingRoot: string): AttachmentOptions | null {
  if (!input) return null
  const staged = stageSkills(input, stagingRoot)
  const options: Record<string, unknown> = { settingSources: [], strictMcpConfig: true }
  options['skills'] = staged.qualifiedNames
  if (staged.pluginPath) options['plugins'] = [{ type: 'local', path: staged.pluginPath, skipMcpDiscovery: true }]
  const notesAppend = input.notes && input.notes.text.trim() !== '' ? `Agent notes:\n${input.notes.text}` : null
  return { options, notesAppend, staged }
}

// ------------------------------------------------------------ receipt

export interface LiveQuerySignals {
  supportedCommands(): Promise<readonly { readonly name: string }[]>
  mcpServerStatus(): Promise<readonly { readonly name: string; readonly status: string }[]>
}

/**
 * The truthful answer to `_harnessdesk/attachment_receipt`: every prepared
 * skill is checked against what the live query actually reports loaded
 * (`supportedCommands()`), never assumed from having been staged — staging
 * can fail silently downstream of this file (a build that does not read this
 * plugin path, a name Claude Code did not recognize) and a receipt that
 * skipped the check would be exactly the invented success decision 16
 * refuses. An approved MCP identity is loaded exactly when the desk's own
 * gateway server reports `connected`; if it is anything else, every
 * approved server for this Seat is refused with that one reason, since none
 * of them has a route to the agent except through that one server. Runtime
 * defaults (a `null` field) have no live enumeration in this pass — reported
 * `null` back to the caller, which folds it into the reason it shows,
 * because inventing "loaded" for a filter nobody ever approved is worse than
 * an honest "cannot tell yet".
 */
export async function attachmentReceipt(
  input: AttachmentInput,
  staged: StagedAttachments,
  query: LiveQuerySignals,
): Promise<AttachmentReceiptResult> {
  const loaded: { kind: 'skill' | 'mcp' | 'notes'; name: string; digest: string }[] = []
  const refused: { kind: 'skill' | 'mcp' | 'notes'; name: string; reason: string }[] = []

  for (const entry of staged.refused) refused.push({ kind: 'skill', name: entry.name, reason: entry.reason })

  if (staged.staged.length > 0) {
    const commands = await query.supportedCommands().catch(() => [])
    const seen = new Set(commands.map((one) => one.name))
    for (const skill of staged.staged) {
      if (seen.has(`${PLUGIN_NAME}:${skill.name}`) || seen.has(skill.name)) loaded.push({ kind: 'skill', name: skill.name, digest: skill.digest })
      else refused.push({ kind: 'skill', name: skill.name, reason: 'Claude Code did not report this skill as loaded.' })
    }
  }

  if (input.mcp && input.mcp.length > 0) {
    const statuses = await query.mcpServerStatus().catch(() => [])
    const gateway = statuses.find((one) => one.name === GATEWAY_SERVER_NAME)
    const reason = gateway ? `The HarnessDesk gateway is ${gateway.status}, not connected.` : 'The HarnessDesk gateway did not connect.'
    for (const server of input.mcp) {
      if (gateway?.status === 'connected') loaded.push({ kind: 'mcp', name: server.name, digest: server.digest })
      else refused.push({ kind: 'mcp', name: server.name, reason })
    }
  }

  if (input.notes) {
    // Notes ride the standing instruction, which has no further live signal
    // to check — `bridge.ts` only reaches this branch once the text was
    // actually folded in, so "loaded" here means exactly that, not a guess.
    loaded.push({ kind: 'notes', name: 'notes', digest: input.notes.digest })
  }

  return { key: input.key, loaded, refused }
}
