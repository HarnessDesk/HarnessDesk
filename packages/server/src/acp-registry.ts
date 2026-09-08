import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'

import type { AcpAgentConfig } from '@harnessdesk/adapter-acp'
import type { AcpRegistryAgentInfo, AcpRegistryCatalogInfo } from '@harnessdesk/protocol'

/**
 * The public ACP registry, read and acted on.
 *
 * The Agent Client Protocol publishes its own list of agents — one JSON
 * document naming every agent that speaks the protocol and how each one is
 * distributed. This module is HarnessDesk's reading of it: fetch the document
 * (through a disk cache, because the list belongs on screen even offline),
 * say which entries this machine can actually run, and turn a chosen entry
 * into the same runnable config a hand-written `agents.json` row becomes.
 *
 * Three distribution channels exist and each asks something different of the
 * machine: `npx` and `uvx` entries name a package their runner fetches on
 * first start, so they only need that runner on PATH; `binary` entries name
 * an archive per platform, which the host downloads, verifies and unpacks
 * into its own state directory when the agent is added. Registering still
 * writes one entry to `agents.json` — with the registry id and version noted
 * beside the command, so the row says where it came from.
 */

const run = promisify(execFile)

/** Where the document lives. See `custom_registry` in the ACP repository. */
export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

/** How long a fetched document is trusted before being re-asked for. */
const FRESH_MS = 6 * 60 * 60 * 1000

/**
 * One directory level, and nothing else: what a registry-written id or
 * version may name on disk. No separators, so it cannot walk anywhere, and
 * the leading letter rules out `.`, `..` and hidden names.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,128}$/

/* --- the document, structurally ------------------------------------------ */

