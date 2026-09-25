import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

import {
  canonicalMcp,
  digestOf,
  dialectFor,
  decodeMcpEntry,
  isSafePathSegment,
  readLibrary,
  type InventoryAgent,
  type McpServerSpec,
} from '@harnessdesk/agent-inventory'
import {
  shortPath,
  type AgentEntry,
  type AgentOrigin,
  type AttachmentDeclaration,
  type AttachmentIdentity,
  type AttachmentKind,
  type CeilingLevel,
} from '@harnessdesk/protocol'

import { PROJECT_AGENT_DIR, resolveWithin } from '../agents.js'

/**
 * Turns an Agent's `skills:`/`mcp:` declarations into bounded, reviewable
 * bytes — never a command, a path or a running process.
 *
 * Reading a cloned repository must start nothing: no child process, no
 * socket, no script. Everything below either reads bytes with a bounded,
 * no-follow walk, or answers "no" with a reason a person can read. The one
 * thing this module is not allowed to do, anywhere, is decide that a
 * declared name is trusted — that is `trust.ts`'s job, and only a person's
 * own answer to `AttachmentTrust.preview` ever grants it.
 */

// ————————————————————————————————————————— bounded, catalogue-only names

/**
 * A catalogue name: lower-case ASCII, 1–128 characters, from the grammar a
 * command, a URL or a path can never satisfy — `/`, `\`, `:` outside a single
 * separator role, and whitespace are all outside it, so `../etc/passwd`,
 * `https://x` and `rm -rf /` are refused on the same line as a name that is
 * merely too long. `agent-def.ts` uses this to bound `skills:` and `mcp:`
 * alike; this is that "exact bounded-name parser", proven in
 * `attachments-catalog.test.ts` against flooding, duplicate, path and
 * shell-text input, not merely against the examples above.
 */
export function parseNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Choose at most 64 names.')
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(item)) {
      throw new Error('Use a catalogue name, not a path or command.')
    }
    if (names.includes(item)) throw new Error('Each name may appear once.')
    names.push(item)
  }
  return names
}

// ————————————————————————————————————————— reading one bundle, bounded and no-follow

const MAX_BUNDLE_ENTRIES = 128
const MAX_BUNDLE_DEPTH = 8
const MAX_FILE_BYTES = 256 * 1024
const MAX_BUNDLE_BYTES = 1024 * 1024

/**
 * macOS's `O_NOFOLLOW_ANY`, the same choice `agent-files.ts` makes and for
 * the same reason: plain `O_NOFOLLOW` refuses a link only at a path's last
 * component, and an ancestor swapped for one after this walk classified it
 * would be followed like any other lookup. Elsewhere than macOS this reads
 * `0`; the per-file `O_NOFOLLOW` below and the identity re-check still hold
 * there, and this desk ships and runs its CI on macOS only.
 */
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0
const openNoFollow = (path: string, flags: number) => open(path, flags | (NOFOLLOW_ANY || constants.O_NOFOLLOW))

const GIT_DIR_FOLDED = '.git'
const foldedSegment = (segment: string): string => segment.normalize('NFC').toLowerCase()
const isGitDir = (name: string): boolean => foldedSegment(name) === GIT_DIR_FOLDED

interface Identity {
  readonly dev: number
  readonly ino: number
}
const identityOf = (info: { readonly dev: number; readonly ino: number }): Identity => ({ dev: info.dev, ino: info.ino })
const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino

export interface BundleFile {
  readonly path: string
  readonly bytes: Uint8Array
}

export type BundleRead = { readonly ok: true; readonly files: readonly BundleFile[] } | { readonly ok: false; readonly reason: string }

