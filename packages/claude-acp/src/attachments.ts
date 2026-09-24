import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

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
}

export interface AttachmentReceiptResult {
  readonly key: string
  readonly loaded: readonly { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly digest: string }[]
  readonly refused: readonly { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly reason: string }[]
}

/** A session key as a folder name may be: a plain token, letters, digits, `-` and `_`, starting with neither. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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
  const { key, skills, mcp } = input
  // The key names this session's staging folder, which is later removed
  // recursively: only a plain token (the host mints UUIDs) may ever be one —
  // never a separator, a dot-segment or anything longer than a name.
  if (typeof key !== 'string' || !SAFE_KEY.test(key)) return null
  // Agent notes are not part of this contract: a host that sends them is not
  // one this bridge negotiated with, and they are never folded into a prompt.
  if (input['notes'] !== undefined && input['notes'] !== null) return null
  if (skills !== null && !Array.isArray(skills)) return null
  if (mcp !== null && !Array.isArray(mcp)) return null
  const decodedSkills = skills === null ? null : skills.map(decodeNamedDigest)
  if (decodedSkills && decodedSkills.some((one) => one === null)) return null
  const decodedMcp = mcp === null ? null : mcp.map(decodeMcpEntry)
  if (decodedMcp && decodedMcp.some((one) => one === null)) return null
  return {
    key,
    skills: decodedSkills as readonly { readonly name: string; readonly digest: string; readonly path: string }[] | null,
    mcp: decodedMcp as readonly { readonly name: string; readonly digest: string; readonly endpoint: string }[] | null,
  }
}

// ------------------------------------------------------------ staging

/**
 * The same bounds, and the same digest, the host's own bundle reader
 * (`packages/server/src/attachments/catalog.ts`: `readBundle`,
 * `bundleDigest`) uses — duplicated because this bridge has no HarnessDesk
 * dependency. Change one, change the other; both packages' tests pin the
 * digest of the same fixture bundle.
 */
const MAX_BUNDLE_ENTRIES = 128
const MAX_BUNDLE_DEPTH = 8
const MAX_FILE_BYTES = 256 * 1024
const MAX_BUNDLE_BYTES = 1024 * 1024
/** macOS's `O_NOFOLLOW_ANY`: no component of the path may be a link, not only its last. */
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0

export interface BundleFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** Sorted literal relative paths and length-prefixed bytes — the host's `bundleDigest`, byte for byte. */
export function bundleDigest(files: readonly BundleFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const path = Buffer.from(file.path, 'utf8')
    const pathLength = Buffer.alloc(4)
    pathLength.writeUInt32BE(path.length)
    const byteLength = Buffer.alloc(4)
    byteLength.writeUInt32BE(file.bytes.length)
    hash.update(pathLength)
    hash.update(path)
    hash.update(byteLength)
    hash.update(file.bytes)
  }
  return hash.digest('hex')
}

const isGitDir = (name: string): boolean => name.normalize('NFC').toLowerCase() === '.git'
const usableName = (name: string): boolean => name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)

/**
 * Reads one bundle whole or not at all, with the host reader's rules: no
 * link at any level (the root included), regular files and folders only,
 * `.git` skipped, and every bound checked before the bytes are kept. The
 * bytes returned are the only bytes this bridge ever writes into a plugin,
 * so the digest taken over them is the digest of what was staged.
 */
