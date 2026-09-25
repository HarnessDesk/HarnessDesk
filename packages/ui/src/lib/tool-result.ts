/**
 * What a tool call's own result actually is, however the runtime shaped it.
 *
 * Every adapter answers a call in its own JSON, and a step used to draw
 * whatever didn't match a known shape as pretty-printed JSON — right for
 * genuinely structured output, wrong for the several shapes that are a plain
 * result wearing a different runtime's envelope: an MCP content array
 * (Claude Code's Agent tool), a command's own record (Antigravity), or an
 * `{output, isError}` pair (DeepSeek). Read once, here, into one of a few
 * known kinds; a shape none of these name stays `'json'`, unchanged.
 *
 * Pure — no React, no store, nothing runtime-specific — so it can be run
 * straight over stored transcripts to check nothing real still falls
 * through. `Items.tsx` decides how each kind draws.
 */

export type ToolResultBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string; readonly mimeType?: string }

export type ToolResultReading =
  /** An MCP-shaped content array. */
  | { readonly kind: 'blocks'; readonly blocks: readonly ToolResultBlock[] }
  /** A command's own record. */
  | { readonly kind: 'command'; readonly command: string; readonly output?: string; readonly exitCode?: number }
  /** A bare output-and-error pair. */
  | { readonly kind: 'output'; readonly text: string; readonly error: boolean }
  /** Nothing named above recognised it; it stays structured JSON. */
  | { readonly kind: 'json' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One block of a content array, in the shape a top-level text/image result already draws. */
const blockOf = (value: unknown): ToolResultBlock | null => {
  if (!isRecord(value)) return null
  if (value['type'] === 'text' && typeof value['text'] === 'string') {
    return { type: 'text', text: value['text'] }
  }
  if (value['type'] === 'image' && typeof value['url'] === 'string') {
    const mimeType = value['mimeType']
    return typeof mimeType === 'string'
      ? { type: 'image', url: value['url'], mimeType }
      : { type: 'image', url: value['url'] }
  }
  return null
}

/**
 * The MCP-shaped content array a tool's own result sometimes arrives wrapped
 * in — `[{type: "text", text: "…"}]`, sometimes one level further under a
 * `content` key. Every element has to be a block this reads, or none of it
 * is: an array carrying one block this module does not know (a
 * `tool_reference` block, among others) falls back to plain JSON as a
 * whole, rather than drawing what it understood and dropping the rest.
 */
const blocksOf = (value: unknown): readonly ToolResultBlock[] | null => {
  const array = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value['content'])
      ? value['content']
      : null
  if (!array || array.length === 0) return null
  const blocks = array.map(blockOf)
  return blocks.every((block): block is ToolResultBlock => block !== null) ? blocks : null
}

/**
 * A command's own record for what it ran — not text, not a content array,
 * the shell tool's own fields. Read only when the field naming the command
 * and one naming its output are both strings, so an unrelated object with a
 * same-named key is not pulled apart on a coincidence.
 */
const commandOf = (value: unknown): ToolResultReading | null => {
  if (!isRecord(value)) return null
  const command = value['commandLine']
  if (typeof command !== 'string') return null
  const output = value['combinedOutput'] ?? value['formatted_output']
  if (typeof output !== 'string') return null
  const exitCode = value['exitCode'] ?? value['exit_code']
  return typeof exitCode === 'number' ? { kind: 'command', command, output, exitCode } : { kind: 'command', command, output }
}

/** A bare `{output, isError}` pair, carried on every one of some runtimes' results. */
const outputOf = (value: unknown): ToolResultReading | null => {
  if (!isRecord(value)) return null
  const output = value['output']
  if (typeof output !== 'string') return null
  if (typeof value['isError'] !== 'boolean') return null
  return { kind: 'output', text: output, error: value['isError'] }
}

/** What a tool's own JSON result reads as, for the transcript to draw. */
export const readToolResult = (value: unknown): ToolResultReading => {
  const blocks = blocksOf(value)
  if (blocks) return { kind: 'blocks', blocks }
  return commandOf(value) ?? outputOf(value) ?? { kind: 'json' }
}
