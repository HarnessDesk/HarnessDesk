/**
 * Claude Code's background tasks, read off the SDK stream.
 *
 * Claude Code has a first-class registry of work that outlives a turn — a
 * command run with `run_in_background`, a nested agent sent off on its own,
 * a session handed to the cloud — and narrates it on the same stream the
 * transcript arrives on. Observed against 2.1.240, one backgrounded `sleep`:
 *
 * ```
 * assistant                     tool_use Bash { command, description, run_in_background: true }
 * system/background_tasks_changed  { tasks: [{ task_id, task_type, description }] }
 * system/task_started              { task_id, tool_use_id, description, is_backgrounded, task_type }
 * user                          tool_result "Command running in background with ID: …"
 * …
 * system/task_updated              { task_id, patch: { status, end_time } }
 * system/task_notification         { task_id, tool_use_id, status, output_file, summary }
 * system/background_tasks_changed  { tasks: [] }
 * ```
 *
 * `background_tasks_changed` is the *running* set, whole, whenever it moves —
 * so it is the authority on what is live, and the two per-task messages are
 * the authority on how one ended. Neither says what the command was, which is
 * why the `tool_use` block is joined in through `tool_use_id`: a panel that
 * can only say "Sleep 25s then echo" and not `sleep 25; echo done-sleeping`
 * is missing the half a person checks.
 *
 * **2.1.258 says less.** Traced on the real wire on 2026-09-05: no
 * `background_tasks_changed`, no `task_started`, and a `task_notification`
 * with no `tool_use_id` — only `task_id`, `status`, `output_file`, `summary`.
 * The one announcement of a *start* is the backgrounded call's own tool
 * result, `Command running in background with ID: bdff13a. Output is being
 * written to: <file>`, so that line is read for the task id, which is the
 * join key, and for the file, which is known from the first second. A
 * `TaskOutput` result (`<task_id>…<status>failed</status>`) says how a task
 * ended some seconds before the notification does, and is read for that.
 * Both wires are handled; whichever messages come, the row is named by the
 * block's description, kinded by its tool, and ended by the first thing that
 * says it ended.
 *
 * The bridge's own SDK typings know only `task_notification`; the other
 * subtypes are newer than the published types and are read structurally.
 * Reading them off the wire rather than off a type is the point — this is an
 * observed shape, and it is allowed to grow a field, or lose one, without
 * breaking us.
 */

/** The union this file speaks. It is deliberately not the SDK's. */
export interface BridgeTask {
  readonly id: string
  readonly label: string
  readonly kind: 'command' | 'agent' | 'other'
  readonly state: 'running' | 'completed' | 'failed' | 'stopped'
  readonly command?: string
  readonly startedAt?: number
  readonly endedAt?: number
  readonly summary?: string
  readonly outputFile?: string
  /** What the task printed, read off `outputFile` once it ended. */
  readonly output?: string
  readonly outputTruncated?: boolean
  /** The file was looked for, for as long as the bridge was willing, and never appeared. */
  readonly outputMissing?: boolean
  readonly toolUseId?: string
  readonly stoppable: boolean
}

interface Entry {
  id: string
  label: string
  kind: BridgeTask['kind']
  state: BridgeTask['state']
  command?: string
  startedAt: number
  endedAt?: number
  summary?: string
  outputFile?: string
  output?: string
  outputTruncated?: boolean
  outputMissing?: boolean
  toolUseId?: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * A tool result's words: a string, or the text blocks of an array.
 *
 * Blocks are joined with a newline. The tags read below live inside one
 * block — a `TaskOutput` result is a single text block — so the join never
 * splits a tag; a result that spread one tag across two blocks would go
 * unread rather than misread, which is the safer of the two failures.
 */
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = asRecord(block)
      return record?.['type'] === 'text' ? (asString(record['text']) ?? '') : ''
    })
    .join('\n')
}

