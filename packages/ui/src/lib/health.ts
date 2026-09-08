import type { RuntimeHealth } from '@harnessdesk/protocol'

/**
 * Why an agent will not start, arranged to be read.
 *
 * A health message is often two things at once: one sentence of ours naming
 * what happened, and then the agent's own output — a validator listing one
 * finding per line, a build's stderr. Rendered as a single paragraph the
 * newlines collapse and the whole thing becomes a wall: OpenClaw's six
 * numbered findings arrived as one grey block with the repair buried at the
 * end of it. Splitting at the first line break is enough to fix that, and it
 * is honest about the seam, because that is exactly where the agent starts
 * speaking for itself.
 *
 * A message with no line break has no detail block — "Gemini CLI is not
 * installed on this machine" is a sentence and stays one.
 */

export type Unavailable = Extract<RuntimeHealth, { readonly state: 'unavailable' }>

export interface HealthParts {
  /** Our sentence: what happened. The trailing colon of a lead-in is dropped. */
  readonly lead: string
  /** The agent's own words, line breaks intact, or null when it said nothing. */
  readonly detail: string | null
  /** What to do about it, when the host knows. */
  readonly remediation: string | null
}

export const splitHealth = (health: Unavailable): HealthParts => {
  const [first = '', ...rest] = health.message.split('\n')
  const detail = rest.join('\n').trim()
  return {
    // `X refuses its own configuration:` introduces the block below it, and a
    // colon dangling at the end of a sentence with nothing after it reads as
    // a truncation.
    lead: first.trim().replace(/:$/, ''),
    detail: detail.length > 0 ? detail : null,
    remediation: health.remediation?.trim() || null,
  }
}

export interface TextSpan {
  readonly text: string
  /** True for what was written between backticks: a command, a path, a key. */
  readonly code: boolean
}

/**
 * Host text split into prose and code.
 *
 * The strings that carry these messages are written with Markdown's backticks
 * around commands — "Install it with \`npm install -g x\`." — because they are
 * also read in a log and in a terminal. On screen the backticks were being
 * drawn literally, which is the one place they mean nothing. This is the
 * smallest reading that fixes it: paired backticks become code, an unpaired
 * one stays a character, and nothing else in the string is interpreted.
 */
export const codeSpans = (text: string): readonly TextSpan[] => {
  const out: TextSpan[] = []
  let rest = text
  while (rest.length > 0) {
    const open = rest.indexOf('`')
    const close = open === -1 ? -1 : rest.indexOf('`', open + 1)
    if (open === -1 || close === -1) {
      out.push({ text: rest, code: false })
      break
    }
    if (open > 0) out.push({ text: rest.slice(0, open), code: false })
    const code = rest.slice(open + 1, close)
    if (code.length > 0) out.push({ text: code, code: true })
    rest = rest.slice(close + 1)
  }
  return out
}
