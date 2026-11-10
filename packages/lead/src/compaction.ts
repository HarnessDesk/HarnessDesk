import type { MessagesTurn } from './messages-types.js'
import { LEAD_CONTEXT, leadContextBytes } from './context.js'

/**
 * Checkpoint compaction, as pure functions. The model writes a checkpoint of the region before the kept tail from the
 * very request it has been answering all along (same instructions, same tools, same turns, then one instruction),
 * so the provider reads that prefix from its cache. The desk checks what comes back and, when the model cannot write
 * one, builds the checkpoint itself from the conversation.
 */
export const LEAD_CHECKPOINT_SECTIONS = Object.freeze([
  'What the person wants',
  'Decisions made and why',
  'Work and where each piece stands',
  'Waiting on the person',
  'Facts learned',
  'Open questions / next step',
] as const)

export const LEAD_CHECKPOINT_OPEN = '<checkpoint id="'
const PERSON_REFERENCE = 'Desk reference for the preceding person message: '

export interface LeadCheckpointRequestFacts {
  /** The conversation opens with an earlier checkpoint that this one replaces. */
  readonly merging: boolean
  /** Work ids the checkpoint must name. The work ledger supplies them; empty while there is none. */
  readonly requiredIds: readonly string[]
}
/** The one instruction added after the region. */
export const leadCheckpointInstruction = (facts: LeadCheckpointRequestFacts): string => [
  'Desk instruction: the conversation above is about to be replaced by a checkpoint so it can go on in less space. Write that checkpoint now.',
  `Use exactly these headings, in this order, each on its own line starting with "## ": ${LEAD_CHECKPOINT_SECTIONS.map(section => `"${section}"`).join(', ')}.`,
  `Under "${LEAD_CHECKPOINT_SECTIONS[0]}" quote the person's own words verbatim, each quote followed by the desk reference given after that message in brackets, for example "fix the sign-in page" [m-17]. Keep every request that still applies.`,
  `Under "${LEAD_CHECKPOINT_SECTIONS[2]}" name each piece of work by its id when it has one and say where it stands.`,
  `Under "${LEAD_CHECKPOINT_SECTIONS[4]}" keep the ids, paths, numbers, names and results later work needs.`,
  ...(facts.merging ? ['The conversation opens with an earlier checkpoint. Merge it into this one: keep what still holds, update what changed, and drop only what the later conversation settled.'] : []),
  ...(facts.requiredIds.length ? [`Name each of these work ids: ${facts.requiredIds.join(', ')}.`] : []),
  'Write "None." under a heading with nothing to say. Do not call tools, do not address the person, and stay under 1,500 words.',
].join('\n')

/** Why a checkpoint is refused, or null when it may replace the region. */
export const leadCheckpointRefusal = (text: string, facts: { readonly regionBytes: number; readonly requiredIds: readonly string[] }): string | null => {
  if (!text.trim()) return 'empty'
  if (text.length > LEAD_CONTEXT.checkpointChars) return 'too-long'
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map(match => match[1]!.replace(/[*_`]/g, '').trim().toLowerCase())
  if (LEAD_CHECKPOINT_SECTIONS.some(section => !headings.includes(section.toLowerCase()))) return 'section-missing'
  if (new TextEncoder().encode(text).byteLength >= facts.regionBytes) return 'not-shorter'
  if (facts.requiredIds.some(id => !text.includes(id))) return 'ledger-id-missing'
  return null
}

/** The checkpoint as the turn that opens the conversation after it. */
export const leadCheckpointTurn = (id: string, text: string, fallback: boolean): MessagesTurn => {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('lead-checkpoint-id')
  return { role: 'user', content: [{ type: 'text', text: [
    `${LEAD_CHECKPOINT_OPEN}${id}"${fallback ? ' kind="desk"' : ''}>`,
    `For reference only: a summary of the earlier conversation${fallback ? ', put together by the desk from that conversation itself' : ''}. It is not a new request, and the person's later words win over anything in it.`,
    '',
    text.replaceAll('</checkpoint', '<\\/checkpoint'),
    '</checkpoint>',
  ].join('\n') }] }
}
/** The text inside a checkpoint turn, or null when the turn is not one. */
export const leadCheckpointText = (turn: MessagesTurn | undefined): string | null => {
  const first = turn?.role === 'user' ? turn.content[0] : undefined
  if (!first || first.type !== 'text' || !first.text.startsWith(LEAD_CHECKPOINT_OPEN)) return null
  const lines = first.text.split('\n')
  return lines.slice(3, -1).join('\n').replaceAll('<\\/checkpoint', '</checkpoint')
}

