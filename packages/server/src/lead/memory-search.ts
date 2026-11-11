import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { leadMemoryLine } from '@harnessdesk/lead'
import { LEAD_MEMORY_LIMITS, type LeadMemoryHit, type LeadMessage } from '@harnessdesk/protocol'
import { leadMemoryKey, leadMemoryNear, leadMemoryTokens } from './memory-scan.js'

/**
 * Search for the Lead: a local BM25 ranking over Archive and the Lead's own past conversation with the person, the
 * person's and its own words and the summaries that replaced earlier parts of it. Nothing leaves the machine. The
 * conversation is copied as it happens into `<home>/lead/memory-conversation.jsonl`, so it outlives the journal's
 * rotation and the summaries that fold it away.
 */
export interface LeadMemoryDoc {
  readonly id: string
  readonly text: string
  readonly at: number
  readonly kind: 'memory' | 'conversation' | 'summary'
  readonly by?: 'person' | 'lead' | 'assistant'
}
const K1 = 1.2, B = 0.75
const dateOf = (at: number): string => new Date(at).toISOString().slice(0, 10)
/** The part of a document around its first matching word, as one clean line the model reads as quoted data. */
const snippet = (text: string, terms: ReadonlySet<string>, chars: number): string => {
  const lower = text.normalize('NFKC').toLowerCase()
  let hit = -1
  for (const term of terms) { const at = lower.indexOf(term); if (at >= 0 && (hit < 0 || at < hit)) hit = at }
  const start = Math.max(0, hit - Math.floor(chars / 3))
  const window = text.slice(start, start + chars)
  return `${start > 0 ? '\u2026 ' : ''}${leadMemoryLine(window)}`
}
/** At most `limit` hits for `query`, best first (ties to the most recent), within `resultBytes` all together. */
export const leadMemoryRank = (docs: readonly LeadMemoryDoc[], query: string, limit: number = LEAD_MEMORY_LIMITS.results): LeadMemoryHit[] => {
  const terms = [...new Set(leadMemoryTokens(query))]
  if (!terms.length || !docs.length) return []
  const tokenized = docs.map(doc => leadMemoryTokens(doc.text)), average = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / docs.length || 1
  const frequency = new Map(terms.map(term => [term, tokenized.filter(tokens => tokens.includes(term)).length]))
  const scored = docs.map((doc, index) => {
    const tokens = tokenized[index]!
    let score = 0
    for (const term of terms) {
      const count = tokens.filter(token => token === term).length
      if (!count) continue
      const n = frequency.get(term)!, idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += idf * (count * (K1 + 1)) / (count + K1 * (1 - B + B * tokens.length / average))
    }
    return { doc, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.doc.at - a.doc.at).slice(0, Math.max(1, Math.min(limit, LEAD_MEMORY_LIMITS.results)))
  const wanted = new Set(terms)
  let chars = Math.min(LEAD_MEMORY_LIMITS.textChars, Math.floor(1600 / Math.max(1, scored.length)))
  for (;;) {
    const hits = scored.map(({ doc }): LeadMemoryHit => ({ text: snippet(doc.text, wanted, chars), at: doc.at, date: dateOf(doc.at),
      source: { kind: doc.kind, id: doc.id.slice(0, 256), ...(doc.by ? { by: doc.by } : {}) } }))
    if (new TextEncoder().encode(JSON.stringify({ results: hits })).byteLength <= LEAD_MEMORY_LIMITS.resultBytes || chars <= 40) return hits
    chars = Math.floor(chars * 0.8)
  }
}

const FILE = 'memory-conversation.jsonl'
const KEEP = 4000, TEXT = 4000, FORGOTTEN = 8000
interface CorpusLine { readonly id: string; readonly text: string; readonly at: number; readonly by: 'person' | 'assistant' }
/** The words of a passage as Forget compares them, spaced as one line. */
const spaced = (text: string): string => ` ${leadMemoryKey(text)} `
/**
 * The Lead's conversation with the person, as search reads it: the person's messages and the Lead's replies. Forget
 * takes passages out; the ids it took stay on a first line of their own, with no text, so a message the journal still
 * holds is not copied back.
 */
export class LeadConversationCorpus {
  #lines: CorpusLine[] = []
  #known = new Set<string>()
  #forgotten: string[] = []
  #tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly dir: string, private readonly now: () => number) {}
  static async open(dir: string, now: () => number = Date.now): Promise<LeadConversationCorpus> {
    const corpus = new LeadConversationCorpus(dir, now)
    const text = await readFile(join(dir, FILE), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const item = JSON.parse(line) as CorpusLine & { readonly forgotten?: unknown }
        if (Array.isArray(item.forgotten)) {
          const ids = item.forgotten.filter((id): id is string => typeof id === 'string')
          corpus.#forgotten.push(...ids); ids.forEach(id => corpus.#known.add(id))
        } else if (typeof item.id === 'string' && typeof item.text === 'string' && Number.isSafeInteger(item.at) && (item.by === 'person' || item.by === 'assistant') && !corpus.#known.has(item.id)) {
          corpus.#lines.push(item); corpus.#known.add(item.id)
        }
      } catch { /* A torn last line is skipped. */ }
    }
    corpus.#lines = corpus.#lines.slice(-KEEP)
    corpus.#forgotten = corpus.#forgotten.slice(-FORGOTTEN)
    return corpus
  }
  /** Adds the messages it has not seen, each at the time `timeOf` gives (when the desk first saw it), else now.
   * Called with the journal's thread at open and whenever it changes. */
  add(messages: readonly LeadMessage[], timeOf: (id: string) => number | undefined = () => undefined): Promise<void> {
    // A desk wake (a reminder) is a user turn the person never wrote: it is never indexed as theirs.
    const fresh = messages.filter(message => (message.role === 'user' && !message.wake || message.role === 'assistant') && message.text.trim() && !this.#known.has(message.id))
    if (!fresh.length) return this.#tail as Promise<void>
    const now = this.now(), lines = fresh.map((message): CorpusLine => ({ id: message.id, text: message.text.slice(0, TEXT), at: timeOf(message.id) ?? now, by: message.role === 'user' ? 'person' : 'assistant' }))
    for (const line of lines) { this.#known.add(line.id); this.#lines.push(line) }
    if (this.#lines.length > KEEP + 500) return this.#rewrite()
    return this.#write(() => appendFile(join(this.dir, FILE), lines.map(line => JSON.stringify(line)).join('\n') + '\n', { mode: 0o600 }))
  }
  /** Takes out every passage that says a forgotten entry: its words, however spaced, cased or styled, inside the
   * passage, or a passage that says nearly the same. */
  forget(texts: readonly string[]): Promise<void> {
    const keys = texts.map(spaced).filter(key => key.trim())
    const gone = this.#lines.filter(line => texts.some(text => leadMemoryNear(line.text, text)) || keys.some(key => spaced(line.text).includes(key)))
    if (!gone.length) return this.#tail as Promise<void>
    const ids = new Set(gone.map(line => line.id))
    this.#lines = this.#lines.filter(line => !ids.has(line.id))
    this.#forgotten = [...this.#forgotten, ...ids].slice(-FORGOTTEN)
    return this.#rewrite()
  }
  /** Forget all: no passage is left, and what the journal still holds is not copied back. */
  clear(): Promise<void> {
    this.#forgotten = [...this.#forgotten, ...this.#lines.map(line => line.id)].slice(-FORGOTTEN)
    this.#lines = []
    return this.#rewrite()
  }
  /** Rewritten whole: after Forget, and once it has grown well past what it keeps. */
  #rewrite(): Promise<void> {
    this.#lines = this.#lines.slice(-KEEP)
    this.#known = new Set([...this.#lines.map(line => line.id), ...this.#forgotten])
    const body = [...this.#forgotten.length ? [JSON.stringify({ forgotten: this.#forgotten })] : [], ...this.#lines.map(line => JSON.stringify(line))]
    return this.#write(async () => {
      const temporary = join(this.dir, `${FILE}.next`)
      await writeFile(temporary, body.length ? body.join('\n') + '\n' : '', { mode: 0o600 })
      await rename(temporary, join(this.dir, FILE))
    })
  }
  #write(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(async () => { await mkdir(this.dir, { recursive: true, mode: 0o700 }); await operation() })
    this.#tail = next.catch(() => {})
    return next
  }
  docs(): LeadMemoryDoc[] { return this.#lines.map(line => ({ id: line.id, text: line.text, at: line.at, kind: 'conversation', by: line.by })) }
}
