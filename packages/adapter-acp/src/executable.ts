import { execFile, spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { whichOnPath as findOnPath } from './which.js'


/**
 * The agent CLI behind a bridge.
 *
 * Some ACP agents are bridges: a shim that embeds its own copy of the agent
 * and speaks ACP on its behalf. `@zed-industries/claude-code-acp` is one — it
 * ships an Agent SDK that ships a Claude Code, and that Claude Code is
 * whatever was current when the bridge was last published, which can be
 * months behind the one installed on the machine. The embedded copy decides
 * which models exist, so a stale bridge is a stale model list.
 *
 * A registry entry names the real CLI here, and the adapter finds it and
 * hands the bridge its path in the environment variable the bridge reads
 * (`CLAUDE_CODE_EXECUTABLE` for that one). Not found is not an error: the
 * bridge falls back to its embedded copy and the log says so.
 */
export interface AcpExecutableSpec {
  /** The CLI's name on `PATH`, or an absolute path. */
  readonly command: string
  /** The variable the bridge reads the resolved path from. */
  readonly env: string
  /** What makes the CLI print its version; `--version` unless said otherwise. */
  readonly versionArgs?: readonly string[]
}

export interface ResolvedExecutable {
  readonly path: string
  /** The semantic version in what `--version` printed, or the whole first line. */
  readonly version: string | null
}

export interface ExecutableResolverOptions {
  readonly which?: (command: string) => Promise<string | null>
  readonly versionOf?: (path: string, args: readonly string[]) => Promise<string | null>
}

// A PATH walk. `/usr/bin/which` is absent on Windows and on minimal images, and there every agent read as not installed (#129).
const whichOnPath = async (command: string): Promise<string | null> => findOnPath(command)

/**
 * The version line, or null — and back within the timeout whatever the
 * CLI does. A wrapper that ignores SIGTERM, or a grandchild holding stdout,
 * would keep `execFile` waiting forever; the child gets its own process
 * group and the group is killed at the deadline.
 *
 * It settles on `close`, which is the event that means the output is
 * drained — `exit` only means the process was reaped, and taking the answer
 * there can drop the very line this exists to read. `exit` starts a short
 * grace instead, so a grandchild holding the pipe costs a blink rather than
 * the deadline. See `installs/run.ts`, which does the same for the same
 * reason.
 */
const printedVersion = (path: string, args: readonly string[]): Promise<string | null> =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, [...args], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let done = false
    let exitCode: number | null = null
    let grace: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
      child.stdout?.destroy()
      resolve(value)
    }
    const answer = (code: number | null): string | null =>
      code === 0 ? (out.trim().split('\n')[0] ?? null) : out.trim().split('\n')[0] || null
    child.stdout?.on('data', (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(0, 64 * 1024)
    })
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish(null)
    }, 10_000)
    child.on('error', () => finish(null))
    child.on('exit', (code) => {
      exitCode = code
      grace = setTimeout(() => finish(answer(exitCode)), 250)
      grace.unref?.()
    })
    child.on('close', (code) => finish(answer(code ?? exitCode)))
  })

/** `2.1.240 (Claude Code)` → `2.1.240`; anything without a triple is kept whole. */
export const versionIn = (printed: string | null): string | null => {
  if (!printed) return null
  const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(printed)
  return match ? match[0] : printed.trim() || null
}

export const resolveExecutable = async (
  spec: AcpExecutableSpec,
  options: ExecutableResolverOptions = {},
): Promise<ResolvedExecutable | null> => {
  const path = isAbsolute(spec.command) ? spec.command : await (options.which ?? whichOnPath)(spec.command)
  if (!path) return null
  const printed = await (options.versionOf ?? printedVersion)(path, spec.versionArgs ?? ['--version'])
  return { path, version: versionIn(printed) }
}