/**
 * Reads one bundle whole or not at all: any link at any level, any file
 * outside the byte/entry/depth bounds, or any non-regular entry refuses the
 * *entire* bundle rather than the one offending path — a partially loaded
 * bundle is a different, unreviewed set of instructions from the one a
 * person would see the size of. Directories count against the entry bound
 * too, so a flood of empty folders costs the same as a flood of files.
 *
 * `root` itself is checked before anything under it is: a caller that
 * already confirmed `root` is a real directory (the project-confinement walk
 * for an Agent-local bundle) still races a swap between that check and this
 * one, and a Library copy's path is never confirmed by anyone else first.
 */
export async function readBundle(root: string): Promise<BundleRead> {
  const files: BundleFile[] = []
  let totalBytes = 0
  let examined = 0

  const top = await lstat(root).catch(() => null)
  if (!top) return { ok: false, reason: `${root} is not there.` }
  if (top.isSymbolicLink()) return { ok: false, reason: `${root} is a link, so this bundle was not read.` }
  if (!top.isDirectory()) return { ok: false, reason: `${root} is not a folder.` }

  const walk = async (dir: string, prefix: string, depth: number, expected: Identity): Promise<string | null> => {
    if (depth > MAX_BUNDLE_DEPTH) return `${prefix || '.'} is nested deeper than ${MAX_BUNDLE_DEPTH} levels.`
    const before = await lstat(dir).catch(() => null)
    if (!before || !before.isDirectory() || !sameIdentity(expected, identityOf(before))) {
      return `${prefix || root} was replaced while this bundle was being read.`
    }
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      return `${prefix || root} could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
    const after = await lstat(dir).catch(() => null)
    if (!after || !after.isDirectory() || !sameIdentity(expected, identityOf(after))) {
      return `${prefix || root} was replaced while this bundle was being read.`
    }
    for (const name of [...names].sort()) {
      examined += 1
      if (examined > MAX_BUNDLE_ENTRIES) return `this bundle has more than ${MAX_BUNDLE_ENTRIES} entries.`
      if (isGitDir(name)) continue
      if (!isSafePathSegment(name)) return `an entry in this bundle has an unusable name.`
      const path = prefix ? `${prefix}/${name}` : name
      const full = join(dir, name)
      const info = await lstat(full).catch(() => null)
      if (!info) continue
      if (info.isSymbolicLink()) return `${path} is a link, so this bundle was not read.`
      if (info.isDirectory()) {
        const problem = await walk(full, path, depth + 1, identityOf(info))
        if (problem) return problem
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES) return `${path} is larger than ${MAX_FILE_BYTES / 1024} KiB.`
        totalBytes += info.size
        if (totalBytes > MAX_BUNDLE_BYTES) return `this bundle is larger than ${MAX_BUNDLE_BYTES / 1024} KiB in total.`
        let handle
        try {
          handle = await openNoFollow(full, constants.O_RDONLY | constants.O_NONBLOCK)
        } catch (error) {
          return `${path} was replaced, so nothing was read.`
        }
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || !sameIdentity(identityOf(info), identityOf(opened))) {
            return `${path} was replaced, so nothing was read.`
          }
          const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1)
          let filled = 0
          for (;;) {
            const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
            if (bytesRead === 0) break
            filled += bytesRead
            if (filled > MAX_FILE_BYTES) return `${path} is larger than ${MAX_FILE_BYTES / 1024} KiB.`
          }
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, filled))
          } catch {
            return `${path} is not valid UTF-8 text; a binary payload cannot be loaded this release.`
          }
          files.push({ path, bytes: buffer.subarray(0, filled) })
        } finally {
          await handle.close()
        }
      } else {
        return `${path} is not a regular file, so this bundle was not read.`
      }
    }
    return null
  }

  const problem = await walk(root, '', 0, identityOf(top))
  if (problem) return { ok: false, reason: problem }
  return { ok: true, files }
}

/**
 * The whole bundle's identity: sorted literal relative paths and
 * length-prefixed bytes, so a comment edited in a script — or the script
 * itself — changes the digest even though `SKILL.md` never moved, and the
 * order `readdir` happens to return never does. Full SHA-256, not the
 * library's cosmetic 16-hex `digestOf`: this digest gates a person's trust
 * decision, not a display column.
 */
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

/**
 * An MCP server's one identity: full SHA-256 over `canonicalMcp(spec)` — the
 * exact command, arguments, environment, URL and headers that would run,
 * however a dialect happened to spell them. The Library's own 16-hex
 * `digestOf` is a display/comparison digest and gates nothing; this is the
 * value a person's approval, a Seat's staging, a runtime's receipt and the
 * gateway's admission all compare against.
 */
export const mcpIdentityDigest = (spec: McpServerSpec): string => createHash('sha256').update(canonicalMcp(spec)).digest('hex')

// ————————————————————————————————————————— resolving one Agent's declarations

export interface AttachmentSubject {
  readonly project: string
  readonly incarnation: string
  readonly agent: string
  readonly origin: AgentOrigin
  readonly agentDigest: string
  readonly runtime: string
  readonly build: string
  readonly ceiling: CeilingLevel
}

export interface ResolvedAttachment {
  readonly identity: AttachmentIdentity
  readonly files: readonly BundleFile[]
  readonly server: McpServerSpec | null
}

/** One name, resolved or not — the pair every review and every Agent page needs. */
export interface AttachmentResolution {
  readonly declarations: readonly AttachmentDeclaration[]
  readonly resolved: readonly ResolvedAttachment[]
}

/** The Agent's own folder — never re-derived through a link once this returns. */
const agentFolder = async (entry: AgentEntry, root: string): Promise<{ readonly path: string } | { readonly problem: string }> => {
  const direct = dirname(entry.path)
  if (entry.origin !== 'project') {
    try {
      return { path: await realpath(direct) }
    } catch {
      return { problem: `${direct} is not there.` }
    }
  }
  let projectRoot: string
  try {
    projectRoot = await realpath(root)
  } catch {
    return { problem: `${root} is not there.` }
  }
  const reached = await resolveWithin(projectRoot, projectRoot, [...PROJECT_AGENT_DIR.split(sep), entry.id])
  if (reached.to !== 'inside') {
    return { problem: `${entry.id} no longer resolves inside the project, so its attachments were not read.` }
  }
  return { path: reached.path }
}

/** An Agent-local `skills/<name>` bundle, read only if it is a plain directory rooted right there. */
const localSkillBundle = async (folder: string, name: string): Promise<BundleRead | null> => {
  const skillsDir = join(folder, 'skills')
  const skillsInfo = await lstat(skillsDir).catch(() => null)
  if (!skillsInfo) return null
  if (!skillsInfo.isDirectory()) return { ok: false, reason: `${skillsDir} is not a folder.` }
  const bundleDir = join(skillsDir, name)
  const bundleInfo = await lstat(bundleDir).catch(() => null)
  if (!bundleInfo) return null
  return readBundle(bundleDir)
}

/** A machine-wide Library copy for one catalogue name, revalidated independently of the scanner's own read. */
const libraryCopy = async (
  kind: AttachmentKind & ('skill' | 'mcp'),
  name: string,
  root: string,
  runtimes: readonly InventoryAgent[],
  home: string,
): Promise<{ readonly path: string; readonly digest: string } | { readonly problem: string }> => {
  const library = await readLibrary(runtimes, { cwd: root, home })
  const entry = library.entries.find((one) => one.kind === kind && one.name === name)
  if (!entry || entry.copies.length === 0) {
    return { problem: `“${name}” is not in your Library — install it for an agent this runs as, or add it to this Agent's own folder.` }
  }
  const usable = entry.copies.filter((copy) => !copy.hollow && copy.digest !== null)
  if (usable.length === 0) {
    return { problem: `“${name}” is a folder in your Library with no definition in it.` }
  }
  const digests = new Set(usable.map((copy) => copy.digest))
  if (digests.size > 1) {
    return {
      problem: `“${name}” has ${usable.length} differing copies in your Library — choose one in the Library page before it can load.`,
    }
  }
  const copy = usable[0]!
  // The scanner's own path is built from `~` or `cwd` expansion alone, never
  // realpath'd: on a machine where a legitimate ancestor is itself a link
  // (macOS's own `/var` -> `/private/var`, most of all — the temp root every
  // test in this file runs under), `readBundle`'s `NOFOLLOW_ANY` open would
  // refuse a perfectly real bundle with ELOOP, having nothing to do with a
  // swap. Canonicalize the ancestor once, here — exactly the way
  // `agentFolder` already does for an Agent-local bundle — and leave the
  // bundle's own final path component unresolved, so `readBundle`'s own
  // top-level check still refuses a Library copy that is itself a link.
  const canonicalAncestor = await realpath(dirname(copy.path)).catch(() => dirname(copy.path))
  return { path: join(canonicalAncestor, basename(copy.path)), digest: copy.digest! }
}

