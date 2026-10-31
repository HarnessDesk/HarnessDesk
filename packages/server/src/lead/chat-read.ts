import type { PhoneWorkThread, PhoneWorkTurn } from '@harnessdesk/protocol'
import { threadProjection } from '../phone-thread.js'

const MAX_BYTES = 12_000
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const excerpt = (text: string, characters: number) => Array.from(text).slice(-characters).join('')

const shorten = (turn: PhoneWorkTurn, length: number): PhoneWorkTurn => {
  switch (turn.type) {
    case 'agent': return { ...turn, markdown: excerpt(turn.markdown, length) }
    case 'you': return { ...turn, text: excerpt(turn.text, length), attachments: turn.attachments.slice(-3).map(name => excerpt(name, 80)) }
    case 'work': return { ...turn, summary: excerpt(turn.summary, length), steps: [] }
    case 'changes': return { ...turn, files: turn.files.slice(-5).map(file => ({ ...file, path: excerpt(file.path, 120), hunks: [] })) }
    case 'approval': return { ...turn, title: excerpt(turn.title, 120), who: excerpt(turn.who, 80),
      command: excerpt(turn.command, length), why: excerpt(turn.why, Math.min(length, 300)),
      ...(turn.sessionGrant ? { sessionGrant: excerpt(turn.sessionGrant, 120) } : {}) }
  }
}

/** Phone transcripts can contain forty substantial turns. Supply a bounded,
 * explicitly partial recent view to the model, rather than losing the whole
 * successful read at the provider's per-tool-result ceiling. Full text stays
 * available in the ordinary chat on the desk and phone. */
export const boundLeadChatRead = (thread: PhoneWorkThread): PhoneWorkThread & { readonly omittedSourceTurns: number; readonly omittedPhoneEntries: number; readonly truncated: boolean } => {
  const projection = threadProjection(thread), omittedSourceTurns = projection?.omittedSourceTurns ?? 0
  const result = { ...(thread.leadChatHolder ? { leadChatHolder: thread.leadChatHolder } : {}), id: thread.id, title: excerpt(thread.title, 160), agent: { name: excerpt(thread.agent.name, 80),
    ...(thread.agent.model ? { model: excerpt(thread.agent.model, 100) } : {}) },
    ...(thread.project ? { project: excerpt(thread.project, 120) } : {}), status: thread.status,
    turns: [] as PhoneWorkTurn[], omittedSourceTurns, omittedPhoneEntries: thread.turns.length, truncated: projection?.truncated ?? false }
  for (let index = thread.turns.length - 1; index >= 0; index--) {
    const turn = thread.turns[index]!
    const candidate = { ...result, turns: [turn, ...result.turns], omittedPhoneEntries: index, truncated: (projection?.truncated ?? false) || omittedSourceTurns > 0 || index > 0 }
    if (bytes(candidate) <= MAX_BYTES) { Object.assign(result, candidate); continue }
    if (result.turns.length === 0) {
      let length = 2000
      do {
        result.turns = [shorten(turn, length)]
        result.omittedPhoneEntries = index; result.truncated = true
        length = Math.floor(length / 2)
      } while (bytes(result) > MAX_BYTES && length >= 16)
    }
    break
  }
  result.truncated ||= result.omittedSourceTurns > 0 || result.omittedPhoneEntries > 0 || result.title !== thread.title || JSON.stringify(result.agent) !== JSON.stringify(thread.agent) || result.project !== thread.project
  return result
}