export function readApprovedBundle(root: string): { readonly ok: true; readonly files: readonly BundleFile[] } | { readonly ok: false; readonly reason: string } {
  if (!isAbsolute(root)) return { ok: false, reason: `${root} is not a folder the desk staged.` }
  let top
  try {
    top = lstatSync(root)
  } catch {
    return { ok: false, reason: `${root} is not there.` }
  }
  if (top.isSymbolicLink()) return { ok: false, reason: `${root} is a link, not part of an approved bundle.` }
  if (!top.isDirectory()) return { ok: false, reason: `${root} is not a folder.` }
  // Canonical ancestor once (macOS's own `/var` is a link), the bundle root
  // itself left unresolved: it was just checked not to be a link.
  let base: string
  try {
    base = join(realpathSync(dirname(root)), basename(root))
  } catch {
    return { ok: false, reason: `${root} could not be resolved.` }
  }
  const files: BundleFile[] = []
  let examined = 0
  let total = 0
  const walk = (dir: string, prefix: string, depth: number): string | null => {
    if (depth > MAX_BUNDLE_DEPTH) return `${prefix || '.'} is nested deeper than ${MAX_BUNDLE_DEPTH} levels.`
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return `${prefix || root} could not be read.`
    }
    for (const name of [...names].sort()) {
      examined += 1
      if (examined > MAX_BUNDLE_ENTRIES) return `this bundle has more than ${MAX_BUNDLE_ENTRIES} entries.`
      if (isGitDir(name)) continue
      if (!usableName(name)) return 'an entry in this bundle has an unusable name.'
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(dir, name)
      let info
      try {
        info = lstatSync(full)
      } catch {
        return `${path} disappeared while it was being staged.`
      }
      if (info.isSymbolicLink()) return `${path} is a link, not part of an approved bundle.`
      if (info.isDirectory()) {
        const problem = walk(full, path, depth + 1)
        if (problem) return problem
        continue
      }
      if (!info.isFile()) return `${path} is neither a file nor a folder.`
      if (info.size > MAX_FILE_BYTES) return `${path} is larger than ${MAX_FILE_BYTES / 1024} KiB.`
      total += info.size
      if (total > MAX_BUNDLE_BYTES) return `this bundle is larger than ${MAX_BUNDLE_BYTES / 1024} KiB in total.`
      let fd: number
      try {
        fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK | (NOFOLLOW_ANY || constants.O_NOFOLLOW))
      } catch {
        return `${path} was replaced, so nothing was staged.`
      }
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) return `${path} was replaced, so nothing was staged.`
        const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1)
        let filled = 0
        for (;;) {
          const read = readSync(fd, buffer, filled, buffer.length - filled, filled)
          if (read === 0) break
          filled += read
          if (filled > MAX_FILE_BYTES) return `${path} is larger than ${MAX_FILE_BYTES / 1024} KiB.`
        }
        files.push({ path, bytes: Uint8Array.prototype.slice.call(buffer, 0, filled) })
      } finally {
        closeSync(fd)
      }
    }
    return null
  }
  const problem = walk(base, '', 0)
  return problem ? { ok: false, reason: problem } : { ok: true, files }
}

export interface StagedAttachments {
  /** `null` when nothing staged at all — an empty or absent skill list never creates a plugin. */
  readonly pluginPath: string | null
  readonly qualifiedNames: readonly string[]
  /** `digest` is taken over the bytes actually written into the plugin — never repeated back from the input. */
  readonly staged: readonly { readonly name: string; readonly digest: string }[]
  readonly refused: readonly { readonly name: string; readonly reason: string }[]
}

/**
 * Rebuilds `root` from scratch as a single host-generated plugin containing
 * nothing but a minimal `.claude-plugin/plugin.json` (a name, nothing else —
 * no hooks, no commands, no `.mcp.json`: decision 9's "no repo-provided
 * manifest is carried") and one `skills/<name>/` per approved skill.
 *
 * Each skill is read once, bounded (`readApprovedBundle`), and hashed; the
 * bytes written are exactly the bytes hashed. A skill whose staged digest is
 * not the digest the host approved is refused and left out, never loaded
 * under the approved one — whatever changed it in between. The rest of the
 * batch still stages.
 */
export function stageSkills(input: AttachmentInput, root: string): StagedAttachments {
  rmSync(root, { recursive: true, force: true })
  if (!input.skills || input.skills.length === 0) return { pluginPath: null, qualifiedNames: [], staged: [], refused: [] }
  const pluginPath = join(root, 'plugin')
  const staged: { name: string; digest: string }[] = []
  const refused: { name: string; reason: string }[] = []
  const qualifiedNames: string[] = []
  for (const skill of input.skills) {
    const read = readApprovedBundle(skill.path)
    if (!read.ok) {
      refused.push({ name: skill.name, reason: read.reason })
      continue
    }
    const digest = bundleDigest(read.files)
    if (digest !== skill.digest) {
      refused.push({ name: skill.name, reason: 'The staged copy is not the content that was approved, so it was not loaded.' })
      continue
    }
    const target = join(pluginPath, 'skills', skill.name)
    for (const file of read.files) {
      mkdirSync(dirname(join(target, file.path)), { recursive: true, mode: 0o700 })
      writeFileSync(join(target, file.path), file.bytes, { mode: 0o600, flag: 'wx' })
    }
    staged.push({ name: skill.name, digest })
    qualifiedNames.push(`${PLUGIN_NAME}:${skill.name}`)
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
  return { options, staged }
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
  const loaded: { kind: 'skill' | 'mcp'; name: string; digest: string }[] = []
  const refused: { kind: 'skill' | 'mcp'; name: string; reason: string }[] = []

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

  return { key: input.key, loaded, refused }
}
