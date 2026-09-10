import { splitContext, wrapContext, type ConfigOption, type Turn, type UserContent } from '@harnessdesk/protocol'

/**
 * The line a pull request ends with when an agent opened it from here.
 *
 * A vendor's own client signs the pull requests its agent opens — "Generated
 * with Claude Code" — and that signature is what tells a reviewer which tool,
 * on which model, wrote what they are reading. An agent driven from this desk
 * would otherwise sign as nothing, or as a client it is not running in. So
 * the desk asks it to sign as the seat that did the work: HarnessDesk, then
 * the agent, its model and its effort, in the agent's own labels. The host is
 * the one party that knows all three; the renderer never names a runtime and
 * the agent does not reliably know what it is running on.
 *
 * It travels as context beside the turn, in the envelope every other
 * injection uses, so the transcript shows it as what it is rather than as
 * something the person typed. Once per conversation, and again only when the
 * seat changes: the line names the model, and a model switched halfway
 * through would otherwise sign the other model's work.
 */

export const HARNESSDESK_URL = 'https://harnessdesk.app'

/** The `source` the envelope carries — the row's label in the transcript. */
export const ATTRIBUTION_SOURCE = 'HarnessDesk'

/** The controls that carry an effort, under the ids the adapters declare them. */
const EFFORT_IDS = ['effort', 'reasoning', 'reasoningEffort']

/**
 * The words an agent folds into a model's name when the effort is part of
 * the id — "(High)", "(Medium)" — and nothing else in brackets: "(70B)",
 * "(2024-08-06)" and "(Hybrid)" are the model's own name and stay as written.
 */
const EFFORT_WORDS = /^(?:minimal|none|low|medium|high|max|maximum|xhigh|extra high|ultra)$/i

/** The label of a select control's current choice, or its raw value when the choice is unlisted. */
const currentLabel = (options: readonly ConfigOption[], id: string): string | null => {
  const option = options.find((entry) => entry.id === id)
  if (!option || option.type !== 'select') return null
  return option.choices.find((choice) => choice.value === option.currentValue)?.label ?? option.currentValue
}

/**
 * The seat as a person would write it: the agent, the model by its own label,
 * then the effort when it is a separate control — "Codex GPT-5.4 · High". An
 * agent that folds the effort into the model's name, "Gemini 3.8 Flash
 * (High)", is written the same way rather than with the brackets.
 */
export const seatLabel = (agent: string, options: readonly ConfigOption[]): string => {
  const model = currentLabel(options, 'model')
  const effort = EFFORT_IDS.map((id) => currentLabel(options, id)).find((label) => label !== null) ?? null
  if (model === null) return effort === null ? agent : `${agent} · ${effort}`
  const folded = effort === null ? /^(.*\S)\s*\(([^()]+)\)$/.exec(model) : null
  const word = folded?.[2]?.trim() ?? ''
  const modelPart = folded && EFFORT_WORDS.test(word) ? `${folded[1]} · ${word}` : model
  return `${agent} ${modelPart}${effort === null ? '' : ` · ${effort}`}`
}

export const attributionLine = (seat: string): string =>
  `🤖 Generated with [HarnessDesk](${HARNESSDESK_URL}) (${seat})`

/** What the agent is told, wrapped as the desk's own context. */
export const attributionEnvelope = (line: string): string =>
  wrapContext(
    ATTRIBUTION_SOURCE,
    [
      'When you open or update a pull request from this conversation — with `gh pr create`, `gh pr edit`, a git host’s API or any other way — end its description with a blank line and then this exact line, unchanged:',
      '',
      line,
      '',
      'It goes nowhere else: not in commit messages, review comments or files.',
    ].join('\n'),
  )

/**
 * The turn with the instruction riding beside it — on the last text block,
 * so it folds beside the words rather than standing as a message of its own,
 * and as a block of its own when the turn carried no text at all.
 */
export const withAttribution = (input: readonly UserContent[], line: string): readonly UserContent[] => {
  const envelope = attributionEnvelope(line)
  let at = -1
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.type === 'text') {
      at = index
      break
    }
  }
  if (at === -1) return [...input, { type: 'text', text: envelope }]
  return input.map((block, index) =>
    index === at && block.type === 'text' ? { ...block, text: `${block.text}\n\n${envelope}` } : block,
  )
}

/** The shape of the line, for finding one the conversation already carries. */
const LINE = /^🤖 Generated with \[HarnessDesk\]\([^)]*\) \(.*\)$/m

/**
 * The attribution line this conversation was last told, read from its own
 * transcript: the last of the person's messages that carries the desk's
 * envelope, and the line inside it. The transcript is the record of what the
 * agent was told, which is why a host that restarted does not need a record
 * of its own to keep "once per conversation" true — and why a seat that
 * changed since is still told again, because the line names the model.
 */
export const lastAttributionIn = (turns: readonly Turn[]): string | null => {
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    const items = turns[at]?.items ?? []
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item?.type !== 'userMessage') continue
      for (const block of item.content) {
        if (block.type !== 'text') continue
        for (const injection of splitContext(block.text).injections) {
          if (injection.label !== ATTRIBUTION_SOURCE) continue
          const found = LINE.exec(injection.text)
          if (found) return found[0]
        }
      }
    }
  }
  return null
}
