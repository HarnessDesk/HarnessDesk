import type { Turn } from '@harnessdesk/protocol'

/**
 * What a conversation looks like from the side.
 *
 * A long transcript has no shape a reader can see. The scrollbar says how far
 * down you are and nothing about what is down there, so finding the turn where
 * something went wrong means scrolling until you recognise it. A mark per
 * message gives the column a shape — where you asked, where it answered, how
 * long each ran — and makes "the bit about the retries" a place rather than a
 * search.
 *
 * Every decision about the rail is here, as a function over data. The
 * component that draws it owns pixels and events and nothing else, so what
 * counts as a mark, when the rail is worth showing and how much of a message
 * is worth previewing can all be tested without a browser.
 */

export type ConversationMark = {
  /** The turn this mark scrolls to. */
  readonly turn: string
  readonly kind: 'prompt' | 'answer'
  /** The first words of it, for the preview a pointer summons. */
  readonly preview: string
}

/**
 * How much of a message the preview carries.
 *
 * Long enough to recognise a turn by, short enough that the card stays a card:
 * roughly three lines at the reading size. The cut is on characters rather
 * than words because a preview is scanned, not read, and a half-word at the
 * end is a cheaper lie than a card that changes height as you move along the
 * rail.
 */
export const PREVIEW_MAX = 280

/**
 * Whether the rail is worth drawing at all.
 *
 * Two conditions, and both matter. A transcript that fits on one screen has
 * nothing to navigate, so the rail would be decoration. A transcript with one
 * exchange in it has nowhere to go but where you already are. Either way the
 * column is better without a thing to move the pointer past.
 */
export const shouldRenderMap = ({
  marks,
  overflows,
}: {
  readonly marks: number
  readonly overflows: boolean
}): boolean => marks >= 2 && overflows

const trim = (text: string): string => text.replace(/\s+/gu, ' ').trim()

const promptText = (turn: Turn): string => {
  for (const item of turn.items) {
    if (item.type !== 'userMessage') continue
    const words = item.content
      .map((part) => (part.type === 'text' ? part.text : part.type === 'mention' || part.type === 'skill' ? part.name : ''))
      .filter(Boolean)
      .join(' ')
    const said = trim(words)
    if (said) return said.slice(0, PREVIEW_MAX)
  }
  return ''
}

const answerText = (turn: Turn): string => {
  const said: string[] = []
  for (const item of turn.items) {
    if (item.type !== 'assistantMessage' || item.phase === 'commentary') continue
    const words = trim(item.text)
    if (words) said.push(words)
    if (said.join(' ').length >= PREVIEW_MAX) break
  }
  return said.join(' ').slice(0, PREVIEW_MAX)
}

/**
 * One mark for what was asked and one for what came back.
 *
 * Not one per item: a turn that read nine files would take nine marks and
 * bury the two that a reader is actually looking for. Not one per turn
 * either — the question and the answer are the two things anybody scrolls
 * back to, and they are usually far enough apart on screen to want separate
 * places.
 *
 * A turn with no words on one side contributes no mark for that side, so a
 * turn that only ran a command does not leave a mark that previews nothing.
 */
export const buildMarks = (turns: readonly Turn[]): readonly ConversationMark[] => {
  const marks: ConversationMark[] = []
  for (const turn of turns) {
    const asked = promptText(turn)
    if (asked) marks.push({ turn: turn.id, kind: 'prompt', preview: asked })
    const answered = answerText(turn)
    if (answered) marks.push({ turn: turn.id, kind: 'answer', preview: answered })
  }
  return marks
}

/**
 * How far the rail may reach before it touches what it is a picture of.
 *
 * The rail lives in the gutter the reading column leaves, and that gutter is
 * wide in a full window and a few dozen pixels in a narrow pane — a 1440
 * window with the sidebar and the dock open leaves about the same as a 640
 * one. A dash at rest is two steps long for a prompt, and the pointer pushes
 * the nearest one out by as much again; unmeasured, that push drew the dash
 * across the first letters of the transcript.
 *
 * So the rail asks, in the pane's own tokens:
 *
 *   roomy   the dashes start where they always have — the rail's inset, the
 *           mark's inset and the mark's own padding in from the pane's edge —
 *           and there is room for the full push and a gap before the text.
 *   tight   not enough room for that, so the rail moves to the pane's edge
 *           (the dash still starts inside its 24px target), and the push is
 *           cut to what fits, with `cap` holding even a resting dash short of
 *           the gap.
 *   none    not even a resting answer-dash fits; the rail is not drawn,
 *           because a map written over the text it maps helps nobody.
 */
export type RailFit =
  | { readonly fit: 'roomy'; readonly reach: number; readonly cap: null }
  | { readonly fit: 'tight'; readonly reach: number; readonly cap: number }
  | null

/**
 * How far past the hide threshold the gutter must move before the rail
 * appears or goes. The inset is read off a drawn mark, so a rail that is not
 * drawn has to guess it; the guess is the drawn value, and this band means a
 * pixel of disagreement (a hairline the theme thickens, a rounding) still
 * cannot flip the rail on and off at every measure.
 */
export const RAIL_HYSTERESIS = 2

export const railFit = ({
  gutter,
  gap,
  step,
  stroke,
  hairline = 0,
  inset = step + hairline,
  shown = false,
}: {
  /** From the pane's left edge to the reading column's first letter. */
  readonly gutter: number
  /** The least air between the longest dash and the text (`--hd-space-1`). */
  readonly gap: number
  /** The rail's inset and the mark's inset (`--hd-space-2`); also a resting answer. */
  readonly step: number
  /** A resting prompt, and the full push (`--hd-space-3`). */
  readonly stroke: number
  /** A mark's hairline (`--hd-border-width`), for the guess below. */
  readonly hairline?: number
  /** From a mark's edge to its dash: its padding and hairline, as drawn. Guessed as one step and a hairline until the rail is drawn and can say. */
  readonly inset?: number
  /** Whether the rail is drawn now: it stays until the room falls a band below the threshold, and comes back only a band above it. */
  readonly shown?: boolean
}): RailFit => {
  const roomy = gutter - 2 * step - inset - gap
  if (roomy >= stroke + stroke) return { fit: 'roomy', reach: stroke, cap: null }
  const tight = gutter - inset - gap
  if (tight < (shown ? step - RAIL_HYSTERESIS : step + RAIL_HYSTERESIS)) return null
  return { fit: 'tight', reach: Math.max(0, Math.min(stroke, tight - stroke)), cap: tight }
}