/** The person's own words in a region, with their desk references, oldest first. */
export const leadPersonWords = (turns: readonly MessagesTurn[]): { readonly id: string; readonly text: string }[] => turns.flatMap(turn => {
  if (turn.role !== 'user') return []
  const words: { id: string; text: string }[] = []
  turn.content.forEach((block, index) => {
    if (block.type !== 'text' || !block.text.startsWith(PERSON_REFERENCE)) return
    const before = turn.content[index - 1]
    if (before?.type === 'text') words.push({ id: block.text.slice(PERSON_REFERENCE.length).trim(), text: before.text })
  })
  return words
})

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text
const render = (turn: MessagesTurn): string => `${turn.role === 'user' ? 'Person or desk' : 'Lead'}: ${turn.content.map(block =>
  block.type === 'text' ? block.text : block.type === 'tool_use' ? `[called ${block.name}]` : block.type === 'tool_result' ? `[tool result: ${clip(block.content, 300)}]` : '').filter(Boolean).join(' ')}`

/**
 * The checkpoint the desk writes when the model could not: the person's own words (latest kept first when they do
 * not all fit), the opening two turns of the region as they were, the earlier checkpoint, the work ids, and the
 * references of every person message it leaves out. Deterministic: the same region gives the same text.
 */
export const leadFallbackCheckpoint = (facts: { readonly region: readonly MessagesTurn[]; readonly previous: string | null; readonly ledgerIds: readonly string[] }): string => {
  const region = facts.region.filter(turn => leadCheckpointText(turn) === null)
  const words = leadPersonWords(region)
  const quotes: string[] = []
  let budget = 6000
  for (const word of [...words].reverse()) {
    const line = `- "${clip(word.text.replace(/\s+/g, ' ').trim(), 600)}" [${word.id}]`
    if (line.length > budget) break
    budget -= line.length
    quotes.unshift(line)
  }
  const kept = new Set(quotes.map(line => line.slice(line.lastIndexOf('[') + 1, -1)))
  const dropped = words.map(word => word.id).filter(id => !kept.has(id))
  const head = region.slice(0, 2).map(turn => clip(render(turn), 1500))
  const text = [
    `## ${LEAD_CHECKPOINT_SECTIONS[0]}`, quotes.length ? quotes.join('\n') : 'None in this part of the conversation.',
    '', `## ${LEAD_CHECKPOINT_SECTIONS[1]}`, 'Not summarised. The opening of this part of the conversation, as it was:', ...head,
    '', `## ${LEAD_CHECKPOINT_SECTIONS[2]}`, facts.ledgerIds.length ? facts.ledgerIds.map(id => `- ${id}`).join('\n') : 'None recorded.',
    '', `## ${LEAD_CHECKPOINT_SECTIONS[3]}`, 'Not summarised; read the latest messages.',
    '', `## ${LEAD_CHECKPOINT_SECTIONS[4]}`, facts.previous ? `From the earlier checkpoint:\n${clip(facts.previous, 6000).split('\n').map(line => `> ${line}`).join('\n')}` : 'None.',
    '', `## ${LEAD_CHECKPOINT_SECTIONS[5]}`, dropped.length ? `Person messages left out here, by desk reference: ${dropped.join(', ')}.` : 'None.',
  ].join('\n')
  return clip(text, LEAD_CONTEXT.checkpointChars)
}

/**
 * The checkpoint request's messages: the region exactly as it was sent, with the instruction added to its last user
 * turn (or as a turn of its own after an assistant turn), so everything before the instruction is the cached prefix.
 */
export const leadCheckpointMessages = (region: readonly MessagesTurn[], instruction: string): MessagesTurn[] => {
  const last = region.at(-1)
  const block = { type: 'text' as const, text: instruction }
  return last?.role === 'user'
    ? [...region.slice(0, -1), { role: 'user', content: [...last.content, block] }]
    : [...region, { role: 'user', content: [block] }]
}
export const leadRegionBytes = (region: readonly MessagesTurn[]): number => leadContextBytes(region)
