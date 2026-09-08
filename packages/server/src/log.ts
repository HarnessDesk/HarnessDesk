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
      stream.write(details === undefined ? `${line}\n` : `${line} ${safeJson(details)}\n`)
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
