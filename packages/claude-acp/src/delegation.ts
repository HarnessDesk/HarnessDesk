import type { BridgeDelegation, DelegationUsage } from './delegation-wire.js'

/**
 * Claude Code's delegations, read off the SDK stream.
 *
 * Claude Code delegates by calling a tool — `Agent` today, `Task` in older
 * builds — and then runs the child on the *same* stream as the parent, with
 * every message the child produces carrying `parent_tool_use_id` set to the
 * id of the tool call that spawned it. There is no second session, no second
 * process, and nothing that announces a child by name. The join is that one
 * field:
 *
 * ```
 * assistant  parent_tool_use_id: null   tool_use { id: "toolu_A", name: "Agent",
 *                                                  input: { subagent_type: "Explore", prompt } }
 * assistant  parent_tool_use_id: "toolu_A"  message { model, usage }   ← the child's first call
 * assistant  parent_tool_use_id: "toolu_A"  message { model, usage }   ← …and its second
 * user       parent_tool_use_id: null   tool_result { tool_use_id: "toolu_A" }  ← it is done
 * ```
 *
 * The bridge has read `parent_tool_use_id` all along, to keep a child's input
 * out of the parent's context fill, and its own comment there notes the
 * children are "still the session's spend". This class is that spend, kept
 * apart rather than summed away: per delegation, what it was asked, what
 * model actually answered, how many calls it took and what those cost.
 *
 * Everything is read structurally. These are observed shapes — the SDK's
 * published types name none of the fields this depends on — and an observed
 * shape is allowed to grow a field without breaking us.
 */

/** The house style for a delegating tool. Both names have shipped. */
const DELEGATING_TOOLS = new Set(['Agent', 'Task'])

interface Entry {
  id: string
  label: string
  state: BridgeDelegation['state']
  prompt?: string
  requestedModel?: string
  models: string[]
  startedAt: number
  endedAt?: number
  calls: number
  input: number
  output: number
  cachedRead: number
  cachedWrite: number
  outputExact: boolean
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * Whether a tool call is a delegation.
 *
 * By name where the name is one we know, and by shape otherwise: a call that
 * carries a `subagent_type` is delegating whatever it is called, and a build
 * that renames the tool again should not silently empty this panel.
 */
const delegates = (name: string | undefined, input: Record<string, unknown>): boolean =>
  (name !== undefined && DELEGATING_TOOLS.has(name)) || asString(input['subagent_type']) !== undefined

export class DelegationRegistry {
  readonly #entries = new Map<string, Entry>()

  /** Injectable so a test can pin the clock, as `TaskRegistry` does. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Reads one SDK message. True when the list changed and is worth pushing.
   *
   * A usage-only change counts: a running child whose token count moved is
   * the whole point of the panel.
   */
  observe(message: unknown): boolean {
    const record = asRecord(message)
    if (!record) return false
    const parent = record['parent_tool_use_id']
    if (record['type'] === 'assistant') {
      return typeof parent === 'string' && parent.length > 0
        ? this.#observeChildCall(parent, record)
        : this.#observeSpawns(record)
    }
    if (record['type'] === 'user') return this.#observeResults(record)
    return false
  }

