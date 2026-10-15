import { resolve } from 'node:path'
import { PATH_KEYS, shellCommandOf, type AgentItem, type FileChange, type ToolCallItem } from '@harnessdesk/protocol'
import type { AcpToolCallUpdate } from '@harnessdesk/transport-acp'

/** Keep wire facts beside the generic call, never in the public transcript. */
export interface ToolItemState {
  readonly call: ToolCallItem
  readonly kind?: string
  readonly title?: string
  readonly diffContent?: AcpToolCallUpdate['content']
  readonly locations?: AcpToolCallUpdate['locations']
  readonly item: Extract<AgentItem, { type: 'toolCall' | 'fileChange' | 'command' }>
}

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

// Input describes an intention, not a file's prior state or a line boundary.
// Keep its text visible, but omit hunk headers so Undo refuses these fragments.
// Only ACP diff content may establish a creation or a reversible line patch.
const inputChangesOf = (call: ToolCallItem, cwd: string): readonly FileChange[] | undefined => {
  const input = objectOf(call.args)
  if (!input) return undefined
  const path = PATH_KEYS.map(key => input[key]).find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  if (!path) return undefined
  const stringOf = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string')
  const marked = (mark: string, text: string) => (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .map(line => `${mark}${line.endsWith('\n') ? line : `${line}\n`}`).join('')
  const replacement = (value: Record<string, unknown>): string | undefined => {
    const before = stringOf(value.old_string, value.old_str)
    const after = stringOf(value.new_string, value.new_str)
    return before === undefined || after === undefined ? undefined
      : before === after ? '' : marked('-', before) + marked('+', after)
  }
  let diff = replacement(input)
  if (diff === undefined && Array.isArray(input.edits)) {
    const edits = input.edits.map(edit => {
      const value = objectOf(edit)
      return value ? replacement(value) : undefined
    })
    if (edits.length && edits.every(edit => edit !== undefined)) diff = edits.join('')
  }
  if (diff === undefined) {
    const content = stringOf(input.content, input.file_text, input.file_content, input.streamContent, input.code_edit, input.diff, input.patch, input.new_source)
    if (content !== undefined) diff = marked('+', content)
  }
  return diff === undefined ? undefined : [{ path: resolve(cwd, path), kind: { type: 'update' }, diff }]
}

// ACP supplies old/new text, sometimes just a changed region. A single hunk
// after trimming shared edges is linear in the text size and needs no file I/O.
const unifiedDiff = (oldText: string, newText: string, oldLine: number, newLine: number): string => {
  if (oldText === newText) return ''
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const old = lines(oldText)
  const next = lines(newText)
  let prefix = 0
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const from = Math.max(0, prefix - 3)
  const oldEnd = Math.min(old.length, old.length - suffix + 3)
  const newEnd = Math.min(next.length, next.length - suffix + 3)
  // A block can be a joined hunk snippet: its last line says nothing about
  // the file's final newline. EOF markers would make Undo reject that hunk.
  const marked = (mark: string, text: string) => `${mark}${text.endsWith('\n') ? text : `${text}\n`}`
  const body = [
    ...old.slice(from, prefix).map(text => marked(' ', text)),
    ...old.slice(prefix, old.length - suffix).map(text => marked('-', text)),
    ...next.slice(prefix, next.length - suffix).map(text => marked('+', text)),
    ...old.slice(old.length - suffix, oldEnd).map(text => marked(' ', text)),
  ].join('')
  return `@@ -${oldLine + from - (oldEnd === from ? 1 : 0)},${oldEnd - from} +${newLine + from - (newEnd === from ? 1 : 0)},${newEnd - from} @@\n${body}`
}

const changesOf = (update: AcpToolCallUpdate, cwd: string): readonly FileChange[] | undefined => {
  const changes = new Map<string, FileChange>()
  const regions = new Map<string, { count: number; delta: number }>()
  for (const block of Array.isArray(update.content) ? update.content : []) {
    if (!block || block.type !== 'diff' || typeof block.path !== 'string' || !block.path.trim() ||
      typeof block.newText !== 'string' || !(block.oldText === null || typeof block.oldText === 'string')) continue
    const path = resolve(cwd, block.path)
    const region = regions.get(path) ?? { count: 0, delta: 0 }
    const locations = Array.isArray(update.locations) ? update.locations.filter(location => location?.path === block.path) : []
    const location = locations[region.count]
    const line = typeof location?.line === 'number' && Number.isInteger(location.line) && location.line > 0 ? location.line : 1
    const change: FileChange = block.oldText === null
      ? { path, kind: { type: 'add' }, diff: block.newText }
      : { path, kind: { type: 'update' }, diff: unifiedDiff(block.oldText, block.newText, Math.max(1, line - region.delta), line) }
    const count = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0
    regions.set(path, { count: region.count + 1, delta: region.delta + count(block.newText) - count(block.oldText ?? '') })
    const previous = changes.get(path)
    changes.set(path, previous ? { ...change, diff: previous.diff + change.diff } : change)
  }
  return changes.size ? [...changes.values()] : undefined
}

export const projectToolItem = (
  call: ToolCallItem,
  update: AcpToolCallUpdate,
  previous: ToolItemState | undefined,
  cwd: string,
): ToolItemState => {
  // Streamed input can already contain a description before the command or
  // path arrives. Keep those late fields as well as the first nonempty input.
  const incoming = objectOf(update.rawInput)
  if (incoming) call = { ...call, args: { ...objectOf(call.args), ...incoming } }
  const kind = update.kind ?? previous?.kind
  const title = update.title ?? previous?.title
  const locations = update.locations ?? previous?.locations
  let changes = changesOf({ ...update, locations }, cwd)
  const diffContent = changes ? update.content : previous?.diffContent
  changes ??= changesOf({ toolCallId: call.id, content: diffContent, locations }, cwd)
  if (!changes && kind === 'edit') changes = inputChangesOf(call, cwd)
  let item: ToolItemState['item'] = call
  const base = { id: call.id, status: call.status, startedAt: call.startedAt, completedAt: call.completedAt }
  if (kind === 'edit' || changes) {
    const byPath = new Map((changes ?? []).map(change => [change.path, change]))
    const input = objectOf(call.args)
    const paths: unknown[] = [
      ...(Array.isArray(locations) ? locations.map(location => location?.path) : []),
      ...PATH_KEYS.map(key => input?.[key]),
    ]
    for (const path of paths) {
      if (typeof path !== 'string' || !path.trim()) continue
      const absolute = resolve(cwd, path)
      if (!byPath.has(absolute)) byPath.set(absolute, { path: absolute, kind: { type: 'update' }, diff: '' })
    }
    changes = [...byPath.values()]
    // The tool reply is written for the model; a file card carries only changes.
    item = { ...base, type: 'fileChange', changes }
  } else if (kind === 'execute') {
    const command = shellCommandOf(call)
    // A meaningful title is the agent's narration. Preserve that existing
    // posture; generic shell labels and command-only titles use CommandItem.
    if (command && !call.result?.some(part => part.type === 'image') && (!title || /^(terminal|bash|shell|execute|command)$/i.test(title.trim()) || title === command || title === `\`${command}\``)) {
      const text = call.result?.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      const stored = call.result?.find(part => part.type === 'json')
      const raw = stored?.type === 'json' ? stored.value : undefined
      const output = objectOf(raw)
      const printed = [output?.stdout, output?.stderr].filter((value): value is string => typeof value === 'string').join('')
      const blocks = Array.isArray(raw) ? raw.flatMap(part => {
        const block = objectOf(part)
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      }).join('\n') : ''
      const outputText = typeof raw === 'string' ? raw : printed || blocks || text
      const exitCode = output?.exitCode ?? output?.exit_code
      item = {
        ...base, type: 'command', command, cwd, origin: 'agent', actions: [{ type: 'unknown', command }],
        ...(outputText ? { output: outputText } : {}),
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
      }
    }
  }
  return { call, kind, title, diffContent, locations, item }
}
