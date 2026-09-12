import { execFile } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

import { Service, type Context } from '@deepseek-ai/cordis'

import type { HostRuntime } from './runtime.js'

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

export class FsService extends Service {
  static [Service.tracker] = tracker('fs')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'fs')
  }

  async read(path: string): Promise<string> {
    const target = resolveInWorkspace(this.runtime, path)
    this.runtime.owner(this.ctx).gate.assertWorkspaceRead(target)
    return readFile(target, 'utf8')
  }

  async write(path: string, content: string): Promise<void> {
    const target = resolveInWorkspace(this.runtime, path)
    this.runtime.owner(this.ctx).gate.assertWorkspaceWrite(target)
    await writeFile(target, content)
  }

  async list(path = '.'): Promise<{ name: string; directory: boolean }[]> {
    const target = resolveInWorkspace(this.runtime, path)
    this.runtime.owner(this.ctx).gate.assertWorkspaceRead(target)
    const entries = await readdir(target, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
  }

  async exists(path: string): Promise<boolean> {
    const target = resolveInWorkspace(this.runtime, path)
    this.runtime.owner(this.ctx).gate.assertWorkspaceRead(target)
    try {
      await stat(target)
      return true
    } catch {
      return false
    }
  }
}

export interface HttpRequestInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs?: number
}

export class HttpService extends Service {
  static [Service.tracker] = tracker('http')

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'http')
  }

  /**
   * Fetches a URL the plugin's manifest allows.
   *
   * Timeouts are mandatory rather than optional: a plugin awaiting a hung
   * request inside a tool call would stall the agent's turn.
   */
  async fetch(url: string, init: HttpRequestInit = {}): Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }> {
    this.runtime.owner(this.ctx).gate.assertNetwork(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
    try {
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
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
    options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
  ): Promise<ShellResult> {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertShell(`${command} ${args.join(' ')}`)

    const cwd = options.cwd ? resolveInWorkspace(this.runtime, options.cwd) : this.runtime.workspace.root
    if (cwd) owner.gate.assertWorkspaceRead(cwd)

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
    const pending = run(command, [...args], {
      ...(cwd ? { cwd } : {}),
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
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
