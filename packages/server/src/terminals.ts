import { randomUUID } from 'node:crypto'

import type {
  RuntimeId,
  RuntimeProcess,
  RuntimeProcesses,
  SessionId,
  TerminalSize,
  WireNotification,
} from '@harnessdesk/protocol'

/**
 * Terminals the host owns.
 *
 * A terminal is opened by a renderer but belongs to the host, because the
 * renderer reloads and the shell must not die with it. The host keeps each
 * terminal's recent output so a reloaded pane can redraw where it left off,
 * and relays live output as notifications. The process itself runs in the
 * runtime's sandbox — the host only holds a handle.
 *
 * Scrollback is capped by bytes, not lines: a process that prints a megabyte
 * of progress bars should cost a megabyte of memory at most, and the cap is
 * what makes "keep everything ever printed" a bounded promise.
 */

const SCROLLBACK_CAP = 512 * 1024
/** How much of a terminal's tail the "Last terminal output" chip carries. */
const LAST_OUTPUT_CHARS = 6_000

interface TerminalRecord {
  readonly id: string
  readonly runtime: RuntimeId
  readonly cwd: string
  process: RuntimeProcess
  size: TerminalSize
  scrollback: Buffer[]
  scrollbackBytes: number
  exitCode: number | null
  /** When this terminal last printed; 0 until it has. */
  lastOutputAt: number
}

export class Terminals {
  readonly #records = new Map<string, TerminalRecord>()

  constructor(private readonly push: (notification: WireNotification) => void) {}

  async open(options: {
    readonly runtime: RuntimeId
    readonly processes: RuntimeProcesses
    readonly cwd: string
    readonly size: TerminalSize
    readonly sessionId?: SessionId
    readonly command?: readonly string[]
  }): Promise<string> {
    const id = randomUUID()
    const process = await options.processes.spawn({
      cwd: options.cwd,
      command: options.command ?? defaultShell(),
      tty: true,
      size: options.size,
      ...(options.sessionId ? { session: options.sessionId } : {}),
    })
    const record: TerminalRecord = {
      id,
      runtime: options.runtime,
      cwd: options.cwd,
      process,
      size: options.size,
      scrollback: [],
      scrollbackBytes: 0,
      exitCode: null,
      lastOutputAt: 0,
    }
    this.#records.set(id, record)
    process.onOutput((stream, data) => {
      this.#remember(record, data)
      this.push({
        method: 'terminal/output',
        params: { terminalId: id, stream, data: Buffer.from(data).toString('base64') },
      })
    })
    process.onExit((exitCode) => {
      record.exitCode = exitCode
      this.push({ method: 'terminal/exited', params: { terminalId: id, exitCode } })
    })
    return id
  }

  attach(id: string): { scrollback: string; exitCode: number | null; size: TerminalSize; cwd: string } {
    const record = this.#require(id)
    return {
      scrollback: Buffer.concat(record.scrollback).toString('base64'),
      exitCode: record.exitCode,
      size: record.size,
      cwd: record.cwd,
    }
  }

  async write(id: string, data: Uint8Array): Promise<void> {
    await this.#require(id).process.write(data)
  }

  async resize(id: string, size: TerminalSize): Promise<void> {
    const record = this.#require(id)
    record.size = size
    await record.process.resize(size)
  }

  /** Kills the process if it is still running and forgets the terminal. */
  async close(id: string): Promise<void> {
    const record = this.#records.get(id)
    if (!record) return
    this.#records.delete(id)
    if (record.exitCode === null) {
      await record.process.kill().catch(() => {})
    }
  }

