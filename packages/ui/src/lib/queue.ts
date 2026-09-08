import type { QueuedMessage, UserContent } from '@harnessdesk/protocol'

import { splitContext, type ContextBlock } from './context-envelope'

/**
 * Reading a queued message back.
 *
 * A queued message is `UserContent[]` — the same array that would have gone to
 * the agent — so the row that shows it and the composer that takes it back for
 * editing both need it turned into something a person recognises: the words
 * they typed, and what rode along with them.
 */

export interface QueuedAttachment {
  readonly kind: 'image' | 'mention' | 'skill'
  readonly name: string
  readonly path: string
}

export interface QueuedView {
  /** What the user actually typed, with any context envelopes taken out. */
  readonly text: string
  readonly attachments: readonly QueuedAttachment[]
  /**
   * The blocks of context riding along — a plugin chip's resolved output, or
   * marks made on a page. Counted rather than shown in a row, which is one
   * line; kept whole so that editing the message can hand them back as the
   * chips they were, instead of losing what the message promised to carry.
   */
  readonly context: readonly ContextBlock[]
}

export const describeQueued = (input: readonly UserContent[]): QueuedView => {
  const spoken: string[] = []
  const attachments: QueuedAttachment[] = []
  const context: ContextBlock[] = []

  for (const part of input) {
    if (part.type === 'text') {
      const split = splitContext(part.text)
      context.push(...split.injections)
      if (split.text.length > 0) spoken.push(split.text)
      continue
    }
    if (part.type === 'image') {
      attachments.push({ kind: 'image', name: part.name ?? 'Image', path: part.url })
      continue
    }
    if (part.type === 'localImage') {
      attachments.push({
        kind: 'image',
        name: part.path.split('/').pop() ?? part.path,
        path: part.path,
      })
      continue
    }
    if (part.type === 'skill' || part.type === 'mention') {
      attachments.push({ kind: part.type, name: part.name, path: part.path })
    }
  }

  return { text: spoken.join('\n\n'), attachments, context }
}

/** One line for a list row: the first line of what was typed, or what it carries. */
export const queuedLabel = (message: QueuedMessage): string => {
  const view = describeQueued(message.input)
  const first = view.text.split('\n').find((line) => line.trim().length > 0)?.trim()
  if (first) return first
  if (view.attachments.length > 0) {
    return view.attachments.map((attachment) => attachment.name).join(', ')
  }
  return view.context.length > 0 ? 'Context only' : 'Empty message'
}
