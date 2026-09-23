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

/**
 * The console streams that have failed, and the ones the file has been told
 * about.
 *
 * A pipe does not refuse a write by throwing. Node dispatches the write, and
 * the EPIPE comes back afterwards as an `error` event on the stream — one per
 * later write, too, because stdio streams are never destroyed. With nobody
 * listening, each became an uncaught exception, which the shell's handler
 * logged through this same console, which failed again: measured 2026-09-23,
 * a desk whose launcher had exited died on the first refused request after
 * that (a refusal is logged as a warning), with exit code 1 and 26 crash
 * files written in 3 ms before the storm guard stopped it.
 *
 * So the logger listens on the streams it writes to. The first error retires
 * that stream for the rest of the process — a console that has gone does not
 * come back — and the file sink, which has every line anyway, says so once.
 * Module-level, because every child logger shares the same two streams.
 */
const watched = new WeakSet<NodeJS.WritableStream>()
const gone = new WeakSet<NodeJS.WritableStream>()
const announced = new WeakSet<NodeJS.WritableStream>()

const watch = (stream: NodeJS.WritableStream): void => {
  if (watched.has(stream)) return
  watched.add(stream)
  stream.on('error', () => {
    gone.add(stream)
  })
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

    let lost: LogRecord | null = null
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
    if (this.#console && gone.has(stream)) {
      // Only a logger with a file can carry the note, so only one marks it said.
      if (this.#file && !announced.has(stream)) {
        announced.add(stream)
        lost = {
          time: record.time,
          level: 'warn',
          scope: this.scope,
          message: `the console behind ${stream === process.stderr ? 'stderr' : 'stdout'} went away; this log continues here only`,
        }
      }
    } else if (this.#console) {
      watch(stream)
      const line = `${record.time} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}`
      /* A console that has gone away must not become the caller's problem.
         On a pipe it does not say so here: the write is dispatched and the
         EPIPE arrives later as an `error` event, which `watch` above answers.
         This try/catch is only for a write that throws synchronously — a file
         or a TTY. Measured 2026-09-13: a throw from here reached the shell's
         `uncaughtException` handler, which logged again, and wrote 267,665
         crash files and 1.0 GB of disk in six minutes before the process
         died. The file sink below still has the line. */
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
          await appendFile(path, `${lost === null ? '' : `${safeJson(lost)}\n`}${safeJson(record)}\n`)
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