/**
 * What a backgrounded call answers, on 2.1.258: the id, and where it writes.
 *
 * Read loosely, because the words are Claude Code's to change. The id is
 * whatever stands between the colon and the next space, less a sentence's
 * trailing period — hex today, but a colon or a dot inside it would still be
 * taken whole. The path runs to the end of its line, less trailing
 * punctuation, because a path with a space in it is a path, not two.
 */
const STARTED = /Command running in background with ID:\s*(\S+)/i
const OUTPUT_FILE = /Output is being written to:[ \t]*(.+?)[ \t]*$/im
const TRAILING_PUNCTUATION = /[.,;:]+$/
const startedIdOf = (text: string): string | undefined => {
  const id = STARTED.exec(text)?.[1]?.replace(TRAILING_PUNCTUATION, '')
  return id && id.length > 0 ? id : undefined
}
const outputFileOf = (text: string): string | undefined => {
  const file = OUTPUT_FILE.exec(text)?.[1]?.replace(TRAILING_PUNCTUATION, '')
  return file && file.length > 0 ? file : undefined
}
/** What a `TaskOutput` read carries about a task, as tags. */
const TAG_TASK_ID = /<task_id>\s*([A-Za-z0-9_-]+)\s*<\/task_id>/
const TAG_STATUS = /<status>\s*([a-z]+)\s*<\/status>/
const TAG_TASK_TYPE = /<task_type>\s*([a-z_]+)\s*<\/task_type>/

/**
 * `local_bash` today; `agent`-ish and `remote`-ish names are documented in
 * the tool's own help ("background shells, async agents, and remote
 * sessions") but were not observed, so they are matched loosely rather than
 * enumerated — an unknown kind lands on `other` and still shows up.
 */
const kindOf = (taskType: string | undefined): BridgeTask['kind'] => {
  const name = (taskType ?? '').toLowerCase()
  if (name.includes('bash') || name.includes('shell') || name.includes('command')) return 'command'
  if (name.includes('agent') || name.includes('task') || name.includes('teammate')) return 'agent'
  return 'other'
}

/** Claude Code says `killed` for a task the user ended; the protocol says `stopped`. */
const stateOf = (status: string | undefined): BridgeTask['state'] | null => {
  switch (status) {
    case 'completed':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return 'stopped'
    case 'running':
    case 'pending':
      return 'running'
    default:
      return null
  }
}

export class TaskRegistry {
  readonly #entries = new Map<string, Entry>()
  /**
   * Commands seen in `tool_use` blocks, waiting for a task to claim them —
   * with the description the agent gave, the tool it went through, and the
   * moment it was seen. All three are needed by a notification that arrives
   * first: a shell that fails in its first millisecond is announced as over
   * before anything has said it started, and the block is then the only
   * thing that knows its name, its kind, and when it began.
   */
  readonly #commands = new Map<
    string,
    { command: string; description?: string; kind: BridgeTask['kind']; at: number }
  >()
  /** Tasks whose label came from a closing summary, not from a name. */
  readonly #namedBySummary = new Set<string>()
  #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /**
   * Folds one SDK message in. Returns true when the list a client would draw
   * changed, so the caller announces only what is worth announcing.
   */
  observe(message: unknown): boolean {
    const record = asRecord(message)
    if (!record) return false
    if (record['type'] === 'assistant') return this.#observeToolUses(record)
    if (record['type'] === 'user') return this.#observeToolResults(record)
    if (record['type'] !== 'system') return false
    switch (record['subtype']) {
      case 'background_tasks_changed':
        return this.#observeRunningSet(record['tasks'])
      case 'task_started':
        return this.#observeStarted(record)
      case 'task_updated':
        return this.#observeUpdated(record)
      case 'task_notification':
        return this.#observeNotification(record)
      default:
        return false
    }
  }

