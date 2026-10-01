/** One sentence shared by the real approval, the catalogue and the preview. */
export interface BoardToolNoteInput {
  /** What the tool does, as a verb phrase (`boardToolPhrase`). */
  readonly phrase: string
  readonly runtimeName: string
  readonly permanentApprovalSetting: string
  readonly hasPermanentOption: boolean
}

export interface BoardToolNote {
  readonly text: string
  readonly title?: string
}

export const boardToolNote = ({
  phrase,
  runtimeName,
  permanentApprovalSetting,
  hasPermanentOption,
}: BoardToolNoteInput): BoardToolNote => {
  const sentence = phrase.trim().replace(/[.!?]+$/, '')
  return {
    text: [
      `HarnessDesk's board wants to ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}.`,
      "HarnessDesk can't confirm which server is asking.",
      ...(!hasPermanentOption
        ? [`To always allow, turn on permanent tool approval in ${runtimeName}'s settings.`]
        : []),
    ].join(' '),
    ...(!hasPermanentOption ? { title: permanentApprovalSetting } : {}),
  }
}

/** The agent's own words for an option: what it says and what it says it does. */
export interface GrantOption {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
  readonly intent: string
}
const wordsOf = (option: GrantOption): string => `${option.label} ${option.description ?? ''}`

/** Whether the agent says a permanent grant outlives this session. Read from its own label and description. */
export const outlivesSession = (option: GrantOption): boolean =>
  option.intent === 'approveAlways' && /future sessions|all sessions|permanent|\bsaves?\b/i.test(wordsOf(option))

/** Whether the agent offers any grant that outlives the session; if not, the card says how to turn that on. */
export const offersPermanentGrant = (options: readonly GrantOption[]): boolean => options.some(outlivesSession)

/**
 * The one option the card may relabel "Allow for this session": the agent offers exactly one grant that ends with
 * the session, and it covers a single tool. Where it offers a server-wide or a second session grant, the agent's
 * own labels stay, so a broader grant is never softened to read like a narrow one.
 */
export const sessionOptionToRelabel = (options: readonly GrantOption[]): GrantOption | null => {
  const session = options.filter((option) => option.intent === 'approveAlways' && !outlivesSession(option))
  const only = session.length === 1 ? session[0]! : null
  return only && !/\bserver\b|\bevery\b|\ball\b/i.test(wordsOf(only)) ? only : null
}

/** The label a button carries: only the one tool-scoped session grant is relabelled; every other label is the agent's own. */
export const boardToolLabel = (option: GrantOption, options: readonly GrantOption[], sessionLabel: string): string =>
  sessionOptionToRelabel(options)?.id === option.id ? sessionLabel : option.label

/** Where a button sits when the card explains a board-tool request: grants stay quiet and apart from the plain Allow. */
export const boardToolPlacement = (option: GrantOption): 'safe' | 'proceed' =>
  option.intent === 'deny' || option.intent === 'cancel' || option.intent === 'approveAlways' ? 'safe' : 'proceed'
