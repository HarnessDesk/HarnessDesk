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

/** An agent's choice as a card reads it. The adapter types an `approveAlways` choice's scope in `grant`. */
export interface GrantOption {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
  readonly intent: string
  readonly grant?: 'session-tool' | 'session-server' | 'permanent' | undefined
}

/** Whether the agent offers any grant that outlives the session; if not, the card says how to turn that on. */
export const offersPermanentGrant = (options: readonly GrantOption[]): boolean =>
  options.some((option) => option.grant === 'permanent')

/**
 * The one grant the card may relabel "Allow for this session": the agent's tool-scoped session grant, when there is
 * exactly one. A server-wide grant beside it keeps the agent's own explicit label, so a broader grant is never
 * softened to read like the narrow one, and the two never share a name.
 */
export const sessionOptionToRelabel = (options: readonly GrantOption[]): GrantOption | null => {
  const tool = options.filter((option) => option.grant === 'session-tool')
  return tool.length === 1 ? tool[0]! : null
}

/** The plain approve choice, when there is exactly one: agents word it differently ("Allow"). */
export const onceOptionToRelabel = (options: readonly GrantOption[]): GrantOption | null => {
  const once = options.filter((option) => option.intent === 'approve')
  return once.length === 1 ? once[0]! : null
}

/** The label a button carries. Only these two choices are relabelled, and only when the adapter declared the words. */
export const boardToolLabel = (
  option: GrantOption,
  options: readonly GrantOption[],
  labels: { readonly session?: string | undefined; readonly once?: string | undefined },
): string =>
  labels.session && sessionOptionToRelabel(options)?.id === option.id ? labels.session
    : labels.once && onceOptionToRelabel(options)?.id === option.id ? labels.once
      : option.label

/** Where a button sits when the card explains a board-tool request: grants stay quiet and apart from the plain Allow. */
export const boardToolPlacement = (option: GrantOption): 'safe' | 'proceed' =>
  option.intent === 'deny' || option.intent === 'cancel' || option.intent === 'approveAlways' ? 'safe' : 'proceed'