  list(): readonly BridgeTask[] {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      state: entry.state,
      startedAt: entry.startedAt,
      stoppable: entry.state === 'running',
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.outputFile ? { outputFile: entry.outputFile } : {}),
      ...(entry.output !== undefined ? { output: entry.output } : {}),
      ...(entry.outputTruncated ? { outputTruncated: true } : {}),
      ...(entry.outputMissing ? { outputMissing: true } : {}),
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
    }))
  }

  /**
   * The finished tasks whose output has not been read yet: Claude Code names
   * the file in `task_notification` and never sends the text, so the bridge
   * goes and gets it. Read once a task has ended — it has stopped writing —
   * and retried by the caller for a few seconds when the file is not there
   * yet. A fresh list each call; a session holds a handful of tasks, never
   * a thousand, so the allocation is not worth a cursor.
   */
  awaitingOutput(): readonly { readonly id: string; readonly outputFile: string }[] {
    return [...this.#entries.values()]
      .filter(
        (entry) =>
          entry.state !== 'running' && entry.outputFile && entry.output === undefined && !entry.outputMissing,
      )
      .map((entry) => ({ id: entry.id, outputFile: entry.outputFile! }))
  }

  /**
   * The bridge stopped looking: the file was never there. Said on the task
   * so a panel can tell "never found" from "not yet", and so the task drops
   * out of `awaitingOutput()` for good. False when nothing changed.
   */
  markOutputMissing(taskId: string): boolean {
    const entry = this.#entries.get(taskId)
    if (!entry || entry.output !== undefined || entry.outputMissing) return false
    entry.outputMissing = true
    return true
  }

  /** Hands a task what it printed. False when nothing changed. */
  attachOutput(taskId: string, output: string, truncated = false): boolean {
    const entry = this.#entries.get(taskId)
    if (!entry || entry.output === output) return false
    entry.output = output
    entry.outputTruncated = truncated
    // Output that arrived is output that was found, whatever was said before.
    entry.outputMissing = false
    return true
  }

  /** Drops what has finished. Running tasks are untouched. */
  clearFinished(): boolean {
    let changed = false
    for (const [id, entry] of this.#entries) {
      if (entry.state === 'running') continue
      this.#entries.delete(id)
      changed = true
    }
    return changed
  }

  /**
   * Marks one stopped without waiting for Claude Code to say so, after a stop
   * it accepted. The stream confirms it a moment later with the same state,
   * so this only shortens the gap between the button and the row changing.
   */
  markStopped(taskId: string): boolean {
    const entry = this.#entries.get(taskId)
    if (!entry || entry.state !== 'running') return false
    entry.state = 'stopped'
    entry.endedAt = this.#now()
    return true
  }

  // ------------------------------------------------------------------ private

  #observeToolUses(record: Record<string, unknown>): boolean {
    const message = asRecord(record['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return false
    // True when a block renamed, re-kinded or re-dated a task the notification
    // had already announced — that is a list a client is drawing wrongly, and
    // the client's own refresh answers from the last push, so it has to be
    // pushed again. A block that merely waits for its task changes nothing.
    let changed = false
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block || block['type'] !== 'tool_use') continue
      const id = asString(block['id'])
      const input = asRecord(block['input'])
      if (!id || !input) continue
      if (input['run_in_background'] !== true) continue
      const command = asString(input['command']) ?? asString(input['prompt'])
      if (!command) continue
      const description = asString(input['description'])
      const joined = {
        command,
        ...(description ? { description } : {}),
        kind: kindOf(asString(block['name'])),
        at: this.#now(),
      }
      this.#commands.set(id, joined)
      // A tool use the registry already knows about — the join can arrive
      // either way round, since `task_started` and the assistant message are
      // two messages that race on a stream.
      for (const entry of this.#entries.values()) {
        if (entry.toolUseId !== id) continue
        if (!entry.command) {
          entry.command = command
          changed = true
        }
        if (this.#adoptJoin(entry, joined)) changed = true
      }
    }
    return changed
  }

  /**
   * The tool results, which on the newer wire are where a task is announced.
   *
   * A backgrounded call answers at once with the task's id and the file it
   * writes to — the only start message 2.1.258 sends — and a later
   * `TaskOutput` read carries the task's own status, which lands seconds
   * before the notification. Both are read; on the older wire, which also
   * sends `task_started`, they merely agree with it.
   */
  #observeToolResults(record: Record<string, unknown>): boolean {
    const message = asRecord(record['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return false
    let changed = false
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block || block['type'] !== 'tool_result') continue
      const toolUseId = asString(block['tool_use_id'])
      const text = resultText(block['content'])
      if (!toolUseId || !text) continue

      const started = startedIdOf(text)
      if (started) {
        const joined = this.#commands.get(toolUseId)
        const outputFile = outputFileOf(text)
        changed =
          this.#upsert(started, {
            ...(joined?.description ? { label: joined.description } : joined ? { label: joined.command } : {}),
            kind: joined?.kind ?? 'command',
            state: 'running',
            toolUseId,
            ...(joined ? { startedAt: joined.at, command: joined.command } : {}),
            ...(outputFile ? { outputFile } : {}),
          }) || changed
        continue
      }

      const taskId = TAG_TASK_ID.exec(text)?.[1]
      if (!taskId) continue
      const status = stateOf(TAG_STATUS.exec(text)?.[1])
      const taskType = TAG_TASK_TYPE.exec(text)?.[1]
      if (status && status !== 'running') {
        changed = this.#upsert(taskId, { state: status, endedAt: this.#now() }) || changed
      }
      if (taskType) changed = this.#upsert(taskId, { kind: kindOf(taskType) }) || changed
    }
    return changed
  }

  /**
   * What the tool-use block knows, given to an entry the notification named
   * first: the description is the name (the summary was standing in for
   * one), the tool is the kind (a notification carries no `task_type`), and
   * the block's moment is when it started rather than when it was found to
   * be over. True when anything moved.
   */
  #adoptJoin(entry: Entry, joined: { description?: string; kind: BridgeTask['kind']; at: number }): boolean {
    let changed = false
    if (joined.description && (entry.label === entry.id || this.#namedBySummary.has(entry.id))) {
      if (entry.label !== joined.description) changed = true
      entry.label = joined.description
      this.#namedBySummary.delete(entry.id)
    }
    if (entry.kind === 'other' && joined.kind !== 'other') {
      entry.kind = joined.kind
      changed = true
    }
    if (joined.at < entry.startedAt) {
      entry.startedAt = joined.at
      changed = true
    }
    return changed
  }

  /**
   * The whole running set, replacing the previous one. A task this names that
   * is not yet known is new; one that is known and running but *absent* has
   * ended, and is left as `completed` unless a `task_notification` has
   * already said otherwise — which it usually has, since the notification
   * comes first.
   */
  #observeRunningSet(raw: unknown): boolean {
    if (!Array.isArray(raw)) return false
    let changed = false
    const running = new Set<string>()
    for (const value of raw) {
      const task = asRecord(value)
      const id = task ? asString(task['task_id']) : undefined
      if (!task || !id) continue
      running.add(id)
      changed = this.#upsert(id, {
        ...(asString(task['description']) ? { label: asString(task['description'])! } : {}),
        kind: kindOf(asString(task['task_type'])),
        state: 'running',
      }) || changed
    }
    for (const entry of this.#entries.values()) {
      if (running.has(entry.id) || entry.state !== 'running') continue
      entry.state = 'completed'
      entry.endedAt ??= this.#now()
      changed = true
    }
    return changed
  }

  #observeStarted(record: Record<string, unknown>): boolean {
    const id = asString(record['task_id'])
    if (!id) return false
    const toolUseId = asString(record['tool_use_id'])
    const joined = toolUseId ? this.#commands.get(toolUseId) : undefined
    return this.#upsert(id, {
      ...(asString(record['description']) ? { label: asString(record['description'])! } : {}),
      kind: kindOf(asString(record['task_type'])),
      state: 'running',
      ...(toolUseId ? { toolUseId } : {}),
      ...(joined ? { command: joined.command } : {}),
    })
  }

  #observeUpdated(record: Record<string, unknown>): boolean {
    const id = asString(record['task_id'])
    const patch = asRecord(record['patch'])
    if (!id || !patch) return false
    const state = stateOf(asString(patch['status']))
    const endTime = typeof patch['end_time'] === 'number' ? patch['end_time'] : undefined
    if (!state && endTime === undefined) return false
    return this.#upsert(id, {
      ...(state ? { state } : {}),
      ...(endTime !== undefined ? { endedAt: endTime } : {}),
    })
  }

  #observeNotification(record: Record<string, unknown>): boolean {
    const id = asString(record['task_id'])
    if (!id) return false
    const toolUseId = asString(record['tool_use_id'])
    const joined = toolUseId ? this.#commands.get(toolUseId) : undefined
    const summary = asString(record['summary'])
    const unnamed = !this.#entries.has(id)
    // A task nothing has named yet takes the block's description if the
    // block has been seen, and the summary only failing that — the summary
    // is a sentence about how it went, and is kept as one either way.
    const label = joined?.description ?? summary
    const changed = this.#upsert(id, {
      state: stateOf(asString(record['status'])) ?? 'completed',
      endedAt: this.#now(),
      ...(label ? { label } : {}),
      ...(summary ? { summary } : {}),
      // `label` above only lands on a task nothing has named yet — see `#upsert`.
      ...(asString(record['output_file']) ? { outputFile: asString(record['output_file'])! } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      ...(joined ? { command: joined.command, kind: joined.kind, startedAt: joined.at } : {}),
    })
    // Remember when the summary is standing in for a name, so the block —
    // which may still be on its way — can replace it.
    if (unnamed && !joined?.description && summary) this.#namedBySummary.add(id)
    return changed
  }

  /**
   * Merges a patch into one entry, creating it if this is the first word
   * about it. A finished task is never dragged back to running: the running
   * set and the notification for the same task can arrive in either order,
   * and only one of them is about how it ended.
   */
  #upsert(id: string, patch: Partial<Omit<Entry, 'id'>>): boolean {
    const existing = this.#entries.get(id)
    if (!existing) {
      this.#entries.set(id, {
        id,
        label: patch.label ?? id,
        kind: patch.kind ?? 'other',
        state: patch.state ?? 'running',
        startedAt: patch.startedAt ?? this.#now(),
        ...(patch.command ? { command: patch.command } : {}),
        ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
        ...(patch.summary ? { summary: patch.summary } : {}),
        ...(patch.outputFile ? { outputFile: patch.outputFile } : {}),
        ...(patch.toolUseId ? { toolUseId: patch.toolUseId } : {}),
      })
      return true
    }
    let changed = false
    const settle = <K extends keyof Entry>(key: K, value: Entry[K] | undefined): void => {
      if (value === undefined || existing[key] === value) return
      existing[key] = value
      changed = true
    }
    if (patch.state && !(existing.state !== 'running' && patch.state === 'running')) {
      settle('state', patch.state)
    }
    // The name a task was given when it started is the name it keeps. Claude
    // Code's closing summary is a whole sentence — *Background command "Run
    // pnpm tests in watch mode" failed with exit code 1* — which renames the
    // row at the moment it ends and then truncates. The state icon already
    // says how it went; the summary is kept for the tooltip. A name that
    // *is* a summary, because the notification came first, gives way to the
    // description when `task_started` or the running set finally brings it.
    if (patch.label && (existing.label === existing.id || this.#namedBySummary.has(id))) {
      if (patch.label !== existing.summary) this.#namedBySummary.delete(id)
      settle('label', patch.label)
    }
    settle('kind', patch.kind === 'other' ? undefined : patch.kind)
    settle('command', patch.command)
    settle('summary', patch.summary)
    settle('outputFile', patch.outputFile)
    settle('toolUseId', patch.toolUseId)
    // The first end stands. On the newer wire a `TaskOutput` read says a
    // task ended seconds before the notification repeats it, and the later
    // stamp would stretch a one-millisecond failure into a fifteen-second
    // one; on the older wire the transition patch carries `end_time` and
    // nothing has set the end yet, so it lands as it always did.
    if (existing.state !== 'running') settle('endedAt', existing.endedAt ?? patch.endedAt ?? this.#now())
    return changed
  }
}
