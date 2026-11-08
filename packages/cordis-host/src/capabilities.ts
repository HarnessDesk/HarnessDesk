import { execFile } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Service, type Context } from '@deepseek-ai/cordis'

import type { HostRuntime, RegisteredPlugin } from './runtime.js'
import { PermissionGate } from './permissions.js'
import { currentShellWorkspace } from './shell-workspace.js'

/**
 * Capability-scoped access to the outside world.
 *
 * A plugin never receives raw `fs` or `fetch`. It receives these, which consult
 * the permission gate on every call. That is the difference between a plugin
 * system and an arbitrary-code-execution system: the manifest is the boundary,
 * and it is checked at the point of use rather than at install time.
 */

const tracker = (name: string) => ({ associate: name, property: 'ctx' })

/** Resolves relative paths against the workspace, so a plugin cannot escape by default. */
const resolveInWorkspace = (runtime: HostRuntime, path: string): string => {
  if (isAbsolute(path)) return resolve(path)
  const root = runtime.workspace.root
  return root ? resolve(root, path) : resolve(path)
}

/**
 * Where a plugin's own reach is served from, when not from this process.
 *
 * A plugin host process runs one plugin under the Node permission model, with
 * no disk, network or programs of its own: its `ctx.fs`, `ctx.http`,
 * `ctx.shell` and `ctx.android` forward every call here, and the parent runs
 * it against the grants the person agreed to (docs/plugin-isolation.md). In
 * the host itself nothing is installed and the services below do the work.
 */
export type CapabilityRequest =
  | { readonly kind: 'fs'; readonly method: 'read' | 'list' | 'exists'; readonly path?: string }
  | { readonly kind: 'fs'; readonly method: 'write'; readonly path: string; readonly content: string }
  | { readonly kind: 'http'; readonly url: string; readonly init?: HttpRequestInit }
  | { readonly kind: 'shell'; readonly command: string; readonly args?: readonly string[]; readonly options?: ShellOptions }
  | { readonly kind: 'android'; readonly method: string; readonly args: readonly unknown[] }

export interface CapabilityBroker {
  call(request: CapabilityRequest): Promise<unknown>
}

let broker: CapabilityBroker | null = null

export const setCapabilityBroker = (next: CapabilityBroker | null): void => {
  broker = next
}

export const capabilityBroker = (): CapabilityBroker | null => broker

// The operations themselves, which the services run in the host, and the
// parent runs for a plugin's process with that plugin's own grants.

export const fsRead = async (runtime: HostRuntime, owner: RegisteredPlugin, path: string): Promise<string> => {
  const target = resolveInWorkspace(runtime, path)
  owner.gate.assertWorkspaceRead(target)
  return readFile(target, 'utf8')
}

export const fsWrite = async (runtime: HostRuntime, owner: RegisteredPlugin, path: string, content: string): Promise<void> => {
  const target = resolveInWorkspace(runtime, path)
  owner.gate.assertWorkspaceWrite(target)
  await writeFile(target, content)
}

export const fsList = async (runtime: HostRuntime, owner: RegisteredPlugin, path = '.'): Promise<{ name: string; directory: boolean }[]> => {
  const target = resolveInWorkspace(runtime, path)
  owner.gate.assertWorkspaceRead(target)
  const entries = await readdir(target, { withFileTypes: true })
  return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
}

export const fsExists = async (runtime: HostRuntime, owner: RegisteredPlugin, path: string): Promise<boolean> => {
  const target = resolveInWorkspace(runtime, path)
  owner.gate.assertWorkspaceRead(target)
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

export class FsService extends Service {
  static [Service.tracker] = tracker('fs')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'fs')
  }

  async read(path: string): Promise<string> {
    if (broker) return await broker.call({ kind: 'fs', method: 'read', path }) as string
    return fsRead(this.runtime, this.runtime.owner(this.ctx), path)
  }

  async write(path: string, content: string): Promise<void> {
    if (broker) return void await broker.call({ kind: 'fs', method: 'write', path, content })
    return fsWrite(this.runtime, this.runtime.owner(this.ctx), path, content)
  }

  async list(path = '.'): Promise<{ name: string; directory: boolean }[]> {
    if (broker) return await broker.call({ kind: 'fs', method: 'list', path }) as { name: string; directory: boolean }[]
    return fsList(this.runtime, this.runtime.owner(this.ctx), path)
  }

  async exists(path: string): Promise<boolean> {
    if (broker) return await broker.call({ kind: 'fs', method: 'exists', path }) as boolean
    return fsExists(this.runtime, this.runtime.owner(this.ctx), path)
  }
}

export interface HttpRequestInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs?: number
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Fetches a URL the plugin's manifest allows.
 *
 * Timeouts are mandatory rather than optional: a plugin awaiting a hung
 * request inside a tool call would stall the agent's turn. `stopped` ends it
 * sooner: the parent passes its plugin process's lifetime, so a request does
 * not go on after the plugin that made it has gone.
 */
export const httpFetch = async (owner: RegisteredPlugin, url: string, init: HttpRequestInit = {}, stopped?: AbortSignal): Promise<HttpResponse> => {
  owner.gate.assertNetwork(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: stopped ? AbortSignal.any([controller.signal, stopped]) : controller.signal,
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return { status: response.status, headers, body: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

export class HttpService extends Service {
  static [Service.tracker] = tracker('http')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'http')
  }

  async fetch(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    if (broker) return await broker.call({ kind: 'http', url, init }) as HttpResponse
    return httpFetch(this.runtime.owner(this.ctx), url, init)
  }

  async json<T = unknown>(url: string, init?: HttpRequestInit): Promise<T> {
    const response = await this.fetch(url, init)
    return JSON.parse(response.body) as T
  }
}

const run = promisify(execFile)

/** How much a command may write before `execFile` cuts it off. */
const MAX_OUTPUT = 16 * 1024 * 1024

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
  /**
   * The command's own exit code, or -1 when it has none: stopped at its
   * timeout (whatever it exited with after), cut off past the 16 MB output
   * limit, killed by a signal, or never started. `stderr` then ends with a
   * line saying which, and naming the command (#161, review of #239, round 1).
   */
  readonly exitCode: number
}

