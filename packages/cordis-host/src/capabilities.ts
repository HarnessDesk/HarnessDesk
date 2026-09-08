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

export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
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

    try {
      const result = await run(command, [...args], {
        ...(cwd ? { cwd } : {}),
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
      })
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: 0 }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string }
      return {
        stdout: failure.stdout?.toString() ?? '',
        // A non-zero exit is information, not an exception: plugins routinely
        // run commands that legitimately fail.
        stderr: failure.stderr?.toString() ?? failure.message ?? '',
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      }
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
