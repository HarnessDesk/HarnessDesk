import type { ConfigOption } from '@harnessdesk/protocol'
import type { ForgeSeat } from '@harnessdesk/cordis-host'

/**
 * The seat: which agent did the work, on which model, at which effort.
 *
 * A vendor's own client signs the pull requests its agent opens — "Generated
 * with Claude Code" — and the signature is what tells a reviewer which tool,
 * on which model, wrote what they are reading. An agent driven from this desk
 * would otherwise sign as nothing, or as a client it is not running in. The
 * host is the one party that knows all three parts: the renderer never names
 * a runtime, and the agent does not reliably know what it is running on.
 *
 * Every part is read from the agent's own labels, never from a table of ours,
 * so a model the agent added yesterday signs under the name the agent gives
 * it. The one rule applied is that an agent's *automatic* choice is not a
 * model: "Gemini CLI Auto" names no model, and the seat is then the agent
 * alone. See `forge.ts` for what is done with the seat.
 */

/** The controls that carry an effort, under the ids the adapters declare them. */
const EFFORT_IDS = ['effort', 'reasoning', 'reasoningEffort']

/**
 * The words an agent folds into a model's name when the effort is part of
 * the id — "(High)", "(Medium)" — and nothing else in brackets: "(70B)",
 * "(2024-08-06)" and "(Hybrid)" are the model's own name and stay as written.
 */
const EFFORT_WORDS = /^(?:minimal|none|low|medium|high|max|maximum|xhigh|extra high|ultra)$/i

/**
 * A choice that is the agent's default rather than a model of its own.
 * Matched on the label and on the value, since Cursor spells it `auto` in
 * both and Gemini CLI labels a real id "Auto".
 */
const AUTOMATIC = /^(?:auto|automatic|default)$/i

/** The label of a select control's current choice, or its raw value when the choice is unlisted. */
const currentLabel = (options: readonly ConfigOption[], id: string): string | null => {
  const option = options.find((entry) => entry.id === id)
  if (!option || option.type !== 'select') return null
  return option.choices.find((choice) => choice.value === option.currentValue)?.label ?? option.currentValue
}

/** Whether the model control's current choice is the automatic one. */
const modelIsAutomatic = (options: readonly ConfigOption[]): boolean => {
  const option = options.find((entry) => entry.id === 'model')
  if (!option || option.type !== 'select') return false
  const label = option.choices.find((choice) => choice.value === option.currentValue)?.label ?? ''
  return AUTOMATIC.test(option.currentValue.trim()) || AUTOMATIC.test(label.trim())
}

/**
 * Whether the seat is thinking, where the agent has such a switch: a boolean
 * control under an effort id (Cursor's `reasoning`), or one named `thinking`.
 */
const thinkingOn = (options: readonly ConfigOption[]): boolean =>
  options.some(
    (option) =>
      option.type === 'boolean' &&
      (option.id === 'thinking' || EFFORT_IDS.includes(option.id)) &&
      option.currentValue === true,
  )

/**
 * The seat's parts, from the agent's name and its controls.
 *
 * The model is its label, or its id when it has none; an effort folded into
 * the label — "Gemini 3.8 Flash (High)" — is split back out, so the parts
 * are the same whichever way the agent spelled them. The automatic choice
 * leaves the model null.
 */
export const seatOf = (
  agent: string,
  options: readonly ConfigOption[],
  version: string | null = null,
): ForgeSeat => {
  const rawModel = modelIsAutomatic(options) ? null : currentLabel(options, 'model')
  let effort = EFFORT_IDS.map((id) => currentLabel(options, id)).find((label) => label !== null) ?? null
  let model = rawModel
  if (model !== null && effort === null) {
    const folded = /^(.*\S)\s*\(([^()]+)\)$/.exec(model)
    const word = folded?.[2]?.trim() ?? ''
    if (folded && EFFORT_WORDS.test(word)) {
      model = folded[1] ?? model
      effort = word
    }
  }
  return {
    agent,
    version: version && version.trim() !== '' ? version.trim() : null,
    model,
    effort,
    thinking: thinkingOn(options),
    label: seatLabel(agent, model, effort),
  }
}

/**
 * The seat as a person would write it: the agent, the model, then the
 * effort — "Codex GPT-5.4 · High"; "Gemini CLI" when the model is the
 * agent's automatic choice and no effort is set.
 */
export const seatLabel = (agent: string, model: string | null, effort: string | null): string => {
  const head = model === null ? agent : `${agent} ${model}`
  return effort === null ? head : `${head} · ${effort}`
}
