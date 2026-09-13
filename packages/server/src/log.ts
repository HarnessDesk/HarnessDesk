import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Structured logging.
 *
 * Two sinks on purpose: a line-oriented console stream for development, and an
 * NDJSON file that the diagnostics bundle can ship verbatim. Nothing here
 * formats for humans twice.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogRecord {
  readonly time: string
  readonly level: LogLevel
  readonly scope: string
  readonly message: string
  readonly details?: unknown
}

export interface LoggerOptions {
  readonly level?: LogLevel
  /** NDJSON destination. Omit to log only to the console. */
  readonly file?: string | null
  readonly console?: boolean
}

export class Logger {
  readonly #level: number
  readonly #file: string | null
  readonly #console: boolean
  #writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly scope: string,
    private readonly options: LoggerOptions = {},
  ) {
    this.#level = ORDER[options.level ?? 'info']
    this.#file = options.file ?? null
    this.#console = options.console ?? true
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.options)
  }

  /** Where the NDJSON log lives, for the diagnostics bundle. Null when console-only. */
  get file(): string | null {
    return this.#file
  }

  debug(message: string, details?: unknown): void {
    this.#write('debug', message, details)
  }
  info(message: string, details?: unknown): void {
    this.#write('info', message, details)
  }
  warn(message: string, details?: unknown): void {
    this.#write('warn', message, details)
  }
  error(message: string, details?: unknown): void {
    this.#write('error', message, details)
  }

  /** Resolves once every queued line has hit disk. Used before exit. */
  async flush(): Promise<void> {
    await this.#writes
  }

  #write(level: LogLevel, message: string, details?: unknown): void {
    if (ORDER[level] < this.#level) return
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(details === undefined ? {} : { details }),
    }

    if (this.#console) {
      const line = `${record.time} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}`
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
      /* A console that has gone away must not become the caller's problem.
         The desk is routinely started detached, and when its parent exits the
         pipe behind stdout breaks: `write` then raises EPIPE at whatever line
         asked for a log. Measured 2026-09-13 — the one line that logs
         unconditionally is the shell's `uncaughtException` handler, so the
         throw was delivered back to that handler, which logged again: 267,665
         crash files and 1.0 GB of disk in six minutes, then the process died.
         The file sink below still has the line. */
      try {
        stream.write(details === undefined ? `${line}\n` : `${line} ${safeJson(details)}\n`)
      } catch {
        // Nowhere to say so: saying so is what is broken.
      }
    }

    if (this.#file) {
      const path = this.#file
      // Serialise appends so interleaved writes cannot split a line.
      this.#writes = this.#writes
        .then(async () => {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, `${safeJson(record)}\n`)
        })
        .catch(() => {
          // A failing log sink must never take the host down with it.
        })
    }
  }
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, replacer)
  } catch {
    return '"[unserialisable]"'
  }
}

const replacer = (_key: string, value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value