  /** Every delegation this session made, oldest first. */
  list(): readonly BridgeDelegation[] {
    return [...this.#entries.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        state: entry.state,
        ...(entry.prompt ? { prompt: entry.prompt } : {}),
        ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
        models: [...entry.models],
        startedAt: entry.startedAt,
        ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
        calls: entry.calls,
        ...(entry.calls > 0 ? { usage: usageOf(entry) } : {}),
      }))
  }

  /**
   * What every child of this session has spent, summed.
   *
   * A share of the session's own total and never an addition to it: Claude
   * Code's `modelUsage` is cumulative over the process, so the parent's
   * counts already contain these. Summed here so the client can *split* a
   * total it must not re-sum.
   */
  totals(): DelegationUsage | null {
    const counted = [...this.#entries.values()].filter((entry) => entry.calls > 0)
    if (counted.length === 0) return null
    return usageOf({
      input: counted.reduce((sum, entry) => sum + entry.input, 0),
      output: counted.reduce((sum, entry) => sum + entry.output, 0),
      cachedRead: counted.reduce((sum, entry) => sum + entry.cachedRead, 0),
      cachedWrite: counted.reduce((sum, entry) => sum + entry.cachedWrite, 0),
      outputExact: counted.every((entry) => entry.outputExact),
    })
  }

  /**
   * A delegation the parent spawned. Its own model and prompt come from the
   * tool call's input, which is the only place either is stated.
   */
  #observeSpawns(record: Record<string, unknown>): boolean {
    const message = asRecord(record['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return false
    let changed = false
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block || block['type'] !== 'tool_use') continue
      const id = asString(block['id'])
      const input = asRecord(block['input'])
      if (!id || !input || !delegates(asString(block['name']), input)) continue
      const existing = this.#entries.get(id)
      // The child's calls can reach us before the spawn does — two messages
      // on one stream race — so a placeholder made there is filled in here
      // rather than replaced, which would drop the tokens already counted.
      const entry = existing ?? this.#placeholder(id)
      entry.label = asString(input['subagent_type']) ?? asString(block['name']) ?? entry.label
      const prompt = asString(input['prompt']) ?? asString(input['description'])
      if (prompt) entry.prompt = prompt
      const model = asString(input['model'])
      if (model) entry.requestedModel = model
      this.#entries.set(id, entry)
      changed = true
    }
    return changed
  }

  /** One API call made by a child, added to the delegation that owns it. */
  #observeChildCall(parent: string, record: Record<string, unknown>): boolean {
    const message = asRecord(record['message'])
    const usage = asRecord(message?.['usage'])
    const entry = this.#entries.get(parent) ?? this.#placeholder(parent)
    this.#entries.set(parent, entry)
    const model = asString(message?.['model'])
    if (model && !entry.models.includes(model)) entry.models.push(model)
    if (!usage) return true
    const input = asCount(usage['input_tokens'])
    const cachedRead = asCount(usage['cache_read_input_tokens'])
    const cachedWrite = asCount(usage['cache_creation_input_tokens'])
    const output = asCount(usage['output_tokens'])
    entry.calls += 1
    entry.input += input + cachedRead + cachedWrite
    entry.cachedRead += cachedRead
    entry.cachedWrite += cachedWrite
    entry.output += output
    // The `message_start` signature: real input, an output count of 1 or 0
    // that was true when the stream opened and is a floor by the time it
    // closes. One such call makes the whole delegation's output a floor.
    if (output <= 1 && input + cachedRead + cachedWrite > 0) entry.outputExact = false
    return true
  }

  /** The parent's tool result: this delegation has finished, one way or another. */
  #observeResults(record: Record<string, unknown>): boolean {
    const message = asRecord(record['message'])
    const content = message?.['content']
    if (!Array.isArray(content)) return false
    let changed = false
    for (const raw of content) {
      const block = asRecord(raw)
      if (!block || block['type'] !== 'tool_result') continue
      const id = asString(block['tool_use_id'])
      if (!id) continue
      const entry = this.#entries.get(id)
      if (!entry || entry.state !== 'running') continue
      entry.state = block['is_error'] === true ? 'failed' : 'completed'
      entry.endedAt = this.now()
      changed = true
    }
    return changed
  }

  /**
   * A delegation known only by its id.
   *
   * Named for the id rather than left blank: a row reading `toolu_01A…` is a
   * poor label and a true one, and it is what lets a child's tokens be
   * counted against something when its spawn has not arrived yet.
   */
  #placeholder(id: string): Entry {
    return {
      id,
      label: id,
      state: 'running',
      models: [],
      startedAt: this.now(),
      calls: 0,
      input: 0,
      output: 0,
      cachedRead: 0,
      cachedWrite: 0,
      outputExact: true,
    }
  }
}

const usageOf = (entry: {
  input: number
  output: number
  cachedRead: number
  cachedWrite: number
  outputExact: boolean
}): DelegationUsage => ({
  inputTokens: entry.input,
  outputTokens: entry.output,
  cachedReadTokens: entry.cachedRead,
  cachedWriteTokens: entry.cachedWrite,
  totalTokens: entry.input + entry.output,
  outputExact: entry.outputExact,
})
