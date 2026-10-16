import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'
import {
  itemId as makeItemId,
  orderTasks,
  type BackgroundTask,
  type RuntimeTasks,
  type SessionId,
} from '@harnessdesk/protocol'

/**
 * Codex's background terminals as `RuntimeTasks`.
 *
 * Codex splits the answer across two places, and neither half is enough:
 *
 * - **`thread/backgroundTerminals/list`** knows what is *alive*. It reports
 *   the OS pid, the CPU share and the resident size, and it forgets a process
 *   the moment it dies — there is no finished list to read, and no start time
 *   on the ones that are running.
 * - **The item stream** knows the *history*. A shell session begins as a
 *   `commandExecution` item whose `source` is `unifiedExecStartup`, which
 *   carries the command, the working directory, the item id and — because we
 *   watched it arrive — the moment it started. It also says whether that
 *   startup succeeded.
 *
 * So this class watches the items for lifecycle and polls the list for
 * liveness: a remembered session that the list still names is running, one it
 * has dropped has ended, and one the list names that we never saw an item for
 * is a session inherited from before this process attached — a resumed
 * thread — which is shown with what little is known rather than hidden.
 *
 * `thread/backgroundTerminals/clean` exists and is deliberately not called.
 * The name does not say whether it reaps dead entries or kills live ones, and
 * the only way to find out costs a paid turn; a "Clear finished" button that
 * might silently kill running work is not worth the guess. Forgetting is done
 * here, where it provably touches nothing.
 */

/** Past this, a command is shortened for its title; the plate keeps it whole. */
const LABEL_MAX = 48

/** Splits a shell line into words, keeping each quoted word as it was written. */
const shellWords = (line: string): string[] => {
  const words: string[] = []
  let word = '', quote: string | null = null, started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) { word += ch + line[++i]; continue }
      word += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; word += ch; started = true; continue }
    if (/\s/.test(ch)) { if (started) { words.push(word); word = ''; started = false } continue }
    word += ch; started = true
  }
  if (started) words.push(word)
  return words
}

const unquote = (word: string) => {
  const q = word[0]
  if ((q !== '"' && q !== "'") || word.at(-1) !== q || word.length < 2) return word
  const inner = word.slice(1, -1)
  return q === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner
}

/**
 * The title a background task is listed under. Codex names a shell session
 * only by its command, and that command usually arrives wrapped —
 * `/bin/zsh -lc "rg -n … /a/long/path"` — so the wrapper was the first thing
 * read, and the plate under the title printed the same line again. The title
 * unwraps the shell, skips a leading `cd …`, and keeps a short command whole;
 * a long one is cut to its program and the first argument that is not a flag.
 */
export const taskLabel = (command: string): string => {
  let line = command.trim()
  const outer = shellWords(line)
  const shell = outer[0]?.split('/').at(-1) ?? ''
  if (outer.length === 3 && /^(ba|z|da|k|fi)?sh$/.test(shell) && /^-[a-z]*c$/.test(outer[1]!)) line = unquote(outer[2]!).trim()
  line = line.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, '')
  if (line.length <= LABEL_MAX) return line || command
  const all = shellWords(line)
  const end = all.findIndex(word => ['&&', '||', ';', '|'].includes(word))
  const words = (end < 0 ? all : all.slice(0, end)).filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const program = words[0]?.split('/').at(-1) ?? ''
  const argument = words.slice(1).find(word => !word.startsWith('-'))
  const short = argument ? `${program} ${argument}` : program
  return `${short.length > LABEL_MAX ? short.slice(0, LABEL_MAX - 1).trimEnd() : short}…`
}

/** How often the live list is re-read while something is running. */
const POLL_MS = 4_000

/** One shell session, as this adapter has pieced it together. */
interface Remembered {
  readonly processId: string
  label: string
  command: string
  cwd?: string
  itemId?: string
  startedAt: number
  endedAt?: number
  /** Set when the item that started it ended badly, or when we killed it. */
  outcome?: 'failed' | 'stopped'
  /** What the startup item printed, as Codex aggregates stdout and stderr. */
  output?: string
  /** False once a poll has come back without it. */
  alive: boolean
  /** True until a poll has had the chance to contradict the item stream. */
  unpolled: boolean
  osPid?: number | null
  cpuPercent?: number | null
  rssKb?: number | null
}

