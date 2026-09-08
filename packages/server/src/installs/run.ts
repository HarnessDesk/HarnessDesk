import { spawn } from 'node:child_process'

/**
 * Runs a command for its output, and comes back no matter what.
 *
 * `execFile` with a timeout is not enough for an install probe. It signals
 * the child it started and then waits for the child's pipes to close — and
 * a wrapper script that ignores SIGTERM, or a grandchild that inherited
 * stdout, keeps them open forever. Measured on the development machine: an
 * old Homebrew-cask `cursor-agent` sat on `--version` for eleven minutes
 * past its ten-second timeout and took the whole catalogue with it.
 *
 * So the child gets a process group of its own, and a deadline kills the
 * whole group with SIGKILL. A copy that has to be killed is reported as
 * having timed out, which the caller treats as "unreadable, never run".
 *
 * What it waits for is `close`, not `exit`. They are not the same event and
 * the difference is the whole output: `exit` fires when the process is
 * reaped and says nothing about the pipes, so resolving there and closing
 * the streams can drop bytes that were still in flight — and a version
 * probe, being a short-output fast-exit program, is the worst case for that
 * race. Losing them is silent and expensive: an empty answer has no release
 * number in it, so a perfectly good copy is marked unreadable and never
 * run. `close` means the output is drained. The hang is still survived
 * because `exit` starts a short grace timer: when a grandchild is holding
 * the pipe open, `close` never comes and the grace resolves with whatever
 * the child managed to say.
 */
export interface RunResult {
  readonly ok: boolean
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface RunOptions {
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  /** Output beyond this is dropped; a probe wants a line, not a log. */
  readonly maxBytes?: number
}

/**
 * How long `close` gets after `exit` before the output is taken as final.
 * Long enough for a pipe that is about to drain, short enough that a stuck
 * grandchild costs a blink rather than a deadline.
 */
const GRACE_MS = 250

export const runForOutput = (
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> =>
  new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? 10_000
    const maxBytes = options.maxBytes ?? 1 << 20
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: { ...process.env, ...options.env },
      })
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let exitCode: number | null = null
    let grace: ReturnType<typeof setTimeout> | undefined
    const collect = (into: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (into === 'stdout') stdout = (stdout + text).slice(0, maxBytes)
      else stderr = (stderr + text).slice(0, maxBytes)
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
      // Whatever is still holding the pipes is not going to be read.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut })
    }
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
      // `exit` follows the kill; this is only the backstop for a group that
      // could not be signalled at all.
      setTimeout(() => finish(null), 1_000).unref()
    }, timeoutMs)
    child.on('error', () => finish(null))
    child.on('exit', (code) => {
      exitCode = code
      // The pipes usually drain within a tick of the exit; this waits for
      // that and gives up on a grandchild that will never let go.
      grace = setTimeout(() => finish(exitCode), GRACE_MS)
      grace.unref?.()
    })
    // The output is complete here, and only here.
    child.on('close', (code) => finish(code ?? exitCode))
  })
