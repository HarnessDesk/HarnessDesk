import { wrapContext, type ConfigOption, type UserContent } from '@harnessdesk/protocol'

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
  const modelPart = folded ? `${folded[1]} · ${folded[2]}` : model
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