  /** Every terminal on a runtime is dead once the runtime is; say so rather than hang. */
  detachAll(runtime: RuntimeId): void {
    for (const record of this.#records.values()) {
      if (record.runtime !== runtime || record.exitCode !== null) continue
      record.exitCode = -1
      /* Killed, not only marked. The exit code was set and nothing stopped the
         shell, and a terminal marked exited is one `close()` no longer kills,
         so every shell the agent had opened outlived it for good (#74). */
      void record.process.kill().catch(() => {})
      this.push({ method: 'terminal/exited', params: { terminalId: record.id, exitCode: -1 } })
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#records.keys()].map((id) => this.close(id)))
  }

  /**
   * The tail of whichever terminal printed most recently, as plain text — the
   * "Last terminal output" chip. Null when no terminal has printed anything,
   * which the caller turns into a sentence rather than an empty block.
   */
  lastOutput(): { cwd: string; text: string; exitCode: number | null } | null {
    let latest: TerminalRecord | null = null
    for (const record of this.#records.values()) {
      if (record.lastOutputAt === 0) continue
      if (!latest || record.lastOutputAt > latest.lastOutputAt) latest = record
    }
    if (!latest) return null
    const text = plainTerminalText(Buffer.concat(latest.scrollback).toString('utf8')).slice(-LAST_OUTPUT_CHARS)
    return { cwd: latest.cwd, text, exitCode: latest.exitCode }
  }

  #remember(record: TerminalRecord, data: Uint8Array): void {
    record.lastOutputAt = Date.now()
    record.scrollback.push(Buffer.from(data))
    record.scrollbackBytes += data.byteLength
    while (record.scrollbackBytes > SCROLLBACK_CAP && record.scrollback.length > 1) {
      const dropped = record.scrollback.shift()!
      record.scrollbackBytes -= dropped.byteLength
    }
  }

  #require(id: string): TerminalRecord {
    const record = this.#records.get(id)
    // The id means nothing to the person reading this; what happened does.
    // A terminal the host no longer knows ended with the host — a restart —
    // or was closed. Either way the answer is a new shell, which the dock offers.
    if (!record) throw new Error('This terminal ended when HarnessDesk restarted, or was closed.')
    return record
  }
}

/**
 * The shell to open when the caller names none.
 *
 * `SHELL` and `/bin/sh -i` are both POSIX facts. Windows sets neither: there
 * is no `SHELL` in a standard environment, `/bin/sh` is not a path that
 * exists, and `-i` is not a flag `cmd.exe` or PowerShell has — so the
 * fallback spawned `ENOENT` and the dock's Open a shell did nothing but
 * throw. `COMSPEC` is the variable Windows does set, and it names the command
 * processor, which is interactive already.
 *
 * `platform` and `env` are parameters so the Windows branch can be exercised
 * from a machine that is not Windows. A rule that can only be checked on the
 * platform it is about is a rule nothing checks, which is how the POSIX
 * assumption survived in a file this long.
 */
export const defaultShell = (
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform } = {},
): string[] => {
  const env = options.env ?? process.env
  if ((options.platform ?? process.platform) === 'win32') {
    const comspec = env['COMSPEC']
    return [comspec && comspec.length > 0 ? comspec : 'cmd.exe']
  }
  const shell = env['SHELL']
  return shell && shell.length > 0 ? [shell, '-i'] : ['/bin/sh', '-i']
}

/**
 * Raw TTY bytes as readable text: escape sequences out, and each line kept
 * as whatever a carriage return last overwrote it with — a progress bar that
 * redrew itself two hundred times reads as its final state, once.
 */
export const plainTerminalText = (raw: string): string =>
  raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^]*?(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI (colours, cursor moves)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_]/g, '') // bare ESC sequences
    // A PTY ends every line \r\n. Fold that first, or the overwrite rule
    // below reads each whole line as overwritten by nothing and eats it.
    .replace(/\r\n/g, '\n')
    .split('\n')
    /* A carriage return sends the cursor back to column 0, and what is typed
       after it overwrites what was there — so the last one on a line wins.
       A carriage return with *nothing* after it has overwritten nothing: the
       cursor moved and the line stayed. Taking the slice from it anyway
       returned the empty string, which deleted a whole line of real output —
       the commonest shape being a progress bar or a status message that
       returns to column 0 and is still waiting to be redrawn.
       The `\r\n` fold above shows the authors had this exact shape in mind
       and closed it for the pair only. */
    .map((line) => line.replace(/\r+$/, ''))
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
