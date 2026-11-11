import { HANDOFF_PREFIX, isHandoffSource, splitContextContent, wrapContext, type AgentItem, type Turn } from '@harnessdesk/protocol'

import { MOVE_TEXT_CHARS } from '../lead/chats.js'
import { CONTINUE_TEXT } from './decide.js'

/**
 * What another agent is given when a conversation moves to it: the packet.
 *
 * Built on the host from the kept transcript, never from the renderer.
 * Everything taken from the transcript is the agent's output and untrusted; it
 * goes in as quoted text inside the envelope, and the renderer shows the
 * packet through the sanitiser like any message.
 *
 * Capped at the Lead's move size, trimmed from the bottom up — command output
 * first, then the oldest recent turns, then the file list — and never refused:
 * the Lead can ask the person instead of moving, a stuck conversation cannot.
 */

/** Recent turns the packet carries. */
export const RECENT = 6
const AGENT_TAIL = 2_000
const OUTPUT_LINES = 20
const FILES = 20
const FIRST_CAP = 32 * 1024
const TRUNCATED = '[truncated — see the full history]'

export interface PacketMeta {
  /** The stuck agent's display name, and its account's nickname or ordinal; never an email. */
  readonly fromName: string
  readonly fromAccount?: string
  readonly title: string
  /** When the limit was reached. */
  readonly at: number
}

const quote = (text: string): string => text.split('\n').map(line => `> ${line}`).join('\n')
const tail = (text: string, limit: number): string => text.length <= limit ? text : `…${text.slice(text.length - limit)}`
const lastLines = (text: string, count: number): string => text.split('\n').slice(-count).join('\n')
/** What the person typed; the host's own continuation is not theirs. */
const typed = (item: AgentItem): string | null => {
  if (item.type !== 'userMessage') return null
  const text = splitContextContent(item.content).text
  return text.trim() === CONTINUE_TEXT ? null : text
}
const ORIGIN = /^Originally handed off from .*$/m
const REQUEST = /The request:\n((?:>.*(?:\n|$))+)/
/** The composer's own hand-off (`buildHandoff` in the UI) writes its goal as a Markdown section, unquoted. */
const GOAL = /(?:^|\n)## Goal\n([\s\S]*?)(?=\n## |$)/

/**
 * A conversation that was itself handed off began with a packet, not with the
 * person's words: the request it carried is the original goal, and where it
 * came from stays attributed. Two packets start one: carry-on's own, whose
 * request is quoted, and the person's hand-off from the composer, whose goal
 * is a `## Goal` section. Either way the words after the packet ("take it from
 * here") are the hop's instruction, not the work.
 */
const inherited = (turns: readonly Turn[]): { readonly request: string | null; readonly origin: string } | null => {
  for (const turn of turns) for (const item of turn.items) {
    if (item.type !== 'userMessage') continue
    const block = splitContextContent(item.content).injections.find(entry => isHandoffSource(entry.label))
    if (!block) continue
    const quoted = REQUEST.exec(block.text)?.[1]
    const goal = GOAL.exec(block.text)?.[1]?.trim()
    const request = quoted !== undefined ? quoted.replace(/\n$/, '').split('\n').map(line => line.replace(/^> ?/, '')).join('\n') : goal || null
    const origin = ORIGIN.exec(block.text)?.[0] ?? `Originally handed off from ${block.label.slice(HANDOFF_PREFIX.length)}.`
    return { request, origin }
  }
  return null
}

interface Section { readonly text: string }

export const carryOnPacket = (turns: readonly Turn[], meta: PacketMeta, cap = MOVE_TEXT_CHARS): string => {
  const said = turns.flatMap(turn => turn.items.flatMap(item => { const text = typed(item); return text !== null && text.trim() ? [text] : [] }))
  const origin = inherited(turns)
  let first = origin?.request ?? said[0] ?? ''
  let last = said.length > (origin ? 0 : 1) && said.at(-1) !== first ? said.at(-1)! : null
  const from = meta.fromAccount ? `${meta.fromName} · ${meta.fromAccount}` : meta.fromName
  const why = `Continued here because ${from} reached its usage limit at ${new Date(meta.at).toISOString()}.`
  const back = `Full history: “${meta.title}” on ${meta.fromName}.`
  const instruction = 'Continue the request above from where it stopped. Check the working tree before redoing anything.'

  const recent = turns.slice(-RECENT)
  const turnSections: Section[] = recent.flatMap((turn, at) => {
    const words = turn.items.flatMap(item => item.type === 'assistantMessage' && item.text.trim() ? [item.text] : []).join('\n\n')
    const asked = turn.items.map(typed).find(text => text !== null && text.trim()) ?? null
    if (!words && !asked) return []
    const lines = [`Turn ${at + 1} of ${recent.length}:`]
    if (asked) lines.push('The person:', quote(tail(asked, AGENT_TAIL)))
    if (words) lines.push('The agent:', quote(tail(words, AGENT_TAIL)))
    return [{ text: lines.join('\n') }]
  })
  const commandSections: Section[] = recent.flatMap(turn => turn.items.flatMap(item => item.type !== 'command' ? [] : [{
    text: [`$ ${item.command}`, `exit ${item.exitCode ?? 'unknown'}`, ...(item.output?.trim() ? [quote(lastLines(item.output.trimEnd(), OUTPUT_LINES))] : [])].join('\n'),
  }]))
  const files = [...new Set(recent.flatMap(turn => turn.items.flatMap(item => item.type === 'fileChange' ? item.changes.map(change => change.path) : [])))].slice(0, FILES)

  const build = (): string => {
    const body = [
      why,
      ...(origin ? [origin.origin] : []),
      `The request:\n${quote(first)}`,
      ...(last !== null ? [`The last message, whose turn did not finish:\n${quote(last)}`] : []),
      ...(turnSections.length ? [`Recent turns:\n\n${turnSections.map(section => section.text).join('\n\n')}`] : []),
      ...(commandSections.length ? [`Commands run:\n\n${commandSections.map(section => section.text).join('\n\n')}`] : []),
      ...(files.length ? [`Files changed:\n${files.map(path => `- ${path}`).join('\n')}`] : []),
      back,
      instruction,
    ].join('\n\n')
    return wrapContext(`${HANDOFF_PREFIX}${meta.fromName} — “${meta.title}”`, body)
  }

  let packet = build()
  // Bottom up: command output, then the oldest turns, then the file list. The why, the request, the last
  // message and the link back stay.
  while (packet.length > cap && commandSections.length) { commandSections.shift(); packet = build() }
  while (packet.length > cap && turnSections.length) { turnSections.shift(); packet = build() }
  while (packet.length > cap && files.length) { files.pop(); packet = build() }
  if (packet.length > cap && first.length > FIRST_CAP) { first = `${first.slice(0, FIRST_CAP)}\n${TRUNCATED}`; packet = build() }
  if (packet.length > cap && last !== null) {
    const room = Math.max(0, last.length - (packet.length - cap) - TRUNCATED.length - 16)
    last = `${last.slice(0, room)}\n${TRUNCATED}`; packet = build()
  }
  // Still over, by a first message the envelope's escaping lengthened: cut it to fit rather than refuse the move.
  if (packet.length > cap) {
    first = `${first.slice(0, Math.max(0, first.length - (packet.length - cap) - TRUNCATED.length - 16))}\n${TRUNCATED}`
    packet = build()
  }
  return packet
}