export interface ShellOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
}

/**
 * Where a program runs from when the parent runs it for a plugin's process:
 * that process's own environment, never the host's, and a signal that stops
 * it when the process goes. The same signal ends the requests and device
 * commands the parent makes for that process.
 */
export interface ShellHost {
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

/** Runs a program for a plugin that declares `shell`. */
export const shellRun = async (
  runtime: HostRuntime,
  owner: RegisteredPlugin,
  command: string,
  args: readonly string[] = [],
  options: ShellOptions = {},
  host: ShellHost = {},
): Promise<ShellResult> => {
  owner.gate.assertShell(`${command} ${args.join(' ')}`)

  // A lane may live outside the project's checkout. Its host-supplied root
  // is both the default and the boundary; an explicit cwd cannot widen it.
  const root = currentShellWorkspace() ?? runtime.workspace.root
  const cwd = options.cwd ? resolve(root ?? '.', options.cwd) : root
  if (cwd) new PermissionGate(owner.permissions, () => root, () => runtime.inOtherCheckout).assertWorkspaceRead(cwd)

  const timeoutMs = options.timeoutMs ?? 30_000
  /* The command as a sentence about it names it: its name, and its first
     argument when that is a word, a subcommand like `git push`. Never an
     argument that could carry a value, a path or a URL or a number. A
     timed-out `gh pr create` said only "stopped after 60 s" (review of #239,
     round 1). */
  const subcommand = args[0] !== undefined && /^[a-z][a-z-]*$/i.test(args[0]) ? args[0] : null
  const named = subcommand ? `${command} ${subcommand}` : command
  /* Anything that is no exit of the command's own came back as exit 1 with
     nothing said, which to ripgrep and grep means "nothing found", so a
     search that ran out of time or room read as an empty answer (#161). It
     is -1 now, with a line of its own saying why. */
  const without = (stdout: string, stderr: string, why: string): ShellResult => ({
    stdout,
    stderr: [stderr.trimEnd(), why].filter((part) => part !== '').join('\n'),
    exitCode: -1,
  })
  // Gateway credential configuration is never inherited by a plugin shell.
  const env = Object.fromEntries(Object.entries(host.env ?? process.env).filter(([key]) => !/^(?:GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG.*|GIT_CREDENTIAL.*)$/i.test(key)))
  const pending = run(command, [...args], {
    env,
    ...(cwd ? { cwd } : {}),
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    ...(host.signal ? { signal: host.signal } : {}),
  })
  const stopped = `${named} stopped after ${timeoutMs / 1000} s`
  try {
    const result = await pending
    /* Stopped at its deadline, whatever it exited with: a child that traps
       SIGTERM exits with its own code, 0 included, and read as that code a
       command cut off at its timeout was an ordinary answer (review of
       #239, round 1). */
    if (pending.child.killed) return without(result.stdout.toString(), result.stderr.toString(), stopped)
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 }
  } catch (error) {
    const failure = error as {
      stdout?: string
      stderr?: string
      code?: number | string | null
      killed?: boolean
      signal?: string | null
    }
    const stdout = failure.stdout?.toString() ?? ''
    const stderr = failure.stderr?.toString() ?? ''
    /* In this order. Past the output limit, Node kills the child itself, so
       `child.killed` is true there as well as at the deadline; the error's
       own code is what tells them apart. */
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return without(stdout, stderr, `${named}'s output passed ${MAX_OUTPUT / (1024 * 1024)} MB and was cut there`)
    }
    if (failure.killed || pending.child.killed) return without(stdout, stderr, stopped)
    // A non-zero exit is information, not an exception: plugins routinely
    // run commands that legitimately fail.
    if (typeof failure.code === 'number') return { stdout, stderr, exitCode: failure.code }
    /* Said in a line of its own, not with Node's message, which repeats the
       command line and its stderr: an OOM-killed search answered with the
       whole ripgrep command line over its stderr twice (review of #239,
       round 1). */
    if (failure.signal) return without(stdout, stderr, `${named} was killed by ${failure.signal}`)
    return without(stdout, stderr, `${named} could not be run${typeof failure.code === 'string' ? ` (${failure.code})` : ''}`)
  }
}

/**
 * Running a program, for plugins that declare `shell`.
 *
 * `execFile`, never `exec`: arguments are passed as an array and no shell
 * interprets them, so a plugin that builds a command from model output cannot
 * be turned into an injection. The working directory is the open workspace.
 */
export class ShellService extends Service {
  static [Service.tracker] = tracker('shell')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'shell')
  }

  async run(
    command: string,
    args: readonly string[] = [],
    options: ShellOptions = {},
  ): Promise<ShellResult> {
    if (broker) return await broker.call({ kind: 'shell', command, args: [...args], options }) as ShellResult
    return shellRun(this.runtime, this.runtime.owner(this.ctx), command, args, options)
  }
}

export class WorkspaceService extends Service {
  static [Service.tracker] = tracker('workspace')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'workspace')
  }

  get root(): string | null {
    // Reading which folder is open is not privileged; reading its contents is.
    return this.runtime.workspace.root
  }

  get branch(): string | null {
    return this.runtime.workspace.branch
  }
}