/** The most a Library server's configuration file may hold before it is not read at all: `~/.claude.json` carries history too. */
const MAX_MCP_CONFIG_BYTES = 8 * 1024 * 1024

/**
 * One read of a Library copy's own configuration file, decoded into the spec
 * that would actually run. The per-brand file format and table key live in
 * `agent-inventory`'s internal location table, which this package does not
 * export; format is inferred from the extension (`.toml` is Codex's,
 * everything measured elsewhere is JSON) and both key spellings measured
 * across agents (`mcpServers`, `mcp_servers`) are tried.
 *
 * The identity (`mcpIdentityDigest`) is taken over the spec decoded from
 * *this* read and nothing else, and the spec returned is that same one: the
 * digest a person approves and the command the gateway later runs can never
 * come from two different reads of a file that changed in between. The
 * scanner's own 16-hex digest for the copy is checked against this read, so
 * a file that changed between the Library scan and this read is refused
 * rather than silently resolved to the newer server.
 */
const readLibraryServer = async (
  path: string,
  name: string,
  runtimes: readonly InventoryAgent[],
  scanned: string,
): Promise<{ readonly spec: McpServerSpec; readonly digest: string } | { readonly problem: string }> => {
  const format: 'json' | 'toml' = path.endsWith('.toml') ? 'toml' : 'json'
  let text: string
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) return { problem: `${shortPath(path, homedir())} is not a regular file.` }
      if (info.size > MAX_MCP_CONFIG_BYTES) return { problem: `${shortPath(path, homedir())} is larger than ${MAX_MCP_CONFIG_BYTES / 1024 / 1024} MiB.` }
      const buffer = Buffer.allocUnsafe(MAX_MCP_CONFIG_BYTES + 1)
      let filled = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
        if (filled > MAX_MCP_CONFIG_BYTES) return { problem: `${shortPath(path, homedir())} is larger than ${MAX_MCP_CONFIG_BYTES / 1024 / 1024} MiB.` }
      }
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, filled))
    } finally {
      await handle.close()
    }
  } catch {
    return { problem: `“${name}”’s configuration could not be read.` }
  }
  for (const brand of new Set(runtimes.map((one) => one.brand))) {
    const dialect = dialectFor(brand)
    if (!dialect) continue
    for (const key of ['mcpServers', 'mcp_servers']) {
      const spec = decodeMcpEntry(text, format, key, name, dialect)
      if (!spec) continue
      if (digestOf(canonicalMcp(spec)) !== scanned) {
        return { problem: `“${name}” changed while it was being read; open this page again to review what is there now.` }
      }
      return { spec, digest: mcpIdentityDigest(spec) }
    }
  }
  return { problem: `“${name}” cannot be read as a server this desk can show you, so there is nothing exact to approve.` }
}

