import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  itemId,
  turnId,
  type AgentItem,
  type RuntimeId,
  type Session,
  type SessionId,
  type ToolCallItem,
  type Turn,
} from '@harnessdesk/protocol'

/**
 * A last-resort read of a Codex conversation, straight from its file on disk.
 *
 * Codex's own `thread/read` refuses a whole thread over one item it cannot
 * deserialize — a rollout written by a newer build (the desktop app ships
 * alphas) contains item kinds the stable CLI has never heard of, and the
 * user's conversation becomes unopenable everywhere. The rollout is plain
 * JSONL, though, and most of what a reader wants — what was said, what was
 * run — parses fine line by line. This reads what it can, skips what it
 * cannot, and says so, so the conversation is at least readable here.
 */

interface RolloutLine {
  readonly timestamp?: string
  readonly type?: string
  readonly payload?: Record<string, unknown> | null
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((part) => {
          const shaped = part as { text?: unknown } | null
          return shaped && typeof shaped.text === 'string' ? shaped.text : ''
        })
        .join('')
    : ''

const OUTPUT_LIMIT = 20_000

/**
 * Codex appends its memory citations to the prose itself — an
 * `<oai-mem-citation>` block of `MEMORY.md:108-118|note=[…]` lines — and its
 * own UI renders them as chips. A markdown renderer swallows the tags and
 * shows the entries as the agent trailing off into plumbing, so the whole
 * block goes, along with any bare trailing citation lines.
 */
const CITATION_BLOCK = /<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/g
const CITATION_LINE = /^\S+:\d+(?:-\d+)?\|note=\[[^\]]*\](?:\s+[0-9a-f][0-9a-f-]{20,})?$/
const stripCitations = (text: string): string => {
  const lines = text.replace(CITATION_BLOCK, '').split('\n')
  while (lines.length > 0) {
    const last = (lines[lines.length - 1] ?? '').trim()
    if (last.length === 0 || CITATION_LINE.test(last)) lines.pop()
    else break
  }
  return lines.join('\n').trimEnd()
}

/** The rollout file for a thread, wherever under `sessions/` it was filed. */
export const findRollout = async (codexHome: string | null, id: string): Promise<string | null> => {
  const root = join(codexHome ?? join(homedir(), '.codex'), 'sessions')
  try {
    const entries = await readdir(root, { recursive: true })
    const match = entries.find((entry) => String(entry).endsWith(`-${id}.jsonl`))
    return match ? join(root, String(match)) : null
  } catch {
    return null
  }
}

