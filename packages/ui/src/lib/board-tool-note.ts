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