/**
 * Resolves every `skills:`/`mcp:` name an Agent declares into an identity a
 * person can review, or a reason it could not be. Starts no process, no
 * network request and no script: an Agent-local bundle is read with
 * `readBundle` alone, and a Library name is only ever revalidated, never
 * trusted from the scanner's own metadata-following read.
 *
 * `home` defaults to this process's own home directory — every real caller
 * omits it — and exists as a parameter so a test can point the Library's
 * unconditional `~/.agents/skills` scan at a fixture instead of the machine
 * this happens to run on.
 */
export async function resolveAttachmentDeclarations(
  entry: AgentEntry,
  root: string,
  runtimes: readonly InventoryAgent[] = [],
  home: string = homedir(),
): Promise<AttachmentResolution> {
  const label = (path: string): string => shortPath(path, home)
  const definition = entry.definition
  const wanted: { readonly kind: 'skill' | 'mcp'; readonly name: string }[] = definition
    ? [
        ...definition.skills.map((name) => ({ kind: 'skill' as const, name })),
        ...definition.mcp.map((name) => ({ kind: 'mcp' as const, name })),
      ]
    : []
  if (wanted.length === 0) return { declarations: [], resolved: [] }

  const folder = await agentFolder(entry, root)
  const folderPath: string | null = 'path' in folder ? folder.path : null
  const declarations: AttachmentDeclaration[] = []
  const resolved: ResolvedAttachment[] = []

  for (const { kind, name } of wanted) {
    if (kind === 'skill') {
      if (folderPath === null) {
        declarations.push({ kind, name, identity: null, problem: (folder as { readonly problem: string }).problem })
        continue
      }
      const local = await localSkillBundle(folderPath, name)
      if (local) {
        if (!local.ok) {
          declarations.push({ kind, name, identity: null, problem: local.reason })
          continue
        }
        const digest = bundleDigest(local.files)
        const identity: AttachmentIdentity = {
          kind,
          name,
          digest,
          source: 'agent',
          pathLabel: label(join(folderPath, 'skills', name)),
        }
        declarations.push({ kind, name, identity, problem: null })
        resolved.push({ identity, files: local.files, server: null })
        continue
      }
      const found = await libraryCopy('skill', name, root, runtimes, home)
      if ('problem' in found) {
        declarations.push({ kind, name, identity: null, problem: found.problem })
        continue
      }
      const bundle = await readBundle(found.path)
      if (!bundle.ok) {
        declarations.push({ kind, name, identity: null, problem: bundle.reason })
        continue
      }
      const digest = bundleDigest(bundle.files)
      const identity: AttachmentIdentity = { kind, name, digest, source: 'library', pathLabel: label(found.path) }
      declarations.push({ kind, name, identity, problem: null })
      resolved.push({ identity, files: bundle.files, server: null })
      continue
    }

    // mcp: never Agent-local — always an existing Library server, by decision 8.
    const found = await libraryCopy('mcp', name, root, runtimes, home)
    if ('problem' in found) {
      declarations.push({ kind, name, identity: null, problem: found.problem })
      continue
    }
    const server = await readLibraryServer(found.path, name, runtimes, found.digest)
    if ('problem' in server) {
      declarations.push({ kind, name, identity: null, problem: server.problem })
      continue
    }
    const identity: AttachmentIdentity = { kind, name, digest: server.digest, source: 'library', pathLabel: label(found.path) }
    declarations.push({ kind, name, identity, problem: null })
    resolved.push({ identity, files: [], server: server.spec })
  }

  return { declarations, resolved }
}

/** The names that actually resolved to a loadable identity. See `resolveAttachmentDeclarations` for why one did not. */
export async function resolveAttachments(
  entry: AgentEntry,
  root: string,
  runtimes: readonly InventoryAgent[] = [],
  home: string = homedir(),
): Promise<readonly ResolvedAttachment[]> {
  return (await resolveAttachmentDeclarations(entry, root, runtimes, home)).resolved
}
