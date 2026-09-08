import { CodexError } from './errors.js'

/**
 * NDJSON framing.
 *
 * The app-server writes one JSON value per line. Payloads are not small — a
 * single `fileChange` item can carry a multi-megabyte diff — so the decoder
 * works on buffered chunks and never assumes a message arrives whole.
 */

export interface DecoderOptions {
  /**
   * Guard against a malformed peer streaming an unbounded line. Generous by
   * default because legitimate diffs do get large.
   */
  readonly maxLineBytes?: number
  readonly onMalformedLine?: (line: string, error: unknown) => void
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024

export class NdjsonDecoder {
  #buffer = ''
  readonly #maxLineBytes: number
  readonly #onMalformedLine: ((line: string, error: unknown) => void) | undefined

  constructor(options: DecoderOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.#onMalformedLine = options.onMalformedLine
  }

  /**
   * Feeds a chunk and yields every complete message it produced. A trailing
   * partial line is retained for the next call.
   */
  push(chunk: string): unknown[] {
    this.#buffer += chunk
    if (this.#buffer.length > this.#maxLineBytes) {
      const size = this.#buffer.length
      this.#buffer = ''
      throw new CodexError(
        'protocol',
        `app-server sent ${size} bytes without a newline; exceeds the ${this.#maxLineBytes} byte line limit`,
      )
    }

    const out: unknown[] = []
    let start = 0
    while (true) {
      const newline = this.#buffer.indexOf('\n', start)
      if (newline === -1) break
      const line = this.#buffer.slice(start, newline).trim()
      start = newline + 1
      if (line.length === 0) continue
      try {
        out.push(JSON.parse(line))
      } catch (error) {
        // A single unparsable line must not poison the stream: Codex writes
        // diagnostics to stderr, but a stray write to stdout is survivable.
        this.#onMalformedLine?.(line, error)
      }
    }
    if (start > 0) this.#buffer = this.#buffer.slice(start)
    return out
  }

  /** Bytes held back waiting for a newline. Useful in diagnostics. */
  get pending(): number {
    return this.#buffer.length
  }

  reset(): void {
    this.#buffer = ''
  }
}

export const encodeLine = (value: unknown): string => `${JSON.stringify(value)}\n`