interface RegistryPackageRun {
  readonly package: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

interface RegistryBinaryRun {
  readonly archive: string
  readonly cmd: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly sha256?: string
}

export interface RegistryAgent {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly repository?: string
  readonly website?: string
  readonly license?: string
  readonly distribution: {
    readonly npx?: RegistryPackageRun
    readonly uvx?: RegistryPackageRun
    readonly binary?: Readonly<Record<string, RegistryBinaryRun>>
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const packageRunOf = (value: unknown): RegistryPackageRun | undefined => {
  if (!isRecord(value) || typeof value['package'] !== 'string') return undefined
  return {
    package: value['package'],
    ...(isStringArray(value['args']) ? { args: value['args'] } : {}),
    ...(isEnv(value['env']) ? { env: value['env'] } : {}),
  }
}

const binaryRunOf = (value: unknown): RegistryBinaryRun | undefined => {
  if (!isRecord(value) || typeof value['archive'] !== 'string' || typeof value['cmd'] !== 'string')
    return undefined
  return {
    archive: value['archive'],
    cmd: value['cmd'],
    ...(isStringArray(value['args']) ? { args: value['args'] } : {}),
    ...(isEnv(value['env']) ? { env: value['env'] } : {}),
    ...(typeof value['sha256'] === 'string' ? { sha256: value['sha256'] } : {}),
  }
}

const isEnv = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

/**
 * One agent as the document declares it, or null when the entry is not one.
 * Forgiving on purpose: the document is someone else's file and a malformed
 * entry should cost that entry, never the list.
 */
const agentOf = (value: unknown): RegistryAgent | null => {
  if (!isRecord(value)) return null
  const { id, name, version } = value
  if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'string') return null
  const distribution = isRecord(value['distribution']) ? value['distribution'] : {}
  const binary = isRecord(distribution['binary'])
    ? Object.fromEntries(
        Object.entries(distribution['binary']).flatMap(([platform, entry]) => {
          const parsed = binaryRunOf(entry)
          return parsed ? [[platform, parsed] as const] : []
        }),
      )
    : undefined
  const npx = packageRunOf(distribution['npx'])
  const uvx = packageRunOf(distribution['uvx'])
  return {
    id,
    name,
    version,
    ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
    ...(typeof value['repository'] === 'string' ? { repository: value['repository'] } : {}),
    ...(typeof value['website'] === 'string' ? { website: value['website'] } : {}),
    ...(typeof value['license'] === 'string' ? { license: value['license'] } : {}),
    distribution: {
      ...(npx ? { npx } : {}),
      ...(uvx ? { uvx } : {}),
      ...(binary && Object.keys(binary).length > 0 ? { binary } : {}),
    },
  }
}

export const parseRegistryDocument = (value: unknown): readonly RegistryAgent[] => {
  if (!isRecord(value) || !Array.isArray(value['agents'])) return []
  return value['agents'].flatMap((entry) => {
    const agent = agentOf(entry)
    return agent ? [agent] : []
  })
}

/** The registry's name for this machine, e.g. `darwin-aarch64`. */
export const registryPlatform = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string => {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux'
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${os}-${cpu}`
}

/* --- what this machine can do with an entry ------------------------------- */

type Channel =
  | { readonly kind: 'npx'; readonly run: RegistryPackageRun }
  | { readonly kind: 'uvx'; readonly run: RegistryPackageRun }
  | { readonly kind: 'binary'; readonly run: RegistryBinaryRun }

/**
 * The channel this machine would use, or the reason there is none.
 *
 * Package runners are preferred over binaries — they pin the version without
 * the host managing an archive — and between them, whichever the entry
 * declares and the machine has. A binary needs a build for this platform and
 * nothing else; the download happens when the agent is added.
 */
const channelFor = (
  agent: RegistryAgent,
  machine: { readonly platform: string; readonly npx: boolean; readonly uvx: boolean },
): { channel: Channel } | { reason: string } => {
  const { npx, uvx, binary } = agent.distribution
  if (npx && machine.npx) return { channel: { kind: 'npx', run: npx } }
  if (uvx && machine.uvx) return { channel: { kind: 'uvx', run: uvx } }
  const build = binary?.[machine.platform]
  if (build) return { channel: { kind: 'binary', run: build } }
  if (npx) return { reason: 'Needs npx (Node.js), which is not on PATH.' }
  if (uvx) return { reason: 'Needs uvx (uv), which is not on PATH.' }
  if (binary) return { reason: `No build for this machine (${machine.platform}).` }
  return { reason: 'The registry entry does not say how to run it.' }
}

/** The channel an entry leads with, for the row's "how it runs" word. */
const declaredRun = (agent: RegistryAgent): AcpRegistryAgentInfo['run'] =>
  agent.distribution.npx ? 'npx' : agent.distribution.uvx ? 'uvx' : 'binary'

/* --- the client ----------------------------------------------------------- */

type Log = (message: string, details?: Record<string, unknown>) => void

export interface AcpRegistryOptions {
  /** Where the cache and downloaded binaries live — the host's state directory. */
  readonly stateDir: string
  readonly url?: string
  /** Fetches one JSON document. Injectable for tests; defaults to global fetch. */
  readonly fetchJson?: (url: string) => Promise<unknown>
  /** Downloads one file to a path. Injectable for tests; defaults to global fetch. */
  readonly download?: (url: string, to: string) => Promise<void>
  readonly which?: (command: string) => Promise<string | null>
  readonly platform?: string
  readonly freshMs?: number
  readonly warn?: Log
}

const fetchJsonWith = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

const downloadWith = async (url: string, to: string): Promise<void> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`)
  mkdirSync(dirname(to), { recursive: true })
  const tmp = `${to}.${process.pid}.tmp`
  // Streamed, not buffered: an agent build can be hundreds of megabytes.
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(tmp))
  renameSync(tmp, to)
}

const whichOnPath = async (command: string): Promise<string | null> => {
  try {
    const { stdout } = await run('/usr/bin/which', [command], { timeout: 5_000 })
    const found = stdout.trim().split('\n')[0]
    return found && found.length > 0 ? found : null
  } catch {
    return null
  }
}

interface CacheFile {
  readonly fetchedAt: number
  readonly url: string
  readonly document: unknown
}