/** Reads the rollout into a read-only `Session`; null when nothing usable. */
export const salvageSession = async (
  codexHome: string | null,
  runtime: RuntimeId,
  id: SessionId,
): Promise<Session | null> => {
  const path = await findRollout(codexHome, id)
  if (!path) return null

  let cwd = ''
  let createdAt = 0
  let updatedAt = 0
  let writer: string | null = null
  const turns: { items: AgentItem[] }[] = []
  const calls = new Map<string, ToolCallItem>()
  let counter = 0
  const nextId = (): ReturnType<typeof itemId> => itemId(`salvage-${(counter += 1)}`)
  const current = (): { items: AgentItem[] } => {
    if (turns.length === 0) turns.push({ items: [] })
    return turns[turns.length - 1] as { items: AgentItem[] }
  }

  try {
    const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
    for await (const line of lines) {
      let entry: RolloutLine
      try {
        entry = JSON.parse(line) as RolloutLine
      } catch {
        continue
      }
      const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN
      if (Number.isFinite(at)) {
        if (createdAt === 0) createdAt = at
        updatedAt = at
      }
      const payload = entry.payload ?? {}
      if (entry.type === 'session_meta') {
        if (typeof payload['cwd'] === 'string') cwd = payload['cwd']
        const originator = typeof payload['originator'] === 'string' ? payload['originator'] : null
        const version = typeof payload['cli_version'] === 'string' ? payload['cli_version'] : null
        writer = originator ? `${originator}${version ? ` ${version}` : ''}` : version
        continue
      }
      if (entry.type === 'compacted') {
        current().items.push({ id: nextId(), type: 'notice', text: 'The conversation was compacted to fit in context.' })
        continue
      }
      if (entry.type !== 'response_item') continue
      const kind = payload['type']
      if (kind === 'message') {
        const text = textOf(payload['content']).trim()
        if (text.length === 0) continue
        if (payload['role'] === 'user') {
          // Scaffolding the desktop app writes as `user` — plugin lists,
          // app context — opens with a tag; a person's message does not.
          if (text.startsWith('<')) continue
          turns.push({
            items: [{ id: nextId(), type: 'userMessage', content: [{ type: 'text', text }] }],
          })
        } else if (payload['role'] === 'assistant') {
          const spoken = stripCitations(text)
          if (spoken.length > 0) current().items.push({ id: nextId(), type: 'assistantMessage', text: spoken })
        }
        continue
      }
      if (kind === 'reasoning') {
        const summary = Array.isArray(payload['summary'])
          ? payload['summary']
              .map((part) => {
                const shaped = part as { text?: unknown } | null
                return shaped && typeof shaped.text === 'string' ? shaped.text : ''
              })
              .filter((text) => text.length > 0)
          : []
        if (summary.length > 0) {
          current().items.push({ id: nextId(), type: 'reasoning', summary, content: [] })
        }
        continue
      }
      if (kind === 'custom_tool_call' || kind === 'function_call') {
        const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool'
        const namespace = typeof payload['namespace'] === 'string' ? payload['namespace'] : null
        let args: unknown = null
        if (kind === 'custom_tool_call') {
          args = typeof payload['input'] === 'string' ? { input: payload['input'] } : null
        } else if (typeof payload['arguments'] === 'string') {
          try {
            args = JSON.parse(payload['arguments'])
          } catch {
            args = { arguments: payload['arguments'] }
          }
        }
        const item: ToolCallItem = {
          id: nextId(),
          type: 'toolCall',
          tool: name,
          source: namespace ? { kind: 'dynamic', namespace } : { kind: 'builtin' },
          status: 'completed',
          args,
        }
        current().items.push(item)
        const callId = payload['call_id']
        if (typeof callId === 'string') calls.set(callId, item)
        continue
      }
      if (kind === 'custom_tool_call_output' || kind === 'function_call_output') {
        const callId = payload['call_id']
        const call = typeof callId === 'string' ? calls.get(callId) : undefined
        if (!call) continue
        const output = typeof payload['output'] === 'string' ? payload['output'] : textOf(payload['output'])
        if (output.trim().length === 0) continue
        const clipped = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}…` : output
        const index = current().items.indexOf(call)
        const finished: ToolCallItem = { ...call, result: [{ type: 'text', text: clipped }] }
        if (index >= 0) current().items[index] = finished
        if (typeof callId === 'string') calls.set(callId, finished)
      }
    }
  } catch {
    // A truncated or unreadable file: whatever parsed before the failure is
    // still worth showing, the same judgement as per-line parse errors.
  }

  const kept = turns.filter((turn) => turn.items.length > 0)
  if (kept.length === 0 || !kept.some((turn) => turn.items.some((item) => item.type === 'userMessage'))) return null
  const first = kept[0] as { items: AgentItem[] }
  first.items = [
    {
      id: itemId('salvage-note'),
      type: 'notice',
      text: `Recovered from the session file on disk — Codex could not load this conversation${
        writer ? ` (it was saved by ${writer})` : ''
      }. It is read-only here.`,
    },
    ...first.items,
  ]
  return {
    id,
    runtime,
    cwd,
    status: { type: 'idle' },
    createdAt: createdAt || Date.now(),
    updatedAt: updatedAt || createdAt || Date.now(),
    itemsLoaded: true,
    turns: kept.map(
      (turn, index): Turn => ({
        id: turnId(`salvage-t-${index + 1}`),
        status: 'completed',
        items: turn.items,
      }),
    ),
  }
}
