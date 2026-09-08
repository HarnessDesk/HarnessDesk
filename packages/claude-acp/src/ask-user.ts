/**
 * Claude Code's `AskUserQuestion`, carried to the client as ACP permission
 * requests and answered back through the tool's own input.
 *
 * The base bridge disallows the tool outright ("not a great way to expose
 * this over ACP at the moment"), so through it Claude could never ask a
 * person anything — the one interaction its own clients make a card of. The
 * SDK's contract for the tool is small: `canUseTool` receives the questions
 * as the tool input and the host answers by returning `updatedInput` with an
 * `answers` map, keyed by the question text, holding the chosen label
 * ("User answers collected by the permission component", sdk-tools.d.ts).
 *
 * ACP has no question vocabulary, but `session/request_permission` carries
 * a flat option list, and one question with its choices is exactly that. So
 * each question goes out as one permission request whose options are the
 * question's own choices, with the whole question beside it in `_meta` and
 * in the tool call's `rawInput` for a client that draws questions as
 * questions rather than as permissions. Free text — the "Other" every one of
 * Claude's own clients adds — has no way back over an option id, so a
 * question is answered from its options or not at all.
 *
 * Pure: no connection, no session — so it is testable without a CLI.
 *
 * @module
 */

/** One question, as the SDK's `AskUserQuestionInput` spells it. */
export interface AskedQuestion {
  readonly question: string
  readonly header: string
  readonly multiSelect: boolean
  readonly options: readonly { readonly label: string; readonly description: string }[]
}

/** The tool's input, narrowed; `questions` is what the model wrote. */
export const questionsOf = (input: unknown): AskedQuestion[] => {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw)) return []
  const out: AskedQuestion[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const q = entry as Record<string, unknown>
    const question = typeof q['question'] === 'string' ? q['question'].trim() : ''
    if (question.length === 0) continue
    const options = Array.isArray(q['options'])
      ? q['options']
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({
            label: typeof o['label'] === 'string' ? o['label'] : '',
            description: typeof o['description'] === 'string' ? o['description'] : '',
          }))
          .filter((o) => o.label.length > 0)
      : []
    out.push({
      question,
      header: typeof q['header'] === 'string' ? q['header'] : '',
      multiSelect: q['multiSelect'] === true,
      options,
    })
  }
  return out
}

/** The option id one choice travels under; the index keeps labels free of escaping. */
export const answerOptionId = (index: number): string => `answer-${index}`

/**
 * The tool-call id one question of a call travels under.
 *
 * A single call carries up to four questions, asked one after another. They
 * share the tool call, so they would share the transcript row a client
 * anchors a card to — and the second card would land on top of the first.
 * A call with one question keeps the call's own id, so the ordinary case is
 * unchanged.
 */
export const questionCallId = (toolCallId: string, index: number, total: number): string =>
  total > 1 ? `${toolCallId}#q${index + 1}` : toolCallId

/** What this bridge says about a question, on the request it rides. */
export const ASK_USER_META_KEY = 'question'

/**
 * The permission request that asks one question. Options are the choices in
 * the question's own order, all `allow_once`: choosing is not granting
 * anything, and a client that files them as approvals gets plain buttons.
 */
export const permissionRequestFor = (
  sessionId: string,
  toolCallId: string,
  asked: AskedQuestion,
): {
  sessionId: string
  toolCall: { toolCallId: string; title: string; kind: 'think'; rawInput: { questions: AskedQuestion[] } }
  options: { optionId: string; name: string; kind: 'allow_once' }[]
  _meta: { harnessdesk: { question: AskedQuestion } }
} => ({
  sessionId,
  toolCall: { toolCallId, title: asked.question, kind: 'think', rawInput: { questions: [asked] } },
  options: asked.options.map((option, index) => ({
    optionId: answerOptionId(index),
    name: option.label,
    kind: 'allow_once',
  })),
  _meta: { harnessdesk: { [ASK_USER_META_KEY]: asked } },
})

/**
 * The label(s) a selected option id stands for, or null when nothing was
 * chosen. A multi-select question's answer arrives as its option ids joined
 * with `+` — ACP's outcome carries one id — and goes back as the labels
 * joined with ", ", which is how Claude Code's own clients write a
 * multi-select answer into the `answers` map.
 */
export const answerFor = (
  asked: AskedQuestion,
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } | undefined,
): string | null => {
  if (!outcome || outcome.outcome !== 'selected') return null
  const labels: string[] = []
  for (const part of outcome.optionId.split('+')) {
    const match = /^answer-(\d+)$/.exec(part)
    const index = match ? Number(match[1]) : Number.NaN
    const option = Number.isInteger(index) ? asked.options[index] : undefined
    if (option) labels.push(option.label)
  }
  if (labels.length === 0) return null
  return asked.multiSelect ? labels.join(', ') : (labels[0] ?? null)
}

/**
 * The tool input handed back to Claude once every question is answered:
 * the original input plus `answers`, keyed the way the SDK reads them.
 */
export const answeredInput = (
  input: Record<string, unknown>,
  answers: ReadonlyMap<string, string>,
): Record<string, unknown> => ({
  ...input,
  answers: Object.fromEntries(answers),
})

/**
 * A question's tool row, titled with the question.
 *
 * The base bridge titles a tool call by its name when it has no better idea,
 * and for `AskUserQuestion` it has none — so the row read as the wire name,
 * which the transcript never prints for anything else. The question is the
 * sentence; the answers follow on the card.
 */
export const questionTitled = <T extends { sessionUpdate?: unknown }>(update: T): T => {
  if (update.sessionUpdate !== 'tool_call') return update
  const titled = update as { title?: unknown; rawInput?: unknown }
  if (titled.title !== 'AskUserQuestion') return update
  const [first] = questionsOf(titled.rawInput)
  return {
    ...update,
    title: first?.question ?? 'Asked a question',
    kind: 'think',
  } as unknown as T
}