export class AcpRegistry {
  readonly #url: string
  readonly #cachePath: string
  readonly #installDir: string
  readonly #fetchJson: (url: string) => Promise<unknown>
  readonly #download: (url: string, to: string) => Promise<void>
  readonly #which: (command: string) => Promise<string | null>
  readonly #platform: string
  readonly #freshMs: number
  readonly #warn: Log

  constructor(options: AcpRegistryOptions) {
    this.#url = options.url ?? ACP_REGISTRY_URL
    this.#cachePath = join(options.stateDir, 'acp-registry.json')
    this.#installDir = join(options.stateDir, 'acp-agents')
    this.#fetchJson = options.fetchJson ?? fetchJsonWith
    this.#download = options.download ?? downloadWith
    this.#which = options.which ?? whichOnPath
    this.#platform = options.platform ?? registryPlatform()
    this.#freshMs = options.freshMs ?? FRESH_MS
    this.#warn = options.warn ?? (() => {})
  }

  #readCache(): CacheFile | null {
    try {
      const parsed = JSON.parse(readFileSync(this.#cachePath, 'utf8')) as Partial<CacheFile>
      if (typeof parsed.fetchedAt !== 'number' || parsed.url !== this.#url) return null
      return { fetchedAt: parsed.fetchedAt, url: this.#url, document: parsed.document }
    } catch {
      return null
    }
  }

  #writeCache(entry: CacheFile): void {
    try {
      mkdirSync(dirname(this.#cachePath), { recursive: true })
      const tmp = `${this.#cachePath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(entry)}\n`, 'utf8')
      renameSync(tmp, this.#cachePath)
    } catch (error) {
      this.#warn('the ACP registry cache could not be written', { error: String(error) })
    }
  }

  /**
   * The document: the cache while it is fresh, the network when it is not,
   * and the stale cache again when the network says no — a list from last
   * week beats no list, and the row's job is to exist.
   */
  async #document(): Promise<{ agents: readonly RegistryAgent[]; fetchedAt: number | null; error?: string }> {
    const cached = this.#readCache()
    if (cached && Date.now() - cached.fetchedAt < this.#freshMs) {
      return { agents: parseRegistryDocument(cached.document), fetchedAt: cached.fetchedAt }
    }
    try {
      const document = await this.#fetchJson(this.#url)
      const fetchedAt = Date.now()
      this.#writeCache({ fetchedAt, url: this.#url, document })
      return { agents: parseRegistryDocument(document), fetchedAt }
    } catch (error) {
      this.#warn('the ACP registry could not be fetched', { url: this.#url, error: String(error) })
      if (cached) {
        return { agents: parseRegistryDocument(cached.document), fetchedAt: cached.fetchedAt }
      }
      return { agents: [], fetchedAt: null, error: String(error) }
    }
  }

  /** The registry as the interface shows it, judged against this machine. */
  async catalog(isRegistered: (id: string) => boolean): Promise<AcpRegistryCatalogInfo> {
    const { agents, fetchedAt, error } = await this.#document()
    if (agents.length === 0) {
      return {
        agents: [],
        fetchedAt,
        unavailable: error
          ? 'The ACP registry could not be reached. The list appears when it can be.'
          : 'The ACP registry answered with no agents.',
      }
    }
    const machine = {
      platform: this.#platform,
      npx: (await this.#which('npx')) !== null,
      uvx: (await this.#which('uvx')) !== null,
    }
    return {
      fetchedAt,
      agents: agents.map((agent): AcpRegistryAgentInfo => {
        const picked = channelFor(agent, machine)
        return {
          id: agent.id,
          name: agent.name,
          version: agent.version,
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.website ?? agent.repository
            ? { website: (agent.website ?? agent.repository)! }
            : {}),
          ...(agent.license ? { license: agent.license } : {}),
          run: 'channel' in picked ? picked.channel.kind : declaredRun(agent),
          available: 'channel' in picked,
          ...('reason' in picked ? { reason: picked.reason } : {}),
          registered: isRegistered(agent.id),
        }
      }),
    }
  }

  /** One entry as the document declares it, or null. No download, no side effect. */
  async describe(id: string): Promise<RegistryAgent | null> {
    const { agents } = await this.#document()
    return agents.find((candidate) => candidate.id === id) ?? null
  }

  /** The version the document currently names for an entry, or null. */
  async currentVersion(id: string): Promise<string | null> {
    return (await this.describe(id))?.version ?? null
  }

  /**
   * Deletes one unpacked version of one agent — what an update leaves
   * behind once the new build has answered a handshake. Confined the same
   * way the install is; a version that is not a plain directory name, or a
   * folder that is not there, is a no-op.
   */
  uninstallVersion(id: string, version: string): void {
    if (!SAFE_SEGMENT.test(id) || !SAFE_SEGMENT.test(version)) return
    const dir = join(this.#installDir, id, version)
    if (!dir.startsWith(this.#installDir + sep)) return
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * One entry, made runnable: the `agents.json` row to store and the config
   * it stands for. A package-runner entry resolves to its runner; a binary
   * entry is downloaded, verified against its digest when the registry gives
   * one, and unpacked under the state directory — so the stored command is an
   * absolute path that outlives the registry document that named it.
   */
  async resolve(id: string): Promise<{
    entry: Record<string, unknown> & { readonly id: string }
    config: AcpAgentConfig
  }> {
    const { agents } = await this.#document()
    const agent = agents.find((candidate) => candidate.id === id)
    if (!agent) {
      throw new Error(`The ACP registry has no agent with the id ${JSON.stringify(id)}.`)
    }
    const machine = {
      platform: this.#platform,
      npx: (await this.#which('npx')) !== null,
      uvx: (await this.#which('uvx')) !== null,
    }
    const picked = channelFor(agent, machine)
    if ('reason' in picked) {
      throw new Error(`${agent.name} cannot run on this machine. ${picked.reason}`)
    }
    const started = await this.#launchOf(agent, picked.channel)
    const entry = {
      id: agent.id,
      name: agent.name,
      ...(agent.description ? { tagline: agent.description } : {}),
      command: started.command,
      ...(started.args.length > 0 ? { args: started.args } : {}),
      ...(started.env ? { env: started.env } : {}),
      ...(started.cwd ? { cwd: started.cwd } : {}),
      // Where the row came from, for anyone reading the file — and for a
      // future update story, which needs to know the version it replaced.
      registry: { id: agent.id, version: agent.version },
    }
    return { entry, config: entry as AcpAgentConfig }
  }

  async #launchOf(
    agent: RegistryAgent,
    channel: Channel,
  ): Promise<{
    command: string
    args: readonly string[]
    env?: Readonly<Record<string, string>>
    cwd?: string
  }> {
    if (channel.kind === 'npx') {
      return {
        command: 'npx',
        // `-y` because the runner otherwise stops to ask on first fetch, and
        // there is no terminal here to answer it.
        args: ['-y', channel.run.package, ...(channel.run.args ?? [])],
        ...(channel.run.env ? { env: channel.run.env } : {}),
      }
    }
    if (channel.kind === 'uvx') {
      return {
        command: 'uvx',
        args: [channel.run.package, ...(channel.run.args ?? [])],
        ...(channel.run.env ? { env: channel.run.env } : {}),
      }
    }
    const command = await this.#installBinary(agent, channel.run)
    return {
      command,
      args: channel.run.args ?? [],
      ...(channel.run.env ? { env: channel.run.env } : {}),
      cwd: dirname(command),
    }
  }

  /**
   * The binary, on disk: `<state>/acp-agents/<id>/<version>/` holds one
   * unpacked archive, and the resolved `cmd` inside it is the command. A
   * version already unpacked is reused — adding the same agent twice must
   * not download twice.
   *
   * Everything path-shaped here — the id, the version, the command — is a
   * string the registry wrote, so nothing touches the disk until each is
   * confined: id and version must be plain directory names, and the command
   * must resolve inside its own install folder. The download is unpacked in
   * a staging folder beside the destination and accepted with one rename, so
   * a failed or refused install never leaves a half-trusted tree where the
   * next run would find and reuse it. (`tar` and `unzip` both refuse
   * absolute and `..` member names by default, which the staging folder
   * backstops rather than trusts.)
   */
  async #installBinary(agent: RegistryAgent, build: RegistryBinaryRun): Promise<string> {
    for (const [field, value] of [
      ['id', agent.id],
      ['version', agent.version],
    ] as const) {
      if (!SAFE_SEGMENT.test(value)) {
        throw new Error(
          `The registry entry's ${field} ${JSON.stringify(value)} is not a plain directory name — refused.`,
        )
      }
    }
    const dir = join(this.#installDir, agent.id, agent.version)
    // The registry writes Windows commands with backslashes; the path is
    // relative either way — and must stay inside the install folder.
    const relative = build.cmd.replaceAll('\\', '/').replace(/^\.\//, '')
    const cmd = resolve(dir, relative)
    if (!cmd.startsWith(dir + sep)) {
      throw new Error(
        `The registry entry's command ${JSON.stringify(build.cmd)} points outside its own folder — refused.`,
      )
    }
    if (existsSync(cmd)) return cmd
    const staging = join(this.#installDir, agent.id, `.staging-${agent.version}-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      const archive = join(staging, `archive-${basenameOf(build.archive)}`)
      await this.#download(build.archive, archive)
      if (build.sha256) {
        const hash = createHash('sha256')
        await pipeline(createReadStream(archive), hash)
        const digest = hash.digest('hex')
        if (digest !== build.sha256.toLowerCase()) {
          throw new Error(
            `The ${agent.name} download does not match the registry's digest — refused. Expected ${build.sha256}, got ${digest}.`,
          )
        }
      }
      await this.#extract(archive, staging)
      const staged = join(staging, relative)
      if (!existsSync(staged)) {
        throw new Error(`The ${agent.name} archive unpacked, but ${build.cmd} was not inside it.`)
      }
      // The archive has served its purpose; some of these are hundreds of
      // megabytes, and leaving one beside its unpacked twin doubles the bill.
      rmSync(archive, { force: true })
      if (process.platform !== 'win32') chmodSync(staged, 0o755)
      // A folder that exists here is a previous install the reuse check
      // above did not accept — a broken unpack; the fresh one replaces it.
      rmSync(dir, { recursive: true, force: true })
      renameSync(staging, dir)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    return cmd
  }

  /**
   * Deletes what `#installBinary` downloaded for one agent — every version,
   * because they were all fetched on this agent's behalf. Called when the
   * agent is unregistered; an id the registry never named a folder for is a
   * no-op, and an id that is not a plain directory name is refused the same
   * way the install refused it.
   */
  uninstall(id: string): void {
    if (!SAFE_SEGMENT.test(id)) return
    const dir = join(this.#installDir, id)
    if (!dir.startsWith(this.#installDir + sep)) return
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * Unpacking without a dependency: `tar` first, which on macOS and Windows
   * is bsdtar and reads zips too; `unzip` as the fallback for a zip on the
   * one platform whose tar does not.
   */
  async #extract(archive: string, dir: string): Promise<void> {
    try {
      await run('tar', ['-xf', archive, '-C', dir], { timeout: 5 * 60_000 })
    } catch (error) {
      if (!archive.toLowerCase().includes('.zip')) throw error
      await run('unzip', ['-o', archive, '-d', dir], { timeout: 5 * 60_000 })
    }
  }
}

/** The archive's on-disk name: the URL's last segment, reduced to plain filename characters. */
const basenameOf = (url: string): string => {
  const clean = url.split(/[?#]/, 1)[0] ?? url
  const name = clean.slice(clean.lastIndexOf('/') + 1).replace(/[^A-Za-z0-9._-]/g, '-')
  return name.replace(/^\.+/, '') || 'download'
}