export class CodexTasks implements RuntimeTasks {
  readonly #threads = new Map<string, Map<string, Remembered>>()
  /** The last list published per thread, so an unchanged poll stays silent. */
  readonly #published = new Map<string, string>()
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly server: CodexAppServer,
    /** Announces a changed list; the host turns it into `session/tasks`. */
    private readonly publish: (thread: SessionId, tasks: readonly BackgroundTask[]) => void,
  ) {}

  async list(session: SessionId): Promise<readonly BackgroundTask[]> {
    await this.#poll(session)
    return this.#view(session)
  }

  async stop(session: SessionId, taskId: string): Promise<boolean> {
    const known = this.#threads.get(session)?.get(taskId)
    // Codex answers `terminated: false` for a process it no longer has, which
    // is also what a second window pressing the same button looks like.
    const response = await this.server
      .request('thread/backgroundTerminals/terminate', { threadId: session, processId: taskId })
      .catch(() => ({ terminated: false }))
    if (known && response.terminated) {
      known.outcome = 'stopped'
      known.alive = false
      known.unpolled = false
      known.endedAt = Date.now()
      this.#announce(session)
    } else {
      void this.#poll(session).then(() => this.#announce(session))
    }
    return response.terminated
  }

  /**
   * Forgets what has finished. Running sessions are untouched — this is the
   * panel's "Clear", and Codex is not asked to do anything at all.
   */
  async clear(session: SessionId): Promise<void> {
    const thread = this.#threads.get(session)
    if (!thread) return
    for (const [id, entry] of thread) if (!entry.alive) thread.delete(id)
    this.#announce(session)
  }

  /**
   * A `commandExecution` item started or finished. Only the ones that open a
   * shell session are tasks; an ordinary command lives and dies inside its
   * turn and belongs to the transcript, not to a panel about what outlives it.
   */
  noteItem(thread: string, item: CodexProtocol.v2.ThreadItem, ended: boolean): void {
    if (item.type !== 'commandExecution') return
    if (item.source !== 'unifiedExecStartup') return
    if (!item.processId) return
    const sessions = this.#ensure(thread)
    const existing = sessions.get(item.processId)
    const entry: Remembered = existing ?? {
      processId: item.processId,
      label: taskLabel(item.command),
      command: item.command,
      startedAt: Date.now(),
      alive: true,
      unpolled: true,
    }
    entry.label = taskLabel(item.command)
    entry.command = item.command
    entry.cwd = item.cwd
    entry.itemId = item.id
    // The one place Codex hands over what a shell session said: the startup
    // item's aggregated output, as far as it has streamed. Kept whenever it
    // is non-empty, so a later update without it cannot blank the row.
    if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 0) {
      entry.output = item.aggregatedOutput
    }
    // A startup that failed never left a shell behind, so it is finished the
    // moment the item is — no poll needed to know that.
    if (ended && item.status === 'failed') {
      entry.outcome = 'failed'
      entry.alive = false
      entry.unpolled = false
      entry.endedAt ??= Date.now()
    }
    sessions.set(item.processId, entry)
    this.#announce(thread as SessionId)
    this.#ensureTimer()
    void this.#poll(thread as SessionId).then(() => this.#announce(thread as SessionId))
  }

  /** A thread closed; its shell sessions went with it. */
  forget(thread: string): void {
    this.#threads.delete(thread)
    this.#published.delete(thread)
    this.#ensureTimer()
  }

  /** The app-server is gone, and every shell session with it. */
  dispose(): void {
    this.#threads.clear()
    this.#published.clear()
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  // ------------------------------------------------------------------ private

  #ensure(thread: string): Map<string, Remembered> {
    const existing = this.#threads.get(thread)
    if (existing) return existing
    const fresh = new Map<string, Remembered>()
    this.#threads.set(thread, fresh)
    return fresh
  }

  /**
   * Re-reads the live set for one thread and folds it into what is
   * remembered. Pagination is followed to the end: a thread with more shell
   * sessions than one page would otherwise have the tail declared dead.
   */
  async #poll(thread: SessionId): Promise<void> {
    let cursor: string | null | undefined
    const alive = new Map<string, CodexProtocol.v2.ThreadBackgroundTerminal>()
    try {
      do {
        const page = await this.server.request('thread/backgroundTerminals/list', {
          threadId: thread,
          ...(cursor ? { cursor } : {}),
        })
        for (const terminal of page.data) alive.set(terminal.processId, terminal)
        cursor = page.nextCursor
      } while (cursor)
    } catch {
      // A refused or failed poll leaves what is remembered alone: reporting
      // every task as finished because one request failed would be worse than
      // a list that is a few seconds stale.
      return
    }

    const sessions = this.#ensure(thread)
    for (const [processId, terminal] of alive) {
      const entry = sessions.get(processId) ?? {
        processId,
        label: taskLabel(terminal.command),
        command: terminal.command,
        startedAt: Date.now(),
        alive: true,
        unpolled: false,
      }
      entry.alive = true
      entry.unpolled = false
      entry.endedAt = undefined
      entry.cwd ??= terminal.cwd
      entry.osPid = terminal.osPid
      entry.cpuPercent = terminal.cpuPercent
      entry.rssKb = terminal.rssKb === null || terminal.rssKb === undefined ? null : Number(terminal.rssKb)
      sessions.set(processId, entry)
    }
    for (const entry of sessions.values()) {
      if (alive.has(entry.processId) || !entry.alive) continue
      entry.alive = false
      entry.unpolled = false
      entry.endedAt ??= Date.now()
      entry.osPid = undefined
      entry.cpuPercent = undefined
      entry.rssKb = undefined
    }
    this.#ensureTimer()
  }

  #view(thread: SessionId): readonly BackgroundTask[] {
    const sessions = this.#threads.get(thread)
    if (!sessions) return []
    return orderTasks(
      [...sessions.values()].map((entry) => {
        const running = entry.alive || entry.unpolled
        return {
          id: entry.processId,
          label: entry.label,
          kind: 'command' as const,
          state: running ? ('running' as const) : (entry.outcome ?? 'completed'),
          command: entry.command,
          startedAt: entry.startedAt,
          stoppable: running,
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          ...(entry.itemId ? { itemId: makeItemId(entry.itemId) } : {}),
          ...(entry.endedAt !== undefined && !running ? { endedAt: entry.endedAt } : {}),
          ...(entry.osPid !== undefined ? { osPid: entry.osPid } : {}),
          ...(entry.cpuPercent !== undefined ? { cpuPercent: entry.cpuPercent } : {}),
          ...(entry.rssKb !== undefined ? { rssKb: entry.rssKb } : {}),
          ...(entry.output !== undefined ? { output: entry.output } : {}),
        }
      }),
    )
  }

  /** Publishes, but only when the list a client would draw actually moved. */
  #announce(thread: SessionId): void {
    const tasks = this.#view(thread)
    // The live figures move on every poll and are not worth a redraw of their
    // own; what a person notices is a task appearing, ending, or being killed.
    const signature = JSON.stringify(
      tasks.map((task) => [task.id, task.state, task.label, task.endedAt ?? 0, task.output?.length ?? 0]),
    )
    if (this.#published.get(thread) === signature) return
    this.#published.set(thread, signature)
    this.publish(thread, tasks)
  }

  /**
   * The poll runs only while something is running, and stops when nothing is.
   * A timer that ticks over an idle app is a timer that shows up in a battery
   * report.
   */
  #ensureTimer(): void {
    const wanted = [...this.#threads.values()].some((sessions) =>
      [...sessions.values()].some((entry) => entry.alive || entry.unpolled),
    )
    if (wanted && !this.#timer) {
      this.#timer = setInterval(() => {
        for (const thread of [...this.#threads.keys()]) {
          void this.#poll(thread as SessionId).then(() => this.#announce(thread as SessionId))
        }
      }, POLL_MS)
      this.#timer.unref?.()
      return
    }
    if (!wanted && this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }
}
